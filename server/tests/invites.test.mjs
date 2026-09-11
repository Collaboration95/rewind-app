import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { acceptInvite, createInvite, INVITE_CODE_PATTERN } = await import('../dist/invites/index.js');
const { createDemoSession } = await import('../dist/session/index.js');

async function withDatabase(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-invite-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  try {
    return await run({ database });
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function addSecondGroup(database) {
  database.exec(`
    INSERT INTO profiles (id, display_name, avatar_label, is_synthetic)
      VALUES ('demo-6', 'Fable', 'Fable, invite member', 1);
    INSERT INTO groups (id, name, current_cycle_id)
      VALUES ('other-group', 'Other People', 'other-cycle');
    INSERT INTO cycles
      (id, group_id, prompt, starts_at, ends_at, status, lock_state,
       max_count, max_seconds, count_used, seconds_used)
      VALUES ('other-cycle', 'other-group', 'Other prompt',
        '2026-09-10T00:00:00.000Z', '2026-09-11T00:00:00.000Z',
        'collecting', 'locked', 5, 30, 0, 0);
    INSERT INTO memberships (group_id, member_id, role, accepted_at)
      VALUES ('other-group', 'demo-6', 'member', '2026-09-10T00:00:00.000Z');
  `);
}

test('owners create bounded expiring invite codes bound to their group', async () => {
  await withDatabase(async ({ database }) => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const created = createInvite(database, 'demo-1', 'demo-group', 600, now);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.match(created.invite.code, INVITE_CODE_PATTERN);
    assert.equal(created.invite.groupId, 'demo-group');
    assert.equal(created.invite.status, 'active');
    assert.equal(created.invite.expiresAt, '2026-09-10T12:10:00.000Z');
    assert.deepEqual(
      { ...database.prepare('SELECT group_id AS groupId, status, expires_at AS expiresAt FROM invites WHERE id = ?').get(created.invite.id) },
      { groupId: 'demo-group', status: 'active', expiresAt: created.invite.expiresAt },
    );
    assert.deepEqual(createInvite(database, 'demo-2', 'demo-group'), {
      ok: false,
      reason: 'forbidden',
    });
  });
});

test('valid invite acceptance persists one member, moves the session group, and consumes the code', async () => {
  await withDatabase(async ({ database }) => {
    addSecondGroup(database);
    const created = createInvite(
      database,
      'demo-1',
      'demo-group',
      600,
      new Date('2026-09-10T12:00:00.000Z'),
    );
    if (!created.ok) throw new Error('Expected invite creation');
    const session = createDemoSession(database, {
      memberId: 'demo-6',
      groupId: 'other-group',
      sessionId: 'demo-6-session',
      now: new Date('2026-09-10T12:01:00.000Z'),
    });
    if (!session.ok) throw new Error('Expected invite member session');

    const accepted = acceptInvite(
      database,
      'demo-6',
      created.invite.code,
      undefined,
      new Date('2026-09-10T12:02:00.000Z'),
    );
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;
    assert.equal(accepted.group.id, 'demo-group');
    assert.equal(accepted.group.actingMemberRole, 'member');
    assert.deepEqual(
      { ...database.prepare('SELECT role FROM memberships WHERE group_id = ? AND member_id = ?').get('demo-group', 'demo-6') },
      { role: 'member' },
    );
    assert.equal(database.prepare('SELECT status FROM invites WHERE id = ?').get(created.invite.id).status, 'used');
    assert.deepEqual(acceptInvite(database, 'demo-6', created.invite.code), {
      ok: false,
      reason: 'used',
    });
  });
});

test('invite acceptance rejects malformed, expired, and cross-group codes without membership writes', async () => {
  await withDatabase(async ({ database }) => {
    addSecondGroup(database);
    const created = createInvite(
      database,
      'demo-1',
      'demo-group',
      600,
      new Date('2026-09-10T12:00:00.000Z'),
    );
    if (!created.ok) throw new Error('Expected invite creation');
    assert.deepEqual(acceptInvite(database, 'demo-6', 'bad'), {
      ok: false,
      reason: 'malformed',
    });
    assert.deepEqual(acceptInvite(database, 'demo-6', created.invite.code, 'other-group'), {
      ok: false,
      reason: 'cross_group',
    });
    assert.deepEqual(
      acceptInvite(
        database,
        'demo-6',
        created.invite.code,
        undefined,
        new Date('2026-09-10T12:11:00.000Z'),
      ),
      { ok: false, reason: 'expired' },
    );
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM memberships WHERE group_id = ? AND member_id = ?')
        .get('demo-group', 'demo-6').count,
      0,
    );
  });
});
