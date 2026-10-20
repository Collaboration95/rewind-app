import assert from 'node:assert/strict';
import test from 'node:test';
import { withDatabase } from './helpers/runtime.mjs';

const { recordAuditEvent } = await import('../dist/audit/index.js');
const { createRealAccount } = await import('../dist/auth/index.js');
const { createRealGroup } = await import('../dist/groups/real.js');

test('audit events record the real signed-in member and null for system actions', () =>
  withDatabase({ prefix: 'rewind-audit-' }, async ({ database }) => {
    const created = await createRealAccount(
      database,
      'audit-owner',
      'Owner',
      'audit fixture password',
    );
    assert.equal(created.ok, true);
    const group = createRealGroup(
      database,
      { id: created.account.id, displayName: 'Owner' },
      { name: 'Audit group', prompt: 'Hello', maxMembers: 5 },
      new Date(),
    );
    const record = (actorMemberId) => {
      const event = recordAuditEvent(database, {
        eventType: 'job.completed',
        actorMemberId,
        resourceId: 'job:audit-1',
        result: 'success',
      });
      const stored = database
        .prepare('SELECT actor_member_id AS actor FROM audit_events WHERE id = ?')
        .get(event.id).actor;
      assert.equal(stored, event.actorMemberId);
      return stored;
    };

    assert.match(group.memberId, /^real-profile-/);
    assert.equal(record(group.memberId), group.memberId, 'real member profile is the actor');
    assert.equal(record(undefined), null, 'system and scheduler actions have no actor');
    assert.equal(record('real-profile-unknown'), null, 'an id naming no profile is not guessed');
    assert.equal(record('not an id; DROP TABLE'), null, 'free text never becomes an actor');
  }));
