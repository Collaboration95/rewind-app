import { Platform } from 'react-native';

import {
  AuthRequestError,
  RealAccountClient,
  createRealAccountArchiveClient,
  invalidRegistrationOutcome,
  isRealAccount,
  isSecureAuthUrl,
  rateLimitMessage,
  resolvePublicMediaPath,
  type TokenStore,
} from '../src/auth/real-account-client';

const account = {
  id: 'account-1',
  username: 'pilot.user',
  displayName: 'Pilot User',
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
};
const token = 'b'.repeat(43);
const API = 'https://api.rewind.example';
const originalOS = Platform.OS;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

let stored: string | null;
const tokenStore: TokenStore = {
  read: jest.fn(async () => stored),
  write: jest.fn(async (value: string) => {
    stored = value;
  }),
  clear: jest.fn(async () => {
    stored = null;
  }),
};

function reply(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function unreadable(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
  } as unknown as Response;
}

function setPlatform(os: string) {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os, writable: true });
}

function setWindow(href: string) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { location: { href, origin: new URL(href).origin } },
  });
}

function client(fetcher: jest.Mock, baseUrl = API) {
  return new RealAccountClient(baseUrl, tokenStore, fetcher as unknown as typeof fetch);
}

beforeEach(() => {
  stored = null;
  setPlatform('ios');
});

afterEach(() => {
  setPlatform(originalOS);
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: unknown }).window;
});

describe('transport security', () => {
  it('accepts a same-origin loopback HTTP API on web only for dev builds', () => {
    setPlatform('web');
    setWindow('http://localhost:8090/');

    expect(isSecureAuthUrl('/api', true)).toBe(true);
    expect(isSecureAuthUrl('/api', false)).toBe(false);
    expect(isSecureAuthUrl('http://localhost:9999/api', true)).toBe(false);
  });

  it('rejects a cross-origin API on web even over HTTPS', () => {
    setPlatform('web');
    setWindow('https://rewind.example/');

    expect(isSecureAuthUrl('https://evil.example/api')).toBe(false);
    expect(isSecureAuthUrl('https://rewind.example/api')).toBe(true);
  });

  it('requires HTTPS on native and treats an unparseable base URL as insecure', () => {
    expect(isSecureAuthUrl('https://api.example')).toBe(true);
    expect(isSecureAuthUrl('http://localhost:8090')).toBe(false);
    expect(isSecureAuthUrl('::::')).toBe(false);
  });
});

describe('login', () => {
  const okBody = { account, expiresAt: '2026-09-28T12:00:00.000Z', token };

  it.each([
    ['rate limited', 429],
    ['bad credentials', 401],
    ['server error', 500],
  ])('maps a %s response to a sign-in error carrying the status', async (_label, status) => {
    const c = client(jest.fn().mockResolvedValue(reply(status, { error: 'x' })));

    await expect(c.login('pilot.user', 'pw')).rejects.toMatchObject({ status, reason: 'sign-in' });
  });

  it.each([
    ['an invalid account', { ...okBody, account: { id: 'a' } }],
    ['no expiry', { account, token }],
    ['no token', { account, expiresAt: okBody.expiresAt }],
    ['a short token', { ...okBody, token: 'short' }],
    ['a token with illegal characters', { ...okBody, token: `${'c'.repeat(42)}!` }],
  ])('rejects a native sign-in response with %s without storing anything', async (_l, body) => {
    const c = client(jest.fn().mockResolvedValue(reply(200, body)));

    await expect(c.login('pilot.user', 'pw')).rejects.toMatchObject({
      status: 502,
      reason: 'response',
    });
    expect(tokenStore.write).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON success body', async () => {
    const c = client(jest.fn().mockResolvedValue(unreadable(200)));

    await expect(c.login('pilot.user', 'pw')).rejects.toMatchObject({ reason: 'response' });
  });

  it('revokes the fresh server session if the token cannot be saved securely', async () => {
    (tokenStore.write as jest.Mock).mockRejectedValueOnce(new Error('keychain locked'));
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(reply(200, okBody))
      .mockResolvedValueOnce(reply(200, { signedOut: true }));
    const c = client(fetcher);

    await expect(c.login('pilot.user', 'pw')).rejects.toMatchObject({
      status: 0,
      reason: 'secure-storage',
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1];
    expect(url).toBe(`${API}/auth/logout`);
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(c.realtimeAuthorizationHeader()).toBeUndefined();
  });

  it('still reports the storage failure when the compensating logout also fails', async () => {
    (tokenStore.write as jest.Mock).mockRejectedValueOnce(new Error('keychain locked'));
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(reply(200, okBody))
      .mockRejectedValueOnce(new Error('offline'));

    await expect(client(fetcher).login('pilot.user', 'pw')).rejects.toMatchObject({
      reason: 'secure-storage',
    });
  });

  it('keeps the native token, session metadata and sign-in method on success', async () => {
    const fetcher = jest.fn().mockResolvedValue(
      reply(200, {
        ...okBody,
        absoluteExpiresAt: '2026-10-28T00:00:00.000Z',
        signInMethod: 'cognito',
      }),
    );
    const c = client(fetcher);

    const result = await c.login('pilot.user', 'pw');

    expect(result).toEqual({
      account,
      expiresAt: okBody.expiresAt,
      absoluteExpiresAt: '2026-10-28T00:00:00.000Z',
      signInMethod: 'cognito',
      token,
    });
    expect(stored).toBe(token);
    expect(c.realtimeAuthorizationHeader()).toBe(`Bearer ${token}`);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ clientType: 'native' });
  });

  it('ignores an unknown sign-in method and never returns a token on web', async () => {
    setPlatform('web');
    setWindow('https://api.rewind.example/');
    const fetcher = jest
      .fn()
      .mockResolvedValue(reply(200, { account, expiresAt: okBody.expiresAt, signInMethod: 'sso' }));
    const c = client(fetcher);

    const result = await c.login('pilot.user', 'pw');

    expect(result).toEqual({ account, expiresAt: okBody.expiresAt });
    expect(tokenStore.write).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0][1].credentials).toBe('include');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ clientType: 'browser' });
    expect(c.realtimeAuthorizationHeader(token)).toBeUndefined();
  });
});

describe('register', () => {
  it.each([400, 409, 429, 503])('maps HTTP %i to a registration error', async (status) => {
    const c = client(jest.fn().mockResolvedValue(reply(status, {})));

    await expect(c.register('new.user', 'long-enough-password')).rejects.toMatchObject({
      status,
      reason: 'registration',
    });
  });

  it('rejects a success response that lacks a valid account', async () => {
    const c = client(jest.fn().mockResolvedValue(reply(201, { account: { id: 1 } })));

    await expect(c.register('new.user', 'long-enough-password')).rejects.toMatchObject({
      status: 502,
      reason: 'response',
    });
  });

  it('returns the created account', async () => {
    const c = client(jest.fn().mockResolvedValue(reply(201, { account })));

    await expect(c.register('new.user', 'long-enough-password')).resolves.toEqual(account);
  });
});

describe('restore', () => {
  const session = {
    account,
    idleExpiresAt: '2026-09-28T01:00:00.000Z',
    absoluteExpiresAt: '2026-10-28T00:00:00.000Z',
  };

  it('returns null on native when no token is stored, without calling the server', async () => {
    const fetcher = jest.fn();

    await expect(client(fetcher).restore()).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('treats a native 401 as an expired session', async () => {
    stored = token;
    const c = client(jest.fn().mockResolvedValue(reply(401, { error: 'session_required' })));

    await expect(c.restore()).rejects.toMatchObject({ status: 401, reason: 'expired' });
  });

  it('returns null on web only for the explicit session_required answer', async () => {
    setPlatform('web');
    setWindow('https://api.rewind.example/');

    await expect(
      client(jest.fn().mockResolvedValue(reply(401, { error: 'session_required' }))).restore(),
    ).resolves.toBeNull();
    await expect(
      client(jest.fn().mockResolvedValue(reply(401, { error: 'session_revoked' }))).restore(),
    ).rejects.toMatchObject({ reason: 'expired' });
    await expect(
      client(jest.fn().mockResolvedValue(unreadable(401))).restore(),
    ).rejects.toMatchObject({ reason: 'expired' });
  });

  it('reports other failures as restore errors', async () => {
    stored = token;
    const c = client(jest.fn().mockResolvedValue(reply(503, {})));

    await expect(c.restore()).rejects.toMatchObject({ status: 503, reason: 'restore' });
  });

  it.each([
    ['no account', { ...session, account: null }],
    ['no idle expiry', { account, absoluteExpiresAt: session.absoluteExpiresAt }],
    ['no absolute expiry', { account, idleExpiresAt: session.idleExpiresAt }],
  ])('rejects a malformed session with %s', async (_label, body) => {
    stored = token;

    await expect(
      client(jest.fn().mockResolvedValue(reply(200, body))).restore(),
    ).rejects.toMatchObject({
      status: 502,
      reason: 'response',
    });
  });

  it('sends the stored bearer token and returns the session with its method', async () => {
    stored = token;
    const fetcher = jest
      .fn()
      .mockResolvedValue(reply(200, { ...session, signInMethod: 'password' }));
    const c = client(fetcher);

    await expect(c.restore()).resolves.toEqual({ ...session, signInMethod: 'password' });

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`${API}/auth/session`);
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(init.credentials).toBe('omit');
    expect(c.realtimeAuthorizationHeader()).toBe(`Bearer ${token}`);
  });
});

describe('logout and token cleanup', () => {
  it('fails locally on native when there is no credential to revoke', async () => {
    const fetcher = jest.fn();

    await expect(client(fetcher).logout()).rejects.toMatchObject({ status: 0, reason: 'logout' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('prefers an explicit token, then the active one, then the stored one', async () => {
    const fetcher = jest.fn().mockResolvedValue(reply(200, { signedOut: true }));
    stored = 'c'.repeat(43);
    const c = client(fetcher);

    await c.logout('d'.repeat(43));
    await c.logout();

    const bearer = (call: number) =>
      new Headers(fetcher.mock.calls[call][1].headers).get('Authorization');
    expect(bearer(0)).toBe(`Bearer ${'d'.repeat(43)}`);
    expect(bearer(1)).toBe(`Bearer ${'c'.repeat(43)}`);
  });

  it('reports a server refusal and an unconfirmed sign-out distinctly', async () => {
    stored = token;
    await expect(
      client(jest.fn().mockResolvedValue(reply(500, {}))).logout(),
    ).rejects.toMatchObject({ status: 500, reason: 'logout' });
    await expect(
      client(jest.fn().mockResolvedValue(reply(200, { signedOut: false }))).logout(),
    ).rejects.toMatchObject({ status: 502, reason: 'logout' });
  });

  it('returns the identity provider sign-out URL only when one is provided', async () => {
    stored = token;
    const withUrl = client(
      jest.fn().mockResolvedValue(reply(200, { signedOut: true, logoutUrl: 'https://idp/logout' })),
    );
    const emptyUrl = client(
      jest.fn().mockResolvedValue(reply(200, { signedOut: true, logoutUrl: '' })),
    );

    await expect(withUrl.logout()).resolves.toBe('https://idp/logout');
    await expect(emptyUrl.logout()).resolves.toBeUndefined();
  });

  it('web logout sends no bearer header', async () => {
    setPlatform('web');
    setWindow('https://api.rewind.example/');
    const fetcher = jest.fn().mockResolvedValue(reply(200, { signedOut: true }));

    await client(fetcher).logout();

    expect(new Headers(fetcher.mock.calls[0][1].headers).has('Authorization')).toBe(false);
    expect(fetcher.mock.calls[0][1].credentials).toBe('include');
  });

  it('clearStoredToken wipes the native store and forgets the active token, but is a no-op on web', async () => {
    stored = token;
    const c = client(
      jest
        .fn()
        .mockResolvedValue(reply(200, { account, idleExpiresAt: 'a', absoluteExpiresAt: 'b' })),
    );
    await c.restore();
    expect(c.realtimeAuthorizationHeader()).toBe(`Bearer ${token}`);

    await c.clearStoredToken();
    expect(stored).toBeNull();
    expect(c.realtimeAuthorizationHeader()).toBeUndefined();

    setPlatform('web');
    (tokenStore.clear as jest.Mock).mockClear();
    await c.clearStoredToken();
    expect(tokenStore.clear).not.toHaveBeenCalled();
  });
});

describe('authenticated request guard', () => {
  it('blocks insecure transport before any network call', async () => {
    const fetcher = jest.fn();

    await expect(
      client(fetcher, 'http://api.rewind.example').request('/x', {}),
    ).rejects.toMatchObject({ reason: 'insecure-transport' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['a path without a leading slash', 'groups'],
    ['a session token in the query', '/groups?token=abc'],
    ['an authorization query key in any case', '/groups?Authorization=abc'],
    ['an access token in the query', '/groups?access_token=abc'],
    ['an app session in the query', '/groups?appSession=abc'],
  ])('refuses %s', async (_label, path) => {
    const fetcher = jest.fn();

    await expect(client(fetcher).request(path, {})).rejects.toMatchObject({ reason: 'response' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses a request whose URL would contain the bearer token', async () => {
    const fetcher = jest.fn();

    await expect(client(fetcher).request(`/groups/${token}`, {}, token)).rejects.toBeInstanceOf(
      AuthRequestError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps a 401 to an expired session and passes other statuses through', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(reply(401, {}))
      .mockResolvedValueOnce(reply(403, {}))
      .mockResolvedValueOnce(reply(429, {}));
    const c = client(fetcher);

    await expect(c.request('/groups', {}, token)).rejects.toMatchObject({
      status: 401,
      reason: 'expired',
      message: 'Your sign-in has expired or was reset.',
    });
    await expect(c.request('/groups', {})).resolves.toMatchObject({ status: 403 });
    await expect(c.request('/groups', {})).resolves.toMatchObject({ status: 429 });
  });

  it('attaches the bearer on native and cookies on web', async () => {
    const fetcher = jest.fn().mockResolvedValue(reply(200, {}));
    await client(fetcher).request('/groups', { method: 'POST' }, token);
    const native = fetcher.mock.calls[0];
    expect(native[0]).toBe(`${API}/groups`);
    expect(new Headers(native[1].headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(native[1].credentials).toBe('omit');

    setPlatform('web');
    setWindow('https://api.rewind.example/');
    await client(fetcher).request('/groups', {}, token);
    const web = fetcher.mock.calls[1];
    expect(new Headers(web[1].headers).has('Authorization')).toBe(false);
    expect(web[1].credentials).toBe('include');
  });
});

describe('auth config and helpers', () => {
  it('reports a failing /auth/config as an error the caller can downgrade', async () => {
    await expect(
      client(jest.fn().mockResolvedValue(reply(500, {}))).fetchAuthConfig(),
    ).rejects.toMatchObject({
      status: 500,
    });
  });

  it('builds a Cognito start URL with an encoded return target', () => {
    const c = client(jest.fn(), `${API}/`);

    expect(c.cognitoStartUrl('/groups?x=1&y=2')).toBe(
      `${API}/auth/cognito/start?return=%2Fgroups%3Fx%3D1%26y%3D2`,
    );
  });

  it('rateLimitMessage uses the server wording only for 429 with a non-blank message', async () => {
    await expect(rateLimitMessage(reply(429, { message: 'Try later.' }), 'fallback')).resolves.toBe(
      'Try later.',
    );
    await expect(rateLimitMessage(reply(429, { message: '  ' }), 'fallback')).resolves.toBe(
      'fallback',
    );
    await expect(rateLimitMessage(reply(429, { message: 3 }), 'fallback')).resolves.toBe(
      'fallback',
    );
    await expect(rateLimitMessage(reply(429, null), 'fallback')).resolves.toBe('fallback');
    await expect(rateLimitMessage(unreadable(429), 'fallback')).resolves.toBe('fallback');
    await expect(rateLimitMessage(reply(500, { message: 'secret' }), 'fallback')).resolves.toBe(
      'fallback',
    );
  });

  it('invalidRegistrationOutcome names the failing field', () => {
    expect(invalidRegistrationOutcome('ab', 'long-enough-password')).toBe('invalid-username');
    expect(invalidRegistrationOutcome('-bad.name', 'long-enough-password')).toBe(
      'invalid-username',
    );
    expect(invalidRegistrationOutcome('good.name', 'short')).toBe('invalid-password');
    expect(invalidRegistrationOutcome('good.name', 'x'.repeat(1025))).toBe('invalid-password');
    expect(invalidRegistrationOutcome('good.name', 'long-enough-password')).toBe('invalid');
  });

  it('isRealAccount rejects non-objects and missing fields', () => {
    expect(isRealAccount(account)).toBe(true);
    expect(isRealAccount(null)).toBe(false);
    expect(isRealAccount('account')).toBe(false);
    expect(isRealAccount({ ...account, updatedAt: 5 })).toBe(false);
  });

  it('AuthRequestError uses a generic message for non-expiry reasons', () => {
    const error = new AuthRequestError(500, 'sign-in');

    expect(error.message).toBe('Authentication request failed.');
    expect(error.name).toBe('AuthRequestError');
  });
});

describe('resolvePublicMediaPath edge cases', () => {
  const capability = `/media/access/${'e'.repeat(43)}`;

  it('rejects a base URL that cannot be parsed', () => {
    expect(() => resolvePublicMediaPath('::::', capability)).toThrow(AuthRequestError);
  });

  it('rejects base URLs with credentials, query or fragment', () => {
    for (const base of [
      'https://user:pw@api.example',
      'https://api.example?x=1',
      'https://api.example#frag',
    ]) {
      expect(() => resolvePublicMediaPath(base, capability)).toThrow(AuthRequestError);
    }
  });
});

describe('archive client response validation', () => {
  const films = (list: unknown[]) => ({
    archive: { films: list, clips: [] },
    pagination: { filmCursor: null, clipCursor: null, hasMoreFilms: false, hasMoreClips: false },
  });
  const path = (seed: string) => `/media/access/${seed.repeat(43).slice(0, 43)}`;
  const archive = (request: jest.Mock) =>
    createRealAccountArchiveClient('https://api.example', request);

  it('surfaces HTTP errors from the archive endpoint with their status', async () => {
    for (const status of [401, 403, 429, 500]) {
      await expect(
        archive(jest.fn().mockResolvedValue(reply(status, {}))).getArchivePage('g'),
      ).rejects.toMatchObject({ status });
    }
  });

  it.each([
    ['a non-object body', null],
    ['no archive', { pagination: {} }],
    [
      'non-array films',
      {
        archive: { films: {}, clips: [] },
        pagination: { hasMoreFilms: false, hasMoreClips: false },
      },
    ],
    [
      'non-boolean pagination flags',
      {
        archive: { films: [], clips: [] },
        pagination: { hasMoreFilms: 'no', hasMoreClips: false },
      },
    ],
    ['a film without a download path', films([{ id: 'f', cycleId: 'c', publishedAt: 'now' }])],
    ['a film with no id', films([{ cycleId: 'c', publishedAt: 'now', downloadPath: path('a') }])],
    ['a non-object film', films(['film'])],
  ])('rejects an archive page with %s', async (_label, body) => {
    await expect(
      archive(jest.fn().mockResolvedValue(reply(200, body))).getArchivePage('g'),
    ).rejects.toMatchObject({ status: 502, reason: 'response' });
  });

  it('rejects a clip missing its contribution id or download path', async () => {
    const clipPage = (clip: unknown) => ({
      archive: { films: [], clips: [clip] },
      pagination: { hasMoreFilms: false, hasMoreClips: false },
    });
    const base = { id: 'c1', cycleId: 'cy', createdAt: 'now', downloadPath: path('a') };

    for (const clip of [base, { ...base, contributionId: 'k', downloadPath: undefined }]) {
      await expect(
        archive(jest.fn().mockResolvedValue(reply(200, clipPage(clip)))).getArchivePage('g'),
      ).rejects.toMatchObject({ status: 502 });
    }
  });

  it('maps clips and passes cursors and the page limit to the server', async () => {
    const request = jest.fn().mockResolvedValue(
      reply(200, {
        archive: {
          films: [],
          clips: [
            {
              id: 'c1',
              contributionId: 'k1',
              cycleId: 'cy',
              createdAt: 'now',
              downloadPath: path('a'),
              playbackPath: null,
            },
          ],
        },
        pagination: { filmCursor: 5, clipCursor: 'next', hasMoreFilms: false, hasMoreClips: true },
      }),
    );

    const result = await archive(request).getArchivePage('g', {
      filmCursor: 'f1',
      clipCursor: 'c0',
      limit: 10,
    });

    expect(request).toHaveBeenCalledWith('/archive?groupId=g&limit=10&filmCursor=f1&clipCursor=c0');
    expect(result.archive.clips[0]).toMatchObject({ playbackUrl: null });
    expect(result.pagination).toEqual({
      filmCursor: null,
      clipCursor: 'next',
      hasMoreFilms: false,
      hasMoreClips: true,
    });
  });

  it('keeps well-formed film segments and drops malformed ones', async () => {
    const segment = { contributionId: 'k', startSeconds: 0, durationSeconds: 2 };
    const film = { id: 'f', cycleId: 'c', publishedAt: 'now', downloadPath: path('a') };
    const request = jest
      .fn()
      .mockResolvedValueOnce(reply(200, films([{ ...film, segments: [segment] }])))
      .mockResolvedValueOnce(
        reply(200, films([{ ...film, segments: [{ ...segment, durationSeconds: 0 }] }])),
      );

    const good = await archive(request).getArchivePage('g');
    const bad = await archive(request).getArchivePage('g');

    expect(good.archive.films[0].segments).toEqual([{ ...segment, hidden: false, mine: false }]);
    expect(bad.archive.films[0]).not.toHaveProperty('segments');
  });

  describe('getPremiere', () => {
    it('treats a missing premiere as locked', async () => {
      await expect(
        archive(jest.fn().mockResolvedValue(reply(404, {}))).getPremiere('g', 'cy'),
      ).resolves.toEqual({ state: 'locked', cycleId: 'cy' });
    });

    it('surfaces other HTTP errors', async () => {
      await expect(
        archive(jest.fn().mockResolvedValue(reply(500, {}))).getPremiere('g', 'cy'),
      ).rejects.toMatchObject({ status: 500, reason: 'response' });
    });

    it.each(['processing', 'delayed', 'locked', 'failed'] as const)(
      'maps the %s state and prefers the response cycle id',
      async (state) => {
        const request = jest
          .fn()
          .mockResolvedValue(reply(200, { release: { state, cycleId: 'server-cycle' } }));

        await expect(archive(request).getPremiere('g', 'asked')).resolves.toEqual({
          state,
          cycleId: 'server-cycle',
        });
      },
    );

    it('reads a bare body and falls back to the requested cycle id', async () => {
      await expect(
        archive(jest.fn().mockResolvedValue(reply(200, { state: 'processing' }))).getPremiere(
          'g',
          'asked',
        ),
      ).resolves.toEqual({ state: 'processing', cycleId: 'asked' });
    });

    it('rejects an unknown state', async () => {
      await expect(
        archive(
          jest.fn().mockResolvedValue(reply(200, { premiere: { state: 'weird' } })),
        ).getPremiere('g', 'cy'),
      ).rejects.toMatchObject({ status: 502 });
    });

    it('rejects a ready premiere without a film id or playback capability', async () => {
      await expect(
        archive(
          jest
            .fn()
            .mockResolvedValue(
              reply(200, { premiere: { state: 'ready', playbackPath: path('a') } }),
            ),
        ).getPremiere('g', 'cy'),
      ).rejects.toMatchObject({ status: 502 });
      await expect(
        archive(
          jest.fn().mockResolvedValue(reply(200, { premiere: { state: 'ready', filmId: 'f' } })),
        ).getPremiere('g', 'cy'),
      ).rejects.toMatchObject({ status: 502 });
    });

    it('resolves a ready premiere from nested film fields', async () => {
      const request = jest.fn().mockResolvedValue(
        reply(200, {
          premiere: { state: 'ready', film: { id: 'film-9', playbackPath: path('p') } },
        }),
      );

      await expect(archive(request).getPremiere('g', 'cy')).resolves.toEqual({
        state: 'ready',
        cycleId: 'cy',
        filmId: 'film-9',
        playbackUrl: `https://api.example${path('p')}`,
      });
    });
  });

  describe('getFreshArchiveMedia', () => {
    const clipEntry = (id: string, contributionId: string) => ({
      id,
      contributionId,
      cycleId: 'cy',
      createdAt: 'now',
      downloadPath: path('c'),
    });
    const clipsPage = (clips: unknown[], clipCursor: string | null) => ({
      archive: { films: [], clips },
      pagination: {
        filmCursor: null,
        clipCursor,
        hasMoreFilms: false,
        hasMoreClips: clipCursor !== null,
      },
    });

    it('walks pages until it finds the clip matching both id and contribution', async () => {
      const request = jest
        .fn()
        .mockResolvedValueOnce(reply(200, clipsPage([clipEntry('c1', 'other')], 'p2')))
        .mockResolvedValueOnce(reply(200, clipsPage([clipEntry('c1', 'k1')], null)));

      const found = await archive(request).getFreshArchiveMedia('g', {
        id: 'c1',
        contributionId: 'k1',
      });

      expect(found).toMatchObject({ id: 'c1', contributionId: 'k1' });
      expect(request.mock.calls[1][0]).toContain('clipCursor=p2');
    });

    it('finds a film by id', async () => {
      const request = jest
        .fn()
        .mockResolvedValue(
          reply(
            200,
            films([{ id: 'f1', cycleId: 'c', publishedAt: 'now', downloadPath: path('a') }]),
          ),
        );

      await expect(archive(request).getFreshArchiveMedia('g', { id: 'f1' })).resolves.toMatchObject(
        { id: 'f1' },
      );
    });

    it('throws a 404 when the media is gone', async () => {
      const request = jest.fn().mockResolvedValue(reply(200, clipsPage([], null)));

      await expect(
        archive(request).getFreshArchiveMedia('g', { id: 'gone', contributionId: 'k' }),
      ).rejects.toMatchObject({ status: 404, reason: 'response' });
    });

    it('stops when the server repeats a cursor instead of looping forever', async () => {
      const request = jest.fn().mockResolvedValue(reply(200, clipsPage([], 'same')));

      await expect(
        archive(request).getFreshArchiveMedia('g', { id: 'x', contributionId: 'k' }),
      ).rejects.toMatchObject({ status: 404 });
      expect(request.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('propagates an authorization failure while paging', async () => {
      const request = jest.fn().mockResolvedValue(reply(403, {}));

      await expect(
        archive(request).getFreshArchiveMedia('g', { id: 'x', contributionId: 'k' }),
      ).rejects.toMatchObject({ status: 403 });
    });
  });
});
