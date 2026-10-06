import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';

const { parseConfig } = await import('../dist/config.js');
const { createRuntimeServer } = await import('../dist/http.js');

const PASSWORD = 'correct-horse-battery-staple';
const basic = (user, password) => `Basic ${btoa(`${user}:${password}`)}`;

async function serve(env, run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-admin-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_PORT: '0', ...env });
  const database = openFixtureDatabase(config);
  database
    .prepare(
      `INSERT INTO real_accounts (id, username, normalized_username, display_name, password_salt,
         password_hash, password_scrypt_n, password_scrypt_r, password_scrypt_p, created_at, updated_at)
       VALUES ('acct-1', 'Alice', 'alice', '<b>Alice</b>', 'salt-secret', 'hash-secret', 1, 1, 1, 'now', 'now')`,
    )
    .run();
  const server = createRuntimeServer(config, database);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((done) => server.close(done));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('admin page is off unless REWIND_ADMIN_PASSWORD is set', async () => {
  await serve({ REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true' }, async (base) => {
    const response = await fetch(`${base}/admin/`, {
      headers: { Authorization: basic('admin', PASSWORD) },
    });
    assert.equal(response.status, 404);
  });
  assert.throws(() => parseConfig({ REWIND_ADMIN_PASSWORD: 'short' }), /at least 16/);
});

test('admin page refuses plain HTTP that did not come through the HTTPS edge', async () => {
  await serve({ REWIND_ADMIN_PASSWORD: PASSWORD }, async (base) => {
    const response = await fetch(`${base}/admin/`, {
      headers: { Authorization: basic('admin', PASSWORD) },
    });
    assert.equal(response.status, 403);
  });
});

test('admin page requires the shared login and hides secrets', async () => {
  await serve(
    { REWIND_ADMIN_PASSWORD: PASSWORD, REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true' },
    async (base) => {
      const missing = await fetch(`${base}/admin/`);
      assert.equal(missing.status, 401);
      assert.match(missing.headers.get('www-authenticate'), /^Basic /);
      for (const wrong of [basic('admin', 'nope'), basic('root', PASSWORD), 'Bearer x']) {
        const response = await fetch(`${base}/admin/`, { headers: { Authorization: wrong } });
        assert.equal(response.status, 401);
      }

      const headers = { Authorization: basic('admin', PASSWORD) };
      const index = await fetch(`${base}/admin/`, { headers });
      assert.equal(index.status, 200);
      assert.equal(index.headers.get('cache-control'), 'no-store');
      assert.match(await index.text(), /href="t\/real_accounts">real_accounts<\/a><\/td><td>1</);

      const table = await (await fetch(`${base}/admin/t/real_accounts`, { headers })).text();
      assert.match(table, /alice/);
      assert.match(table, /&lt;b&gt;Alice&lt;\/b&gt;/);
      assert.doesNotMatch(table, /hash-secret|salt-secret/);
      assert.match(table, /<i>hidden<\/i>/);

      const unknown = await fetch(`${base}/admin/t/${encodeURIComponent('x"; DROP')}`, {
        headers,
      });
      assert.equal(unknown.status, 404);
      const write = await fetch(`${base}/admin/`, { method: 'POST', headers });
      assert.equal(write.status, 404);
    },
  );
});
