import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';

const { parseConfig } = await import('../dist/config.js');
const { createRuntimeServer, authClientSource, authTransportIsSecure } =
  await import('../dist/http.js');
const { createRealAccount, resetRealAccountPassword, revokeRealSession, validateRealSession } =
  await import('../dist/auth/index.js');

function syntheticSummary(database) {
  return Object.fromEntries(
    ['profiles', 'groups', 'memberships', 'cycles', 'contributions', 'messages'].map((table) => [
      table,
      database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    ]),
  );
}

async function withRuntime(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-real-auth-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
  });
  const database = openFixtureDatabase(config);
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

async function postRegistration(baseUrl, username, password) {
  return fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

async function raceLoginWithReset(databasePath, account, ordering, reset) {
  const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(
    `(async () => {
       const { parentPort, workerData } = require('node:worker_threads');
       const { DatabaseSync } = require('node:sqlite');
       const gate = new Int32Array(workerData.gateBuffer);
       const database = new DatabaseSync(workerData.databasePath);
       database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
       const wrapped = {
         prepare(sql) {
           const statement = database.prepare(sql);
           if (!sql.includes('INSERT INTO real_account_sessions') || !sql.includes('SELECT ?, id')) {
             return statement;
           }
           return new Proxy(statement, {
             get(target, property) {
               if (property === 'run') {
                 return (...parameters) => {
                   if (workerData.ordering === 'reset-first') {
                     parentPort.postMessage({ phase: 'verified-before-insert' });
                     if (Atomics.wait(gate, 0, 0, 10000) === 'timed-out') {
                       throw new Error('timed out waiting for reset to commit');
                     }
                     return target.run(...parameters);
                   }
                   const result = target.run(...parameters);
                   parentPort.postMessage({ phase: 'inserted-before-reset' });
                   if (Atomics.wait(gate, 0, 0, 10000) === 'timed-out') {
                     throw new Error('timed out waiting for reset to commit');
                   }
                   return result;
                 };
               }
               const value = Reflect.get(target, property, target);
               return typeof value === 'function' ? value.bind(target) : value;
             },
           });
         },
       };
       try {
         const { authenticateRealAccount } = await import(workerData.authModuleUrl);
         const result = await authenticateRealAccount(
           wrapped,
           workerData.username,
           workerData.password,
           'race-test-source',
           new Date('2026-09-28T00:00:00.000Z'),
         );
         parentPort.postMessage({ result });
       } catch (error) {
         parentPort.postMessage({ error: String(error && error.stack ? error.stack : error) });
       } finally {
         database.close();
       }
     })();`,
    {
      eval: true,
      workerData: {
        authModuleUrl: new URL('../dist/auth/index.js', import.meta.url).href,
        databasePath,
        gateBuffer: gate.buffer,
        ordering,
        password: 'old correct password',
        username: account.username,
      },
    },
  );

  try {
    const [pause] = await once(worker, 'message');
    assert.equal(
      pause.phase,
      ordering === 'reset-first' ? 'verified-before-insert' : 'inserted-before-reset',
    );
    const resetResult = await reset();
    assert.equal(resetResult.ok, true);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const [completion] = await once(worker, 'message');
    if (completion.error) throw new Error(completion.error);
    return completion.result;
  } finally {
    if (Atomics.load(gate, 0) === 0) {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
    }
    await worker.terminate();
  }
}

test('additive auth migration and account reset preserve synthetic fixture-group data', async () => {
  await withRuntime(async ({ database, dataDir }) => {
    const seeded = syntheticSummary(database);
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
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM real_accounts').get().count, 2);
    assert.equal(
      JSON.stringify(
        database.prepare('SELECT password_hash, password_salt FROM real_accounts').all(),
      ).includes('correct horse'),
      false,
    );
    assert.deepEqual(syntheticSummary(database), seeded);

    const result = await resetRealAccountPassword(database, 'alice_1', 'replacement password 123');
    assert.equal(result.ok, true);
    assert.deepEqual(syntheticSummary(database), seeded);

    // Reopening the persisted database applies no destructive rebuild and
    // keeps the real-auth tables separate from the synthetic fixture records.
    const { DatabaseSync } = await import('node:sqlite');
    const { migrateDatabase } = await import('../dist/db.js');
    const reopened = new DatabaseSync(`${dataDir}/rewind.sqlite`);
    try {
      reopened.exec(`DROP TABLE reminder_outbox;
        DROP TABLE reminder_destinations;
        DROP TABLE real_account_sessions;
        DROP TABLE auth_login_throttles;
        DROP TABLE real_accounts;
        DELETE FROM schema_migration_markers WHERE migration_key = 'real-account-auth-v1';
        DELETE FROM schema_migrations WHERE version = 18;`);
      migrateDatabase(reopened);
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM profiles').get().count, 5);
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM real_accounts').get().count, 0);
      assert.deepEqual(syntheticSummary(reopened), seeded);
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
    authClientSource(
      {
        socket: { remoteAddress: '127.0.0.1', encrypted: false },
        headers: {
          host: 'api.example.test',
          'x-forwarded-proto': 'https',
          'x-rewind-origin-auth': 'edge-only-secret',
        },
      },
      config,
    ),
    '127.0.0.1',
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

    const current = await fetch(`${baseUrl}/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(current.status, 200);
    const restoredSession = await current.json();
    assert.equal(restoredSession.account.username, 'member.one');
    assert.equal(restoredSession.account.id, created.account.id);
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

test('session restore distinguishes a missing browser session from a revoked credential', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const missing = await fetch(`${baseUrl}/auth/session`);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error, 'session_required');

    const account = await createRealAccount(
      database,
      'session.restore',
      'Session Restore',
      'long correct password',
    );
    const login = await postLogin(baseUrl, account.account.username, 'long correct password');
    const { token } = await login.json();
    revokeRealSession(database, token, new Date('2026-09-28T00:00:00.000Z'));
    const revoked = await fetch(`${baseUrl}/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(revoked.status, 401);
    assert.equal((await revoked.json()).error, 'session_expired');
  });
});

test('a reset committed after password verification blocks session insertion on a separate connection', async () => {
  await withRuntime(async ({ database, dataDir }) => {
    const account = await createRealAccount(
      database,
      'race.user',
      'Race User',
      'old correct password',
    );
    assert.equal(account.ok, true);
    const separateConnection = new DatabaseSync(`${dataDir}/rewind.sqlite`);
    separateConnection.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    try {
      const result = await raceLoginWithReset(
        `${dataDir}/rewind.sqlite`,
        account.account,
        'reset-first',
        () => resetRealAccountPassword(separateConnection, 'race.user', 'new correct password'),
      );
      assert.deepEqual(result, { status: 'invalid' });
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM real_account_sessions').get().count,
        0,
      );
    } finally {
      separateConnection.close();
    }
  });
});

test('a reset committed after guarded session insertion revokes that session', async () => {
  await withRuntime(async ({ database, dataDir }) => {
    const account = await createRealAccount(
      database,
      'race.after',
      'Race After',
      'old correct password',
    );
    assert.equal(account.ok, true);
    const separateConnection = new DatabaseSync(`${dataDir}/rewind.sqlite`);
    separateConnection.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    try {
      const result = await raceLoginWithReset(
        `${dataDir}/rewind.sqlite`,
        account.account,
        'login-first',
        () => resetRealAccountPassword(separateConnection, 'race.after', 'new correct password'),
      );
      assert.equal(result.status, 'authenticated');
      assert.equal(validateRealSession(database, result.token).status, 'invalid');
      assert.ok(
        database
          .prepare('SELECT revoked_at FROM real_account_sessions ORDER BY created_at DESC LIMIT 1')
          .get().revoked_at,
      );
    } finally {
      separateConnection.close();
    }
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

test('public registration creates a sign-in-ready account without group membership', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const profilesBefore = database.prepare('SELECT COUNT(*) AS count FROM profiles').get().count;
    const registration = await postRegistration(
      baseUrl,
      '  new.member  ',
      'a secure registration password',
    );
    assert.equal(registration.status, 201);
    const registrationBody = await registration.json();
    assert.deepEqual(Object.keys(registrationBody), ['account']);
    assert.deepEqual(Object.keys(registrationBody.account), [
      'id',
      'username',
      'displayName',
      'createdAt',
      'updatedAt',
    ]);
    assert.equal(registrationBody.account.username, 'new.member');
    assert.equal(registrationBody.account.displayName, 'new.member');
    assert.equal(JSON.stringify(registrationBody).includes('secure registration password'), false);

    const signIn = await postLogin(baseUrl, 'NEW.MEMBER', 'a secure registration password');
    assert.equal(signIn.status, 200);
    const signInBody = await signIn.json();
    assert.equal(signInBody.account.id, registrationBody.account.id);
    assert.match(signInBody.token, /^[A-Za-z0-9_-]{43}$/);

    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM real_accounts').get().count, 1);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM real_group_memberships').get().count,
      0,
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM real_group_metadata').get().count,
      0,
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM profiles').get().count,
      profilesBefore,
    );
  });
});

test('registration gives the same safe failure for invalid, weak, and duplicate inputs', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const malformed = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    const invalid = await postRegistration(baseUrl, 'x', 'a secure password');
    const weak = await postRegistration(baseUrl, 'weak.pass', 'short');
    const created = await postRegistration(
      baseUrl,
      'duplicate.user',
      'a secure registration password',
    );
    const duplicate = await postRegistration(
      baseUrl,
      'DUPLICATE.USER',
      'a different secure password',
    );

    assert.equal(created.status, 201);
    assert.equal(malformed.status, 400);
    assert.equal(invalid.status, 400);
    assert.equal(weak.status, 400);
    assert.equal(duplicate.status, 409);
    const failures = await Promise.all([malformed.json(), invalid.json(), weak.json()]);
    assert.deepEqual(failures[0], failures[1]);
    assert.deepEqual(failures[1], failures[2]);
    assert.equal(failures[0].error, 'invalid_registration');
    assert.deepEqual(await duplicate.json(), {
      error: 'username_unavailable',
      message: 'This username is unavailable. Choose another username or sign in.',
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM real_accounts').get().count, 1);
  });
});

test('registration throttles repeated attempts before account creation', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await postRegistration(baseUrl, 'x', 'a secure password');
      assert.equal(response.status, 400);
    }

    const throttled = await postRegistration(
      baseUrl,
      'throttled.user',
      'a secure registration password',
    );
    assert.equal(throttled.status, 429);
    assert.equal(Number(throttled.headers.get('retry-after')) > 0, true);
    assert.deepEqual(await throttled.json(), {
      error: 'registration_rate_limited',
      message: 'Registration is temporarily unavailable. Please try again later.',
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM real_accounts').get().count, 0);
  });
});
