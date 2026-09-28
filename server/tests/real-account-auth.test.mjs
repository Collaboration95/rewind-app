import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase, fixtureSummary } = await import('../dist/db.js');
const { createRuntimeServer, authClientSource, authTransportIsSecure } =
  await import('../dist/http.js');
const { createDemoSession } = await import('../dist/session/index.js');
const { createRealAccount, resetRealAccountPassword } = await import('../dist/auth/index.js');

async function withRuntime(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-real-auth-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
  });
  const database = openDatabase(config);
  const serverOptions = { now: () => new Date('2026-09-28T00:00:00.000Z') };
  const server = createRuntimeServer(config, database, serverOptions);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run({ baseUrl, config, database, server, dataDir });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function postLogin(baseUrl, username, password, clientType = 'native', extraHeaders = {}) {
  return fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ username, password, clientType }),
  });
}

test('additive auth migration and account reset preserve synthetic Demo data and sessions', async () => {
  await withRuntime(async ({ database, dataDir }) => {
    const seededDemo = fixtureSummary(database);
    const demoBefore = createDemoSession(database, { memberId: 'demo-1' });
    assert.equal(demoBefore.ok, true);
    const first = await createRealAccount(
      database,
      'Alice_1',
      'Alice One',
      'correct horse battery 1',
    );
    const second = await createRealAccount(database, 'Bob-2', 'Bob Two', 'correct horse battery 2');
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(
      database.prepare('SELECT password_salt FROM real_accounts WHERE id = ?').get(first.account.id)
        .password_salt,
      database
        .prepare('SELECT password_salt FROM real_accounts WHERE id = ?')
        .get(second.account.id).password_salt,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM profiles').get().count, 5);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM real_accounts').get().count, 2);
    assert.equal(
      JSON.stringify(
        database.prepare('SELECT password_hash, password_salt FROM real_accounts').all(),
      ).includes('correct horse'),
      false,
    );
    assert.deepEqual(fixtureSummary(database), {
      ...seededDemo,
      sessions: seededDemo.sessions + 1,
    });

    const result = await resetRealAccountPassword(database, 'alice_1', 'replacement password 123');
    assert.equal(result.ok, true);
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM sessions WHERE id = ?')
        .get(demoBefore.session.id).count,
      1,
    );

    // Reopening the persisted Demo database applies no destructive rebuild and
    // keeps the new real-auth tables separate from Demo records.
    const { DatabaseSync } = await import('node:sqlite');
    const { migrateDatabase } = await import('../dist/db.js');
    const reopened = new DatabaseSync(`${dataDir}/rewind.sqlite`);
    try {
      reopened.exec(`DROP TABLE real_account_sessions;
        DROP TABLE auth_login_throttles;
        DROP TABLE real_accounts;
        DELETE FROM schema_migration_markers WHERE migration_key = 'real-account-auth-v1';
        DELETE FROM schema_migrations WHERE version = 18;`);
      migrateDatabase(reopened);
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM profiles').get().count, 5);
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 2);
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM real_accounts').get().count, 0);
      assert.deepEqual(fixtureSummary(reopened), {
        ...seededDemo,
        sessions: seededDemo.sessions + 1,
      });
    } finally {
      reopened.close();
    }
  });
});

test('external auth transport rejects forged forwarded HTTPS without the origin secret', () => {
  const config = parseConfig({ REWIND_ORIGIN_AUTH_SECRET: 'edge-only-secret' });
  const request = {
    socket: { remoteAddress: '198.51.100.23', encrypted: false },
    headers: { host: 'api.example.test', 'x-forwarded-proto': 'https' },
  };
  assert.equal(authTransportIsSecure(request, config), false);
  assert.equal(
    authTransportIsSecure(
      {
        ...request,
        headers: {
          host: 'api.example.test',
          'x-forwarded-proto': 'https',
          'x-rewind-origin-auth': 'edge-only-secret',
        },
      },
      config,
    ),
    true,
  );
  assert.equal(
    authClientSource(
      {
        socket: { remoteAddress: '127.0.0.1', encrypted: false },
        headers: {
          host: 'api.example.test',
          'x-forwarded-proto': 'https',
          'x-rewind-origin-auth': 'edge-only-secret',
          'x-rewind-client-address': '203.0.113.9',
        },
      },
      config,
    ),
    '203.0.113.9',
  );
  assert.equal(
    authTransportIsSecure(
      {
        ...request,
        headers: {
          host: 'api.example.test',
          'x-forwarded-proto': 'http',
          'x-rewind-origin-auth': 'edge-only-secret',
        },
      },
      config,
    ),
    false,
  );
  const localConfig = parseConfig({ REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true' });
  assert.equal(
    authTransportIsSecure(
      {
        socket: { remoteAddress: '127.0.0.1', encrypted: false },
        headers: { host: '127.0.0.1:8787' },
      },
      localConfig,
    ),
    true,
  );
  assert.equal(
    authTransportIsSecure(
      {
        socket: { remoteAddress: '127.0.0.1', encrypted: false },
        headers: { host: 'rewind.example.test' },
      },
      localConfig,
    ),
    false,
  );
  const hostedLoopbackProxyRequest = {
    socket: { remoteAddress: '127.0.0.1', encrypted: false },
    headers: { host: 'api.example.test', 'x-forwarded-proto': 'https' },
  };
  assert.equal(
    authTransportIsSecure(
      hostedLoopbackProxyRequest,
      parseConfig({ REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true' }),
    ),
    false,
  );
  assert.equal(
    authTransportIsSecure(
      {
        ...hostedLoopbackProxyRequest,
        headers: {
          ...hostedLoopbackProxyRequest.headers,
          'x-rewind-origin-auth': 'edge-only-secret',
        },
      },
      config,
    ),
    true,
  );
});

test('auth preflight and failure responses never expose wildcard CORS', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const preflight = await fetch(`${baseUrl}/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://untrusted.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.notEqual(preflight.headers.get('access-control-allow-origin'), '*');

    const unsupported = await fetch(`${baseUrl}/auth/login`, { method: 'PUT' });
    assert.equal(unsupported.status, 405);
    assert.notEqual(unsupported.headers.get('access-control-allow-origin'), '*');

    const oversized = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'user.name',
        password: 'x'.repeat(70_000),
        clientType: 'native',
      }),
    });
    assert.equal(oversized.status, 413);
    assert.notEqual(oversized.headers.get('access-control-allow-origin'), '*');
  });
});

test('real login returns an opaque native token, supports current/logout, and browser cookies stay secure', async () => {
  await withRuntime(async ({ baseUrl, config, database }) => {
    const created = await createRealAccount(
      database,
      'member.one',
      'Member One',
      'long correct password',
    );
    assert.equal(created.ok, true);
    const login = await postLogin(baseUrl, 'MEMBER.ONE', 'long correct password');
    assert.equal(login.status, 200);
    const { token, account } = await login.json();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(account.id, created.account.id);
    assert.notEqual(
      database.prepare('SELECT token_hash FROM real_account_sessions').get().token_hash,
      token,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);

    const current = await fetch(`${baseUrl}/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(current.status, 200);
    assert.equal((await current.json()).account.username, 'member.one');
    const queryToken = await fetch(`${baseUrl}/auth/session?token=${token}`);
    assert.equal(queryToken.status, 401);

    config.allowOrigin = baseUrl;
    const browserLogin = await postLogin(
      baseUrl,
      'member.one',
      'long correct password',
      'browser',
      {
        Origin: baseUrl,
      },
    );
    assert.equal(browserLogin.status, 200);
    const cookie = browserLogin.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.equal(cookie.includes(token), false);
    assert.equal(browserLogin.headers.get('access-control-allow-origin'), baseUrl);
    assert.equal(browserLogin.headers.get('access-control-allow-credentials'), 'true');

    const cookieToken = cookie.match(/__Host-rewind_session=([^;]+)/)[1];
    const browserCurrent = await fetch(`${baseUrl}/auth/session`, {
      headers: { Cookie: `__Host-rewind_session=${cookieToken}` },
    });
    assert.equal(browserCurrent.status, 200);
    assert.match(browserCurrent.headers.get('set-cookie'), /Max-Age=/);

    const rejectedOrigin = await postLogin(
      baseUrl,
      'member.one',
      'long correct password',
      'browser',
      {
        Origin: 'https://attacker.example',
      },
    );
    assert.equal(rejectedOrigin.status, 403);
    assert.notEqual(rejectedOrigin.headers.get('access-control-allow-origin'), '*');

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(logout.status, 200);
    const revoked = await fetch(`${baseUrl}/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(revoked.status, 401);
  });
});

test('wrong credentials are generic, throttled by account and source, and reset revokes sessions', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    await createRealAccount(database, 'limit.user', 'Limit User', 'long correct password');
    let last;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      last = await postLogin(baseUrl, 'limit.user', 'wrong password value');
      assert.equal(last.status, 401);
    }
    const badBody = await last.json();
    const throttled = await postLogin(baseUrl, 'limit.user', 'long correct password');
    assert.equal(throttled.status, 401);
    assert.deepEqual(await throttled.json(), badBody);
    assert.equal(
      database.prepare('SELECT MAX(cooldown_level) AS level FROM auth_login_throttles').get().level,
      1,
    );

    database
      .prepare('UPDATE auth_login_throttles SET cooldown_until = ?')
      .run('2026-09-27T23:00:00.000Z');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await postLogin(baseUrl, 'limit.user', 'wrong password value');
    }
    assert.equal(
      database.prepare('SELECT MAX(cooldown_level) AS level FROM auth_login_throttles').get().level,
      2,
    );
    const cooldown = Date.parse(
      database
        .prepare(
          `SELECT cooldown_until FROM auth_login_throttles
      WHERE scope = 'account'`,
        )
        .get().cooldown_until,
    );
    assert.equal(cooldown, Date.parse('2026-09-28T00:00:00.000Z') + 30 * 60 * 1000);

    const { token } = await (
      await postLogin(baseUrl, 'limit.user', 'long correct password', 'native', {
        'X-Forwarded-Proto': 'https',
      })
    )
      .json()
      .catch(() => ({}));
    assert.equal(token, undefined);

    const otherSource = await postLogin(baseUrl, 'limit.user', 'long correct password', 'native', {
      Origin: 'https://evil.example',
    });
    assert.equal(otherSource.status, 403);
    assert.notEqual(otherSource.headers.get('access-control-allow-origin'), '*');
  });
});

test('parallel guesses cannot race past the five-failure cooldown', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    await createRealAccount(database, 'parallel.user', 'Parallel User', 'long correct password');
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => postLogin(baseUrl, 'parallel.user', 'wrong password value')),
    );
    assert.ok(responses.every((response) => response.status === 401));
    assert.equal(
      database
        .prepare(`SELECT cooldown_level FROM auth_login_throttles WHERE scope = 'account'`)
        .get().cooldown_level,
      1,
    );
    const correct = await postLogin(baseUrl, 'parallel.user', 'long correct password');
    assert.equal(correct.status, 401);
  });
});

test('session idle and absolute expiry are enforced, and reset revokes tokens', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    await createRealAccount(database, 'expiry.user', 'Expiry User', 'long correct password');
    const response = await postLogin(baseUrl, 'expiry.user', 'long correct password');
    const { token } = await response.json();
    const tokenHash = database
      .prepare('SELECT token_hash FROM real_account_sessions')
      .get().token_hash;
    database
      .prepare('UPDATE real_account_sessions SET idle_expires_at = ? WHERE token_hash = ?')
      .run('2026-09-27T23:59:00.000Z', tokenHash);
    const idleExpired = await fetch(`${baseUrl}/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(idleExpired.status, 401);
    assert.ok(
      database
        .prepare('SELECT revoked_at FROM real_account_sessions WHERE token_hash = ?')
        .get(tokenHash).revoked_at,
    );

    const next = await postLogin(baseUrl, 'expiry.user', 'long correct password');
    const fresh = await next.json();
    await resetRealAccountPassword(database, 'expiry.user', 'new password long enough');
    const revoked = await fetch(`${baseUrl}/auth/session`, {
      headers: { Authorization: `Bearer ${fresh.token}` },
    });
    assert.equal(revoked.status, 401);
    const oldPassword = await postLogin(baseUrl, 'expiry.user', 'long correct password');
    assert.equal(oldPassword.status, 401);
    const newPassword = await postLogin(baseUrl, 'expiry.user', 'new password long enough');
    assert.equal(newPassword.status, 200);
    const finalSession = await newPassword.json();
    const finalHash = database
      .prepare('SELECT token_hash FROM real_account_sessions ORDER BY rowid DESC LIMIT 1')
      .get().token_hash;
    database
      .prepare('UPDATE real_account_sessions SET absolute_expires_at = ? WHERE token_hash = ?')
      .run('2026-09-27T23:59:00.000Z', finalHash);
    const absoluteExpired = await fetch(`${baseUrl}/auth/session`, {
      headers: { Authorization: `Bearer ${finalSession.token}` },
    });
    assert.equal(absoluteExpired.status, 401);
  });
});

test('malformed and duplicate account input has no partial writes', async () => {
  await withRuntime(async ({ database }) => {
    assert.deepEqual(await createRealAccount(database, 'x', 'Broken', 'long correct password'), {
      ok: false,
      reason: 'invalid',
    });
    const created = await createRealAccount(
      database,
      'valid.name',
      'Valid Name',
      'long correct password',
    );
    const duplicate = await createRealAccount(
      database,
      'VALID.NAME',
      'Duplicate',
      'another long password',
    );
    assert.equal(created.ok, true);
    assert.deepEqual(duplicate, { ok: false, reason: 'duplicate' });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM real_accounts').get().count, 1);
  });
});
