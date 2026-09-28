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
    expect(fetcher).not.toHaveBeenCalled();
    expect(isSecureAuthUrl('http://api.rewind.example')).toBe(false);
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
      .mockResolvedValueOnce(response(200, {}));
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
  });

  it('clears native secure storage after local sign-out even when the server is offline', async () => {
    storedToken = token;
    const fetcher = jest.fn().mockRejectedValue(new Error('offline'));
    const client = new RealAccountClient('https://api.rewind.example', tokenStore, fetcher);

    await expect(client.logout(token)).rejects.toThrow('offline');
    expect(storedToken).toBeNull();
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
