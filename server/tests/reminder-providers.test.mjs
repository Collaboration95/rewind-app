import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createECDH, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import webpush from 'web-push';
import { parseConfig } from '../dist/config.js';
import {
  createExpoReminderProvider,
  createWebPushReminderProvider,
  createConfiguredReminderProviders,
  REMINDER_PROVIDER_TIMEOUT_MS,
  REMINDER_PROVIDER_RESPONSE_MAX_BYTES,
} from '../dist/reminders/providers.js';
import { validateReminderVapidConfig } from '../dist/reminders/config.js';
import { validReminderDestination } from '../dist/reminders/outbox.js';

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
// OpenSSL may omit a leading zero byte when exporting the scalar. VAPID
// requires the fixed-width 32-byte encoding even for those generated keys.
const privateScalar = curve.getPrivateKey();
const privateBytes = Buffer.alloc(32);
privateScalar.copy(privateBytes, privateBytes.length - privateScalar.length);
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
  privateKey: privateBytes.toString('base64url'),
};

test('web push destinations accept the Safari, Firefox, Chrome and Edge push services only', () => {
  for (const host of [
    'web.push.apple.com',
    'updates.push.services.mozilla.com',
    'fcm.googleapis.com',
    'wns2-par02p.notify.windows.com',
  ])
    assert.equal(
      validReminderDestination('webpush', { ...subscription, endpoint: `https://${host}/w/x` })
        ?.endpoint,
      `https://${host}/w/x`,
    );
  for (const endpoint of [
    'https://notify.windows.com.attacker.invalid/w/x',
    'https://attacker-notify.windows.com/w/x',
    'https://wns2-par02p.notify.windows.com:8443/w/x',
    'https://permanently-removed.invalid/fcm/send/x',
  ])
    assert.equal(validReminderDestination('webpush', { ...subscription, endpoint }), null);
});

test('valid VAPID scalars with leading zero bytes retain their fixed-width encoding', async () => {
  const privateKey = Buffer.alloc(32);
  privateKey[31] = 1;
  const leadingZeroCurve = createECDH('prime256v1');
  leadingZeroCurve.setPrivateKey(privateKey);
  assert.ok(leadingZeroCurve.getPrivateKey().length < 32);
  const fixedWidth = {
    ...config,
    publicKey: leadingZeroCurve.getPublicKey().toString('base64url'),
    privateKey: privateKey.toString('base64url'),
  };
  assert.deepEqual(validateReminderVapidConfig(fixedWidth), fixedWidth);
  let sent = false;
  const providers = await createConfiguredReminderProviders(
    { webpush: fixedWidth },
    {
      fetcher: async () => {
        sent = true;
        return new Response(null, { status: 201 });
      },
    },
  );
  assert.equal((await providers.webpush.send(subscription, payload)).status, 'accepted');
  assert.equal(sent, true);
});

test('VAPID rejects valid-length mismatched keys, invalid points/scalars and noncanonical encodings before SDK work', async () => {
  const other = createECDH('prime256v1');
  other.generateKeys();
  assert.deepEqual(validateReminderVapidConfig(config), config);
  for (const bad of [
    { ...config, publicKey: other.getPublicKey().toString('base64url') },
    { ...config, privateKey: Buffer.alloc(32).toString('base64url') },
    { ...config, privateKey: Buffer.alloc(32, 255).toString('base64url') },
    { ...config, publicKey: Buffer.alloc(65, 4).toString('base64url') },
    {
      ...config,
      privateKey: config.privateKey.slice(0, -1) + (config.privateKey.endsWith('A') ? 'B' : 'A'),
    },
    { ...config, subject: 'https://user:secret@example.invalid' },
  ]) {
    let calls = 0;
    await assert.rejects(
      createConfiguredReminderProviders(
        { webpush: bad },
        {
          webpush: {
            async sendNotification() {
              calls++;
              return { statusCode: 201 };
            },
          },
        },
      ),
      (error) =>
        error.message === 'Invalid Web Push reminder configuration.' &&
        !error.message.includes(bad.privateKey),
    );
    assert.equal(calls, 0);
  }
});

for (const providerKind of ['expo', 'webpush']) {
  test(`${providerKind} total deadline bounds a transport that ignores abort`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    const fetcher = async (_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    };
    const provider =
      providerKind === 'expo'
        ? createExpoReminderProvider({}, fetcher)
        : (await createConfiguredReminderProviders({ webpush: config }, { fetcher })).webpush;
    const pending = provider.send(providerKind === 'expo' ? { token } : subscription, payload);
    await setImmediate();
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(REMINDER_PROVIDER_TIMEOUT_MS);
    assert.deepEqual(await pending, { status: 'transient', category: 'temporary_failure' });
    assert.equal(signal.aborted, true);
  });

  test(`${providerKind} trickling response cannot extend the hard deadline and hanging cancellation does not block`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let cancelCalls = 0;
    const reader = {
      read: async () => ({ done: false, value: Uint8Array.from([32]) }),
      cancel: () => {
        cancelCalls++;
        return new Promise(() => {});
      },
      releaseLock() {},
    };
    // A finite first chunk followed by a blocked read represents a server
    // keeping the socket active before stalling; inactivity timeout is insufficient.
    let reads = 0;
    reader.read = async () =>
      ++reads === 1 ? { done: false, value: Uint8Array.from([32]) } : new Promise(() => {});
    const fetcher = async () => ({
      ok: true,
      status: 201,
      url: '',
      redirected: false,
      headers: new Headers(),
      body: { getReader: () => reader },
    });
    const provider =
      providerKind === 'expo'
        ? createExpoReminderProvider({}, fetcher)
        : (await createConfiguredReminderProviders({ webpush: config }, { fetcher })).webpush;
    const pending = provider.send(providerKind === 'expo' ? { token } : subscription, payload);
    await setImmediate();
    t.mock.timers.tick(REMINDER_PROVIDER_TIMEOUT_MS);
    assert.equal((await pending).status, 'transient');
    assert.ok(cancelCalls > 0);
  });

  test(`${providerKind} rejects redirects and streamed oversized bodies without exposing provider details`, async () => {
    for (const response of [
      new Response('SECRET private location', {
        status: 302,
        headers: { Location: 'https://127.0.0.1/private' },
      }),
      new Response('SECRET'.repeat(12000)),
      new Response('x', {
        headers: { 'Content-Length': String(REMINDER_PROVIDER_RESPONSE_MAX_BYTES + 1) },
      }),
    ]) {
      let calls = 0;
      const fetcher = async (_url, init) => {
        calls++;
        assert.equal(init.redirect, 'error');
        return response;
      };
      const provider =
        providerKind === 'expo'
          ? createExpoReminderProvider({}, fetcher)
          : (await createConfiguredReminderProviders({ webpush: config }, { fetcher })).webpush;
      const result = await provider.send(
        providerKind === 'expo' ? { token } : subscription,
        payload,
      );
      assert.notEqual(result.status, 'accepted');
      assert.equal(calls, 1);
      assert.doesNotMatch(JSON.stringify(result), /SECRET|127\.0\.0\.1/);
    }
  });
}

test('packaged Web Push request generation encrypts locally; bounded fetch carries VAPID only in headers and never redirects', async () => {
  let call;
  const provider = (
    await createConfiguredReminderProviders(
      { webpush: config },
      {
        fetcher: async (url, init) => {
          call = { url, init };
          return new Response(null, { status: 201 });
        },
      },
    )
  ).webpush;
  assert.equal((await provider.send(subscription, payload)).status, 'accepted');
  assert.equal(call.url, subscription.endpoint);
  assert.equal(call.init.redirect, 'error');
  assert.match(call.init.headers.Authorization, /^vapid /);
  assert.equal(call.init.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(call.init.body instanceof ArrayBuffer);
  assert.equal(Buffer.from(call.init.body).includes(Buffer.from(payload.body)), false);
  assert.equal(JSON.stringify(call.init).includes(config.privateKey), false);
});

test('actual packaged Web Push HTTPS delivery does not follow a redirect to a private host', async (t) => {
  const calls = [];
  t.mock.method(https, 'request', (options, callback) => {
    calls.push(options);
    const request = new EventEmitter();
    request.write = () => {};
    request.end = () => {
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 302;
        response.headers = { location: 'https://127.0.0.1/private' };
        callback(response);
        response.emit('end');
      });
    };
    return request;
  });
  await assert.rejects(
    webpush.sendNotification(subscription, JSON.stringify(payload), {
      vapidDetails: config,
      timeout: REMINDER_PROVIDER_TIMEOUT_MS,
    }),
    (error) => error.statusCode === 302,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hostname, 'web.push.apple.com');
});

test('Expo accepts exactly 64 KiB but cancels a multi-chunk response immediately beyond the limit', async () => {
  const json = JSON.stringify({ data: { status: 'ok', id: 'bounded-ticket' } });
  const exact = createExpoReminderProvider(
    {},
    async () => new Response(json.padEnd(REMINDER_PROVIDER_RESPONSE_MAX_BYTES, ' ')),
  );
  assert.equal((await exact.send({ token }, payload)).receiptId, 'bounded-ticket');
  let cancelled = 0;
  let reads = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(4096));
      },
      cancel() {
        cancelled++;
      },
    },
    { highWaterMark: 0 },
  );
  const oversized = createExpoReminderProvider({}, async () => new Response(stream));
  assert.equal((await oversized.send({ token }, payload)).status, 'transient');
  assert.equal(reads, 17);
  assert.equal(cancelled, 1);
});

test('provider error responses are cancelled without reading private/unbounded bodies', async () => {
  let cancelled = 0;
  let reads = 0;
  const provider = createExpoReminderProvider(
    {},
    async () =>
      new Response(
        new ReadableStream(
          {
            pull() {
              reads++;
            },
            cancel() {
              cancelled++;
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 410 },
      ),
  );
  assert.equal((await provider.send({ token }, payload)).status, 'invalid');
  assert.equal(reads, 0);
  assert.equal(cancelled, 1);
});

test('a transport returning an already redirected private URL is rejected without parsing its body', async () => {
  const response = new Response('SECRET provider data');
  Object.defineProperties(response, {
    redirected: { value: true },
    url: { value: 'https://127.0.0.1/private' },
  });
  const result = await createExpoReminderProvider({}, async () => response).send(
    { token },
    payload,
  );
  assert.deepEqual(result, { status: 'transient', category: 'temporary_failure' });
});

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
