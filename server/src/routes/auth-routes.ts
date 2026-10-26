// /auth/* sign-in (password and Cognito), session and account routes.
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import {
  REAL_SESSION_COOKIE,
  authenticateRealAccount,
  cognitoSubForAccount,
  createRealAccount,
  createRealSession,
  findOrCreateCognitoAccount,
  revokeRealSession,
  updateAccountDisplayName,
  validateRealSession,
  verifyRealAccountPassword,
} from '../auth';
import {
  OIDC_TRANSACTION_COOKIE,
  cognitoServiceFor,
  newLoginTransaction,
  readLoginTransaction,
  sameSecret,
  transactionCookieValue,
  type UsedStates,
} from '../auth/cognito';
import { purgeRealAccount, removeStoredMedia } from '../auth/deletion';
import { type RuntimeConfig, mediaDir } from '../config';
import { type RewindDatabase } from '../db';

import { requestBody } from './body';
import { AuthRouteContext, Route, RuntimeServerOptions, findRoute } from './context';
import { RegistrationRateLimiter } from './limits';
import {
  authClientSource,
  authJson,
  authOriginIsAllowed,
  authToken,
  authTransportIsSecure,
  publicOrigin,
  redirectWithCookies,
} from './respond';

const CLEAR_SESSION_COOKIE = `${REAL_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;

function handleAuthConfig(ctx: AuthRouteContext): void {
  const { request, response, config, cognito, passwordSignIn } = ctx;
  authJson(request, response, config, 200, { passwordSignIn, cognito: Boolean(cognito) });
}

function handleCognitoStart(ctx: AuthRouteContext): void {
  const { request, response, config, url, now, cognito } = ctx;
  if (!cognito) {
    authJson(request, response, config, 404, {
      error: 'cognito_unavailable',
      message: 'Cognito sign-in is not configured.',
    });
    return;
  }
  const transaction = newLoginTransaction(url.searchParams.get('return') ?? '/', now);
  redirectWithCookies(
    response,
    cognito.authorizeUrl({
      redirectUri: `${publicOrigin(request, config)}/api/auth/callback`,
      state: transaction.state,
      nonce: transaction.nonce,
      codeChallenge: transaction.codeChallenge,
    }),
    [
      `${OIDC_TRANSACTION_COOKIE}=${transactionCookieValue(transaction)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    ],
  );
}

async function handleCognitoCallback(ctx: AuthRouteContext): Promise<void> {
  const { request, response, config, database, cognitoStates, url, now, cognito } = ctx;
  const clearTransaction = `${OIDC_TRANSACTION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  // A failure after the state matched returns to where sign-in started, so a
  // pending invitation link survives a cancelled or failed attempt.
  const fail = (code: string, returnPath = '/') => {
    const target = new URL(returnPath, 'http://rewind.local');
    target.searchParams.set('auth_error', code);
    redirectWithCookies(response, `${target.pathname}${target.search}`, [clearTransaction]);
  };
  const transaction = readLoginTransaction(request.headers.cookie, now);
  const state = url.searchParams.get('state') ?? '';
  // The state must match this browser's cookie and can finish only once.
  if (
    !cognito ||
    !transaction ||
    !sameSecret(state, transaction.state) ||
    !cognitoStates.consume(transaction.state, now.getTime())
  ) {
    fail('cognito');
    return;
  }
  const providerError = url.searchParams.get('error');
  if (providerError) {
    fail(providerError === 'access_denied' ? 'cognito_denied' : 'cognito', transaction.returnPath);
    return;
  }
  const code = url.searchParams.get('code') ?? '';
  if (!code || code.length > 2048) {
    fail('cognito', transaction.returnPath);
    return;
  }
  let sessionCookie: string;
  try {
    const identity = await cognito.exchange({
      code,
      codeVerifier: transaction.codeVerifier,
      redirectUri: `${publicOrigin(request, config)}/api/auth/callback`,
    });
    if (!identity.nonce || !sameSecret(identity.nonce, transaction.nonce)) {
      fail('cognito', transaction.returnPath);
      return;
    }
    if (!identity.emailVerified) {
      fail('cognito', transaction.returnPath);
      return;
    }
    const account = findOrCreateCognitoAccount(database, identity.sub, now);
    const created = createRealSession(database, account.id, now);
    const maxAge = Math.max(0, Math.floor((Date.parse(created.expiresAt) - now.getTime()) / 1000));
    sessionCookie = `${REAL_SESSION_COOKIE}=${created.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  } catch {
    fail('cognito', transaction.returnPath);
    return;
  }
  redirectWithCookies(response, transaction.returnPath, [clearTransaction, sessionCookie]);
}

async function handleProfile(ctx: AuthRouteContext): Promise<void> {
  const { request, response, config, database, now } = ctx;
  const token = authToken(request);
  const session = token ? validateRealSession(database, token, now) : null;
  if (session?.status !== 'valid') {
    authJson(request, response, config, 401, {
      error: 'session_required',
      message: 'A valid sign-in is required.',
    });
    return;
  }
  const body = await requestBody(request, config, 8 * 1024);
  const account = updateAccountDisplayName(
    database,
    session.account.id,
    typeof body?.displayName === 'string' ? body.displayName : '',
    now,
  );
  if (!account) {
    authJson(request, response, config, 400, {
      error: 'invalid_display_name',
      message: 'Enter a name of 1 to 80 characters.',
    });
    return;
  }
  authJson(request, response, config, 200, { account });
}

async function handleRegister(ctx: AuthRouteContext): Promise<void> {
  const { request, response, config, database, registrationRateLimiter, now } = ctx;
  const rateLimit = registrationRateLimiter.tryAcquire(
    authClientSource(request, config),
    now.getTime(),
  );
  if (!rateLimit.allowed) {
    authJson(
      request,
      response,
      config,
      429,
      {
        error: 'registration_rate_limited',
        message: 'Registration is temporarily unavailable. Please try again later.',
      },
      { 'Retry-After': String(rateLimit.retryAfter) },
    );
    return;
  }
  const body = await requestBody(request, config, 8 * 1024);
  const username = typeof body?.username === 'string' ? body.username : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!body || !username || username.length > 128 || !password || password.length > 1024) {
    authJson(request, response, config, 400, {
      error: 'invalid_registration',
      message: 'Account registration failed. Check your details or try later.',
    });
    return;
  }
  try {
    const result = await createRealAccount(database, username, username.trim(), password, now);
    if (!result.ok && result.reason === 'duplicate') {
      authJson(request, response, config, 409, {
        error: 'username_unavailable',
        message: 'This username is unavailable. Choose another username or sign in.',
      });
      return;
    }
    if (!result.ok) {
      authJson(request, response, config, 400, {
        error: 'invalid_registration',
        message: 'Account registration failed. Check your details or try later.',
      });
      return;
    }
    authJson(request, response, config, 201, { account: result.account });
  } catch {
    authJson(request, response, config, 503, {
      error: 'registration_unavailable',
      message: 'Registration is temporarily unavailable. Please try again later.',
    });
  }
}

async function handleLogin(ctx: AuthRouteContext): Promise<void> {
  const { request, response, config, database, now } = ctx;
  const body = await requestBody(request, config);
  const username = typeof body?.username === 'string' ? body.username : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const clientType = body?.clientType;
  if (
    !username ||
    username.length > 128 ||
    !password ||
    password.length > 1024 ||
    (clientType !== 'browser' && clientType !== 'native')
  ) {
    authJson(request, response, config, 401, {
      error: 'sign_in_failed',
      message: 'Sign-in failed. Check your details or try later.',
    });
    return;
  }
  const source = authClientSource(request, config);
  const result = await authenticateRealAccount(database, username, password, source, now);
  // Unknown usernames are throttled the same way, so this reveals no accounts.
  if (result.status === 'throttled') {
    authJson(
      request,
      response,
      config,
      429,
      {
        error: 'sign_in_throttled',
        message: 'Too many sign-in attempts. Try again later.',
      },
      { 'Retry-After': String(result.retryAfterSeconds) },
    );
    return;
  }
  if (result.status !== 'authenticated') {
    authJson(request, response, config, 401, {
      error: 'sign_in_failed',
      message: 'Sign-in failed. Check your details or try later.',
    });
    return;
  }
  if (clientType === 'browser') {
    const maxAge = Math.max(0, Math.floor((Date.parse(result.expiresAt) - now.getTime()) / 1000));
    authJson(
      request,
      response,
      config,
      200,
      { account: result.account, expiresAt: result.expiresAt, signInMethod: 'password' },
      {
        'Set-Cookie': `${REAL_SESSION_COOKIE}=${result.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
      },
    );
  } else {
    authJson(request, response, config, 200, {
      account: result.account,
      token: result.token,
      expiresAt: result.expiresAt,
      signInMethod: 'password',
    });
  }
}

function handleSession(ctx: AuthRouteContext): void {
  const { request, response, config, database, now } = ctx;
  const token = authToken(request);
  const session = validateRealSession(database, token ?? '', now);
  if (session.status !== 'valid') {
    const missingCredential = token === null;
    authJson(
      request,
      response,
      config,
      401,
      {
        error: missingCredential ? 'session_required' : 'session_expired',
        message: missingCredential
          ? 'A valid sign-in is required.'
          : 'This sign-in has expired or was revoked.',
      },
      // Drop a stale cookie so only the first visit after losing a session
      // reports it; later visits are plain signed-out visits.
      missingCredential ? {} : { 'Set-Cookie': CLEAR_SESSION_COOKIE },
    );
    return;
  }
  authJson(
    request,
    response,
    config,
    200,
    {
      account: session.account,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      signInMethod: session.signInMethod,
    },
    request.headers.cookie && !request.headers.authorization
      ? {
          'Set-Cookie': `${REAL_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((Date.parse(session.idleExpiresAt) - now.getTime()) / 1000))}`,
        }
      : {},
  );
}

async function handleDeleteAccount(ctx: AuthRouteContext): Promise<void> {
  const { request, response, config, database, now, options, cognito } = ctx;
  const token = authToken(request);
  const session = token ? validateRealSession(database, token, now) : null;
  if (session?.status !== 'valid') {
    authJson(request, response, config, 401, {
      error: 'session_required',
      message: 'A valid sign-in is required.',
    });
    return;
  }
  const body = await requestBody(request, config, 8 * 1024);
  const cognitoSub = cognitoSubForAccount(database, session.account.id);
  if (cognitoSub) {
    // Cognito owns the credentials, so the check is a typed confirmation and
    // the Cognito user goes first: a failure here leaves the account intact.
    if (body?.confirmation !== 'DELETE') {
      authJson(request, response, config, 403, {
        error: 'confirmation_incorrect',
        message: 'Type DELETE to confirm.',
      });
      return;
    }
    try {
      if (!cognito) throw new Error('Cognito is not configured.');
      await cognito.deleteUser(cognitoSub);
    } catch {
      authJson(request, response, config, 502, {
        error: 'cognito_unavailable',
        message: 'The account could not be deleted right now. Try again shortly.',
      });
      return;
    }
  } else {
    const password = typeof body?.password === 'string' ? body.password : '';
    const check = password
      ? await verifyRealAccountPassword(database, session.account.id, password, now)
      : 'invalid';
    if (check !== 'ok') {
      authJson(request, response, config, check === 'throttled' ? 429 : 403, {
        error: check === 'throttled' ? 'password_check_throttled' : 'password_incorrect',
        message:
          check === 'throttled'
            ? 'Too many attempts. Try again later.'
            : 'The password is incorrect.',
      });
      return;
    }
  }
  const media = purgeRealAccount(database, session.account.id, now);
  await removeStoredMedia(media, {
    outputDir: mediaDir(config, 'processed'),
    stagingDir: mediaDir(config, 'staging'),
    mediaStore: options.mediaStore,
    mediaEnvironment: options.mediaEnvironment,
  });
  authJson(
    request,
    response,
    config,
    200,
    {
      deleted: true,
      ...(cognitoSub && cognito
        ? { logoutUrl: cognito.logoutUrl(publicOrigin(request, config)) }
        : {}),
    },
    {
      'Set-Cookie': CLEAR_SESSION_COOKIE,
    },
  );
}

function handleLogout(ctx: AuthRouteContext): void {
  const { request, response, config, database, now, cognito } = ctx;
  const token = authToken(request);
  // A Cognito session also ends Cognito's own, so the next sign-in asks again.
  const ended = token ? validateRealSession(database, token, now) : null;
  const logoutUrl =
    cognito && ended?.status === 'valid' && ended.signInMethod === 'cognito'
      ? cognito.logoutUrl(publicOrigin(request, config))
      : undefined;
  if (token) revokeRealSession(database, token, now);
  authJson(
    request,
    response,
    config,
    200,
    { signedOut: true, ...(logoutUrl ? { logoutUrl } : {}) },
    {
      'Set-Cookie': CLEAR_SESSION_COOKIE,
    },
  );
}

export const authRoutes: readonly Route<AuthRouteContext>[] = [
  { methods: ['GET'], path: '/auth/config', handle: handleAuthConfig },
  { methods: ['GET'], path: '/auth/cognito/start', handle: handleCognitoStart },
  { methods: ['GET'], path: '/auth/callback', handle: handleCognitoCallback },
  { methods: ['POST'], path: '/auth/profile', handle: handleProfile },
  { methods: ['POST'], path: '/auth/register', handle: handleRegister },
  { methods: ['POST'], path: '/auth/login', handle: handleLogin },
  { methods: ['GET'], path: '/auth/session', handle: handleSession },
  { methods: ['POST'], path: '/auth/account/delete', handle: handleDeleteAccount },
  { methods: ['POST'], path: '/auth/logout', handle: handleLogout },
];

export async function handleRealAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  database: RewindDatabase,
  registrationRateLimiter: RegistrationRateLimiter,
  cognitoStates: UsedStates,
  url: URL,
  now: Date,
  options: RuntimeServerOptions = {},
): Promise<void> {
  if (!authTransportIsSecure(request, config) || !authOriginIsAllowed(request, config)) {
    authJson(request, response, config, 403, {
      error: 'auth_transport_unavailable',
      message: 'Sign-in is unavailable on this connection.',
    });
    return;
  }
  const cognito = cognitoServiceFor(config, options.cognito);
  const passwordSignIn = config.authPassword !== false;
  if (
    !passwordSignIn &&
    (url.pathname === '/auth/register' || url.pathname === '/auth/login') &&
    request.method === 'POST'
  ) {
    authJson(request, response, config, 403, {
      error: 'password_sign_in_disabled',
      message: 'Sign in with Cognito on this environment.',
    });
    return;
  }
  const ctx: AuthRouteContext = {
    request,
    response,
    config,
    database,
    registrationRateLimiter,
    cognitoStates,
    url,
    now,
    options,
    cognito,
    passwordSignIn,
  };
  const found = findRoute(authRoutes, request.method, url.pathname);
  if (found) return found.route.handle(ctx, found.match);
  authJson(request, response, config, 404, {
    error: 'not_found',
    message: 'The requested resource was not found.',
  });
}
