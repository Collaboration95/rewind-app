import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export interface RealAccount {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface RealAccountSession {
  account: RealAccount;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

export type AuthState = 'loading' | 'entry' | 'active' | 'error';
export type AuthNotice =
  'expired' | 'revoked' | 'offline' | 'sign-in-failed' | 'revocation-unconfirmed' | null;

const SECURE_SESSION_KEY = 'rewind.real-account.session-token';

export interface TokenStore {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

export const secureTokenStore: TokenStore = {
  read: () => SecureStore.getItemAsync(SECURE_SESSION_KEY),
  write: (token) => SecureStore.setItemAsync(SECURE_SESSION_KEY, token),
  clear: () => SecureStore.deleteItemAsync(SECURE_SESSION_KEY),
};

export function isSecureAuthUrl(baseUrl: string): boolean {
  try {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const url = new URL(baseUrl, window.location.href);
      return url.protocol === 'https:' && url.origin === window.location.origin;
    }
    return new URL(baseUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

function authUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function requestOptions(init: RequestInit, nativeToken?: string): RequestInit {
  const headers = new Headers(init.headers);
  if (Platform.OS !== 'web' && nativeToken) headers.set('Authorization', `Bearer ${nativeToken}`);
  return {
    ...init,
    headers,
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class RealAccountClient {
  private activeToken: string | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly tokenStore: TokenStore = secureTokenStore,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  canConnectSecurely(): boolean {
    return isSecureAuthUrl(this.baseUrl);
  }

  async login(
    username: string,
    password: string,
  ): Promise<{ account: RealAccount; token?: string; expiresAt: string }> {
    this.assertSecureTransport();
    const response = await this.fetcher(
      authUrl(this.baseUrl, '/auth/login'),
      requestOptions({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          clientType: Platform.OS === 'web' ? 'browser' : 'native',
        }),
      }),
    );
    if (!response.ok) throw new AuthRequestError(response.status, 'sign-in');
    const body = await readJson(response);
    if (!isRealAccount(body.account)) throw new AuthRequestError(502, 'response');
    let token: string | undefined;
    if (typeof body.expiresAt !== 'string') throw new AuthRequestError(502, 'response');
    if (Platform.OS !== 'web') {
      if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) {
        throw new AuthRequestError(502, 'response');
      }
      token = body.token;
      try {
        await this.tokenStore.write(token);
      } catch {
        await this.fetcher(
          authUrl(this.baseUrl, '/auth/logout'),
          requestOptions({ method: 'POST' }, token),
        ).catch(() => undefined);
        throw new AuthRequestError(0, 'secure-storage');
      }
      this.activeToken = token;
    }
    return { account: body.account, expiresAt: body.expiresAt, ...(token ? { token } : {}) };
  }

  async restore(): Promise<RealAccountSession | null> {
    this.assertSecureTransport();
    const token = Platform.OS === 'web' ? undefined : await this.tokenStore.read();
    if (Platform.OS !== 'web' && !token) return null;
    this.activeToken = token ?? undefined;
    const response = await this.fetcher(
      authUrl(this.baseUrl, '/auth/session'),
      requestOptions({ method: 'GET' }, token ?? undefined),
    );
    if (response.status === 401) throw new AuthRequestError(401, 'expired');
    if (!response.ok) throw new AuthRequestError(response.status, 'restore');
    const body = await readJson(response);
    if (
      !isRealAccount(body.account) ||
      typeof body.idleExpiresAt !== 'string' ||
      typeof body.absoluteExpiresAt !== 'string'
    ) {
      throw new AuthRequestError(502, 'response');
    }
    return {
      account: body.account,
      idleExpiresAt: body.idleExpiresAt,
      absoluteExpiresAt: body.absoluteExpiresAt,
    };
  }

  async logout(token?: string): Promise<void> {
    this.assertSecureTransport();
    try {
      const credential =
        Platform.OS === 'web'
          ? undefined
          : (token ?? this.activeToken ?? (await this.tokenStore.read()) ?? undefined);
      const response = await this.fetcher(
        authUrl(this.baseUrl, '/auth/logout'),
        requestOptions({ method: 'POST' }, credential),
      );
      if (!response.ok) throw new AuthRequestError(response.status, 'logout');
      const body = await readJson(response);
      if (body.signedOut !== true) throw new AuthRequestError(502, 'logout');
    } finally {
      this.activeToken = undefined;
      if (Platform.OS !== 'web') await this.tokenStore.clear();
    }
  }

  clearStoredToken(): Promise<void> {
    this.activeToken = undefined;
    return Platform.OS === 'web' ? Promise.resolve() : this.tokenStore.clear();
  }

  async request(path: string, init: RequestInit, token?: string): Promise<Response> {
    this.assertSecureTransport();
    const browserBase =
      Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.href : undefined;
    const base = new URL(this.baseUrl, browserBase);
    const target = new URL(authUrl(this.baseUrl, path), browserBase);
    if (
      !path.startsWith('/') ||
      target.origin !== base.origin ||
      (token !== undefined && target.href.includes(token)) ||
      [...target.searchParams.keys()].some((key) =>
        ['token', 'session', 'sessionid', 'authorization', 'access_token'].includes(
          key.toLowerCase(),
        ),
      )
    ) {
      throw new AuthRequestError(0, 'response');
    }
    const response = await this.fetcher(
      target.toString(),
      requestOptions(init, token ?? this.activeToken),
    );
    if (response.status === 401) throw new AuthRequestError(401, 'expired');
    return response;
  }

  private assertSecureTransport(): void {
    if (!this.canConnectSecurely()) throw new AuthRequestError(0, 'insecure-transport');
  }
}

function isRealAccount(value: unknown): value is RealAccount {
  if (!value || typeof value !== 'object') return false;
  const account = value as Record<string, unknown>;
  return (
    typeof account.id === 'string' &&
    typeof account.username === 'string' &&
    typeof account.displayName === 'string' &&
    typeof account.createdAt === 'string' &&
    typeof account.updatedAt === 'string'
  );
}

export class AuthRequestError extends Error {
  constructor(
    readonly status: number,
    readonly reason:
      | 'sign-in'
      | 'response'
      | 'restore'
      | 'expired'
      | 'insecure-transport'
      | 'secure-storage'
      | 'logout',
  ) {
    super(
      reason === 'expired'
        ? 'Your sign-in has expired or was reset.'
        : 'Authentication request failed.',
    );
    this.name = 'AuthRequestError';
  }
}
