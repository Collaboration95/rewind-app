import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { CognitoRuntimeConfig } from '../config';

/** Short-lived, HttpOnly cookie that carries state, nonce and PKCE verifier. */
export const OIDC_TRANSACTION_COOKIE = '__Host-rewind_oidc';
export const OIDC_TRANSACTION_MS = 10 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 10_000;
const MAX_USED_STATES = 10_000;

export interface CognitoIdentity {
  sub: string;
  nonce?: string;
  emailVerified: boolean;
}

export interface CognitoService {
  readonly config: CognitoRuntimeConfig;
  authorizeUrl(parameters: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  }): string;
  /** Swap the authorization code for an ID token and return it verified. */
  exchange(parameters: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<CognitoIdentity>;
  logoutUrl(origin: string): string;
  deleteUser(sub: string): Promise<void>;
}

export interface CognitoDependencies {
  fetch?: typeof fetch;
  /** Tests preload a JWKS with `cacheJwks`, so no network is needed. */
  verifier?: Pick<ReturnType<typeof createVerifier>, 'verify'>;
  deleteUser?: (sub: string) => Promise<void>;
}

function createVerifier(config: CognitoRuntimeConfig) {
  return CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    tokenUse: 'id',
    clientId: config.clientId,
  });
}

export function createCognitoService(
  config: CognitoRuntimeConfig,
  dependencies: CognitoDependencies = {},
): CognitoService {
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const verifier = dependencies.verifier ?? createVerifier(config);
  let client: CognitoIdentityProviderClient | null = null;
  return {
    config,
    authorizeUrl({ redirectUri, state, nonce, codeChallenge }) {
      const url = new URL(`https://${config.domain}/oauth2/authorize`);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },
    async exchange({ code, codeVerifier, redirectUri }) {
      const response = await fetcher(`https://${config.domain}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: config.clientId,
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        }).toString(),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Cognito token exchange failed (${response.status}).`);
      const body = (await response.json()) as { id_token?: unknown };
      if (typeof body.id_token !== 'string') throw new Error('Cognito returned no ID token.');
      // Signature, issuer, audience, token use and expiry are all checked here.
      const claims = (await verifier.verify(body.id_token)) as Record<string, unknown>;
      if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('ID token has no sub.');
      return {
        sub: claims.sub,
        nonce: typeof claims.nonce === 'string' ? claims.nonce : undefined,
        emailVerified: claims.email_verified !== false && claims.email_verified !== 'false',
      };
    },
    logoutUrl(origin) {
      const url = new URL(`https://${config.domain}/logout`);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        logout_uri: `${origin}/`,
      }).toString();
      return url.toString();
    },
    async deleteUser(sub) {
      if (dependencies.deleteUser) return dependencies.deleteUser(sub);
      client ??= new CognitoIdentityProviderClient({ region: config.region });
      try {
        await client.send(
          new AdminDeleteUserCommand({ UserPoolId: config.userPoolId, Username: sub }),
        );
      } catch (error) {
        // Already gone (for example a retry after a failed purge): that is the goal.
        if (!(error instanceof UserNotFoundException)) throw error;
      }
    },
  };
}

const services = new WeakMap<CognitoRuntimeConfig, CognitoService>();

/** The service for this runtime config; tests inject their own through options. */
export function cognitoServiceFor(
  config: { cognito?: CognitoRuntimeConfig | null },
  injected?: CognitoService,
): CognitoService | null {
  if (injected) return injected;
  if (!config.cognito) return null;
  let service = services.get(config.cognito);
  if (!service) {
    service = createCognitoService(config.cognito);
    services.set(config.cognito, service);
  }
  return service;
}

export interface LoginTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
  returnPath: string;
  expiresAt: number;
}

/** Only same-origin absolute paths (no scheme, no `//host`, no backslashes). */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || value.length > 2048 || !/^\/(?![/\\])[^\s\\]*$/.test(value)) return '/';
  return value;
}

export function newLoginTransaction(returnPath: string, now: Date): LoginTransaction {
  const codeVerifier = randomBytes(48).toString('base64url');
  return {
    state: randomBytes(24).toString('base64url'),
    nonce: randomBytes(24).toString('base64url'),
    codeVerifier,
    codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    returnPath: safeReturnPath(returnPath),
    expiresAt: now.getTime() + OIDC_TRANSACTION_MS,
  };
}

export function transactionCookieValue(transaction: LoginTransaction): string {
  const { state, nonce, codeVerifier, returnPath, expiresAt } = transaction;
  return Buffer.from(
    JSON.stringify({ state, nonce, codeVerifier, returnPath, expiresAt }),
  ).toString('base64url');
}

export function readLoginTransaction(
  cookieHeader: string | undefined,
  now: Date,
): LoginTransaction | null {
  const raw = cookieHeader
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${OIDC_TRANSACTION_COOKIE}=`))
    ?.slice(OIDC_TRANSACTION_COOKIE.length + 1);
  if (!raw || raw.length > 4096) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      typeof value.state !== 'string' ||
      typeof value.nonce !== 'string' ||
      typeof value.codeVerifier !== 'string' ||
      typeof value.returnPath !== 'string' ||
      typeof value.expiresAt !== 'number' ||
      value.expiresAt <= now.getTime()
    ) {
      return null;
    }
    return {
      state: value.state,
      nonce: value.nonce,
      codeVerifier: value.codeVerifier,
      codeChallenge: createHash('sha256').update(value.codeVerifier).digest('base64url'),
      returnPath: safeReturnPath(value.returnPath),
      expiresAt: value.expiresAt,
    };
  } catch {
    return null;
  }
}

export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Each `state` completes at most once. Authorization codes are single-use at
 * Cognito already; this stops a captured callback URL plus cookie from being
 * replayed against this server. Kept in memory: the server is a single process
 * and a restart only shortens the 10-minute window, which the cookie bounds.
 */
export class UsedStates {
  private readonly used = new Map<string, number>();

  /** True the first time a state is seen, false on every replay. */
  consume(state: string, now: number): boolean {
    for (const [key, expiresAt] of this.used) {
      if (expiresAt > now) break;
      this.used.delete(key);
    }
    if (this.used.has(state)) return false;
    // Map keeps insertion order, so the oldest entry is dropped first.
    if (this.used.size >= MAX_USED_STATES) this.used.delete(this.used.keys().next().value!);
    this.used.set(state, now + OIDC_TRANSACTION_MS);
    return true;
  }
}
