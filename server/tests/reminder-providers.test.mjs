import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import test from 'node:test';
import { parseConfig } from '../dist/config.js';
import {
  createExpoReminderProvider,
  createWebPushReminderProvider,
  createConfiguredReminderProviders,
} from '../dist/reminders/providers.js';

const token = 'ExpoPushToken[synthetic_reminder_token]';
const payload = {
  title: 'Rewind',
  body: 'Open Rewind for your weekly reminder.',
  data: {
    kind: 'weekly-reminder',
    groupId: 'synthetic-group',
    reminderId: '12345678-1234-1234-1234-123456789012',
  },
};
const curve = createECDH('prime256v1');
curve.generateKeys();
const subscription = {
  endpoint: 'https://web.push.apple.com/fixture',
  keys: {
    p256dh: curve.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  },
};
const config = {
  subject: 'mailto:fixture@example.invalid',
  publicKey: subscription.keys.p256dh,
  privateKey: curve.getPrivateKey().toString('base64url'),
};

test('provider config is explicit, rejects partial/unsafe material and never echoes credentials', () => {
  assert.equal(parseConfig({}).reminders, null);
  assert.deepEqual(parseConfig({ REWIND_REMINDER_EXPO_ENABLED: 'true' }).reminders, { expo: {} });
  for (const env of [
    { REWIND_REMINDER_EXPO_ENABLED: 'yes' },
    { REWIND_REMINDER_EXPO_ENABLED: 'true', REWIND_REMINDER_EXPO_ACCESS_TOKEN: 'secret\nheader' },
    { REWIND_REMINDER_VAPID_SUBJECT: 'https://fixture.invalid' },
    {
      REWIND_REMINDER_VAPID_SUBJECT: 'file:///secret',
      REWIND_REMINDER_VAPID_PUBLIC_KEY: config.publicKey,
      REWIND_REMINDER_VAPID_PRIVATE_KEY: config.privateKey,
    },
  ])
    assert.throws(
      () => parseConfig(env),
      (error) =>
        !error.message.includes('secret\nheader') && !error.message.includes(config.privateKey),
    );
  assert.deepEqual(
    parseConfig({
      REWIND_REMINDER_VAPID_SUBJECT: config.subject,
      REWIND_REMINDER_VAPID_PUBLIC_KEY: config.publicKey,
      REWIND_REMINDER_VAPID_PRIVATE_KEY: config.privateKey,
    }).reminders.webpush,
    config,
  );
});

test('configured SDK construction is inert and exposes no provider secret in public configuration', async () => {
  assert.deepEqual(await createConfiguredReminderProviders(null), {});
  let sends = 0;
  const providers = await createConfiguredReminderProviders(
    { expo: { accessToken: 'synthetic-secret' }, webpush: config },
    {
      fetcher: async () => {
        sends++;
        throw new Error('no network');
      },
    },
  );
  assert.deepEqual(Object.keys(providers).sort(), ['expo', 'webpush']);
  assert.equal(sends, 0);
  assert.equal(typeof providers.webpush.send, 'function');
});

test('Expo sends a generic bounded payload and persists acceptance ticket separately from receipt', async () => {
  const calls = [];
  const provider = createExpoReminderProvider(
    { accessToken: 'synthetic-provider-secret' },
    async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          data:
            calls.length === 1
              ? { status: 'ok', id: 'synthetic-ticket' }
              : {
                  'synthetic-ticket': {
                    status: 'error',
                    details: { error: 'DeviceNotRegistered' },
                  },
                },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    },
  );
  assert.deepEqual(await provider.send({ token }, payload), {
    status: 'accepted',
    category: 'provider_accepted',
    receiptId: 'synthetic-ticket',
  });
  assert.deepEqual(await provider.receipt('synthetic-ticket'), {
    status: 'invalid',
    category: 'invalid_destination',
  });
  assert.equal(calls[0].url, 'https://exp.host/--/api/v2/push/send');
  assert.equal(calls[1].url, 'https://exp.host/--/api/v2/push/getReceipts');
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer synthetic-provider-secret');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ['body', 'data', 'title', 'to', 'ttl']);
  assert.equal(body.ttl, 900);
  assert.doesNotMatch(JSON.stringify(body), /provider-secret|media|chat|capability/);
  assert.deepEqual(JSON.parse(calls[1].init.body), { ids: ['synthetic-ticket'] });
});

for (const [status, category] of [
  [429, 'rate_limited'],
  [503, 'temporary_failure'],
  [403, 'provider_rejected'],
]) {
  test(`Expo HTTP ${status} produces only the safe ${category} category`, async () => {
    const provider = createExpoReminderProvider(
      {},
      async () => new Response('SECRET provider-body', { status }),
    );
    const result = await provider.send({ token }, payload);
    assert.equal(result.category, category);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  });
}

test('Expo malformed/oversized/absent receipts cannot leak responses or trigger redirects', async () => {
  const oversized = createExpoReminderProvider({}, async () => new Response('x'.repeat(65537)));
  assert.equal((await oversized.send({ token }, payload)).category, 'temporary_failure');
  const absent = createExpoReminderProvider(
    {},
    async () => new Response(JSON.stringify({ data: {} })),
  );
  assert.deepEqual(await absent.receipt('synthetic-ticket'), {
    status: 'pending',
    category: 'receipt_pending',
  });
  const badId = await absent.receipt('https://private.invalid/token');
  assert.equal(badId.status, 'permanent');
  assert.doesNotMatch(JSON.stringify(badId), /private.invalid/);
});

test('Web Push adapter binds VAPID only to SDK options and coalesces the generic reminder topic', async () => {
  let call;
  const provider = createWebPushReminderProvider(config, {
    async sendNotification(...args) {
      call = args;
      return { statusCode: 201 };
    },
  });
  assert.deepEqual(await provider.send(subscription, payload), {
    status: 'accepted',
    category: 'provider_accepted',
  });
  assert.deepEqual(call[0], subscription);
  assert.deepEqual(JSON.parse(call[1]), payload);
  assert.deepEqual(call[2].vapidDetails, config);
  assert.equal(call[2].timeout, 5000);
  assert.equal(call[2].TTL, 900);
  assert.equal(call[2].topic, payload.data.reminderId.replace(/-/g, ''));
  assert.doesNotMatch(call[1], new RegExp(config.privateKey));
  let sent = false;
  const blocked = createWebPushReminderProvider(config, {
    async sendNotification() {
      sent = true;
      return { statusCode: 201 };
    },
  });
  assert.equal(
    (await blocked.send({ ...subscription, endpoint: 'https://127.0.0.1/private' }, payload))
      .status,
    'invalid',
  );
  assert.equal(sent, false);
});

for (const [status, category] of [
  [410, 'invalid_destination'],
  [429, 'rate_limited'],
  [500, 'temporary_failure'],
  [401, 'provider_rejected'],
]) {
  test(`Web Push ${status} response/error is classified without persisting provider data`, async () => {
    const provider = createWebPushReminderProvider(config, {
      async sendNotification() {
        throw { statusCode: status, body: 'SECRET', endpoint: subscription.endpoint };
      },
    });
    const result = await provider.send(subscription, payload);
    assert.equal(result.category, category);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|apple|fixture/);
  });
}
