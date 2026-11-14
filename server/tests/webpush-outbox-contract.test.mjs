import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createECDH } from 'node:crypto';
import test from 'node:test';
import { runReminderOutboxTick, scanDueReminderJobs } from '../dist/reminders/outbox.js';
import { nextWeeklyReminderAt } from '../dist/reminders/schedule.js';
import { withBoundaryRuntime } from './helpers/boundary-runtime.mjs';

const due = new Date('2026-10-18T19:00:00.000Z');

async function withWebPush(run) {
  const sends = [];
  let result = async () => ({ status: 'accepted', category: 'provider_accepted' });
  const providers = {
    webpush: {
      send: async (destination, payload) => {
        sends.push({ destination, payload });
        return result();
      },
    },
  };
  await withBoundaryRuntime(
    async (c) => {
      const owner = await c.account('webpush-contract-owner');
      const group = await c.group(owner, { prompt: 'A secret prompt stays inside the app' });
      const key = createECDH('prime256v1');
      const registration = {
        deviceId: 'boundary_webpush_device_01',
        provider: 'webpush',
        destination: {
          endpoint: 'https://web.push.apple.com/boundary-private-subscription',
          keys: {
            p256dh: key.generateKeys().toString('base64url'),
            auth: Buffer.alloc(16, 9).toString('base64url'),
          },
        },
      };
      const prefix = `/real/groups/${group.group.id}/reminders`;
      assert.equal(
        (await c.post(prefix, owner, { enabled: true, snoozedUntil: null })).status,
        200,
      );
      const registered = await c.post(`${prefix}/destinations`, owner, registration);
      assert.equal(registered.status, 200);
      const body = await registered.json();
      assert.doesNotMatch(
        JSON.stringify(body),
        /boundary-private-subscription|p256dh|session_token|device_key/,
      );
      const duplicate = await c.post(`${prefix}/destinations`, owner, registration);
      assert.equal(duplicate.status, 200);
      assert.equal((await duplicate.json()).destination.id, body.destination.id);
      const outbox = async () => {
        const response = await c.request(`${prefix}/outbox`, { actor: owner });
        assert.equal(response.status, 200);
        return (await response.json()).outbox;
      };
      await run({
        ...c,
        owner,
        group,
        prefix,
        registration,
        sends,
        outbox,
        setResult: (handler) => (result = handler),
        scan: () => scanDueReminderJobs(c.database, c.now()),
        tick: () => runReminderOutboxTick(c.database, providers, { now: c.now }),
      });
    },
    { options: { reminderProviders: providers, reminderWebPushPublicKey: 'synthetic-public-key' } },
  );
}

test('web push retries malformed responses and thrown failures with bounded backoff and a stable reminder identity', async () => {
  await withWebPush(async (c) => {
    c.setNow(new Date(due.getTime() - 1));
    assert.equal(c.scan().queued, 0);
    c.setNow(due);
    assert.equal(c.scan().queued, 1);
    assert.equal(c.scan().queued, 0);
    c.setResult(async () => ({
      status: 'accepted',
      category: 'private-provider-secret',
      receiptId: 'private/receipt',
    }));
    assert.equal((await c.tick()).state, 'retry');
    assert.equal((await c.outbox())[0].category, 'temporary_failure');
    assert.equal((await c.tick()).claimed, false);
    c.setNow(new Date(due.getTime() + 29999));
    assert.equal((await c.tick()).claimed, false);
    c.setNow(new Date(due.getTime() + 30000));
    c.setResult(async () => {
      throw new Error('private provider/network information');
    });
    assert.equal((await c.tick()).state, 'retry');
    c.setNow(new Date(due.getTime() + 89999));
    assert.equal((await c.tick()).claimed, false);
    c.setNow(new Date(due.getTime() + 90000));
    c.setResult(async () => ({ status: 'accepted', category: 'provider_accepted' }));
    assert.equal((await c.tick()).state, 'accepted');
    const rows = await c.outbox();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attempts, 3);
    assert.equal(rows[0].receiptAttempts, 0);
    assert.equal(rows[0].category, 'provider_accepted');
    assert.equal(c.sends.length, 3);
    assert.equal(new Set(c.sends.map(({ payload }) => payload.data.reminderId)).size, 1);
    assert.equal(c.sends[0].payload.data.groupId, c.group.group.id);
    assert.doesNotMatch(
      JSON.stringify(rows),
      /private-provider|private\/receipt|network information/,
    );
    assert.doesNotMatch(
      JSON.stringify(c.sends.map(({ payload }) => payload)),
      /secret prompt|contract-owner|subscription/,
    );
    assert.equal((await c.tick()).claimed, false);
  });
});

test('an invalid web push subscription disables future delivery without another send', async () => {
  await withWebPush(async (c) => {
    c.setNow(due);
    assert.equal(c.scan().queued, 1);
    c.setResult(async () => ({ status: 'invalid', category: 'invalid_destination' }));
    const result = await c.tick();
    assert.equal(result.state, 'failed');
    const destinations = await c.request(`${c.prefix}/destinations`, { actor: c.owner });
    assert.equal(destinations.status, 200);
    assert.equal((await destinations.json()).destinations[0].enabled, false);
    c.setNow(new Date(due.getTime() + 3 * 86400000));
    assert.equal((await c.request('/auth/session', { actor: c.owner })).status, 200);
    c.setNow(new Date(due.getTime() + 7 * 86400000));
    assert.equal((await c.request('/auth/session', { actor: c.owner })).status, 200);
    assert.equal(c.scan().queued, 0);
    assert.equal((await c.tick()).claimed, false);
    assert.equal(c.sends.length, 1);
  });
});

test('late scans skip notifications older than a day instead of sending stale reminders', async () => {
  await withWebPush(async (c) => {
    c.setNow(new Date(due.getTime() + 86400001));
    assert.equal(c.scan().queued, 0);
    assert.equal((await c.tick()).claimed, false);
    assert.deepEqual(await c.outbox(), []);
    assert.equal(c.sends.length, 0);
  });
});

test('weekly scheduling advances strictly past the current slot across year and fractional-offset boundaries', () => {
  assert.equal(nextWeeklyReminderAt(due, 'UTC'), '2026-10-25T19:00:00.000Z');
  assert.equal(
    nextWeeklyReminderAt(new Date('2026-12-31T23:59:59Z'), 'Asia/Kathmandu'),
    '2027-01-03T13:15:00.000Z',
  );
  for (const [after, zone] of [
    [new Date(NaN), 'UTC'],
    [due, 'Invalid/Timezone'],
    [due, ''],
  ])
    assert.throws(() => nextWeeklyReminderAt(after, zone), RangeError);
});
