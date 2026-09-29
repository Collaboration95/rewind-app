import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDirectOriginUrl,
  assertSecurePublicUrl,
  parseCredentials,
  runForTest,
} from '../scripts/verify-real-login.mjs';

test('parses two credentials without revealing them and requires HTTPS', () => {
  const result = parseCredentials(
    'Username: first.user\nPassword: first-secret\nUsername: second.user\nPassword: second-secret\n',
  );
  assert.deepEqual(result, [
    { username: 'first.user', password: 'first-secret' },
    { username: 'second.user', password: 'second-secret' },
  ]);
  assert.throws(() => parseCredentials('Username: one\nPassword: only-one\n'));
  assert.equal(assertSecurePublicUrl('https://example.test').origin, 'https://example.test');
  for (const url of [
    'http://example.test',
    'https://user:pass@example.test',
    'https://example.test/path?q=secret',
  ]) {
    assert.throws(() => assertSecurePublicUrl(url));
  }
  assert.equal(assertDirectOriginUrl('http://192.0.2.10').protocol, 'http:');
  assert.throws(() => assertDirectOriginUrl('http://user:pass@192.0.2.10'));
});

test('verifies the complete auth lifecycle and generic failure against local HTTPS fixture', async () => {
  const fixtureAccounts = [
    { username: 'first.user', password: 'first-private-test-password' },
    { username: 'second.user', password: 'second-private-test-password' },
  ];
  let token = '';
  let nativeToken = '';
  let loggedOut = false;
  let nativeLoggedOut = false;
  let directProbeHeaders;
  const fixtureFetch = async (input, init = {}) => {
    const parsedUrl = new URL(input);
    const path = parsedUrl.pathname;
    if (parsedUrl.hostname === '192.0.2.10') {
      directProbeHeaders = new Headers(init.headers);
      return new Response(null, {
        status: 302,
        headers: { location: 'https://origin.example.test/api/auth/session' },
      });
    }
    const headers = new Headers(init.headers);
    const cookie = headers.get('cookie') ?? '';
    if (path === '/api/auth/session' && !cookie && !headers.has('authorization')) {
      return Response.json({ error: 'session_required' }, { status: 401 });
    }
    if (path === '/api/auth/login') {
      const parsed = JSON.parse(init.body);
      if (
        parsed.clientType === 'native' &&
        parsed.username === fixtureAccounts[1].username &&
        parsed.password === fixtureAccounts[1].password
      ) {
        nativeToken = 'N'.repeat(43);
        return Response.json({
          account: { id: 'native-fixture', username: parsed.username },
          token: nativeToken,
          expiresAt: 'later',
        });
      }
      if (
        parsed.clientType === 'browser' &&
        parsed.username === fixtureAccounts[0].username &&
        parsed.password === fixtureAccounts[0].password
      ) {
        token = 'fixture-session-token';
        return Response.json(
          { account: { id: 'fixture', username: parsed.username }, expiresAt: 'later' },
          {
            status: 200,
            headers: {
              'set-cookie': `__Host-rewind_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
            },
          },
        );
      }
      return Response.json(
        { error: 'sign_in_failed', message: 'Sign-in failed. Check your details or try later.' },
        { status: 401 },
      );
    }
    if (
      path === '/api/auth/session' &&
      headers.get('authorization') === `Bearer ${nativeToken}` &&
      !nativeLoggedOut
    ) {
      return Response.json({
        account: { id: 'native-fixture' },
        idleExpiresAt: 'later',
        absoluteExpiresAt: 'later',
      });
    }
    if (path === '/api/auth/session' && cookie.includes(token) && !loggedOut) {
      return Response.json({
        account: { id: 'fixture' },
        idleExpiresAt: 'later',
        absoluteExpiresAt: 'later',
      });
    }
    if (path === '/api/auth/logout') {
      if (headers.has('authorization')) {
        nativeLoggedOut = true;
        return Response.json({ signedOut: true });
      }
      loggedOut = true;
      return Response.json(
        { signedOut: true },
        {
          status: 200,
          headers: {
            'set-cookie':
              '__Host-rewind_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
          },
        },
      );
    }
    return Response.json({ error: 'session_required' }, { status: 401 });
  };
  const checks = await runForTest(
    new URL('https://public.example.test'),
    fixtureAccounts,
    new URL('http://192.0.2.10'),
    fixtureFetch,
  );
  assert.equal(checks.length, 7);
  assert.equal(directProbeHeaders.has('authorization'), false);
  assert.equal(directProbeHeaders.has('cookie'), false);
});
