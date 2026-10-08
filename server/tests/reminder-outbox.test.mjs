import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseConfig } from '../dist/config.js';
import { createRealGroup, selectRealGroup } from '../dist/groups/real.js';
import { updateRealGroupSettings, updateRealReminderPreference } from '../dist/groups/settings.js';
import { revokeRealSession } from '../dist/auth/index.js';
import { createRuntimeServer } from '../dist/http.js';
import { accountFixture } from './helpers/upload-intents.mjs';
import {
  registerReminderDestination,
  listReminderDestinations,
  disableReminderDestination,
  scanDueReminderJobs,
  runReminderOutboxTick,
  listReminderOutbox,
  validReminderDestination,
  reminderDeliveryStatus,
} from '../dist/reminders/outbox.js';
import { startReminderLoop } from '../dist/reminders/loop.js';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';
import { sqliteOnly } from './helpers/dialect.mjs';

const execFileAsync = promisify(execFile);
const token = 'ExpoPushToken[synthetic_reminder_token]';
const token2 = 'ExpoPushToken[synthetic_second_token]';
const deviceId = 'synthetic_device_0001';
const registration = { deviceId, provider: 'expo', destination: { token } };

test('re-registration in another group cannot revive old-group reminders at scan or send', async () => {
  await fixture(async (c) => {
    const other = createRealGroup(
      c.db,
      { id: 'reminder-owner', displayName: 'Owner' },
      { name: 'Other owned group', prompt: 'Another prompt', maxMembers: 5 },
      c.now,
    );
    updateRealReminderPreference(
      c.db,
      'reminder-owner',
      other.group.id,
      { enabled: true, snoozedUntil: null },
      c.now,
    );
    selectRealGroup(c.db, 'reminder-owner', c.actor.groupId);
    c.now = new Date(c.due);
    assert.equal(scanDueReminderJobs(c.db, c.now).queued, 1);
    selectRealGroup(c.db, 'reminder-owner', other.group.id);
    const newActor = { ...c.actor, groupId: other.group.id };
    registerReminderDestination(c.db, newActor, registration, c.now);
    assert.equal(scanDueReminderJobs(c.db, c.now).queued, 1);
    for (let index = 0; index < 3; index++) await c.tick();
    assert.equal(c.sent.length, 1);
    assert.equal(c.sent[0].payload.data.groupId, other.group.id);
    assert.equal(listReminderOutbox(c.db, c.actor, c.now), null);
    selectRealGroup(c.db, 'reminder-owner', c.actor.groupId);
    assert.equal(listReminderOutbox(c.db, c.actor, c.now)[0].state, 'cancelled');
  });
});

test('a new login does not mistake the previous session device registration for an active association', async () => {
  await fixture(async (c) => {
    const registered = registerReminderDestination(c.db, c.actor, registration, c.now);
    const newToken = randomBytes(32).toString('base64url');
    c.db
      .prepare(
        `INSERT INTO real_account_sessions (token_hash,account_id,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
      SELECT ?,account_id,created_at,last_seen_at,idle_expires_at,absolute_expires_at FROM real_account_sessions WHERE token_hash = ?`,
      )
      .run(
        createHash('sha256').update(newToken).digest('hex'),
        createHash('sha256').update(c.session).digest('hex'),
      );
    revokeRealSession(c.db, c.session, c.now);
    const newActor = { ...c.actor, sessionToken: newToken };
    const rows = listReminderDestinations(c.db, newActor, c.now, deviceId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, registered.destination.id);
    assert.equal(rows[0].enabled, false);
    assert.doesNotMatch(
      JSON.stringify(rows),
      /session_token_hash|synthetic_reminder_token|device_key/,
    );
    const refreshed = registerReminderDestination(c.db, newActor, registration, c.now);
    assert.equal(refreshed.ok, true);
    assert.equal(listReminderDestinations(c.db, newActor, c.now, deviceId)[0].enabled, true);
  });
});
async function fixture(run, { zone = 'UTC' } = {}) {
  const root = await mkdtemp(`${tmpdir()}/rewind-reminder-outbox-`);
  const config = parseConfig({
    REWIND_DATA_DIR: root,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_ORIGIN_AUTH_SECRET: 'synthetic-fixture-edge',
  });
  const context = {
    root,
    config,
    now: new Date('2026-10-04T08:00:00Z'),
    db: openFixtureDatabase(config),
  };
  context.session = accountFixture(context.db, 'reminder-owner', context.now);
  context.otherSession = accountFixture(context.db, 'reminder-outsider', context.now);
  context.group = createRealGroup(
    context.db,
    { id: 'reminder-owner', displayName: 'Owner' },
    { name: 'Private group', prompt: 'A private prompt', maxMembers: 5 },
    context.now,
  );
  context.actor = { sessionToken: context.session, groupId: context.group.group.id };
  if (zone !== 'UTC')
    assert.equal(
      updateRealGroupSettings(
        context.db,
        'reminder-owner',
        context.actor.groupId,
        { prompt: 'Private prompt', timeZone: zone },
        context.now,
      ).ok,
      true,
    );
  assert.equal(
    updateRealReminderPreference(
      context.db,
      'reminder-owner',
      context.actor.groupId,
      { enabled: true, snoozedUntil: null },
      context.now,
    ).ok,
    true,
  );
  context.destination = registerReminderDestination(
    context.db,
    context.actor,
    registration,
    context.now,
  );
  assert.equal(context.destination.ok, true);
  context.providers = {
    expo: {
      async send(destination, payload) {
        context.sent.push({ destination, payload });
        return { status: 'accepted', category: 'provider_accepted' };
      },
    },
  };
  context.sent = [];
  context.tick = () =>
    runReminderOutboxTick(context.db, context.providers, { now: () => context.now });
  context.due = zone === 'Asia/Singapore' ? '2026-10-04T11:00:00Z' : '2026-10-04T19:00:00Z';
  try {
    await run(context);
  } finally {
    context.db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('delivery status reflects configured providers and live registration without claiming delivery', async () => {
  await fixture(async (c) => {
    assert.equal(reminderDeliveryStatus(c.db, 'reminder-owner', {}).state, 'not-configured');
    const registered = reminderDeliveryStatus(c.db, 'reminder-owner', c.providers, c.now);
    assert.equal(registered.state, 'registered');
    assert.match(registered.message, /delivery is not confirmed/);
    assert.equal(
      reminderDeliveryStatus(c.db, 'reminder-outsider', c.providers, c.now).state,
      'registration-required',
    );
    assert.doesNotMatch(JSON.stringify(registered), /synthetic_reminder_token|session|destination/);
    disableReminderDestination(c.db, c.actor, c.destination.destination.id, c.now);
    assert.equal(
      reminderDeliveryStatus(c.db, 'reminder-owner', c.providers, c.now).state,
      'registration-required',
    );
    registerReminderDestination(c.db, c.actor, registration, c.now);
    revokeRealSession(c.db, c.session, c.now);
    assert.equal(
      reminderDeliveryStatus(c.db, 'reminder-owner', c.providers, c.now).state,
      'registration-required',
    );
  });
});

test('group-local Sunday queues once across duplicate scans, DB reopen and repeated sends', async () => {
  await fixture(
    async (c) => {
      c.now = new Date('2026-10-04T10:59:59Z');
      assert.equal(scanDueReminderJobs(c.db, c.now).queued, 0);
      c.now = new Date(c.due);
      assert.equal(scanDueReminderJobs(c.db, c.now).queued, 1);
      assert.equal(scanDueReminderJobs(c.db, c.now).queued, 0);
      c.db.close();
      c.db = openFixtureDatabase(c.config);
      assert.equal(scanDueReminderJobs(c.db, c.now).queued, 0);
      assert.equal((await c.tick()).state, 'accepted');
      assert.equal((await c.tick()).claimed, false);
      assert.equal(c.sent.length, 1);
      const payload = c.sent[0].payload;
      assert.deepEqual(Object.keys(payload).sort(), ['body', 'data', 'title']);
      assert.deepEqual(Object.keys(payload.data).sort(), ['groupId', 'kind', 'reminderId']);
      assert.equal(payload.data.groupId, c.actor.groupId);
      assert.doesNotMatch(
        JSON.stringify(payload),
        /Private prompt|Private group|synthetic_reminder_token|password|media\/|https:/,
      );
      const status = listReminderOutbox(c.db, c.actor, c.now);
      assert.equal(status.length, 1);
      assert.equal(status[0].state, 'accepted');
      assert.doesNotMatch(JSON.stringify(status), /token|destination|receiptId|session/);
    },
    { zone: 'Asia/Singapore' },
  );
});

test('duplicate destinations collapse; outsider, foreign endpoint and arbitrary keys cannot overwrite ownership', async () => {
  await fixture(async (c) => {
    const replay = registerReminderDestination(c.db, c.actor, registration, c.now);
    assert.equal(replay.destination.id, c.destination.destination.id);
    const secondDevice = registerReminderDestination(
      c.db,
      c.actor,
      { ...registration, deviceId: 'synthetic_device_0002' },
      c.now,
    );
    assert.equal(secondDevice.destination.id, c.destination.destination.id);
    assert.equal(listReminderDestinations(c.db, c.actor, c.now).length, 1);
    assert.equal(
      registerReminderDestination(
        c.db,
        { ...c.actor, sessionToken: c.otherSession },
        registration,
        c.now,
      ).ok,
      false,
    );
    assert.equal(
      disableReminderDestination(
        c.db,
        { ...c.actor, sessionToken: c.otherSession },
        c.destination.destination.id,
        c.now,
      ),
      false,
    );
    const otherGroup = createRealGroup(
      c.db,
      { id: 'reminder-outsider', displayName: 'Other' },
      { name: 'Other group', prompt: 'Other', maxMembers: 5 },
      c.now,
    );
    const otherActor = { sessionToken: c.otherSession, groupId: otherGroup.group.id };
    assert.equal(registerReminderDestination(c.db, otherActor, registration, c.now).ok, false);
    assert.equal(validReminderDestination('expo', { token, sessionToken: c.session }), null);
    assert.equal(
      validReminderDestination('webpush', {
        endpoint: 'http://127.0.0.1/private',
        keys: { auth: 'a'.repeat(22), p256dh: 'b'.repeat(87) },
      }),
      null,
    );
    assert.equal(
      validReminderDestination('webpush', {
        endpoint: 'https://attacker.invalid/private',
        keys: { auth: 'a'.repeat(22), p256dh: 'b'.repeat(87) },
      }),
      null,
    );
    assert.doesNotMatch(
      JSON.stringify(listReminderDestinations(c.db, c.actor, c.now)),
      /synthetic_reminder_token|session_token_hash|destination_json|device_key/,
    );
  });
});

for (const change of [
  'disabled',
  'snoozed',
  'signed-out',
  'expired',
  'rotated',
  'group-switched',
]) {
  test(`${change} before send cancels the queued reminder without provider traffic`, async () => {
    await fixture(async (c) => {
      c.now = new Date(c.due);
      assert.equal(scanDueReminderJobs(c.db, c.now).queued, 1);
      if (change === 'disabled')
        updateRealReminderPreference(
          c.db,
          'reminder-owner',
          c.actor.groupId,
          { enabled: false, snoozedUntil: null },
          c.now,
        );
      if (change === 'snoozed')
        updateRealReminderPreference(
          c.db,
          'reminder-owner',
          c.actor.groupId,
          { enabled: true, snoozedUntil: '2026-10-05T20:00:00Z' },
          c.now,
        );
      if (change === 'signed-out') revokeRealSession(c.db, c.session, c.now);
      if (change === 'group-switched')
        createRealGroup(
          c.db,
          { id: 'reminder-owner', displayName: 'Owner' },
          { name: 'New current group', prompt: 'New group', maxMembers: 5 },
          c.now,
        );
      // The session idles out after SESSION_IDLE_MS (7 days).
      if (change === 'expired') c.now = new Date(Date.parse(c.due) + 8 * 24 * 60 * 60 * 1000);
      if (change === 'rotated')
        assert.equal(
          registerReminderDestination(
            c.db,
            c.actor,
            { ...registration, destination: { token: token2 } },
            c.now,
          ).ok,
          true,
        );
      assert.equal((await c.tick()).claimed, false);
      assert.equal(c.sent.length, 0);
      assert.equal(
        c.db.prepare('SELECT state,response_category FROM reminder_outbox').get().state,
        'cancelled',
      );
    });
  });
}

test('disabled/snoozed members are skipped at scan and bounded cursor does not starve later preferences', async () => {
  await fixture(async (c) => {
    updateRealReminderPreference(
      c.db,
      'reminder-owner',
      c.actor.groupId,
      { enabled: true, snoozedUntil: '2026-10-05T08:00:00Z' },
      c.now,
    );
    c.now = new Date(c.due);
    assert.equal(scanDueReminderJobs(c.db, c.now).queued, 0);
    const scan = scanDueReminderJobs(c.db, c.now, { limit: 1 });
    assert.ok(scan.nextCursor);
    assert.equal(scanDueReminderJobs(c.db, c.now, { limit: 1, after: scan.nextCursor }).scanned, 0);
    assert.throws(() => scanDueReminderJobs(c.db, c.now, { limit: 101 }), /bounds/);
  });
});

test('transient provider failures retry only after backoff and stop at three attempts', async () => {
  await fixture(async (c) => {
    c.now = new Date(c.due);
    scanDueReminderJobs(c.db, c.now);
    let calls = 0;
    c.providers.expo.send = async () => {
      calls++;
      throw new Error('SECRET https://private.invalid/token');
    };
    assert.equal((await c.tick()).state, 'retry');
    c.now = new Date('2026-10-04T19:00:29Z');
    assert.equal((await c.tick()).claimed, false);
    c.now = new Date('2026-10-04T19:00:30Z');
    assert.equal((await c.tick()).state, 'retry');
    c.now = new Date('2026-10-04T19:01:30Z');
    assert.equal((await c.tick()).state, 'failed');
    assert.equal((await c.tick()).claimed, false);
    assert.equal(calls, 3);
    const row = c.db.prepare('SELECT state,attempts,response_category FROM reminder_outbox').get();
    assert.equal(row.attempts, 3);
    assert.equal(row.response_category, 'temporary_failure');
    assert.doesNotMatch(JSON.stringify(row), /SECRET|private.invalid/);
  });
});

test('Expo receipt failure disables a destination without resending the accepted ticket', async () => {
  await fixture(async (c) => {
    c.now = new Date(c.due);
    scanDueReminderJobs(c.db, c.now);
    let sends = 0,
      receipts = 0;
    c.providers.expo = {
      async send() {
        sends++;
        return { status: 'accepted', category: 'provider_accepted', receiptId: 'synthetic-ticket' };
      },
      async receipt(id) {
        receipts++;
        assert.equal(id, 'synthetic-ticket');
        return { status: 'invalid', category: 'invalid_destination' };
      },
    };
    assert.equal((await c.tick()).state, 'awaiting_receipt');
    c.now = new Date('2026-10-04T19:14:59Z');
    assert.equal((await c.tick()).claimed, false);
    c.now = new Date('2026-10-04T19:15:00Z');
    assert.equal((await c.tick()).state, 'failed');
    assert.equal(sends, 1);
    assert.equal(receipts, 1);
    assert.equal(c.db.prepare('SELECT enabled FROM reminder_destinations').get().enabled, 0);
    assert.equal(
      c.db.prepare('SELECT attempts,receipt_attempts FROM reminder_outbox').get().attempts,
      1,
    );
  });
});

test('missing provider receipts remain bounded and never resend an accepted notification', async () => {
  await fixture(async (c) => {
    c.now = new Date(c.due);
    scanDueReminderJobs(c.db, c.now);
    let sends = 0;
    c.providers.expo = {
      async send() {
        sends++;
        return { status: 'accepted', category: 'provider_accepted', receiptId: 'synthetic-ticket' };
      },
      async receipt() {
        return { status: 'pending', category: 'receipt_pending' };
      },
    };
    await c.tick();
    for (const [at, state] of [
      ['19:15:00', 'awaiting_receipt'],
      ['19:20:00', 'awaiting_receipt'],
      ['19:25:00', 'accepted'],
    ]) {
      c.now = new Date(`2026-10-04T${at}Z`);
      assert.equal((await c.tick()).state, state);
    }
    assert.equal(sends, 1);
    const row = c.db
      .prepare('SELECT attempts,receipt_attempts,response_category FROM reminder_outbox')
      .get();
    assert.equal(row.receipt_attempts, 3);
    assert.equal(row.response_category, 'receipt_unavailable');
    assert.equal((await c.tick()).claimed, false);
  });
});

test('reclaimed lease fences stale provider results and keeps one persisted job', async () => {
  await fixture(async (c) => {
    c.now = new Date(c.due);
    scanDueReminderJobs(c.db, c.now);
    let release, entered;
    const firstEntered = new Promise((resolve) => (entered = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    const ids = [];
    c.providers.expo.send = async (destination, payload) => {
      ids.push(payload.data.reminderId);
      if (ids.length === 1) {
        entered();
        await gate;
        return { status: 'permanent', category: 'provider_rejected' };
      }
      return { status: 'accepted', category: 'provider_accepted' };
    };
    const first = c.tick();
    await firstEntered;
    c.now = new Date('2026-10-04T19:01:01Z');
    assert.equal((await c.tick()).state, 'accepted');
    release();
    assert.equal((await first).state, 'stale');
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
    const row = c.db.prepare('SELECT state,attempts,response_category FROM reminder_outbox').get();
    assert.equal(row.state, 'accepted');
    assert.equal(row.attempts, 2);
    assert.equal(row.response_category, 'provider_accepted');
    assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM reminder_outbox').get().n, 1);
  });
});

test('destination association can move after sign-out, and old pending work cannot reach the new account', async () => {
  await fixture(async (c) => {
    c.now = new Date(c.due);
    scanDueReminderJobs(c.db, c.now);
    revokeRealSession(c.db, c.session, c.now);
    const other = createRealGroup(
      c.db,
      { id: 'reminder-outsider', displayName: 'Other' },
      { name: 'Other', prompt: 'Other', maxMembers: 5 },
      c.now,
    );
    assert.equal(
      registerReminderDestination(
        c.db,
        { sessionToken: c.otherSession, groupId: other.group.id },
        registration,
        c.now,
      ).ok,
      true,
    );
    assert.equal((await c.tick()).claimed, false);
    assert.equal(c.sent.length, 0);
    assert.equal(c.db.prepare('SELECT state FROM reminder_outbox').get().state, 'cancelled');
  });
});

test('HTTPS-policy API binds registration/status/disable to the current real member with no secret response', async () => {
  await fixture(async (c) => {
    const server = createRuntimeServer(c.config, c.db, {
      now: () => c.now,
      reminderProviders: c.providers,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = (session = c.session) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session}`,
      'X-Rewind-Origin-Auth': 'synthetic-fixture-edge',
      'X-Forwarded-Proto': 'https',
    });
    const path = `/real/groups/${c.actor.groupId}/reminders/destinations`;
    try {
      const configured = await fetch(`${base}/real/reminders/config`, { headers: headers() });
      assert.equal(configured.status, 200);
      assert.deepEqual(await configured.json(), { providers: ['expo'], webPushPublicKey: null });
      const preferences = await fetch(`${base}/real/groups/${c.actor.groupId}/reminders`, {
        headers: headers(),
      });
      assert.equal(preferences.status, 200);
      assert.equal((await preferences.json()).preference.delivery.state, 'registered');
      const mediaConfig = await fetch(`${base}/real/media/config`, { headers: headers() });
      assert.equal(mediaConfig.status, 200);
      assert.deepEqual(await mediaConfig.json(), {
        directTransfer: false,
        maxVideoBytes: 50 * 1024 * 1024,
        maxPhotoBytes: 10 * 1024 * 1024,
      });
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(registration),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.destination.id, c.destination.destination.id);
      assert.doesNotMatch(
        JSON.stringify(body),
        /synthetic_reminder_token|session|device_key|destination_json/,
      );
      assert.equal(
        registerReminderDestination(
          c.db,
          c.actor,
          { deviceId: 'synthetic_device_0002', provider: 'expo', destination: { token: token2 } },
          c.now,
        ).ok,
        true,
      );
      const recovered = await (
        await fetch(`${base}${path}?deviceId=${deviceId}`, { headers: headers() })
      ).json();
      assert.deepEqual(recovered.destinations, [body.destination]);
      assert.doesNotMatch(
        JSON.stringify(recovered),
        /synthetic_reminder_token|synthetic_device|session|device_key|destination_json/,
      );
      assert.deepEqual(
        await (
          await fetch(`${base}${path}?deviceId=unregistered_device_1`, { headers: headers() })
        ).json(),
        { destinations: [] },
      );
      for (const query of [
        'deviceId=short',
        `deviceId=${deviceId}&deviceId=${deviceId}`,
        'deviceId=',
      ])
        assert.equal((await fetch(`${base}${path}?${query}`, { headers: headers() })).status, 400);
      assert.equal(
        (await fetch(`${base}${path}?deviceId=${deviceId}`, { headers: headers(c.otherSession) }))
          .status,
        403,
      );
      assert.equal(
        (await fetch(`${base}${path}`, { headers: headers(c.otherSession) })).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${base}${path}`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ ...registration, accountId: 'reminder-outsider' }),
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${base}${path}`, {
            method: 'POST',
            headers: { ...headers(), 'X-Forwarded-Proto': 'http' },
            body: JSON.stringify(registration),
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${base}${path}/${body.destination.id}`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ enabled: false }),
          })
        ).status,
        200,
      );
      const rows = await (await fetch(`${base}${path}`, { headers: headers() })).json();
      assert.equal(rows.destinations.find((row) => row.id === body.destination.id).enabled, false);
      const outbox = await (
        await fetch(`${base}/real/groups/${c.actor.groupId}/reminders/outbox`, {
          headers: headers(),
        })
      ).json();
      assert.deepEqual(outbox, { outbox: [] });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('CLI without configured providers performs no scan, network work or database creation', async () => {
  const root = await mkdtemp(`${tmpdir()}/rewind-reminder-cli-`);
  const env = { ...process.env, REWIND_DATA_DIR: root, REWIND_REMINDER_EXPO_ENABLED: 'false' };
  for (const key of Object.keys(env))
    if (key.startsWith('REWIND_REMINDER_') && key !== 'REWIND_REMINDER_EXPO_ENABLED')
      delete env[key];
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['server/dist/cli.js', 'reminders', '--once', '--json'],
      { env },
    );
    assert.deepEqual(JSON.parse(stdout), {
      state: 'not-configured',
      scanned: 0,
      queued: 0,
      jobs: [],
    });
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(root), []);
    await assert.rejects(
      execFileAsync(process.execPath, ['server/dist/cli.js', 'reminders', '--json'], { env }),
      /requires --once/,
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ['server/dist/cli.js', 'reminders', '--once', '--max-jobs', '101'],
        { env },
      ),
      /from 1 to 100/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('three crashed receipt leases finish inspectably without an extra provider call', async () => {
  await fixture(async (c) => {
    c.now = new Date(c.due);
    scanDueReminderJobs(c.db, c.now);
    c.providers.expo = {
      async send() {
        return { status: 'accepted', category: 'provider_accepted', receiptId: 'synthetic-ticket' };
      },
      async receipt() {
        throw new Error('must not exceed receipt cap');
      },
    };
    await c.tick();
    c.db
      .prepare(
        "UPDATE reminder_outbox SET receipt_attempts = 3, lease_id = 'expired-lease', lease_expires_at = ?, next_attempt_at = ?",
      )
      .run('2026-10-04T19:16:00Z', '2026-10-04T19:15:00Z');
    c.now = new Date('2026-10-04T19:16:01Z');
    assert.equal((await c.tick()).claimed, false);
    const row = c.db
      .prepare('SELECT state,receipt_attempts,response_category FROM reminder_outbox')
      .get();
    assert.equal(row.state, 'accepted');
    assert.equal(row.receipt_attempts, 3);
    assert.equal(row.response_category, 'receipt_unavailable');
  });
});

test(
  'additive outbox migration repairs an interrupted empty schema without losing accounts',
  { skip: sqliteOnly },
  async () => {
    await fixture(async (c) => {
      const accounts = c.db.prepare('SELECT COUNT(*) AS n FROM real_accounts').get().n;
      c.db.exec('DROP TABLE reminder_outbox');
      c.db.close();
      c.db = openFixtureDatabase(c.config);
      assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM real_accounts').get().n, accounts);
      assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM reminder_outbox').get().n, 0);
      assert.equal(
        c.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 27').get().n,
        1,
      );
      assert.equal(c.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    });
  },
);

test('the runtime reminder loop queues and sends a due reminder once (#347)', async () => {
  await fixture(async (c) => {
    c.now = new Date(c.due);
    const errors = [];
    const loop = startReminderLoop(async () => openFixtureDatabase(c.config), c.providers, {
      intervalMs: 60_000,
      now: () => c.now,
      onError: (message) => errors.push(message),
    });
    try {
      await loop.tick();
      await loop.tick();
      assert.deepEqual(errors, []);
      assert.equal(c.sent.length, 1);
      assert.equal(c.sent[0].payload.data.groupId, c.actor.groupId);
    } finally {
      await loop.stop();
    }
  });
});
