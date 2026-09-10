import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { fixtureSummary, openDatabase, resetDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { createGroup } = await import('../dist/groups/index.js');

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
      'owner',
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

test('local group creation validates before writing and creates an owner one-day cycle atomically', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-group-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  try {
    const baseline = fixtureSummary(database);
    const invalid = createGroup(database, 'demo-1', {
      name: '   ',
      prompt: 'A valid prompt',
      now: new Date('2026-09-10T12:00:00.000Z'),
    });
    assert.deepEqual(invalid, { ok: false, field: 'name', reason: 'required' });
    assert.deepEqual(fixtureSummary(database), baseline);

    const tooLong = createGroup(database, 'demo-1', {
      name: 'A valid group',
      prompt: 'x'.repeat(161),
      now: new Date('2026-09-10T12:00:00.000Z'),
    });
    assert.deepEqual(tooLong, { ok: false, field: 'prompt', reason: 'too_long' });
    assert.deepEqual(fixtureSummary(database), baseline);

    const created = createGroup(database, 'demo-1', {
      name: '  Saturday table  ',
      prompt: '  What is worth keeping?  ',
      now: new Date('2026-09-10T12:00:00.000Z'),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.group.name, 'Saturday table');
    assert.equal(created.group.actingMemberRole, 'owner');
    assert.equal(created.cycle.prompt, 'What is worth keeping?');
    assert.equal(created.cycle.status, 'collecting');
    assert.equal(created.cycle.lockState, 'locked');
    assert.equal(
      Date.parse(created.cycle.endsAt) - Date.parse(created.cycle.startsAt),
      24 * 60 * 60 * 1000,
    );
    assert.equal(
      database
        .prepare('SELECT role FROM memberships WHERE group_id = ? AND member_id = ?')
        .get(created.group.id, 'demo-1').role,
      'owner',
    );
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Demo session and group HTTP mutations preserve the selected group context', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-2' }),
    });
    assert.equal(sessionResponse.status, 201);
    const { session } = await sessionResponse.json();

    const groupResponse = await fetch(
      `${baseUrl}/groups?sessionId=${encodeURIComponent(session.id)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Walk home', prompt: 'What did you notice?' }),
      },
    );
    assert.equal(groupResponse.status, 201);
    const created = await groupResponse.json();
    assert.equal(created.group.actingMemberRole, 'owner');
    assert.equal(
      Date.parse(created.cycle.endsAt) - Date.parse(created.cycle.startsAt),
      24 * 60 * 60 * 1000,
    );

    const current = await fetch(
      `${baseUrl}/groups/current?sessionId=${encodeURIComponent(session.id)}`,
    );
    assert.equal(current.status, 200);
    assert.equal((await current.json()).group.id, created.group.id);
  });
});

test('local Demo reset endpoint restores the deterministic fixture and removes created groups', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-1' }),
    });
    const { session } = await sessionResponse.json();
    const groupResponse = await fetch(
      `${baseUrl}/groups?sessionId=${encodeURIComponent(session.id)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Temporary group', prompt: 'Temporary prompt' }),
      },
    );
    assert.equal(groupResponse.status, 201);
    assert.equal(fixtureSummary(database).groups, 2);

    const reset = await fetch(`${baseUrl}/demo/reset?sessionId=${encodeURIComponent(session.id)}`, {
      method: 'POST',
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(fixtureSummary(database), {
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
  });
});
