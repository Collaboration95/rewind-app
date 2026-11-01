import assert from 'node:assert/strict';
import test from 'node:test';
import { updateRealGroupSettings, updateRealReminderPreference } from '../dist/groups/settings.js';
import { withBoundaryRuntime } from './helpers/boundary-runtime.mjs';

test('a full group rejects another invitee and keeps the unused invitation intact', async () => {
  await withBoundaryRuntime(async (c) => {
    const owner = await c.account('capacity-owner');
    const member = await c.account('capacity-member');
    const outsider = await c.account('capacity-outsider');
    const group = await c.group(owner, { maxMembers: 2 });
    const extraInvite = await c.invite(owner, group.group.id);
    await c.join(owner, member, group.group.id);
    const response = await c.post('/real/invites/accept', outsider, { code: extraInvite.code });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).status, 'full');
    assert.deepEqual(
      (await (await c.request('/real/groups', { actor: outsider })).json()).groups,
      [],
    );
    const revoke = await c.request(`/real/groups/${group.group.id}/invites/${extraInvite.id}`, {
      actor: owner,
      method: 'DELETE',
    });
    assert.equal(revoke.status, 200, 'capacity failure did not consume the invitation');
    const forbidden = await c.post(`/real/groups/${group.group.id}/invites`, member);
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error, 'invite_forbidden');
    assert.equal((await c.post(`/real/groups/${group.group.id}/invites`, outsider)).status, 404);
  });
});

test('an invitation cannot be redirected to another group and remains usable for its intended group', async () => {
  await withBoundaryRuntime(async (c) => {
    const owner = await c.account('scoped-invite-owner');
    const member = await c.account('scoped-invite-member');
    const first = await c.group(owner, { name: 'First group' });
    const second = await c.group(owner, { name: 'Second group' });
    const invite = await c.invite(owner, first.group.id);
    const mismatch = await c.post('/real/invites/accept', member, {
      code: invite.code,
      groupId: second.group.id,
    });
    assert.equal(mismatch.status, 404);
    assert.equal((await mismatch.json()).status, 'denied');
    assert.deepEqual(
      (await (await c.request('/real/groups', { actor: member })).json()).groups,
      [],
    );
    const accepted = await c.post('/real/invites/accept', member, {
      code: `  ${invite.code.toLowerCase()}  `,
      groupId: first.group.id,
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).group.group.id, first.group.id);
    const replay = await c.post('/real/invites/accept', member, { code: invite.code });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).status, 'replayed');
    const select = await c.post('/real/groups/current', member, { groupId: second.group.id });
    assert.equal(select.status, 404);
    const current = await (await c.request('/real/groups/current', { actor: member })).json();
    assert.equal(current.group.group.id, first.group.id);
  });
});

test('invitation expiry enforces five-minute and seven-day bounds and expires at the exact deadline', async () => {
  await withBoundaryRuntime(async (c) => {
    const owner = await c.account('expiry-bound-owner');
    const member = await c.account('expiry-bound-member');
    const group = await c.group(owner);
    for (const expiresInSeconds of [0, 299, 300.5, 604801, 'not-a-duration']) {
      const response = await c.post(`/real/groups/${group.group.id}/invites`, owner, {
        expiresInSeconds,
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'invite_invalid_expiry');
    }
    const min = await c.invite(owner, group.group.id, { expiresInSeconds: 300 });
    const max = await c.invite(owner, group.group.id, { expiresInSeconds: 604800 });
    assert.equal(Date.parse(max.expiresAt) - c.now().getTime(), 604800000);
    c.setNow(min.expiresAt);
    const expired = await c.post('/real/invites/accept', member, { code: min.code });
    assert.equal(expired.status, 400);
    assert.equal((await expired.json()).status, 'expired');
    const accepted = await c.post('/real/invites/accept', member, { code: max.code });
    assert.equal(accepted.status, 200);
    assert.equal(
      (
        await c.request(`/real/groups/${group.group.id}/invites/${max.id}`, {
          actor: owner,
          method: 'DELETE',
        })
      ).status,
      404,
    );
  });
});

test('closed-cycle settings and revoked authorization leave the prompt, zone and reminder preference unchanged', async () => {
  await withBoundaryRuntime(async (c) => {
    const owner = await c.account('settings-bound-owner');
    const group = await c.group(owner);
    const originalResponse = await c.request('/real/groups/current', { actor: owner });
    assert.equal(originalResponse.status, 200);
    const original = await originalResponse.json();
    const settings = { prompt: 'Must not replace prompt', timeZone: 'Asia/Singapore' };
    const update = (now, authorize) =>
      updateRealGroupSettings(
        c.database,
        owner.account.id,
        group.group.id,
        settings,
        now,
        authorize,
      );
    assert.deepEqual(
      update(c.now(), () => false),
      { ok: false, reason: 'forbidden' },
    );
    assert.deepEqual(update(new Date(group.cycle.endsAt)), { ok: false, reason: 'cycle_closed' });
    assert.deepEqual(
      updateRealReminderPreference(
        c.database,
        owner.account.id,
        group.group.id,
        { enabled: true, snoozedUntil: null },
        c.now(),
        () => false,
      ),
      { ok: false, reason: 'forbidden' },
    );
    const after = await (await c.request('/real/groups/current', { actor: owner })).json();
    assert.deepEqual(after, original);
    const reminder = await (
      await c.request(`/real/groups/${group.group.id}/reminders`, { actor: owner })
    ).json();
    assert.equal(reminder.preference.enabled, false);
    for (const snoozedUntil of [
      'invalid',
      c.now().toISOString(),
      new Date(c.now().getTime() + 32 * 86400000).toISOString(),
    ]) {
      const response = await c.post(`/real/groups/${group.group.id}/reminders`, owner, {
        enabled: true,
        snoozedUntil,
      });
      assert.equal(response.status, 400);
    }
    const until = new Date(c.now().getTime() + 86400000).toISOString();
    assert.equal(
      (
        await c.post(`/real/groups/${group.group.id}/reminders`, owner, {
          enabled: true,
          snoozedUntil: until,
        })
      ).status,
      200,
    );
    c.setNow(until);
    const resumed = await (
      await c.request(`/real/groups/${group.group.id}/reminders`, { actor: owner })
    ).json();
    assert.equal(resumed.preference.enabled, true);
    assert.equal(resumed.preference.snoozedUntil, null);
  });
});
