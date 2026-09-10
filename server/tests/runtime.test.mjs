import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { fixtureSummary, openDatabase, resetDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');

async function withRuntime(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-runtime-test-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_FFMPEG_BIN: 'ffmpeg',
  });
  const database = openDatabase(config);
  const server = createRuntimeServer(config, database);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run({ baseUrl, config, database });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('configuration rejects an unsafe bind address with an actionable hint', async () => {
  assert.throws(
    () => parseConfig({ REWIND_HOST: 'public.example.com' }),
    /local or LAN-safe bind address.*127\.0\.0\.1.*0\.0\.0\.0/,
  );
});

test('fresh migration, restart, and reset preserve or restore deterministic state', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-db-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  try {
    let database = openDatabase(config);
    const seeded = fixtureSummary(database);
    assert.deepEqual(seeded, {
      profiles: 5,
      groups: 1,
      memberships: 5,
      invites: 1,
      cycles: 1,
      sessions: 1,
      contributions: 1,
      media_jobs: 3,
      messages: 1,
      reactions: 1,
    });
    database
      .prepare('UPDATE memberships SET role = ? WHERE group_id = ? AND member_id = ?')
      .run('owner', 'demo-group', 'demo-1');
    database.close();

    database = openDatabase(config);
    assert.deepEqual(fixtureSummary(database), seeded);
    assert.equal(
      database
        .prepare('SELECT role FROM memberships WHERE group_id = ? AND member_id = ?')
        .get('demo-group', 'demo-1').role,
      'owner',
    );
    database.close();

    resetDatabase(config);
    database = openDatabase(config);
    assert.deepEqual(fixtureSummary(database), seeded);
    assert.equal(
      database
        .prepare('SELECT role FROM memberships WHERE group_id = ? AND member_id = ?')
        .get('demo-group', 'demo-1').role,
      'member',
    );
    database.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('health and typed fixture endpoints are reachable over the local service', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.service, 'rewind-local-runtime');
    assert.equal(health.ready, true);

    const profiles = await fetch(`${baseUrl}/profiles`).then((response) => response.json());
    assert.equal(profiles.profiles.length, 5);

    const group = await fetch(`${baseUrl}/groups/current?memberId=demo-1`).then((response) =>
      response.json(),
    );
    assert.equal(group.group.id, 'demo-group');
    const cycle = await fetch(`${baseUrl}/cycles/current?groupId=demo-group&memberId=demo-1`).then(
      (response) => response.json(),
    );
    assert.equal(cycle.cycle.id, 'demo-cycle');
  });
});

test('every protected endpoint category returns the same safe denial to a non-member', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const paths = [
      '/groups/demo-group',
      '/cycles/current?groupId=demo-group',
      '/messages/demo-message?groupId=demo-group',
      '/contributions/demo-contribution?groupId=demo-group',
      '/clips/demo-clip?groupId=demo-group',
      '/films/demo-film?groupId=demo-group',
      '/downloads/demo-download?groupId=demo-group',
    ];
    const responses = await Promise.all(
      paths.map(async (path) => {
        const response = await fetch(`${baseUrl}${path}&memberId=demo-outsider`);
        return { status: response.status, body: await response.json() };
      }),
    );
    for (const result of responses) {
      assert.equal(result.status, 403);
      assert.deepEqual(result.body, {
        allowed: false,
        status: 403,
        error: 'forbidden',
        message: 'You do not have access to this resource.',
      });
    }

    const allowed = await fetch(`${baseUrl}/films/demo-film?groupId=demo-group&memberId=demo-1`);
    assert.equal(allowed.status, 200);
  });
});
