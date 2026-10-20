import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { createCognitoService } from '../dist/auth/cognito.js';
import { withBoundaryRuntime, BOUNDARY_NOW } from './helpers/boundary-runtime.mjs';

const config = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_Boundary',
  clientId: 'boundaryclient1234567890',
  domain: 'boundary.auth.ap-southeast-1.amazoncognito.com',
};
const returnPath = '/?groupId=private-invite&code=ABC-DEF';
const transactionCookie = (response) =>
  response.headers.getSetCookie().find((value) => value.startsWith('__Host-rewind_oidc='));

async function start(c) {
  const response = await c.request(`/auth/cognito/start?return=${encodeURIComponent(returnPath)}`, {
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get('location'));
  return {
    state: url.searchParams.get('state'),
    nonce: url.searchParams.get('nonce'),
    cookie: transactionCookie(response).split(';')[0],
  };
}

async function assertFailure(
  c,
  flow,
  { code = 'synthetic-code', cookie = flow.cookie, target = returnPath } = {},
) {
  const response = await c.request(
    `/auth/callback?state=${encodeURIComponent(flow.state)}&code=${encodeURIComponent(code)}`,
    { headers: { cookie }, redirect: 'manual' },
  );
  assert.equal(response.status, 302);
  const expected = new URL(target, 'https://rewind.example');
  expected.searchParams.set('auth_error', 'cognito');
  assert.equal(response.headers.get('location'), expected.pathname + expected.search);
  assert.match(transactionCookie(response), /Max-Age=0/);
  assert.equal(
    response.headers.getSetCookie().some((value) => value.startsWith('__Host-rewind_session=')),
    false,
  );
  assert.equal((await c.request('/auth/session')).status, 401);
  assert.equal(c.database.prepare('SELECT COUNT(*) AS n FROM real_accounts').get().n, 0);
  assert.equal(c.database.prepare('SELECT COUNT(*) AS n FROM real_account_sessions').get().n, 0);
}

function service({
  fetcher = async () => Response.json({ id_token: 'synthetic-token' }),
  claims = {},
} = {}) {
  const calls = [];
  const cognito = createCognitoService(config, {
    fetch: async (...args) => {
      calls.push(args);
      return fetcher(...args);
    },
    verifier: { verify: async () => ({ sub: 'boundary-user', email_verified: true, ...claims }) },
  });
  return { cognito, calls };
}

for (const [name, fetcher, claims] of [
  [
    'a rejected token exchange',
    async () => new Response('private provider details', { status: 503 }),
  ],
  [
    'a network failure',
    async () => {
      throw new Error('private network details');
    },
  ],
  ['invalid provider JSON', async () => new Response('{private invalid json')],
  ['a missing ID token', async () => Response.json({ access_token: 'private-access-token' })],
  ['a non-string ID token', async () => Response.json({ id_token: 42 })],
  ['a missing subject', undefined, { sub: '' }],
  ['a non-string subject', undefined, { sub: 42 }],
  ['a missing nonce', undefined, {}],
]) {
  test(`Cognito callback fails closed on ${name} and consumes the state`, async () => {
    const { cognito, calls } = service({ fetcher, claims });
    await withBoundaryRuntime(
      async (c) => {
        const flow = await start(c);
        await assertFailure(c, flow);
        assert.equal(calls.length, 1);
        await assertFailure(c, flow, { target: '/' });
        assert.equal(calls.length, 1, 'replay never repeats an exchange');
      },
      { options: { cognito } },
    );
  });
}

test('missing and oversized authorization codes never reach the provider', async () => {
  const { cognito, calls } = service();
  await withBoundaryRuntime(
    async (c) => {
      for (const code of ['', 'x'.repeat(2049)]) {
        const flow = await start(c);
        await assertFailure(c, flow, { code });
      }
      assert.equal(calls.length, 0);
    },
    { options: { cognito } },
  );
});

test('malformed, oversized and expired transaction cookies never reach the provider', async () => {
  const { cognito, calls } = service();
  await withBoundaryRuntime(
    async (c) => {
      const flow = await start(c);
      const value = JSON.parse(Buffer.from(flow.cookie.split('=')[1], 'base64url').toString());
      const cookies = [
        '__Host-rewind_oidc=not-json',
        `__Host-rewind_oidc=${'a'.repeat(4097)}`,
        ...[
          { ...value, expiresAt: BOUNDARY_NOW.getTime() },
          { ...value, expiresAt: String(value.expiresAt) },
          { ...value, codeVerifier: null },
          { ...value, nonce: 42 },
        ].map(
          (entry) =>
            `__Host-rewind_oidc=${Buffer.from(JSON.stringify(entry)).toString('base64url')}`,
        ),
      ];
      for (const cookie of cookies) await assertFailure(c, flow, { cookie, target: '/' });
      c.setNow(new Date(BOUNDARY_NOW.getTime() + 10 * 60 * 1000));
      await assertFailure(c, flow, { target: '/' });
      assert.equal(calls.length, 0);
    },
    { options: { cognito } },
  );
});

test('unsafe return paths fall back to the app root and unconfigured Cognito is unavailable', async () => {
  const { cognito } = service();
  await withBoundaryRuntime(
    async (c) => {
      for (const path of ['/has space', `/too-long?value=${'x'.repeat(2048)}`]) {
        const response = await c.request(`/auth/cognito/start?return=${encodeURIComponent(path)}`, {
          redirect: 'manual',
        });
        const cookie = transactionCookie(response).split(';')[0];
        const state = new URL(response.headers.get('location')).searchParams.get('state');
        await assertFailure(c, { cookie, state }, { code: '', target: '/' });
      }
    },
    { options: { cognito } },
  );
  await withBoundaryRuntime(async (c) => {
    const response = await c.request('/auth/cognito/start');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'cognito_unavailable');
  });
});

test('runtime Cognito configuration produces Managed Login redirects without contacting the provider', async () => {
  await withBoundaryRuntime(
    async (c) => {
      const response = await c.request('/auth/config');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { passwordSignIn: true, cognito: true });
      for (let attempt = 0; attempt < 2; attempt++) {
        const login = await c.request('/auth/cognito/start', { redirect: 'manual' });
        assert.equal(login.status, 302);
        const url = new URL(login.headers.get('location'));
        assert.equal(url.origin, `https://${config.domain}`);
        assert.equal(url.searchParams.get('client_id'), config.clientId);
        assert.equal(url.searchParams.get('redirect_uri'), `${c.baseUrl}/api/auth/callback`);
      }
    },
    {
      env: {
        REWIND_COGNITO_REGION: config.region,
        REWIND_COGNITO_USER_POOL_ID: config.userPoolId,
        REWIND_COGNITO_CLIENT_ID: config.clientId,
        REWIND_COGNITO_DOMAIN: config.domain,
      },
    },
  );
});
