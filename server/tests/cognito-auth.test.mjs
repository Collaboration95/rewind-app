import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';

const { ConfigError, parseConfig } = await import('../dist/config.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { createCognitoService, safeReturnPath, UsedStates } =
  await import('../dist/auth/cognito.js');

const COGNITO = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_TestPool1',
  clientId: 'testclientid1234567890',
  domain: 'rewind-test-123.auth.ap-southeast-1.amazoncognito.com',
};
const ISSUER = `https://cognito-idp.${COGNITO.region}.amazonaws.com/${COGNITO.userPoolId}`;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const JWKS = {
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }],
};

function b64(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString(
    'base64url',
  );
}

function signToken(claims, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: 'sub-alice',
    iss: ISSUER,
    aud: COGNITO.clientId,
    token_use: 'id',
    iat: now,
    exp: now + 3600,
    email_verified: true,
    ...claims,
  };
  const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const input = `${head}.${b64(payload)}`;
  const signature = createSign('RSA-SHA256').update(input).sign(key).toString('base64url');
  return `${input}.${signature}`;
}

/** A runtime with an injected Cognito service whose token endpoint is a stub. */
async function withRuntime(run, { env = {}, deleteUser } = {}) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-cognito-`);
  const config = {
    ...parseConfig({
      REWIND_DATA_DIR: dataDir,
      REWIND_HOST: '127.0.0.1',
      REWIND_PORT: '0',
      REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
      ...env,
    }),
  };
  const database = openFixtureDatabase(config);
  const verifier = CognitoJwtVerifier.create({
    userPoolId: COGNITO.userPoolId,
    tokenUse: 'id',
    clientId: COGNITO.clientId,
  });
  verifier.cacheJwks(JWKS);
  const exchange = { idToken: null, requests: [] };
  const deleted = [];
  const cognito = createCognitoService(COGNITO, {
    verifier,
    fetch: async (url, init) => {
      exchange.requests.push({ url: String(url), body: new URLSearchParams(init.body) });
      return exchange.idToken
        ? Response.json({ id_token: exchange.idToken })
        : new Response('{}', { status: 400 });
    },
    deleteUser:
      deleteUser ??
      (async (sub) => {
        deleted.push(sub);
      }),
  });
  const server = createRuntimeServer(config, database, { cognito });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run({ baseUrl, database, exchange, deleted });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const cookieOf = (response, name) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .find((value) => value.startsWith(`${name}=`));

/** Start a flow and return what the callback needs. */
async function startFlow(baseUrl, returnPath = '/') {
  const response = await fetch(
    `${baseUrl}/auth/cognito/start?return=${encodeURIComponent(returnPath)}`,
    { redirect: 'manual' },
  );
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  return {
    response,
    location,
    cookie: cookieOf(response, '__Host-rewind_oidc'),
    state: location.searchParams.get('state'),
    nonce: location.searchParams.get('nonce'),
  };
}

async function callback(baseUrl, flow, { state = flow.state, code = 'auth-code', cookie } = {}) {
  return fetch(`${baseUrl}/auth/callback?code=${code}&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
    headers: { cookie: cookie ?? flow.cookie ?? '' },
  });
}

async function signInSuccessfully(ctx, claims = {}) {
  const flow = await startFlow(ctx.baseUrl);
  ctx.exchange.idToken = signToken({ nonce: flow.nonce, ...claims });
  const response = await callback(ctx.baseUrl, flow);
  const session = cookieOf(response, '__Host-rewind_session');
  return { flow, response, session };
}

function assertRejected(response) {
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^\/\?auth_error=cognito/);
  assert.equal(cookieOf(response, '__Host-rewind_session'), undefined);
}

test('auth config reports the sign-in methods', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const body = await (await fetch(`${baseUrl}/auth/config`)).json();
    assert.deepEqual(body, { passwordSignIn: true, cognito: true });
  });
});

test('start redirects to Managed Login with PKCE and a transaction cookie', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const flow = await startFlow(baseUrl, '/?code=ABCD&groupId=g1');
    assert.equal(flow.location.host, COGNITO.domain);
    assert.equal(flow.location.pathname, '/oauth2/authorize');
    const query = flow.location.searchParams;
    assert.equal(query.get('response_type'), 'code');
    assert.equal(query.get('client_id'), COGNITO.clientId);
    assert.equal(query.get('code_challenge_method'), 'S256');
    assert.match(query.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/api\/auth\/callback$/);
    assert.ok(query.get('state') && query.get('nonce') && query.get('code_challenge'));
    const setCookie = flow.response.headers.getSetCookie().join('\n');
    assert.match(setCookie, /__Host-rewind_oidc=.*HttpOnly.*SameSite=Lax.*Max-Age=600/);
  });
});

test('return paths stay on this origin', () => {
  assert.equal(safeReturnPath('/?code=A&groupId=g'), '/?code=A&groupId=g');
  for (const bad of [
    'https://evil.example/',
    '//evil.example',
    '/\\evil',
    'javascript:1',
    '',
    null,
  ])
    assert.equal(safeReturnPath(bad), '/');
});

test('a good callback signs in, creates the account once and keeps the invite path', async () => {
  await withRuntime(async (ctx) => {
    const flow = await startFlow(ctx.baseUrl, '/?code=ABCD&groupId=g1');
    ctx.exchange.idToken = signToken({ nonce: flow.nonce });
    const response = await callback(ctx.baseUrl, flow);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/?code=ABCD&groupId=g1');
    const session = cookieOf(response, '__Host-rewind_session');
    assert.ok(session);
    assert.match(response.headers.getSetCookie().join('\n'), /__Host-rewind_oidc=;.*Max-Age=0/);
    // The code and verifier went to Cognito's token endpoint.
    const sent = ctx.exchange.requests[0];
    assert.equal(sent.url, `https://${COGNITO.domain}/oauth2/token`);
    assert.equal(sent.body.get('grant_type'), 'authorization_code');
    assert.equal(
      createHash('sha256').update(sent.body.get('code_verifier')).digest('base64url'),
      flow.location.searchParams.get('code_challenge'),
    );

    const info = await (
      await fetch(`${ctx.baseUrl}/auth/session`, { headers: { cookie: session } })
    ).json();
    assert.equal(info.signInMethod, 'cognito');
    assert.equal(info.account.displayName, '');

    // Same Cognito user again: same account, new session.
    const again = await signInSuccessfully(ctx);
    assert.ok(again.session);
    assert.equal(
      ctx.database
        .prepare('SELECT COUNT(*) AS n FROM real_accounts WHERE cognito_sub = ?')
        .get('sub-alice').n,
      1,
    );
  });
});

test('callbacks with a bad token, state or replay are rejected', async () => {
  await withRuntime(async (ctx) => {
    const reject = async (claims, key) => {
      const flow = await startFlow(ctx.baseUrl);
      ctx.exchange.idToken = signToken({ nonce: flow.nonce, ...claims }, key);
      assertRejected(await callback(ctx.baseUrl, flow));
    };
    const now = Math.floor(Date.now() / 1000);
    await reject({ iss: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_Other' });
    await reject({ aud: 'someotherclient' });
    await reject({ exp: now - 60, iat: now - 3600 });
    await reject({}, otherKey); // bad signature
    await reject({ token_use: 'access' });
    await reject({ nonce: 'not-the-nonce' });
    await reject({ email_verified: false });

    // State that does not match this browser's cookie.
    const flow = await startFlow(ctx.baseUrl);
    ctx.exchange.idToken = signToken({ nonce: flow.nonce });
    assertRejected(await callback(ctx.baseUrl, flow, { state: 'forged-state' }));
    // No cookie at all (a login started in another browser).
    assertRejected(await callback(ctx.baseUrl, flow, { cookie: '' }));

    // The real state works once, then never again.
    const first = await callback(ctx.baseUrl, flow);
    assert.ok(cookieOf(first, '__Host-rewind_session'));
    assertRejected(await callback(ctx.baseUrl, flow));

    assert.equal(
      ctx.database.prepare('SELECT COUNT(*) AS n FROM real_accounts').get().n,
      1,
      'only the one good sign-in made an account',
    );
  });
});

test('a cancelled sign-in returns to the app with a message', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const flow = await startFlow(baseUrl);
    const response = await fetch(
      `${baseUrl}/auth/callback?error=access_denied&state=${encodeURIComponent(flow.state)}`,
      { redirect: 'manual', headers: { cookie: flow.cookie } },
    );
    assert.equal(response.headers.get('location'), '/?auth_error=cognito_denied');
  });
});

test('used states expire and are bounded', () => {
  const states = new UsedStates();
  assert.equal(states.consume('a', 0), true);
  assert.equal(states.consume('a', 1), false);
  assert.equal(states.consume('a', 11 * 60 * 1000), true);
});

test('first-sign-in display name is saved on the account', async () => {
  await withRuntime(async (ctx) => {
    const { session } = await signInSuccessfully(ctx);
    const post = (displayName) =>
      fetch(`${ctx.baseUrl}/auth/profile`, {
        method: 'POST',
        headers: { cookie: session, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
      });
    assert.equal((await post('   ')).status, 400);
    assert.equal((await post('x'.repeat(81))).status, 400);
    const ok = await post('  Alice  ');
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).account.displayName, 'Alice');
    const info = await (
      await fetch(`${ctx.baseUrl}/auth/session`, { headers: { cookie: session } })
    ).json();
    assert.equal(info.account.displayName, 'Alice');
    const anonymous = await fetch(`${ctx.baseUrl}/auth/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'x' }),
    });
    assert.equal(anonymous.status, 401);
  });
});

test('Cognito accounts cannot sign in with a password', async () => {
  await withRuntime(async (ctx) => {
    await signInSuccessfully(ctx);
    const username = ctx.database.prepare('SELECT username FROM real_accounts').get().username;
    const response = await fetch(`${ctx.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password: 'synthetic fixture password',
        clientType: 'native',
      }),
    });
    assert.equal(response.status, 401);
  });
});

test('sign-out of a Cognito session returns the Cognito logout URL', async () => {
  await withRuntime(async (ctx) => {
    const { session } = await signInSuccessfully(ctx);
    const out = await fetch(`${ctx.baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { cookie: session },
    });
    const body = await out.json();
    assert.equal(body.signedOut, true);
    const url = new URL(body.logoutUrl);
    assert.equal(url.host, COGNITO.domain);
    assert.equal(url.pathname, '/logout');
    assert.equal(url.searchParams.get('client_id'), COGNITO.clientId);
    assert.match(url.searchParams.get('logout_uri'), /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const after = await fetch(`${ctx.baseUrl}/auth/session`, { headers: { cookie: session } });
    assert.equal(after.status, 401);
  });
});

test('deleting a Cognito account asks for DELETE, removes the Cognito user, then the data', async () => {
  await withRuntime(async (ctx) => {
    const { session } = await signInSuccessfully(ctx);
    const remove = (body) =>
      fetch(`${ctx.baseUrl}/auth/account/delete`, {
        method: 'POST',
        headers: { cookie: session, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    assert.equal((await remove({ password: 'anything' })).status, 403);
    assert.equal((await remove({ confirmation: 'delete' })).status, 403);
    assert.deepEqual(ctx.deleted, []);
    const ok = await remove({ confirmation: 'DELETE' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).deleted, true);
    assert.deepEqual(ctx.deleted, ['sub-alice']);
    assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM real_accounts').get().n, 0);
  });
});

test('a failed Cognito deletion leaves the account in place', async () => {
  await withRuntime(
    async (ctx) => {
      const { session } = await signInSuccessfully(ctx);
      const response = await fetch(`${ctx.baseUrl}/auth/account/delete`, {
        method: 'POST',
        headers: { cookie: session, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'DELETE' }),
      });
      assert.equal(response.status, 502);
      assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM real_accounts').get().n, 1);
    },
    {
      deleteUser: async () => {
        throw new Error('Cognito unreachable');
      },
    },
  );
});

test('password sign-in off: register and login are refused, Cognito still works', async () => {
  await withRuntime(
    async (ctx) => {
      const config = await (await fetch(`${ctx.baseUrl}/auth/config`)).json();
      assert.deepEqual(config, { passwordSignIn: false, cognito: true });
      for (const path of ['/auth/register', '/auth/login']) {
        const response = await fetch(`${ctx.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'someone',
            password: 'x'.repeat(16),
            clientType: 'browser',
          }),
        });
        assert.equal(response.status, 403);
        assert.equal((await response.json()).error, 'password_sign_in_disabled');
      }
      assert.ok((await signInSuccessfully(ctx)).session);
    },
    {
      env: {
        REWIND_AUTH_PASSWORD: 'false',
        ...Object.fromEntries(
          Object.entries({
            REWIND_COGNITO_REGION: COGNITO.region,
            REWIND_COGNITO_USER_POOL_ID: COGNITO.userPoolId,
            REWIND_COGNITO_CLIENT_ID: COGNITO.clientId,
            REWIND_COGNITO_DOMAIN: COGNITO.domain,
          }),
        ),
      },
    },
  );
});

test('release refuses to start with password sign-in enabled', () => {
  const cognito = {
    REWIND_COGNITO_REGION: COGNITO.region,
    REWIND_COGNITO_USER_POOL_ID: COGNITO.userPoolId,
    REWIND_COGNITO_CLIENT_ID: COGNITO.clientId,
    REWIND_COGNITO_DOMAIN: COGNITO.domain,
  };
  for (const environment of [
    { REWIND_MEDIA_ENVIRONMENT: 'release' },
    { REWIND_DATABASE_ENVIRONMENT: 'release' },
  ]) {
    assert.throws(() => parseConfig({ ...environment, ...cognito }), ConfigError);
    assert.throws(
      () => parseConfig({ ...environment, ...cognito, REWIND_AUTH_PASSWORD: 'true' }),
      /not allowed on the release/,
    );
    const config = parseConfig({ ...environment, ...cognito, REWIND_AUTH_PASSWORD: 'false' });
    assert.equal(config.authPassword, false);
    assert.equal(config.cognito.userPoolId, COGNITO.userPoolId);
  }
  // dev and local keep the password form.
  assert.equal(parseConfig({ REWIND_MEDIA_ENVIRONMENT: 'dev', ...cognito }).authPassword, true);
  assert.equal(parseConfig({}).authPassword, true);
  assert.equal(parseConfig({}).cognito, null);
});

test('password sign-in off without Cognito settings is a config error', () => {
  assert.throws(() => parseConfig({ REWIND_AUTH_PASSWORD: 'false' }), /needs the REWIND_COGNITO/);
  assert.throws(() => parseConfig({ REWIND_COGNITO_REGION: COGNITO.region }), /incomplete/);
});
