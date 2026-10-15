import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import test from 'node:test';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';
import { createTestTrigger } from './helpers/dialect.mjs';

const { parseConfig } = await import('../dist/config.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { createRealAccount } = await import('../dist/auth/index.js');
const { createCycleWindow } = await import('../dist/cycles/engine.js');
const { validateRealGroupInput } = await import('../dist/groups/real.js');

const listProfiles = (database) =>
  database.prepare('SELECT * FROM profiles WHERE is_synthetic = 1 ORDER BY id').all();

async function withRuntime(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-real-groups-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
  });
  let database = openFixtureDatabase(config);
  let server;
  const startServer = async () => {
    server = createRuntimeServer(config, database, {
      now: () => new Date('2026-09-28T00:00:00.000Z'),
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  };
  let baseUrl = await startServer();
  const restart = async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    database = openFixtureDatabase(config);
    baseUrl = await startServer();
    return baseUrl;
  };
  try {
    await run({ baseUrl, database, restart });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function provision(baseUrl, database, username = 'real-owner') {
  const created = await createRealAccount(
    database,
    username,
    'Real Owner',
    'a sufficiently long pilot password',
    new Date('2026-09-28T00:00:00.000Z'),
  );
  assert.equal(created.ok, true);
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'a sufficiently long pilot password',
      clientType: 'native',
    }),
  });
  assert.equal(login.status, 200);
  const auth = await login.json();
  return { account: created.account, authorization: `Bearer ${auth.token}` };
}

test('real groups require a real session and are isolated from fixture-group profiles and memberships', async () => {
  await withRuntime(async ({ baseUrl, database, restart }) => {
    const profilesBefore = listProfiles(database);
    const fixtureMembershipCount = Number(
      database.prepare('SELECT COUNT(*) AS n FROM memberships').get().n,
    );
    const fixtureCycle = database
      .prepare('SELECT id, starts_at, ends_at FROM cycles ORDER BY id LIMIT 1')
      .get();
    const unauthenticated = await fetch(`${baseUrl}/real/groups/current`);
    assert.equal(unauthenticated.status, 401);
    const deniedCreate = await fetch(`${baseUrl}/real/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Private', prompt: 'A moment', maxMembers: 4 }),
    });
    assert.equal(deniedCreate.status, 401);

    const { account, authorization } = await provision(baseUrl, database);
    const response = await fetch(`${baseUrl}/real/groups`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '  Saturday table  ',
        prompt: '  What should we remember?  ',
        maxMembers: 4,
      }),
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.group.name, 'Saturday table');
    assert.equal(result.group.role, 'owner');
    assert.equal(result.group.maxMembers, 4);
    assert.equal(result.cycle.prompt, 'What should we remember?');
    assert.equal(
      Date.parse(result.cycle.endsAt) - Date.parse(result.cycle.startsAt),
      28 * 86400000,
    );
    assert.equal(result.cycle.contributionCount, 0);

    const profile = database
      .prepare('SELECT * FROM real_profiles WHERE account_id = ?')
      .get(account.id);
    const membership = database
      .prepare('SELECT * FROM real_group_memberships WHERE account_id = ?')
      .get(account.id);
    assert.ok(profile);
    assert.equal(profile.display_name, 'Real Owner');
    assert.equal(membership.profile_id, profile.id);
    assert.equal(membership.role, 'owner');
    assert.deepEqual(listProfiles(database), profilesBefore);
    assert.equal(
      Number(database.prepare('SELECT COUNT(*) AS n FROM memberships').get().n),
      fixtureMembershipCount,
    );
    assert.deepEqual(
      database
        .prepare('SELECT id, starts_at, ends_at FROM cycles WHERE id = ?')
        .get(fixtureCycle.id),
      fixtureCycle,
    );

    const restartedBaseUrl = await restart();
    const restored = await fetch(`${restartedBaseUrl}/real/groups/current`, {
      headers: { Authorization: authorization },
    });
    assert.equal(restored.status, 200);
    assert.deepEqual((await restored.json()).group, result);
  });
});

test('real group form and database constraints enforce 2–10 member capacity', async () => {
  const valid = (maxMembers) =>
    validateRealGroupInput({ name: 'Valid', prompt: 'Prompt', maxMembers });
  assert.equal(valid(2)?.maxMembers, 2);
  assert.equal(valid(10)?.maxMembers, 10);
  for (const value of [1, 11, 2.5, '4', null]) assert.equal(valid(value), null);
  assert.equal(validateRealGroupInput({ name: '  ', prompt: 'Prompt', maxMembers: 2 }), null);
  assert.equal(validateRealGroupInput({ name: 'Name', prompt: '  ', maxMembers: 2 }), null);

  await withRuntime(async ({ baseUrl, database }) => {
    const { authorization } = await provision(baseUrl, database);
    for (const maxMembers of [1, 11]) {
      const response = await fetch(`${baseUrl}/real/groups`, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Private', prompt: 'Prompt', maxMembers }),
      });
      assert.equal(response.status, 400);
    }
    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO real_group_metadata
      (group_id, owner_account_id, max_members, cycle_duration_ms, created_at)
      VALUES ('invalid', 'absent', 11, 86400000, 'now')`,
        )
        .run(),
    );
  });
});

test('failed real-group creation rolls back profile, group, cycle, membership, and selection writes', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const { authorization } = await provision(baseUrl, database);
    createTestTrigger(database, {
      name: 'reject_real_membership',
      timing: 'BEFORE',
      event: 'INSERT',
      table: 'real_group_memberships',
      action: { abort: 'membership write rejected' },
    });
    const response = await fetch(`${baseUrl}/real/groups`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Atomic', prompt: 'Prompt', maxMembers: 2 }),
    });
    assert.equal(response.status, 409);
    for (const table of [
      'real_profiles',
      'real_group_metadata',
      'real_group_memberships',
      'real_account_group_selections',
    ]) {
      assert.equal(
        Number(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n),
        0,
        table,
      );
    }
    assert.equal(
      Number(
        database
          .prepare(
            `SELECT COUNT(*) AS n FROM groups g JOIN real_group_metadata m ON m.group_id = g.id`,
          )
          .get().n,
      ),
      0,
    );
    assert.equal(
      Number(
        database
          .prepare(
            `SELECT COUNT(*) AS n FROM cycles c JOIN real_group_metadata m ON m.group_id = c.group_id`,
          )
          .get().n,
      ),
      0,
    );
  });
});

test('four-week duration is exact from the server-owned cycle clock', () => {
  const startsAt = '2026-09-28T00:00:00.000Z';
  const cycle = createCycleWindow({ preset: 'four-week', startsAt });
  assert.equal(Date.parse(cycle.endsAt) - Date.parse(cycle.startsAt), 28 * 86400000);
});
