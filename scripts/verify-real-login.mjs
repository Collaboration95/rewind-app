#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_CREDENTIALS = '/private/tmp/rewind-issue-241-credentials-20260930.txt';
const TIMEOUT_MS = 12_000;

export function parseCredentials(contents) {
  const accounts = [...contents.matchAll(/Username:\s*([^\r\n]+)\r?\nPassword:\s*([^\r\n]+)/g)];
  if (accounts.length < 2) throw new Error('Expected two account blocks in credentials file.');
  return accounts
    .slice(0, 2)
    .map(([, username, password]) => ({ username: username.trim(), password: password.trim() }));
}

export function assertSecurePublicUrl(input) {
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Target must be a public HTTPS origin URL without embedded credentials, query, or fragment.',
    );
  }
  return url;
}

export function assertDirectOriginUrl(input) {
  const url = new URL(input);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Direct origin must be an HTTP or HTTPS origin URL without embedded credentials, query, or fragment.',
    );
  }
  return url;
}

function safeCookieHeader(response) {
  const value = response.headers.get('set-cookie') ?? '';
  const parts = value.split(';').map((part) => part.trim());
  const cookie = parts[0] ?? '';
  const attributes = new Set(parts.slice(1).map((part) => part.toLowerCase()));
  const valid =
    cookie.startsWith('__Host-rewind_session=') &&
    attributes.has('path=/') &&
    attributes.has('httponly') &&
    attributes.has('secure') &&
    attributes.has('samesite=lax') &&
    !attributes.has('domain');
  if (!valid) throw new Error('browser cookie flags did not satisfy policy');
  return cookie;
}

async function request(base, path, init = {}, fetcher = fetch) {
  const response = await fetcher(new URL(path, base), {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return response;
}

function expectStatus(response, status, name) {
  if (response.status !== status)
    throw new Error(`${name}: expected HTTP ${status}, received ${response.status}`);
}

export async function runForTest(base, accounts, directOrigin = null, fetcher = fetch) {
  const checks = [];
  const check = (name) => {
    checks.push(name);
    console.log(`PASS ${name}`);
  };

  const unsigned = await request(base, '/api/auth/session', {}, fetcher);
  expectStatus(unsigned, 401, 'unsigned session');
  check('unsigned session denied (401)');

  const login = await request(
    base,
    '/api/auth/login',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base.origin },
      body: JSON.stringify({ ...accounts[0], clientType: 'browser' }),
    },
    fetcher,
  );
  expectStatus(login, 200, 'login');
  const cookie = safeCookieHeader(login);
  check('real browser login and secure cookie flags');

  const restored = await request(base, '/api/auth/session', { headers: { cookie } }, fetcher);
  expectStatus(restored, 200, 'session restore');
  const restoreBody = await restored.json();
  if (
    !restoreBody.account ||
    typeof restoreBody.idleExpiresAt !== 'string' ||
    typeof restoreBody.absoluteExpiresAt !== 'string'
  ) {
    throw new Error('session restore response shape was invalid');
  }
  check('cookie session restore');

  const logout = await request(
    base,
    '/api/auth/logout',
    { method: 'POST', headers: { cookie } },
    fetcher,
  );
  expectStatus(logout, 200, 'logout');
  const clearCookie = (logout.headers.get('set-cookie') ?? '').toLowerCase();
  if (
    !clearCookie.startsWith('__host-rewind_session=') ||
    !clearCookie.includes('max-age=0') ||
    !clearCookie.includes('httponly') ||
    !clearCookie.includes('secure')
  ) {
    throw new Error('logout did not clear the secure session cookie');
  }
  expectStatus(
    await request(base, '/api/auth/session', { headers: { cookie } }, fetcher),
    401,
    'revoked session',
  );
  check('logout clears cookie and revokes session');

  const nativeLogin = await request(
    base,
    '/api/auth/login',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base.origin },
      body: JSON.stringify({ ...accounts[1], clientType: 'native' }),
    },
    fetcher,
  );
  expectStatus(nativeLogin, 200, 'native login');
  const nativeBody = await nativeLogin.json();
  if (typeof nativeBody.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nativeBody.token)) {
    throw new Error('native login did not return an opaque token of the expected shape');
  }
  const bearer = { authorization: `Bearer ${nativeBody.token}` };
  const bearerRestore = await request(base, '/api/auth/session', { headers: bearer }, fetcher);
  expectStatus(bearerRestore, 200, 'native bearer restore');
  const bearerBody = await bearerRestore.json();
  if (
    !bearerBody.account ||
    typeof bearerBody.idleExpiresAt !== 'string' ||
    typeof bearerBody.absoluteExpiresAt !== 'string'
  ) {
    throw new Error('native bearer restore response shape was invalid');
  }
  const nativeLogout = await request(
    base,
    '/api/auth/logout',
    { method: 'POST', headers: bearer },
    fetcher,
  );
  expectStatus(nativeLogout, 200, 'native logout');
  const nativeLogoutBody = await nativeLogout.json();
  if (nativeLogoutBody.signedOut !== true) throw new Error('native logout response was invalid');
  expectStatus(
    await request(base, '/api/auth/session', { headers: bearer }, fetcher),
    401,
    'revoked native session',
  );
  check('native bearer login, restore, logout, and revocation');

  const wrong = await request(
    base,
    '/api/auth/login',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base.origin },
      body: JSON.stringify({
        username: accounts[0].username,
        password: `${accounts[0].password}-incorrect`,
        clientType: 'browser',
      }),
    },
    fetcher,
  );
  expectStatus(wrong, 401, 'wrong password');
  const wrongBody = await wrong.json();
  if (
    wrongBody.error !== 'sign_in_failed' ||
    wrongBody.message !== 'Sign-in failed. Check your details or try later.'
  ) {
    throw new Error('wrong-password response was not generic');
  }
  check('one wrong-password attempt returns generic response');

  if (directOrigin) {
    const direct = await request(directOrigin, '/api/auth/session', {}, fetcher);
    const redirectedToHttps =
      direct.status >= 300 &&
      direct.status < 400 &&
      direct.headers.get('location')?.toLowerCase().startsWith('https://');
    if (direct.status !== 401 && direct.status !== 403 && !redirectedToHttps) {
      throw new Error(
        `direct-origin request expected denial or HTTPS redirect, received HTTP ${direct.status}`,
      );
    }
    check(
      redirectedToHttps
        ? 'direct-origin HTTP redirects to HTTPS'
        : `direct-origin request denied (${direct.status})`,
    );
  } else {
    console.log('SKIP direct-origin denial (REWIND_ORIGIN_AUTH_SECRET not provided)');
  }
  return checks;
}

async function main(args) {
  if (!args.includes('--run-live'))
    throw new Error('Live verification is gated; pass --run-live explicitly.');
  const target = process.env.REWIND_VERIFY_PUBLIC_URL;
  if (!target) throw new Error('Set REWIND_VERIFY_PUBLIC_URL to the public HTTPS origin.');
  const base = assertSecurePublicUrl(target);
  const directOrigin = process.env.REWIND_VERIFY_DIRECT_ORIGIN_URL
    ? assertDirectOriginUrl(process.env.REWIND_VERIFY_DIRECT_ORIGIN_URL)
    : null;
  const credentialsPath = process.env.REWIND_VERIFY_CREDENTIALS_FILE || DEFAULT_CREDENTIALS;
  const credentials = parseCredentials(await readFile(credentialsPath, 'utf8'));
  console.log(`Target: ${base.origin}`);
  await runForTest(base, credentials, directOrigin);
  console.log('Live verification completed. Credentials and response data were not printed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`FAIL ${error instanceof Error ? error.message : 'verification failed'}`);
    process.exitCode = 1;
  });
}
