import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { parseFilmSegments, type FilmSegment, type Premiere } from '../domain/premiere';

export interface RealAccount {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export type SignInMethod = 'cognito' | 'password';

export interface RealAccountSession {
  account: RealAccount;
  idleExpiresAt: string;
  absoluteExpiresAt?: string;
  /** How this session was opened; an absent value means a password sign-in. */
  signInMethod?: SignInMethod;
}

/** Which sign-in options the server offers (`GET /auth/config`). */
export interface AuthConfig {
  passwordSignIn: boolean;
  cognito: boolean;
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = { passwordSignIn: true, cognito: false };

function parseSignInMethod(value: unknown): { signInMethod?: SignInMethod } {
  return value === 'cognito' || value === 'password' ? { signInMethod: value } : {};
}

export type AuthState = 'loading' | 'entry' | 'active' | 'error';
export type RegistrationOutcome =
  | 'created'
  | 'invalid'
  | 'invalid-username'
  | 'invalid-password'
  | 'duplicate'
  | 'rate-limited'
  | 'unavailable';

/**
 * The server answers every rejected registration with one generic 400, so
 * name the failing field from the same rules (server/src/auth/index.ts).
 */
export function invalidRegistrationOutcome(
  username: string,
  password: string,
): 'invalid' | 'invalid-username' | 'invalid-password' {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(username.trim())) return 'invalid-username';
  if (password.length < 12 || password.length > 1024) return 'invalid-password';
  return 'invalid';
}
export type AuthNotice =
  | 'expired'
  | 'revoked'
  | 'offline'
  | 'sign-in-failed'
  | 'sign-in-throttled'
  | 'unavailable'
  | 'revocation-unconfirmed'
  | 'local-credential-removal-failed'
  | 'sign-out-incomplete'
  | 'sign-out-recovery-pending'
  | 'sign-out-marker-cleanup-failed'
  | 'sign-out-marker-unavailable'
  | 'deleted'
  | 'cognito-failed'
  | 'cognito-denied'
  | null;

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

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

// Dev builds only (`make run-real`): a same-origin plain-HTTP loopback API is
// accepted because the local server allows HTTP auth only from loopback.
function isLocalDevAuthUrl(url: URL, devBuild: boolean): boolean {
  return devBuild && url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname);
}

export function isSecureAuthUrl(baseUrl: string, devBuild = __DEV__): boolean {
  try {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const url = new URL(baseUrl, window.location.href);
      if (url.origin !== window.location.origin) return false;
      return url.protocol === 'https:' || isLocalDevAuthUrl(url, devBuild);
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

/** Read throttling feedback only when a UI consumer is rejecting the response. */
export async function rateLimitMessage(response: Response, fallback: string): Promise<string> {
  if (response.status !== 429) return fallback;
  const body = await readJson(response);
  return typeof body.message === 'string' && body.message.trim() ? body.message : fallback;
}

export class RealAccountClient {
  private activeToken: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly tokenStore: TokenStore = secureTokenStore,
    fetcher: typeof fetch = globalThis.fetch,
  ) {
    // Browser fetch requires the global object as its receiver. Store a bound
    // function because requests invoke this.fetcher from the client instance.
    this.fetcher = fetcher.bind(globalThis);
  }

  canConnectSecurely(): boolean {
    return isSecureAuthUrl(this.baseUrl);
  }

  async register(username: string, password: string): Promise<RealAccount> {
    this.assertSecureTransport();
    const response = await this.fetcher(
      authUrl(this.baseUrl, '/auth/register'),
      requestOptions({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }),
    );
    if (!response.ok) throw new AuthRequestError(response.status, 'registration');
    const body = await readJson(response);
    if (!isRealAccount(body.account)) throw new AuthRequestError(502, 'response');
    return body.account;
  }

  async login(
    username: string,
    password: string,
  ): Promise<{
    account: RealAccount;
    token?: string;
    expiresAt: string;
    absoluteExpiresAt?: string;
    signInMethod?: SignInMethod;
  }> {
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
    return {
      account: body.account,
      expiresAt: body.expiresAt,
      ...(typeof body.absoluteExpiresAt === 'string'
        ? { absoluteExpiresAt: body.absoluteExpiresAt }
        : {}),
      ...parseSignInMethod(body.signInMethod),
      ...(token ? { token } : {}),
    };
  }

  /** Public sign-in options; the caller treats any failure as "password only". */
  async fetchAuthConfig(): Promise<AuthConfig> {
    this.assertSecureTransport();
    const response = await this.fetcher(
      authUrl(this.baseUrl, '/auth/config'),
      requestOptions({ method: 'GET' }),
    );
    if (!response.ok) throw new AuthRequestError(response.status, 'response');
    const body = await readJson(response);
    if (typeof body.passwordSignIn !== 'boolean' || typeof body.cognito !== 'boolean') {
      throw new AuthRequestError(502, 'response');
    }
    return { passwordSignIn: body.passwordSignIn, cognito: body.cognito };
  }

  /** Full-page URL that starts the server-side Cognito sign-in and returns to `returnTo`. */
  cognitoStartUrl(returnTo: string): string {
    return authUrl(this.baseUrl, `/auth/cognito/start?return=${encodeURIComponent(returnTo)}`);
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
    if (response.status === 401) {
      const body = await readJson(response);
      if (Platform.OS === 'web' && body.error === 'session_required') return null;
      throw new AuthRequestError(401, 'expired');
    }
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
      ...parseSignInMethod(body.signInMethod),
    };
  }

  /** Returns the identity provider's sign-out URL when the session came from one. */
  async logout(token?: string): Promise<string | undefined> {
    this.assertSecureTransport();
    const credential =
      Platform.OS === 'web'
        ? undefined
        : (token ?? this.activeToken ?? (await this.tokenStore.read()) ?? undefined);
    if (Platform.OS !== 'web' && !credential) throw new AuthRequestError(0, 'logout');
    const response = await this.fetcher(
      authUrl(this.baseUrl, '/auth/logout'),
      requestOptions({ method: 'POST' }, credential),
    );
    if (!response.ok) throw new AuthRequestError(response.status, 'logout');
    const body = await readJson(response);
    if (body.signedOut !== true) throw new AuthRequestError(502, 'logout');
    this.activeToken = undefined;
    return typeof body.logoutUrl === 'string' && body.logoutUrl ? body.logoutUrl : undefined;
  }

  async clearStoredToken(): Promise<void> {
    if (Platform.OS === 'web') return;
    await this.tokenStore.clear();
    this.activeToken = undefined;
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
        [
          'token',
          'session',
          'sessionid',
          'appsession',
          'app_session',
          'session_token',
          'authorization',
          'access_token',
        ].includes(key.toLowerCase()),
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

  realtimeAuthorizationHeader(token?: string): string | undefined {
    const credential = token ?? this.activeToken;
    return Platform.OS !== 'web' && credential ? `Bearer ${credential}` : undefined;
  }

  private assertSecureTransport(): void {
    if (!this.canConnectSecurely()) throw new AuthRequestError(0, 'insecure-transport');
  }
}

export function isRealAccount(value: unknown): value is RealAccount {
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
      | 'registration'
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

export interface RealArchiveFilm {
  id: string;
  cycleId: string;
  publishedAt: string;
  downloadUrl: string;
  playbackUrl: string | null;
  segments?: FilmSegment[];
}

export interface RealArchiveClip {
  id: string;
  contributionId: string;
  cycleId: string;
  createdAt: string;
  downloadUrl: string;
  playbackUrl: string | null;
}

export interface RealArchivePage {
  archive: { films: RealArchiveFilm[]; clips: RealArchiveClip[] };
  pagination: {
    filmCursor: string | null;
    clipCursor: string | null;
    hasMoreFilms: boolean;
    hasMoreClips: boolean;
  };
}

export interface RealArchivePageRequest {
  filmCursor?: string | null;
  clipCursor?: string | null;
  limit?: number;
}

export interface RealAccountArchiveClient {
  getArchivePage(groupId: string, page?: RealArchivePageRequest): Promise<RealArchivePage>;
  getPremiere(groupId: string, cycleId: string): Promise<Premiere>;
  getFreshArchiveMedia(
    groupId: string,
    media: Pick<RealArchiveFilm, 'id'> | Pick<RealArchiveClip, 'id' | 'contributionId'>,
  ): Promise<RealArchiveFilm | RealArchiveClip>;
}

/** Resolve a server-issued capability at the configured public API origin. */
export function resolvePublicMediaPath(
  baseUrl: string,
  capabilityPath: string,
  devBuild = __DEV__,
): string {
  let base: URL;
  let capability: URL;
  let target: URL;
  try {
    base = new URL(baseUrl, typeof window !== 'undefined' ? window.location?.href : undefined);
    capability = new URL(capabilityPath, 'https://rewind-capability.invalid');
    const basePath = base.pathname.replace(/\/+$/, '');
    target = new URL(`${basePath}${capabilityPath}`, base.origin);
  } catch {
    throw new AuthRequestError(502, 'response');
  }

  const secureOrLocalDev = (url: URL) =>
    url.protocol === 'https:' || isLocalDevAuthUrl(url, devBuild);
  if (
    !secureOrLocalDev(base) ||
    base.username.length > 0 ||
    base.password.length > 0 ||
    base.search.length > 0 ||
    base.hash.length > 0 ||
    capability.origin !== 'https://rewind-capability.invalid' ||
    capability.pathname !== capabilityPath ||
    capability.search.length > 0 ||
    capability.hash.length > 0 ||
    !/^\/media\/access\/[A-Za-z0-9_-]{43}$/.test(capability.pathname) ||
    target.origin !== base.origin ||
    !secureOrLocalDev(target) ||
    target.search.length > 0 ||
    target.hash.length > 0
  ) {
    throw new AuthRequestError(502, 'response');
  }
  return target.toString();
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalCapabilityUrl(baseUrl: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const path = requiredString(value);
  return path ? resolvePublicMediaPath(baseUrl, path) : null;
}

function mapRealArchivePage(baseUrl: string, value: unknown): RealArchivePage {
  const body = recordValue(value);
  const archive = recordValue(body?.archive);
  const pagination = recordValue(body?.pagination);
  if (
    !archive ||
    !pagination ||
    !Array.isArray(archive.films) ||
    !Array.isArray(archive.clips) ||
    typeof pagination.hasMoreFilms !== 'boolean' ||
    typeof pagination.hasMoreClips !== 'boolean'
  ) {
    throw new AuthRequestError(502, 'response');
  }

  const mapFilm = (value: unknown): RealArchiveFilm => {
    const film = recordValue(value);
    const id = requiredString(film?.id);
    const cycleId = requiredString(film?.cycleId);
    const publishedAt = requiredString(film?.publishedAt);
    const downloadUrl = optionalCapabilityUrl(baseUrl, film?.downloadPath);
    if (!id || !cycleId || !publishedAt || !downloadUrl) {
      throw new AuthRequestError(502, 'response');
    }
    const segments = parseFilmSegments(film?.segments);
    return {
      id,
      cycleId,
      publishedAt,
      downloadUrl,
      playbackUrl: optionalCapabilityUrl(baseUrl, film?.playbackPath),
      ...(segments ? { segments } : {}),
    };
  };
  const mapClip = (value: unknown): RealArchiveClip => {
    const clip = recordValue(value);
    const id = requiredString(clip?.id);
    const contributionId = requiredString(clip?.contributionId);
    const cycleId = requiredString(clip?.cycleId);
    const createdAt = requiredString(clip?.createdAt);
    const downloadUrl = optionalCapabilityUrl(baseUrl, clip?.downloadPath);
    if (!id || !contributionId || !cycleId || !createdAt || !downloadUrl) {
      throw new AuthRequestError(502, 'response');
    }
    return {
      id,
      contributionId,
      cycleId,
      createdAt,
      downloadUrl,
      playbackUrl: optionalCapabilityUrl(baseUrl, clip?.playbackPath),
    };
  };

  return {
    archive: {
      films: archive.films.map(mapFilm),
      clips: archive.clips.map(mapClip),
    },
    pagination: {
      filmCursor: typeof pagination.filmCursor === 'string' ? pagination.filmCursor : null,
      clipCursor: typeof pagination.clipCursor === 'string' ? pagination.clipCursor : null,
      hasMoreFilms: pagination.hasMoreFilms,
      hasMoreClips: pagination.hasMoreClips,
    },
  };
}

function mapRealPremiere(baseUrl: string, value: unknown, cycleId: string): Premiere {
  const body = recordValue(value);
  const metadata = recordValue(body?.premiere) ?? recordValue(body?.release) ?? body;
  const film = recordValue(metadata?.film);
  const state = metadata?.state;
  const responseCycleId = requiredString(metadata?.cycleId) ?? cycleId;
  if (state === 'processing' || state === 'delayed' || state === 'locked' || state === 'failed') {
    return { state, cycleId: responseCycleId };
  }
  if (state === 'ready') {
    const filmId =
      requiredString(metadata?.filmId) ?? requiredString(film?.id) ?? requiredString(metadata?.id);
    const playbackUrl = optionalCapabilityUrl(
      baseUrl,
      metadata?.playbackPath ?? film?.playbackPath,
    );
    if (!filmId || !playbackUrl) throw new AuthRequestError(502, 'response');
    const segments = parseFilmSegments(metadata?.segments);
    return {
      state: 'ready',
      cycleId: responseCycleId,
      filmId,
      playbackUrl,
      ...(segments ? { segments } : {}),
    };
  }
  throw new AuthRequestError(502, 'response');
}

export function createRealAccountArchiveClient(
  baseUrl: string,
  authenticatedRequest: (path: string, init?: RequestInit) => Promise<Response>,
): RealAccountArchiveClient {
  const getArchivePage = async (
    groupId: string,
    page: RealArchivePageRequest = {},
  ): Promise<RealArchivePage> => {
    const query = new URLSearchParams({ groupId, limit: String(page.limit ?? 50) });
    if (page.filmCursor) query.set('filmCursor', page.filmCursor);
    if (page.clipCursor) query.set('clipCursor', page.clipCursor);
    const response = await authenticatedRequest(`/archive?${query.toString()}`);
    if (!response.ok) throw new AuthRequestError(response.status, 'response');
    return mapRealArchivePage(baseUrl, await readJson(response));
  };
  const getPremiere = async (groupId: string, cycleId: string): Promise<Premiere> => {
    const response = await authenticatedRequest(
      `/cycles/${encodeURIComponent(cycleId)}/premiere?groupId=${encodeURIComponent(groupId)}`,
    );
    if (response.status === 404) return { state: 'locked', cycleId };
    if (!response.ok) throw new AuthRequestError(response.status, 'response');
    return mapRealPremiere(baseUrl, await readJson(response), cycleId);
  };

  return {
    getArchivePage,
    getPremiere,
    async getFreshArchiveMedia(groupId, targetMedia) {
      let filmCursor: string | null = null;
      let clipCursor: string | null = null;
      const seenCursors = new Set<string>();
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const cursorKey = `${filmCursor ?? ''}\u0000${clipCursor ?? ''}`;
        if (seenCursors.has(cursorKey)) break;
        seenCursors.add(cursorKey);
        const page = await getArchivePage(groupId, { filmCursor, clipCursor, limit: 50 });
        const match =
          'contributionId' in targetMedia
            ? page.archive.clips.find(
                (clip) =>
                  clip.id === targetMedia.id && clip.contributionId === targetMedia.contributionId,
              )
            : page.archive.films.find((film) => film.id === targetMedia.id);
        if (match) return match;
        if (!page.pagination.hasMoreFilms && !page.pagination.hasMoreClips) break;
        const nextFilmCursor = page.pagination.hasMoreFilms ? page.pagination.filmCursor : null;
        const nextClipCursor = page.pagination.hasMoreClips ? page.pagination.clipCursor : null;
        if (nextFilmCursor === filmCursor && nextClipCursor === clipCursor) break;
        filmCursor = nextFilmCursor;
        clipCursor = nextClipCursor;
      }
      throw new AuthRequestError(404, 'response');
    },
  };
}
