// Characterisation of /auth/*, the global request gate (method check, CORS
// preflight, 404s), /health, and /media/access/:token in server/src/http.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JSON_TYPE,
  UNKNOWN_TOKEN,
  defineCases,
  routeFixture,
  send,
} from './helpers/route-contract.mjs';

const fx = await routeFixture();
const SESSION_COOKIE = '__Host-rewind_session';
const NEW_USER = { username: 'rc.new.user', password: 'a long enough contract password' };
const token43 = 'B'.repeat(43);

defineCases(fx, [
  // ---- health ----------------------------------------------------------
  {
    path: '/health',
    status: 200,
    keys: ['addresses', 'checks', 'ok', 'ready', 'service', 'version'],
  },
  {
    path: '/version',
    status: 200,
    keys: ['addresses', 'checks', 'ok', 'ready', 'service', 'version'],
  },
  {
    method: 'POST',
    path: '/health',
    status: 200,
    keys: ['addresses', 'checks', 'ok', 'ready', 'service', 'version'],
    name: 'health ignores the method',
  },
  {
    method: 'DELETE',
    path: '/version',
    status: 200,
    keys: ['addresses', 'checks', 'ok', 'ready', 'service', 'version'],
    name: 'version ignores the method',
  },
  { path: '/health/', status: 404, error: 'not_found' },
  { path: '/healthz', status: 404, error: 'not_found' },

  // ---- global gate -------------------------------------------------------
  { path: '/', status: 404, error: 'not_found' },
  { path: '/nowhere', status: 404, error: 'not_found' },
  { method: 'POST', path: '/nowhere', status: 404, error: 'not_found' },
  { method: 'DELETE', path: '/nowhere', status: 404, error: 'not_found' },
  { path: '/nowhere', actor: 'owner', status: 404, error: 'not_found' },
  { method: 'PUT', path: '/nowhere', status: 405, error: 'method_not_allowed' },
  { method: 'PATCH', path: '/health', status: 405, error: 'method_not_allowed' },
  {
    method: 'PUT',
    path: '/archive?groupId={g}',
    actor: 'owner',
    status: 405,
    error: 'method_not_allowed',
  },
  {
    method: 'HEAD',
    path: '/health',
    status: 405,
    noBody: true,
    name: 'HEAD is not supported outside media paths',
  },
  { method: 'HEAD', path: '/archive?groupId={g}', actor: 'owner', status: 405, noBody: true },
  { method: 'PUT', path: '/auth/session', status: 405, error: 'method_not_allowed' },
  { method: 'PUT', path: '/auth/login', status: 405, error: 'method_not_allowed' },

  // ---- /media/access/:token ----------------------------------------------
  { path: `/media/access/${token43}`, status: 404, error: 'not_found', name: 'unknown capability' },
  { path: `/media/access/${token43}`, actor: 'owner', status: 404, error: 'not_found' },
  {
    method: 'HEAD',
    path: `/media/access/${token43}`,
    status: 404,
    noBody: true,
    name: 'HEAD is allowed through on media paths',
  },
  {
    path: `/media/access/${token43}`,
    headers: { Origin: 'https://attacker.example' },
    status: 403,
    error: 'forbidden',
  },
  {
    path: `/media/access/${token43}`,
    headers: { 'x-forwarded-proto': 'https' },
    status: 403,
    error: 'forbidden',
    name: 'x-forwarded-proto without the origin-auth secret',
  },
  {
    path: `/media/access/${token43}`,
    actor: 'garbage',
    status: 403,
    error: 'forbidden',
    name: 'malformed bearer is denied rather than ignored',
  },
  {
    path: `/media/access/${token43}`,
    headers: { Cookie: `${SESSION_COOKIE}=nope` },
    status: 403,
    error: 'forbidden',
    name: 'malformed cookie is denied rather than ignored',
  },
  {
    path: `/media/access/${token43}`,
    actor: 'unknown',
    status: 404,
    error: 'not_found',
    name: 'well-formed unknown session',
  },
  {
    method: 'POST',
    path: `/media/access/${token43}`,
    status: 404,
    error: 'not_found',
    name: 'POST falls through to the generic 404',
  },
  { path: '/media/access/too-short', status: 404, error: 'not_found' },
  { path: `/media/access/${token43}x`, status: 404, error: 'not_found' },
  { path: '/media/access/', status: 404, error: 'not_found' },

  // ---- /auth guard --------------------------------------------------------
  { path: '/auth/config', status: 200, keys: ['cognito', 'passwordSignIn'] },
  {
    path: '/auth/config',
    headers: { Origin: 'https://attacker.example' },
    status: 403,
    error: 'auth_transport_unavailable',
  },
  {
    path: '/auth/config',
    headers: { 'x-forwarded-proto': 'https' },
    status: 403,
    error: 'auth_transport_unavailable',
    name: 'x-forwarded-proto without the origin-auth secret',
  },
  {
    path: '/auth/config',
    headers: { 'x-forwarded-proto': 'https', 'x-rewind-origin-auth': 'wrong' },
    status: 403,
    error: 'auth_transport_unavailable',
  },
  {
    path: '/auth/no-such-route',
    headers: { 'x-forwarded-proto': 'https' },
    status: 403,
    error: 'auth_transport_unavailable',
    name: 'guard runs before routing',
  },
  {
    method: 'POST',
    path: '/auth/login',
    headers: { Origin: 'https://attacker.example' },
    body: {},
    status: 403,
    error: 'auth_transport_unavailable',
  },
  { method: 'POST', path: '/auth/config', status: 404, error: 'not_found', name: 'wrong method' },
  { path: '/auth/no-such-route', status: 404, error: 'not_found' },
  { path: '/auth/', status: 404, error: 'not_found' },
  {
    path: '/auth/cognito/start',
    status: 404,
    error: 'cognito_unavailable',
    name: 'Cognito not configured',
  },
  {
    method: 'POST',
    path: '/auth/cognito/start',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },

  // ---- /auth/session -----------------------------------------------------
  { path: '/auth/session', status: 401, error: 'session_required' },
  {
    path: '/auth/session',
    actor: 'garbage',
    status: 401,
    error: 'session_required',
    name: 'malformed bearer counts as missing',
  },
  { path: '/auth/session', actor: 'unknown', status: 401, error: 'session_expired' },
  {
    path: '/auth/session?token=' + token43,
    status: 401,
    error: 'session_required',
    name: 'query tokens are ignored',
  },
  {
    path: '/auth/session',
    actor: 'owner',
    status: 200,
    keys: ['absoluteExpiresAt', 'account', 'idleExpiresAt', 'signInMethod'],
  },
  {
    method: 'POST',
    path: '/auth/session',
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },

  // ---- /auth/profile -------------------------------------------------------
  {
    method: 'POST',
    path: '/auth/profile',
    body: { displayName: 'x' },
    status: 401,
    error: 'session_required',
  },
  {
    method: 'POST',
    path: '/auth/profile',
    actor: 'unknown',
    body: { displayName: 'x' },
    status: 401,
    error: 'session_required',
  },
  {
    method: 'POST',
    path: '/auth/profile',
    actor: 'creator',
    body: {},
    status: 400,
    error: 'invalid_display_name',
  },
  {
    method: 'POST',
    path: '/auth/profile',
    actor: 'creator',
    raw: '{bad',
    status: 400,
    error: 'invalid_display_name',
  },
  {
    method: 'POST',
    path: '/auth/profile',
    actor: 'creator',
    body: { displayName: 'y'.repeat(81) },
    status: 400,
    error: 'invalid_display_name',
  },
  {
    method: 'POST',
    path: '/auth/profile',
    actor: 'creator',
    oversize: 70_000,
    status: 413,
    error: 'payload_too_large',
  },
  {
    method: 'POST',
    path: '/auth/profile',
    actor: 'creator',
    body: { displayName: 'Renamed' },
    status: 200,
    keys: ['account'],
  },
  {
    method: 'GET',
    path: '/auth/profile',
    actor: 'creator',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },

  // ---- /auth/login ---------------------------------------------------------
  { method: 'POST', path: '/auth/login', body: {}, status: 401, error: 'sign_in_failed' },
  { method: 'POST', path: '/auth/login', raw: '{bad', status: 401, error: 'sign_in_failed' },
  {
    method: 'POST',
    path: '/auth/login',
    body: { username: 'a', password: 'b' },
    status: 401,
    error: 'sign_in_failed',
    name: 'clientType is required',
  },
  {
    method: 'POST',
    path: '/auth/login',
    body: { username: 'a', password: 'b', clientType: 'other' },
    status: 401,
    error: 'sign_in_failed',
  },
  {
    method: 'POST',
    path: '/auth/login',
    body: { username: 'a'.repeat(129), password: 'b', clientType: 'native' },
    status: 401,
    error: 'sign_in_failed',
  },
  {
    method: 'POST',
    path: '/auth/login',
    body: { username: 'no-such-user', password: 'bad password', clientType: 'native' },
    status: 401,
    error: 'sign_in_failed',
  },
  {
    method: 'POST',
    path: '/auth/login',
    oversize: 70_000,
    status: 413,
    error: 'payload_too_large',
  },
  { method: 'GET', path: '/auth/login', status: 404, error: 'not_found', name: 'wrong method' },

  // ---- /auth/register (five attempts per source and window) ----------------
  {
    method: 'POST',
    path: '/auth/register',
    raw: '{bad',
    status: 400,
    error: 'invalid_registration',
  },
  { method: 'POST', path: '/auth/register', body: {}, status: 400, error: 'invalid_registration' },
  {
    method: 'POST',
    path: '/auth/register',
    body: { username: 'u'.repeat(129), password: NEW_USER.password },
    status: 400,
    error: 'invalid_registration',
  },
  {
    method: 'POST',
    path: '/auth/register',
    body: NEW_USER,
    status: 201,
    keys: ['account'],
    name: 'register',
  },
  {
    method: 'POST',
    path: '/auth/register',
    body: NEW_USER,
    status: 409,
    error: 'username_unavailable',
  },
  {
    method: 'POST',
    path: '/auth/register',
    oversize: 70_000,
    status: 429,
    error: 'registration_rate_limited',
    name: 'sixth attempt is limited before the body is read',
  },
  { method: 'GET', path: '/auth/register', status: 404, error: 'not_found', name: 'wrong method' },

  // ---- /auth/account/delete --------------------------------------------------
  {
    method: 'POST',
    path: '/auth/account/delete',
    body: { password: 'x' },
    status: 401,
    error: 'session_required',
  },
  {
    method: 'POST',
    path: '/auth/account/delete',
    actor: 'unknown',
    body: { password: 'x' },
    status: 401,
    error: 'session_required',
  },
  {
    method: 'POST',
    path: '/auth/account/delete',
    actor: 'creator',
    body: {},
    status: 403,
    error: 'password_incorrect',
  },
  {
    method: 'POST',
    path: '/auth/account/delete',
    actor: 'creator',
    raw: '{bad',
    status: 403,
    error: 'password_incorrect',
  },
  {
    method: 'POST',
    path: '/auth/account/delete',
    actor: 'creator',
    oversize: 70_000,
    status: 413,
    error: 'payload_too_large',
  },
  {
    method: 'GET',
    path: '/auth/account/delete',
    actor: 'creator',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },

  // ---- /auth/logout --------------------------------------------------------
  { method: 'GET', path: '/auth/logout', status: 404, error: 'not_found', name: 'wrong method' },
  {
    method: 'POST',
    path: '/auth/logout',
    status: 200,
    keys: ['signedOut'],
    name: 'signing out without a session still succeeds',
  },
  { method: 'POST', path: '/auth/logout', actor: 'unknown', status: 200, keys: ['signedOut'] },
]);

test('password sign-in lifecycle: login (native + browser), session cookie, logout, delete', async () => {
  const native = await send(fx, {
    method: 'POST',
    path: '/auth/login',
    body: { ...NEW_USER, clientType: 'native' },
  });
  assert.equal(native.status, 200);
  assert.deepEqual(Object.keys(native.json).sort(), [
    'account',
    'expiresAt',
    'signInMethod',
    'token',
  ]);
  assert.equal(native.json.signInMethod, 'password');
  assert.match(native.json.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(native.response.headers.get('set-cookie'), null);

  const browser = await send(fx, {
    method: 'POST',
    path: '/auth/login',
    body: { ...NEW_USER, clientType: 'browser' },
  });
  assert.equal(browser.status, 200);
  assert.deepEqual(Object.keys(browser.json).sort(), ['account', 'expiresAt', 'signInMethod']);
  const cookie = browser.response.headers.get('set-cookie');
  assert.match(
    cookie,
    new RegExp(
      `^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=\\d+$`,
    ),
  );
  const cookieHeader = cookie.split(';', 1)[0];

  const bearerSession = await send(fx, {
    path: '/auth/session',
    headers: { Authorization: `Bearer ${native.json.token}` },
  });
  assert.equal(bearerSession.status, 200);
  assert.equal(bearerSession.response.headers.get('set-cookie'), null);
  const cookieSession = await send(fx, {
    path: '/auth/session',
    headers: { Cookie: cookieHeader },
  });
  assert.equal(cookieSession.status, 200);
  assert.match(
    cookieSession.response.headers.get('set-cookie'),
    /^__Host-rewind_session=.*Max-Age=\d+$/,
  );
  const mismatch = await send(fx, {
    path: '/auth/session',
    headers: { Authorization: `Bearer ${native.json.token}`, Cookie: cookieHeader },
  });
  assert.equal(mismatch.status, 401, 'bearer and cookie that disagree are rejected');
  assert.equal(mismatch.json.error, 'session_required');

  const wrong = await send(fx, {
    method: 'POST',
    path: '/auth/login',
    body: { username: NEW_USER.username, password: 'not the password', clientType: 'native' },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error, 'sign_in_failed');

  const logout = await send(fx, {
    method: 'POST',
    path: '/auth/logout',
    headers: { Authorization: `Bearer ${native.json.token}` },
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.json, { signedOut: true });
  assert.match(
    logout.response.headers.get('set-cookie'),
    /^__Host-rewind_session=; .*Max-Age=0; Expires=Thu, 01 Jan 1970/,
  );
  const after = await send(fx, {
    path: '/auth/session',
    headers: { Authorization: `Bearer ${native.json.token}` },
  });
  assert.equal(after.status, 401);
  assert.equal(after.json.error, 'session_expired');

  const deleted = await send(fx, {
    method: 'POST',
    path: '/auth/account/delete',
    headers: { Cookie: cookieHeader },
    body: { password: NEW_USER.password },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json, { deleted: true });
  assert.match(deleted.response.headers.get('set-cookie'), /Max-Age=0/);
  const gone = await send(fx, { path: '/auth/session', headers: { Cookie: cookieHeader } });
  assert.equal(gone.status, 401);
});

test('JSON replies on /auth and global routes keep their CORS posture', async () => {
  const health = await send(fx, { path: '/health' });
  assert.equal(health.response.headers.get('access-control-allow-origin'), '*');
  assert.equal(health.response.headers.get('content-type'), JSON_TYPE);
  const auth = await send(fx, { path: '/auth/config' });
  assert.equal(auth.response.headers.get('access-control-allow-origin'), null);
  const sameOrigin = await send(fx, { path: '/auth/config', headers: { Origin: fx.c.baseUrl } });
  assert.equal(sameOrigin.status, 200, 'same-origin loopback Origin is allowed');
  assert.equal(sameOrigin.response.headers.get('access-control-allow-origin'), null);
  assert.equal(sameOrigin.response.headers.get('vary'), 'Origin');
  const refused = await send(fx, {
    path: '/auth/config',
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.response.headers.get('access-control-allow-origin'), null);
  const unsupported = await send(fx, { method: 'PUT', path: '/auth/login' });
  assert.equal(unsupported.response.headers.get('access-control-allow-origin'), null);
  const unsupportedGlobal = await send(fx, { method: 'PUT', path: '/health' });
  assert.equal(unsupportedGlobal.response.headers.get('access-control-allow-origin'), '*');
});

test('OPTIONS: auth-style paths get no-store preflights, other paths a plain wildcard 204', async () => {
  for (const path of ['/auth/login', '/real/groups', '/archive', '/clips/x']) {
    const { response, status, text } = await send(fx, {
      method: 'OPTIONS',
      path,
      headers: { Origin: 'https://attacker.example' },
    });
    assert.equal(status, 204, path);
    assert.equal(text, '');
    assert.equal(response.headers.get('access-control-allow-origin'), null, path);
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
    assert.equal(
      response.headers.get('access-control-allow-headers'),
      'Authorization, Content-Type, Range, Last-Event-ID',
    );
  }
  // /films/* routes were removed, so their preflight is the plain one.
  for (const path of ['/health', '/nowhere', '/media/x', '/films/x/play']) {
    const { response, status } = await send(fx, { method: 'OPTIONS', path });
    assert.equal(status, 204, path);
    assert.equal(response.headers.get('access-control-allow-origin'), '*', path);
    assert.equal(response.headers.get('cache-control'), null, path);
    assert.equal(
      response.headers.get('access-control-allow-headers'),
      'Content-Type, Authorization, Range, Last-Event-ID',
    );
    assert.equal(
      response.headers.get('access-control-allow-methods'),
      'GET, HEAD, POST, DELETE, OPTIONS',
    );
  }
  // /media/access/ preflights are auth-style too.
  const media = await send(fx, { method: 'OPTIONS', path: `/media/access/${token43}` });
  assert.equal(media.status, 204);
  assert.equal(media.response.headers.get('cache-control'), 'no-store');
});

test('auth: the callback with no login transaction returns to / with an error and clears the cookie', async () => {
  const { response, status } = await send(fx, { path: '/auth/callback?state=x&code=y' });
  assert.equal(status, 302);
  assert.equal(response.headers.get('location'), '/?auth_error=cognito');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('set-cookie'), /^__Host-rewind_oidc=; .*Max-Age=0$/);
});

test('auth: password sign-in can be switched off', async () => {
  const { config } = fx.c;
  config.authPassword = false;
  try {
    const status = await send(fx, { path: '/auth/config' });
    assert.deepEqual(status.json, { passwordSignIn: false, cognito: false });
    for (const path of ['/auth/login', '/auth/register']) {
      const refused = await send(fx, { method: 'POST', path, body: {} });
      assert.equal(refused.status, 403, path);
      assert.equal(refused.json.error, 'password_sign_in_disabled', path);
    }
    const session = await send(fx, { path: '/auth/session', actor: 'owner' });
    assert.equal(session.status, 200, 'existing sessions keep working');
  } finally {
    config.authPassword = true;
  }
});

// ---- a second runtime with an injected Cognito service -------------------------
const seen = {};
const cognitoFx = await routeFixture({
  options: {
    cognito: {
      config: {},
      authorizeUrl: (parameters) => {
        Object.assign(seen, parameters);
        return `https://idp.example/authorize?state=${parameters.state}`;
      },
      exchange: async () => {
        throw new Error('stubbed token exchange fails');
      },
      logoutUrl: (origin) => `https://idp.example/logout?origin=${encodeURIComponent(origin)}`,
      deleteUser: async () => undefined,
    },
  },
});

test('cognito: config reports it, start redirects with a transaction cookie, failures return to the app', async () => {
  const config = await send(cognitoFx, { path: '/auth/config' });
  assert.deepEqual(config.json, { passwordSignIn: true, cognito: true });

  const start = await send(cognitoFx, { path: '/auth/cognito/start?return=/join/ABCDEF' });
  assert.equal(start.status, 302);
  assert.equal(
    start.response.headers.get('location'),
    `https://idp.example/authorize?state=${seen.state}`,
  );
  assert.equal(start.response.headers.get('cache-control'), 'no-store');
  assert.equal(seen.redirectUri, `${cognitoFx.c.baseUrl}/api/auth/callback`);
  const setCookie = start.response.headers.get('set-cookie');
  assert.match(
    setCookie,
    /^__Host-rewind_oidc=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/,
  );
  const cookie = setCookie.split(';', 1)[0];

  const denied = await send(cognitoFx, {
    path: `/auth/callback?state=${seen.state}&error=access_denied`,
    headers: { Cookie: cookie },
  });
  assert.equal(denied.status, 302);
  assert.equal(denied.response.headers.get('location'), '/join/ABCDEF?auth_error=cognito_denied');
  assert.match(denied.response.headers.get('set-cookie'), /Max-Age=0$/);

  // the state is single use
  const replay = await send(cognitoFx, {
    path: `/auth/callback?state=${seen.state}&code=abc`,
    headers: { Cookie: cookie },
  });
  assert.equal(replay.status, 302);
  assert.equal(replay.response.headers.get('location'), '/?auth_error=cognito');

  const second = await send(cognitoFx, { path: '/auth/cognito/start' });
  const secondCookie = second.response.headers.get('set-cookie').split(';', 1)[0];
  const failed = await send(cognitoFx, {
    path: `/auth/callback?state=${seen.state}&code=abc`,
    headers: { Cookie: secondCookie },
  });
  assert.equal(failed.status, 302, 'a failed exchange also redirects');
  assert.equal(failed.response.headers.get('location'), '/?auth_error=cognito');

  const missingCode = await send(cognitoFx, { path: '/auth/cognito/start' });
  const missingCookie = missingCode.response.headers.get('set-cookie').split(';', 1)[0];
  const noCode = await send(cognitoFx, {
    path: `/auth/callback?state=${seen.state}`,
    headers: { Cookie: missingCookie },
  });
  assert.equal(noCode.status, 302);
  assert.equal(noCode.response.headers.get('location'), '/?auth_error=cognito');
});

test('UNKNOWN_TOKEN is 43 url-safe characters', () => {
  assert.match(UNKNOWN_TOKEN, /^[A-Za-z0-9_-]{43}$/);
});
