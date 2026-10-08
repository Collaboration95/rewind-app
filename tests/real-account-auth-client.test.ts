import { Platform } from 'react-native';

import {
  AuthRequestError,
  RealAccountClient,
  isSecureAuthUrl,
  type TokenStore,
} from '../src/auth/real-account-client';

const account = {
  id: 'account-1',
  username: 'pilot.user',
  displayName: 'Pilot User',
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
};
const token = 'a'.repeat(43);
const expiresAt = '2026-09-28T12:00:00.000Z';
let storedToken: string | null;
const tokenStore: TokenStore = {
  read: async () => storedToken,
  write: async (value) => {
    storedToken = value;
  },
  clear: async () => {
    storedToken = null;
  },
};
const originalPlatformOS = Platform.OS;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function setPlatform(os: string) {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os, writable: true });
}

beforeEach(() => {
  storedToken = null;
  setPlatform('ios');
});

afterEach(() => {
  setPlatform(originalPlatformOS);
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: unknown }).window;
});

describe('real-account client transport and storage', () => {
  it('refuses password and session requests over plaintext HTTP before fetch', async () => {
    const fetcher = jest.fn();
    const client = new RealAccountClient('http://api.rewind.example', tokenStore, fetcher);

    await expect(client.login('pilot.user', 'not-a-real-password')).rejects.toMatchObject({
      reason: 'insecure-transport',
    });
    await expect(client.register('new.user', 'not-a-real-password')).rejects.toMatchObject({
      reason: 'insecure-transport',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(isSecureAuthUrl('http://api.rewind.example')).toBe(false);
  });

  it('registers over same-origin HTTPS without retaining password or session credentials', async () => {
    setPlatform('web');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          href: 'https://rewind.example/',
          origin: 'https://rewind.example',
        },
      },
      writable: true,
    });
    const fetcher = jest.fn().mockResolvedValue(response(201, { account }));
    const client = new RealAccountClient('https://rewind.example', tokenStore, fetcher);

    await expect(client.register('new.user', 'long correct password')).resolves.toEqual(account);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://rewind.example/auth/register');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.body).toBe(
      JSON.stringify({ username: 'new.user', password: 'long correct password' }),
    );
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(storedToken).toBeNull();
  });

  it('accepts same-origin plain-HTTP loopback auth only in dev builds', () => {
    setPlatform('web');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { href: 'http://localhost:8090/', origin: 'http://localhost:8090' } },
      writable: true,
    });
    expect(isSecureAuthUrl('/api', true)).toBe(true);
    expect(isSecureAuthUrl('/api', false)).toBe(false);
    expect(isSecureAuthUrl('http://127.0.0.1:8787', true)).toBe(false);

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { href: 'http://rewind.example/', origin: 'http://rewind.example' } },
      writable: true,
    });
    expect(isSecureAuthUrl('/api', true)).toBe(false);
  });

  it('preserves a safe registration error status for accessible form feedback', async () => {
    const fetcher = jest.fn().mockResolvedValue(response(409, { error: 'username_unavailable' }));
    const client = new RealAccountClient('https://api.rewind.example', tokenStore, fetcher);

    await expect(client.register('new.user', 'long correct password')).rejects.toMatchObject({
      status: 409,
      reason: 'registration',
    });
    expect(storedToken).toBeNull();
  });

  it('returns only a generic sign-in failure for a rejected username/password', async () => {
    const fetcher = jest.fn().mockResolvedValue(response(401, { error: 'sign_in_failed' }));
    const client = new RealAccountClient('https://api.rewind.example', tokenStore, fetcher);

    await expect(client.login('pilot.user', 'wrong-password')).rejects.toMatchObject({
      status: 401,
      reason: 'sign-in',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(storedToken).toBeNull();
  });

  it('stores the native opaque token in the secure store and sends it only as a bearer header', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(response(200, { account, token, expiresAt }))
      .mockResolvedValueOnce(
        response(200, {
          account,
          idleExpiresAt: expiresAt,
          absoluteExpiresAt: '2026-10-28T00:00:00.000Z',
        }),
      )
      .mockResolvedValueOnce(response(200, { signedOut: true }));
    const client = new RealAccountClient('https://api.rewind.example', tokenStore, fetcher);

    await expect(client.login('pilot.user', 'secret input')).resolves.toMatchObject({
      account,
      token,
    });
    expect(storedToken).toBe(token);
    const loginInit = fetcher.mock.calls[0][1] as RequestInit;
    expect(loginInit.credentials).toBe('omit');
    expect(loginInit.body).toBe(
      JSON.stringify({ username: 'pilot.user', password: 'secret input', clientType: 'native' }),
    );
    await expect(client.restore()).resolves.toMatchObject({ account, idleExpiresAt: expiresAt });
    const sessionUrl = String(fetcher.mock.calls[1][0]);
    const sessionInit = fetcher.mock.calls[1][1] as RequestInit;
    expect(sessionUrl).not.toContain(token);
    expect(new Headers(sessionInit.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(sessionInit.credentials).toBe('omit');
    await client.logout(token);
    expect(
      new Headers((fetcher.mock.calls[2][1] as RequestInit).headers).get('Authorization'),
    ).toBe(`Bearer ${token}`);
    expect(storedToken).toBe(token);
    await client.clearStoredToken();
    expect(storedToken).toBeNull();
  });

  it('restores a native token after restart and clears it when the server reports expiry or reset', async () => {
    storedToken = token;
    const fetcher = jest.fn().mockResolvedValue(response(401, { error: 'session_required' }));
    const client = new RealAccountClient('https://api.rewind.example', tokenStore, fetcher);

    await expect(client.restore()).rejects.toBeInstanceOf(AuthRequestError);
    expect(
      new Headers((fetcher.mock.calls[0][1] as RequestInit).headers).get('Authorization'),
    ).toBe(`Bearer ${token}`);
    await client.logout(token).catch(() => undefined);
    await client.clearStoredToken();
    expect(storedToken).toBeNull();
  });

  it('treats a missing browser session as signed out instead of expired', async () => {
    setPlatform('web');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          href: 'https://rewind.example/',
          origin: 'https://rewind.example',
        },
      },
      writable: true,
    });
    const fetcher = jest.fn().mockResolvedValue(response(401, { error: 'session_required' }));
    const client = new RealAccountClient('https://rewind.example', tokenStore, fetcher);

    await expect(client.restore()).resolves.toBeNull();
  });

  it('reuses a restored native token for successful logout after app restart', async () => {
    storedToken = token;
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          account,
          idleExpiresAt: expiresAt,
          absoluteExpiresAt: '2026-10-28T00:00:00.000Z',
        }),
      )
      .mockResolvedValueOnce(response(200, { signedOut: true }));
    const client = new RealAccountClient('https://api.rewind.example', tokenStore, fetcher);

    await client.restore();
    await client.logout();
    expect(
      new Headers((fetcher.mock.calls[1][1] as RequestInit).headers).get('Authorization'),
    ).toBe(`Bearer ${token}`);
    expect(storedToken).toBe(token);
    await client.clearStoredToken();
    expect(storedToken).toBeNull();
  });

  it('uses same-origin browser cookies and never reads or stores a JavaScript token', async () => {
    setPlatform('web');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          href: 'https://rewind.example/',
          origin: 'https://rewind.example',
        },
      },
      writable: true,
    });
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(response(200, { account, expiresAt }))
      .mockResolvedValueOnce(
        response(200, {
          account,
          idleExpiresAt: expiresAt,
          absoluteExpiresAt: '2026-10-28T00:00:00.000Z',
        }),
      )
      .mockResolvedValueOnce(response(200, {}))
      .mockResolvedValueOnce(response(200, { signedOut: true }));
    const client = new RealAccountClient('https://rewind.example', tokenStore, fetcher);

    await client.login('pilot.user', 'secret input');
    await client.restore();
    expect(storedToken).toBeNull();
    for (const [, init] of fetcher.mock.calls as [string, RequestInit][]) {
      expect(init.credentials).toBe('include');
      expect(new Headers(init.headers).has('Authorization')).toBe(false);
    }
    expect(isSecureAuthUrl('https://api.other-origin.example')).toBe(false);
    expect(isSecureAuthUrl('/api')).toBe(true);

    const sameOriginApiClient = new RealAccountClient('/api', tokenStore, fetcher);
    await sameOriginApiClient.request('/groups', {}, token);
    expect(fetcher.mock.calls[2][0]).toBe('https://rewind.example/api/groups');
    expect((fetcher.mock.calls[2][1] as RequestInit).credentials).toBe('include');
    expect(
      new Headers((fetcher.mock.calls[2][1] as RequestInit).headers).has('Authorization'),
    ).toBe(false);
    await client.logout();
    expect(fetcher.mock.calls[3][0]).toBe('https://rewind.example/auth/logout');
    expect((fetcher.mock.calls[3][1] as RequestInit).credentials).toBe('include');
  });

  it('rejects non-2xx and success-shaped-but-unconfirmed logout responses', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(response(503, { signedOut: false }))
      .mockResolvedValueOnce(response(200, { signedOut: false }));
    const client = new RealAccountClient('https://api.rewind.example', tokenStore, fetcher);

    await expect(client.logout(token)).rejects.toMatchObject({ status: 503, reason: 'logout' });
    await expect(client.logout(token)).rejects.toMatchObject({ status: 502, reason: 'logout' });
    expect(
      new Headers((fetcher.mock.calls[0][1] as RequestInit).headers).get('Authorization'),
    ).toBe(`Bearer ${token}`);
  });

  it('rejects native logout without a credential before accepting a tokenless success response', async () => {
    const fetcher = jest.fn().mockResolvedValue(response(200, { signedOut: true }));
    const client = new RealAccountClient('https://api.rewind.example', tokenStore, fetcher);

    await expect(client.logout()).rejects.toMatchObject({ status: 0, reason: 'logout' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(storedToken).toBeNull();
  });

  it('keeps server logout and local token deletion as separate operations when offline', async () => {
    storedToken = token;
    const fetcher = jest.fn().mockRejectedValue(new Error('offline'));
    const client = new RealAccountClient('https://api.rewind.example', tokenStore, fetcher);

    await expect(client.logout(token)).rejects.toThrow('offline');
    expect(storedToken).toBe(token);
    await client.clearStoredToken();
    expect(storedToken).toBeNull();
  });

  it('keeps remote revocation confirmed when SecureStore token deletion rejects', async () => {
    storedToken = token;
    const failingStore: TokenStore = {
      ...tokenStore,
      clear: async () => {
        throw new Error('SecureStore unavailable');
      },
    };
    const fetcher = jest.fn().mockResolvedValue(response(200, { signedOut: true }));
    const client = new RealAccountClient('https://api.rewind.example', failingStore, fetcher);

    await expect(client.logout(token)).resolves.toBeUndefined();
    expect(storedToken).toBe(token);
    await expect(client.clearStoredToken()).rejects.toThrow('SecureStore unavailable');
    expect(storedToken).toBe(token);
  });

  it('rejects auth tokens and session identifiers in protected request URLs', async () => {
    const fetcher = jest.fn();
    const client = new RealAccountClient('https://api.rewind.example', tokenStore, fetcher);

    await expect(client.request(`/groups?sessionId=${token}`, {}, token)).rejects.toMatchObject({
      reason: 'response',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Cognito support in the real-account client', () => {
  const webLocation = {
    configurable: true,
    value: { location: { href: 'https://rewind.example/', origin: 'https://rewind.example' } },
    writable: true,
  };

  it('reads the public sign-in options and rejects malformed answers', async () => {
    setPlatform('web');
    Object.defineProperty(globalThis, 'window', webLocation);
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(response(200, { passwordSignIn: false, cognito: true }))
      .mockResolvedValueOnce(response(200, { passwordSignIn: 'yes' }))
      .mockResolvedValueOnce(response(503, {}));
    const client = new RealAccountClient('https://rewind.example/api', tokenStore, fetcher);

    await expect(client.fetchAuthConfig()).resolves.toEqual({
      passwordSignIn: false,
      cognito: true,
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://rewind.example/api/auth/config',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
    await expect(client.fetchAuthConfig()).rejects.toMatchObject({ status: 502 });
    await expect(client.fetchAuthConfig()).rejects.toMatchObject({ status: 503 });
  });

  it('builds the server-side Cognito start URL with an encoded return path', () => {
    const client = new RealAccountClient('/api/', tokenStore, jest.fn());
    expect(client.cognitoStartUrl('/invite?groupId=g&code=AB12')).toBe(
      '/api/auth/cognito/start?return=%2Finvite%3FgroupId%3Dg%26code%3DAB12',
    );
  });

  it('carries signInMethod from the session and login, and ignores unknown values', async () => {
    setPlatform('web');
    Object.defineProperty(globalThis, 'window', webLocation);
    const session = { account, idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt };
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(response(200, { ...session, signInMethod: 'cognito' }))
      .mockResolvedValueOnce(response(200, session))
      .mockResolvedValueOnce(response(200, { ...session, signInMethod: 'saml' }))
      .mockResolvedValueOnce(response(200, { account, expiresAt, signInMethod: 'password' }));
    const client = new RealAccountClient('https://rewind.example', tokenStore, fetcher);

    await expect(client.restore()).resolves.toMatchObject({ signInMethod: 'cognito' });
    await expect(client.restore()).resolves.not.toHaveProperty('signInMethod');
    await expect(client.restore()).resolves.not.toHaveProperty('signInMethod');
    await expect(client.login('pilot.user', 'pw')).resolves.toMatchObject({
      signInMethod: 'password',
    });
  });

  it('returns the provider sign-out URL from logout when the server sends one', async () => {
    setPlatform('web');
    Object.defineProperty(globalThis, 'window', webLocation);
    const logoutUrl = 'https://auth.example.com/logout?client_id=abc';
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(response(200, { signedOut: true, logoutUrl }))
      .mockResolvedValueOnce(response(200, { signedOut: true }));
    const client = new RealAccountClient('https://rewind.example', tokenStore, fetcher);

    await expect(client.logout()).resolves.toBe(logoutUrl);
    await expect(client.logout()).resolves.toBeUndefined();
  });
});

test('account write limits return the unread response and keep the credential active', async () => {
  const token = 't'.repeat(43);
  storedToken = token;
  const limitedResponse = new Response(
    JSON.stringify({
      error: 'rate_limited',
      message: 'You have reached the group creation limit. Please try again later.',
    }),
    { status: 429, headers: { 'Content-Type': 'application/json' } },
  );
  const fetcher = jest.fn().mockResolvedValue(limitedResponse);
  const client = new RealAccountClient('https://api.rewind.example', tokenStore, fetcher);
  const result = await client.request('/real/groups', { method: 'POST' }, token);
  expect(result).toBe(limitedResponse);
  expect(result.status).toBe(429);
  expect(result.bodyUsed).toBe(false);
  await expect(result.json()).resolves.toEqual({
    error: 'rate_limited',
    message: 'You have reached the group creation limit. Please try again later.',
  });
  expect(storedToken).toBe(token);
});
