import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');

const SAFE_DENIAL = {
  allowed: false,
  status: 403,
  error: 'forbidden',
  message: 'You do not have access to this resource.',
};

async function withSecondGroup(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-cross-group-test-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
  });
  const database = openDatabase(config);
  database.exec(`
    INSERT INTO profiles (id, display_name, avatar_label, is_synthetic)
      VALUES ('demo-6', 'Fable', 'Fable, second-group member', 1);
    INSERT INTO groups (id, name, current_cycle_id)
      VALUES ('other-group', 'Other People', 'other-cycle');
    INSERT INTO cycles
      (id, group_id, prompt, starts_at, ends_at, status, lock_state,
       max_count, max_seconds, count_used, seconds_used)
      VALUES
      ('other-cycle', 'other-group', 'A second private prompt',
       '2026-09-01T00:00:00.000Z', '2026-09-12T00:00:00.000Z',
       'collecting', 'locked', 5, 30, 0, 0);
    INSERT INTO memberships (group_id, member_id, role, accepted_at)
      VALUES ('other-group', 'demo-6', 'member', '2026-09-01T00:00:00.000Z');
    INSERT INTO invites (id, group_id, invitee_member_id, status, created_at)
      VALUES ('other-invite', 'other-group', 'demo-6', 'accepted', '2026-09-01T00:00:00.000Z');
    INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
      VALUES ('other-contribution', 'other-cycle', 'demo-6', 4, '2026-09-01T00:00:00.000Z');
    INSERT INTO media_jobs (id, group_id, contribution_id, kind, status, output_path, created_at)
      VALUES
      ('other-clip', 'other-group', 'other-contribution', 'clip', 'ready', NULL, '2026-09-01T00:00:00.000Z'),
      ('other-film', 'other-group', NULL, 'film', 'ready', NULL, '2026-09-01T00:00:00.000Z'),
      ('other-download', 'other-group', NULL, 'download', 'ready', NULL, '2026-09-01T00:00:00.000Z');
    INSERT INTO messages (id, group_id, member_id, body, created_at)
      VALUES ('other-message', 'other-group', 'demo-6', 'A second private message.', '2026-09-01T00:00:00.000Z');
  `);
  const server = createRuntimeServer(config, database);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run({ baseUrl, database });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function createSession(baseUrl, memberId, groupId) {
  const response = await fetch(`${baseUrl}/sessions/demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, groupId }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).session;
}

test('every exposed protected category denies a member of another group without content', async () => {
  await withSecondGroup(async ({ baseUrl }) => {
    const session = await createSession(baseUrl, 'demo-6', 'other-group');
    const sessionQuery = `&sessionId=${encodeURIComponent(session.id)}`;
    const resourceCases = [
      { name: 'groups', path: `/groups/demo-group?memberId=demo-1${sessionQuery}` },
      { name: 'cycles', path: `/cycles/current?groupId=demo-group&memberId=demo-1${sessionQuery}` },
      {
        name: 'messages',
        path: `/messages/demo-message?groupId=demo-group&memberId=demo-1${sessionQuery}`,
      },
      {
        name: 'contributions',
        path: `/contributions/demo-contribution?groupId=demo-group&memberId=demo-1${sessionQuery}`,
      },
      { name: 'clips', path: `/clips/demo-clip?groupId=demo-group&memberId=demo-1${sessionQuery}` },
      { name: 'films', path: `/films/demo-film?groupId=demo-group&memberId=demo-1${sessionQuery}` },
      {
        name: 'downloads',
        path: `/downloads/demo-download?groupId=demo-group&memberId=demo-1${sessionQuery}`,
      },
    ];
    for (const resource of resourceCases) {
      const response = await fetch(`${baseUrl}${resource.path}`);
      assert.equal(response.status, 403, resource.name);
      assert.deepEqual(await response.json(), SAFE_DENIAL, resource.name);
    }
  });
});

test('each protected category remains readable for the member of its own group', async () => {
  await withSecondGroup(async ({ baseUrl }) => {
    const session = await createSession(baseUrl, 'demo-6', 'other-group');
    const suffix = `&sessionId=${encodeURIComponent(session.id)}&memberId=demo-1`;
    const ownPaths = [
      `/groups/other-group?${suffix.slice(1)}`,
      `/cycles/current?groupId=other-group${suffix}`,
      `/messages/other-message?groupId=other-group${suffix}`,
      `/contributions/other-contribution?groupId=other-group${suffix}`,
      `/clips/other-clip?groupId=other-group${suffix}`,
      `/films/other-film?groupId=other-group${suffix}`,
      `/downloads/other-download?groupId=other-group${suffix}`,
    ];
    for (const path of ownPaths) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200, path);
      const body = await response.json();
      assert.equal(Object.keys(body).length, 1, path);
    }
  });
});

test('a member of another group cannot use the owner-only cycle control', async () => {
  await withSecondGroup(async ({ baseUrl, database }) => {
    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-6', groupId: 'other-group' }),
    });
    assert.equal(sessionResponse.status, 201);
    const { session } = await sessionResponse.json();
    const response = await fetch(
      `${baseUrl}/cycles/demo/advance?groupId=demo-group&memberId=demo-1&sessionId=${encodeURIComponent(session.id)}&advanceSeconds=60`,
      { method: 'POST' },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), SAFE_DENIAL);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM cycle_control_events').get().count,
      0,
    );
  });
});

test('a session from another group cannot inspect or play a group premiere', async () => {
  await withSecondGroup(async ({ baseUrl }) => {
    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-6', groupId: 'other-group' }),
    });
    const { session } = await sessionResponse.json();
    const response = await fetch(
      `${baseUrl}/cycles/demo-cycle/premiere?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`,
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), SAFE_DENIAL);
  });
});

test('a session from another group cannot operate the local Demo reveal control', async () => {
  await withSecondGroup(async ({ baseUrl }) => {
    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-6', groupId: 'other-group' }),
    });
    const { session } = await sessionResponse.json();
    const response = await fetch(
      `${baseUrl}/demo/reveal?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`,
      { method: 'POST' },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), SAFE_DENIAL);
  });
});

test('a session from another group cannot create a synthetic Demo contribution', async () => {
  await withSecondGroup(async ({ baseUrl }) => {
    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-6', groupId: 'other-group' }),
    });
    const { session } = await sessionResponse.json();
    const response = await fetch(
      `${baseUrl}/demo/synthetic-clip?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`,
      { method: 'POST' },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), SAFE_DENIAL);
  });
});

test('invite creation binds the requested group to the session context', async () => {
  await withSecondGroup(async ({ baseUrl }) => {
    const session = await createSession(baseUrl, 'demo-6', 'other-group');
    const response = await fetch(
      `${baseUrl}/invites?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`,
      { method: 'POST' },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), SAFE_DENIAL);
  });
});
