import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import test from 'node:test';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';

const { parseConfig } = await import('../dist/config.js');
const { migrateDatabase, schemaReadiness } = await import('../dist/db.js');
const { createRealAccount, revokeRealSession } = await import('../dist/auth/index.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { createRealGroup } = await import('../dist/groups/real.js');
const { createRealGroupInvite, acceptRealGroupInvite } = await import('../dist/groups/invites.js');
const { advanceCycleLifecycle } = await import('../dist/cycles/index.js');
const { nextWeeklyReminderAt, validateTimeZone } = await import('../dist/reminders/schedule.js');
const NOW = new Date('2026-10-02T12:00:00.000Z');

async function fixture(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-group-settings-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
  });
  let database = openFixtureDatabase(config);
  let server = createRuntimeServer(config, database, { now: () => NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function account(username) {
    const created = await createRealAccount(
      database,
      username,
      username,
      'synthetic group settings password',
      NOW,
    );
    assert.equal(created.ok, true);
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password: 'synthetic group settings password',
        clientType: 'native',
      }),
    });
    assert.equal(login.status, 200);
    return { account: created.account, token: (await login.json()).token };
  }
  const owner = await account('settings-owner'),
    member = await account('settings-member'),
    outsider = await account('settings-outsider');
  const group = createRealGroup(
    database,
    owner.account,
    { name: 'Group-local prompts', prompt: 'Original prompt', maxMembers: 3 },
    NOW,
  );
  const invite = createRealGroupInvite(database, group.group.id, owner.account.id, undefined, NOW);
  assert.equal(invite.ok, true);
  assert.equal(
    acceptRealGroupInvite(database, member.account, invite.invite.code, undefined, NOW).ok,
    true,
  );
  const request = (person, suffix, method = 'GET', body) =>
    fetch(`${baseUrl}/real/groups/${group.group.id}/${suffix}`, {
      method,
      headers: { Authorization: `Bearer ${person.token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const restart = async () => {
    await new Promise((done) => server.close(done));
    database.close();
    database = openFixtureDatabase(config);
    server = createRuntimeServer(config, database, { now: () => NOW });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    return database;
  };
  try {
    await run({ database, config, group, owner, member, outsider, request, restart });
  } finally {
    await new Promise((done) => server.close(done));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('Sunday 19:00 resolves group timezone across DST and non-DST weeks', () => {
  assert.equal(validateTimeZone('Not/A_Zone'), null);
  assert.equal(
    nextWeeklyReminderAt(new Date('2026-03-02T00:00:00Z'), 'America/New_York'),
    '2026-03-08T23:00:00.000Z',
  );
  assert.equal(
    nextWeeklyReminderAt(new Date('2026-10-26T00:00:00Z'), 'America/New_York'),
    '2026-11-02T00:00:00.000Z',
  );
  assert.equal(nextWeeklyReminderAt(NOW, 'Asia/Singapore'), '2026-10-04T11:00:00.000Z');
  assert.equal(
    nextWeeklyReminderAt(new Date('2026-10-04T11:00:00Z'), 'Asia/Singapore'),
    '2026-10-11T11:00:00.000Z',
  );
  assert.equal(nextWeeklyReminderAt(NOW, 'UTC'), '2026-10-04T19:00:00.000Z');
  assert.throws(() => nextWeeklyReminderAt(NOW, 'Invalid/Zone'), RangeError);
});

test('only owner edits current/future prompts and zone; no actor can mutate deadlines', async () => {
  await fixture(async ({ database, group, owner, member, outsider, request }) => {
    const body = { prompt: 'An owner-selected custom memory', timeZone: 'Asia/Singapore' };
    assert.equal((await request(member, 'settings', 'POST', body)).status, 403);
    assert.equal((await request(outsider, 'settings', 'POST', body)).status, 403);
    assert.equal(
      (await request(owner, 'settings', 'POST', { ...body, endsAt: '2040-01-01T00:00:00Z' }))
        .status,
      400,
    );
    assert.equal(
      (await request(owner, 'settings', 'POST', { ...body, timeZone: 'Invalid/Zone' })).status,
      400,
    );
    const saved = await request(owner, 'settings', 'POST', body);
    assert.equal(saved.status, 200);
    const updated = (await saved.json()).group;
    assert.equal(updated.cycle.prompt, body.prompt);
    assert.equal(updated.group.timeZone, body.timeZone);
    assert.equal(updated.cycle.endsAt, group.cycle.endsAt);
    const rollover = advanceCycleLifecycle(database, {
      groupId: group.group.id,
      clock: () => new Date(group.cycle.endsAt),
    });
    assert.equal(rollover.nextCycle.prompt, body.prompt);
    const second = await request(owner, 'settings', 'POST', {
      ...body,
      prompt: 'The next cycle prompt',
    });
    assert.equal(second.status, 200);
    assert.equal(
      database.prepare('SELECT prompt FROM cycles WHERE id = ?').get(group.cycle.id).prompt,
      body.prompt,
    );
  });
});

test('self-only enabled/snooze/disable survives restart; forged identity and revoked session fail', async () => {
  await fixture(async ({ group, owner, member, outsider, request, restart }) => {
    const initial = await request(member, 'reminders');
    assert.equal(initial.status, 200);
    const preference = (await initial.json()).preference;
    assert.equal(preference.timeZone, 'UTC');
    assert.equal(preference.enabled, false);
    assert.equal(preference.delivery.state, 'not-configured');
    const snoozedUntil = new Date(NOW.getTime() + 7 * 86_400_000).toISOString();
    assert.equal(
      (
        await request(member, 'reminders', 'POST', {
          enabled: true,
          snoozedUntil,
          accountId: owner.account.id,
        })
      ).status,
      400,
    );
    assert.equal((await request(outsider, 'reminders')).status, 403);
    assert.equal(
      (await request(member, 'reminders', 'POST', { enabled: true, snoozedUntil })).status,
      200,
    );
    const restarted = await restart();
    const resumed = (await (await request(member, 'reminders')).json()).preference;
    assert.equal(resumed.enabled, true);
    assert.equal(resumed.snoozedUntil, snoozedUntil);
    assert.equal((await (await request(owner, 'reminders')).json()).preference.enabled, false);
    assert.equal(
      (await request(member, 'reminders', 'POST', { enabled: false, snoozedUntil: null })).status,
      200,
    );
    assert.equal((await (await request(member, 'reminders')).json()).preference.enabled, false);
    assert.equal(
      restarted.prepare('SELECT ends_at AS endsAt FROM cycles WHERE id = ?').get(group.cycle.id)
        .endsAt,
      group.cycle.endsAt,
    );
    revokeRealSession(restarted, member.token, NOW);
    assert.equal(
      (await request(member, 'reminders', 'POST', { enabled: true, snoozedUntil: null })).status,
      401,
    );
    assert.equal(
      restarted
        .prepare('SELECT COUNT(*) AS n FROM real_group_reminder_preferences WHERE account_id = ?')
        .get(owner.account.id).n,
      0,
    );
  });
});

test('additive reminder migration upgrades legacy groups with UTC and repairs missing preference table', async () => {
  await fixture(async ({ database, group }) => {
    database.exec('DROP TABLE real_group_reminder_preferences');
    database.exec('ALTER TABLE real_group_metadata DROP COLUMN time_zone');
    database
      .prepare(
        "DELETE FROM schema_migration_markers WHERE migration_key = 'real-group-reminders-v1'",
      )
      .run();
    database.prepare('DELETE FROM schema_migrations WHERE version = 25').run();
    migrateDatabase(database);
    assert.equal(schemaReadiness(database).ready, true);
    assert.equal(
      database
        .prepare('SELECT time_zone AS zone FROM real_group_metadata WHERE group_id = ?')
        .get(group.group.id).zone,
      'UTC',
    );
    database.exec('DROP TABLE real_group_reminder_preferences');
    assert.equal(schemaReadiness(database).ready, false);
    migrateDatabase(database);
    assert.equal(schemaReadiness(database).ready, true);
    assert.equal(
      database.prepare('SELECT prompt FROM cycles WHERE id = ?').get(group.cycle.id).prompt,
      'Original prompt',
    );
  });
});
