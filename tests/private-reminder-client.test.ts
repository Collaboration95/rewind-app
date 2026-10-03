import { createPrivateReminderClient } from '../src/reminders/private-reminder-client';
import {
  createNativePushPlatform,
  createWebPushPlatform,
  type NativeNotifications,
  type PreparedPushPlatform,
} from '../src/reminders/push-platform';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
const secret = {
  endpoint: 'https://web.push.apple.com/private-endpoint',
  keys: { p256dh: 'private-key', auth: 'private-auth' },
};
const reply = (body: object, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      values.delete(key);
    }),
  };
  const prepared: PreparedPushPlatform = {
    provider: 'webpush',
    permission: jest.fn(async () => 'granted' as const),
    subscribe: jest.fn(async () => secret),
    unsubscribe: jest.fn(async () => {}),
  };
  const platform = { prepare: jest.fn(async () => prepared) };
  const request = jest.fn(async (path: string, options?: RequestInit): Promise<Response> => {
    if (path === '/real/reminders/config')
      return reply({ providers: ['webpush'], webPushPublicKey: publicKey });
    if (options?.method === 'POST' && path.endsWith('/destinations'))
      return reply({ destination: { id: 'destination-one', enabled: true, provider: 'webpush' } });
    if (options?.method === 'POST') return reply({ disabled: true });
    return reply({ destinations: [{ id: 'destination-one', provider: 'webpush', enabled: true }] });
  });
  const createDeviceId = jest.fn(async () => 'device-identity-123456');
  const options = {
    isCurrentContext: () => true,
    accountId: 'account-one',
    groupId: 'group/one',
    authenticatedRequest: request,
    platform,
    storage,
    createDeviceId,
  };
  return {
    values,
    storage,
    prepared,
    platform,
    request,
    options,
    client: createPrivateReminderClient(options),
  };
}

it('checks config without subscribing; explicit opt-in registers only the selected-group/device payload', async () => {
  const f = fixture();
  expect((await f.client.load()).canEnable).toBe(true);
  expect(f.prepared.subscribe).not.toHaveBeenCalled();
  const enabled = await f.client.enable();
  expect(enabled).toMatchObject({ state: 'enabled', enabled: true, canEnable: false });
  expect(f.request).toHaveBeenCalledWith(
    '/real/groups/group%2Fone/reminders/destinations',
    expect.objectContaining({
      body: JSON.stringify({
        deviceId: 'device-identity-123456',
        provider: 'webpush',
        destination: secret,
      }),
    }),
  );
  const publicOutput = JSON.stringify([enabled, [...f.values.entries()]]);
  expect(publicOutput).not.toContain(secret.endpoint);
  expect(publicOutput).not.toContain(secret.keys.auth);
  expect(publicOutput).not.toContain(secret.keys.p256dh);
  expect(enabled.message).toContain('delivery is not confirmed');
});

it('bounds a stalled authenticated support request without requesting notification permission', async () => {
  jest.useFakeTimers();
  try {
    const f = fixture();
    f.request.mockImplementationOnce(
      (_path, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const loading = f.client.load();
    await jest.advanceTimersByTimeAsync(10_000);
    expect((await loading).state).toBe('error');
    expect(f.prepared.subscribe).not.toHaveBeenCalled();
    expect(f.values.get('@rewind/private-reminder-association:account-one')).toBeUndefined();
  } finally {
    jest.useRealTimers();
  }
});

it('coalesces concurrent opt-ins and reuses stable device identity and public registration after recreation', async () => {
  const f = fixture();
  await f.client.load();
  await Promise.all([f.client.enable(), f.client.enable()]);
  await f.client.enable();
  expect(f.prepared.subscribe).toHaveBeenCalledTimes(1);
  expect(
    f.request.mock.calls.filter(
      ([path, init]) => path.endsWith('/destinations') && init?.method === 'POST',
    ),
  ).toHaveLength(1);
  const restored = createPrivateReminderClient(f.options);
  expect((await restored.load()).enabled).toBe(true);
  await restored.enable();
  expect(f.options.createDeviceId).toHaveBeenCalledTimes(1);
  expect(f.prepared.subscribe).toHaveBeenCalledTimes(1);
});

it('disables the exact private destination with enabled false and unsubscribes web material', async () => {
  const f = fixture();
  await f.client.load();
  await f.client.enable();
  expect(await f.client.disable()).toMatchObject({ enabled: false, state: 'available' });
  expect(f.request).toHaveBeenLastCalledWith(
    '/real/groups/group%2Fone/reminders/destinations/destination-one',
    expect.objectContaining({ body: '{"enabled":false}' }),
  );
  expect(f.prepared.unsubscribe).toHaveBeenCalledTimes(1);
  expect(f.values.has('@rewind/private-reminder-association:account-one')).toBe(false);
});

it('fences delayed platform work before it can register into a switched or signed-out context', async () => {
  const f = fixture();
  const subscription = deferred<typeof secret>();
  f.prepared.subscribe = jest.fn(() => subscription.promise);
  await f.client.load();
  const enabling = f.client.enable();
  const revoking = f.client.revoke();
  subscription.resolve(secret);
  await enabling;
  expect(await revoking).toMatchObject({ state: 'revoked', enabled: false });
  expect(f.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect((await f.client.enable()).enabled).toBe(false);
});

it('compensates a registration response arriving after revoke with the original authorized request', async () => {
  const f = fixture();
  const registration = deferred<Response>();
  await f.client.load();
  f.request.mockImplementationOnce(() => registration.promise);
  const enabling = f.client.enable();
  // The registration body must actually cross the boundary before revocation.
  for (let step = 0; step < 8; step++) await Promise.resolve();
  expect(f.request).toHaveBeenCalledTimes(2);
  const revoking = f.client.revoke();
  registration.resolve(
    reply({ destination: { id: 'late-id', enabled: true, provider: 'webpush' } }),
  );
  await enabling;
  expect(await revoking).toMatchObject({ state: 'revoked', enabled: false });
  expect(f.request).toHaveBeenCalledWith(
    '/real/groups/group%2Fone/reminders/destinations/late-id',
    expect.objectContaining({ body: '{"enabled":false}' }),
  );
});

it('retains an unconfirmed disable for retry instead of claiming server removal', async () => {
  const f = fixture();
  await f.client.load();
  await f.client.enable();
  f.request.mockResolvedValueOnce(reply({}, 403));
  expect(await f.client.disable()).toMatchObject({
    state: 'cleanup-pending',
    canDisable: true,
    canEnable: false,
  });
  expect(f.values.has('@rewind/private-reminder-association:account-one')).toBe(true);
  expect(await f.client.disable()).toMatchObject({ state: 'available', enabled: false });
});

it('reconciles OS permission revocation without requesting permission or leaving the server association enabled', async () => {
  const f = fixture();
  await f.client.load();
  await f.client.enable();
  f.prepared.permission = jest.fn(async () => 'denied');
  expect(await f.client.load()).toMatchObject({
    state: 'denied',
    enabled: false,
    canEnable: false,
  });
  expect(f.prepared.subscribe).toHaveBeenCalledTimes(1);
  expect(f.request).toHaveBeenLastCalledWith(
    expect.stringContaining('/destination-one'),
    expect.objectContaining({ body: '{"enabled":false}' }),
  );
});

it('does not subscribe when provider configuration is absent or the build is unsupported', async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce(reply({ providers: [], webPushPublicKey: null }));
  expect(await f.client.load()).toMatchObject({ state: 'unconfigured', canEnable: false });
  await f.client.enable();
  expect(f.prepared.subscribe).not.toHaveBeenCalled();
  const client = createPrivateReminderClient({
    ...f.options,
    platform: { prepare: async () => ({ unsupported: 'Unsupported build' }) },
  });
  expect(await client.load()).toMatchObject({ state: 'unsupported', canEnable: false });
});

it('rejects outsider registration without displaying server/token material or storing a success', async () => {
  const f = fixture();
  await f.client.load();
  f.request.mockResolvedValueOnce(reply({ error: secret }, 403));
  const result = await f.client.enable();
  expect(result).toMatchObject({ state: 'error', enabled: false });
  expect(JSON.stringify(result)).not.toContain(secret.endpoint);
  expect(f.values.has('@rewind/private-reminder-association:account-one')).toBe(false);
});

it('preserves a lost-registration-response gate across restart and revoke when lookup is offline', async () => {
  const f = fixture();
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation((path, init) =>
    path.includes('?deviceId=') ? Promise.reject(new Error('Offline')) : original(path, init),
  );
  await f.client.load();
  f.request.mockRejectedValueOnce(new Error(secret.endpoint));
  expect(await f.client.enable()).toMatchObject({ state: 'cleanup-pending', canEnable: false });
  const restored = createPrivateReminderClient(f.options);
  expect(await restored.load()).toMatchObject({ state: 'cleanup-pending' });
  expect(await restored.revoke()).toMatchObject({ state: 'cleanup-pending' });
  expect(f.values.get('@rewind/private-reminder-association:account-one')).toContain('uncertain');
});

function webFixture() {
  const subscription = { toJSON: () => secret, unsubscribe: jest.fn(async () => true) };
  const manager = {
    getSubscription: jest.fn(async () => null as typeof subscription | null),
    subscribe: jest.fn(async () => subscription),
  };
  const environment = {
    secure: true,
    installed: true,
    pushSupported: true,
    permission: () => 'default' as const,
    registration: jest.fn(async () => ({ active: {}, pushManager: manager })),
    decode: (value: string) => Buffer.from(value, 'base64').toString('binary'),
  };
  return { subscription, manager, environment };
}

it.each(['secure', 'installed', 'pushSupported'] as const)(
  'explains unsupported web %s without touching PushManager',
  async (feature) => {
    const f = webFixture();
    f.environment[feature] = false;
    expect(await createWebPushPlatform(f.environment).prepare()).toHaveProperty('unsupported');
    expect(f.environment.registration).not.toHaveBeenCalled();
  },
);
it('invokes installed-web subscribe synchronously from opt-in and reuses the subscription', async () => {
  const f = webFixture();
  const prepared = await createWebPushPlatform(f.environment).prepare();
  if ('unsupported' in prepared) throw new Error('fixture');
  expect(f.manager.subscribe).not.toHaveBeenCalled();
  const optIn = prepared.subscribe(publicKey, () => true);
  expect(f.manager.subscribe).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: expect.any(Uint8Array),
  });
  await optIn;
  await prepared.subscribe(publicKey, () => true);
  expect(f.manager.subscribe).toHaveBeenCalledTimes(1);
  await prepared.unsubscribe();
  expect(f.subscription.unsubscribe).toHaveBeenCalledTimes(1);
});
it('reuses an installed-web subscription without creating a second destination', async () => {
  const f = webFixture();
  f.manager.getSubscription.mockResolvedValue(f.subscription);
  const prepared = await createWebPushPlatform(f.environment).prepare();
  if ('unsupported' in prepared) throw new Error('fixture');
  expect(await prepared.subscribe(publicKey, () => true)).toEqual(secret);
  expect(f.manager.subscribe).not.toHaveBeenCalled();
});

function nativeFixture() {
  const native: NativeNotifications = {
    getPermissionsAsync: jest.fn(async () => ({ granted: false, status: 'undetermined' })),
    requestPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
    getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExpoPushToken[private-token-value]' })),
    setNotificationChannelAsync: jest.fn(async () => null),
    AndroidImportance: { DEFAULT: 3 },
  };
  const options = {
    platform: 'android',
    expoGo: false,
    projectId: 'project-id',
    physicalDevice: jest.fn(async () => true),
    notifications: jest.fn(async () => native),
  };
  return { native, options };
}
it.each(['expoGo', 'projectId', 'simulator'] as const)(
  'rejects native %s before importing notifications',
  async (feature) => {
    const f = nativeFixture();
    if (feature === 'expoGo') f.options.expoGo = true;
    if (feature === 'projectId') f.options.projectId = '';
    if (feature === 'simulator') f.options.physicalDevice.mockResolvedValue(false);
    expect(await createNativePushPlatform(f.options).prepare()).toHaveProperty('unsupported');
    expect(f.options.notifications).not.toHaveBeenCalled();
  },
);
it('lazily registers Expo token only on opt-in and creates Android channel before permission/token', async () => {
  const f = nativeFixture();
  const platform = createNativePushPlatform(f.options);
  expect(f.options.notifications).not.toHaveBeenCalled();
  const prepared = await platform.prepare();
  if ('unsupported' in prepared) throw new Error('fixture');
  await prepared.permission();
  expect(f.native.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(f.native.getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(await prepared.subscribe(null, () => true)).toEqual({
    token: 'ExpoPushToken[private-token-value]',
  });
  expect(f.native.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'project-id' });
  const channelOrder = (f.native.setNotificationChannelAsync as jest.Mock).mock
    .invocationCallOrder[0];
  const permissionOrder = (f.native.requestPermissionsAsync as jest.Mock).mock
    .invocationCallOrder[0];
  expect(channelOrder).toBeLessThan(permissionOrder);
});
it('does not acquire a native token after denial or a revoke during channel preparation', async () => {
  const f = nativeFixture();
  f.native.requestPermissionsAsync = jest.fn(async () => ({ granted: false, status: 'denied' }));
  const prepared = await createNativePushPlatform(f.options).prepare();
  if ('unsupported' in prepared) throw new Error('fixture');
  await expect(prepared.subscribe(null, () => true)).rejects.toThrow();
  expect(f.native.getExpoPushTokenAsync).not.toHaveBeenCalled();
  const channel = deferred<unknown>();
  f.native.setNotificationChannelAsync = jest.fn(() => channel.promise);
  let active = true;
  const optIn = prepared.subscribe(null, () => active);
  active = false;
  channel.resolve(null);
  await expect(optIn).rejects.toThrow();
  expect(f.native.requestPermissionsAsync).toHaveBeenCalledTimes(1);
});

it('revokes persisted registration before load using the exact current-group authorization', async () => {
  const f = fixture();
  await f.client.load();
  await f.client.enable();
  const restored = createPrivateReminderClient(f.options);
  expect(await restored.revoke()).toMatchObject({ state: 'revoked', enabled: false });
  expect(f.request).toHaveBeenLastCalledWith(
    '/real/groups/group%2Fone/reminders/destinations/destination-one',
    expect.objectContaining({ body: '{"enabled":false}' }),
  );
  expect(f.prepared.unsubscribe).toHaveBeenCalled();
});
it('registers a native Expo token through the same authorization route without storing it', async () => {
  const f = fixture();
  const n = nativeFixture();
  const request = jest.fn(async (_path: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? reply({ destination: { id: 'native-id', provider: 'expo', enabled: true } })
      : reply({ providers: ['expo'], webPushPublicKey: null }),
  );
  const client = createPrivateReminderClient({
    ...f.options,
    platform: createNativePushPlatform(n.options),
    authenticatedRequest: request,
  });
  await client.load();
  expect(n.native.getExpoPushTokenAsync).not.toHaveBeenCalled();
  const state = await client.enable();
  expect(state.enabled).toBe(true);
  expect(request).toHaveBeenLastCalledWith(
    '/real/groups/group%2Fone/reminders/destinations',
    expect.objectContaining({
      body: JSON.stringify({
        deviceId: 'device-identity-123456',
        provider: 'expo',
        destination: { token: 'ExpoPushToken[private-token-value]' },
      }),
    }),
  );
  expect(JSON.stringify([state, [...f.values.values()]])).not.toContain('private-token-value');
});

it('does not start a fresh registration while a disable is awaiting acknowledgement', async () => {
  const f = fixture();
  await f.client.load();
  await f.client.enable();
  const disabled = deferred<Response>();
  f.request.mockImplementationOnce(() => disabled.promise);
  const removing = f.client.disable();
  const state = await f.client.enable();
  expect(state.canEnable).toBe(false);
  expect(f.prepared.subscribe).toHaveBeenCalledTimes(1);
  disabled.resolve(reply({ disabled: true }));
  expect(await removing).toMatchObject({ enabled: false });
});

it.each(['account', 'group'] as const)(
  'does not use replacement credentials after the %s context changes during registration',
  async () => {
    const f = fixture();
    const response = deferred<Response>();
    let current = true;
    const client = createPrivateReminderClient({ ...f.options, isCurrentContext: () => current });
    await client.load();
    f.request.mockImplementationOnce(() => response.promise);
    const enabling = client.enable();
    for (let step = 0; step < 8; step++) await Promise.resolve();
    expect(f.request).toHaveBeenCalledTimes(2);
    current = false;
    response.resolve(
      reply({ destination: { id: 'old-context-id', provider: 'webpush', enabled: true } }),
    );
    expect(await enabling).toMatchObject({ state: 'cleanup-pending', canEnable: false });
    expect(await client.revoke()).toMatchObject({ state: 'cleanup-pending' });
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.prepared.unsubscribe).not.toHaveBeenCalled();
    expect(f.values.get('@rewind/private-reminder-association:account-one')).toContain(
      'old-context-id',
    );
  },
);

it('does not fall back to an older destination when the device-filtered recovery response is malformed', async () => {
  const f = fixture();
  f.values.set(
    '@rewind/private-reminder-association:account-one',
    JSON.stringify({ id: 'older-id' }),
  );
  await f.client.load();
  f.request
    .mockRejectedValueOnce(new Error('Registration response lost'))
    .mockResolvedValueOnce(reply({ destinations: [{ id: 'older-id' }] }));
  expect(await f.client.enable()).toMatchObject({ state: 'cleanup-pending' });
  expect(f.request).toHaveBeenLastCalledWith(
    '/real/groups/group%2Fone/reminders/destinations?deviceId=device-identity-123456',
    { signal: expect.any(AbortSignal) },
  );
  expect(f.request.mock.calls.some(([path]) => path.endsWith('/older-id'))).toBe(false);
});

it('recovers a lost registration reply through the authorized device-filtered GET and disables its exact destination', async () => {
  const f = fixture();
  await f.client.load();
  f.request.mockRejectedValueOnce(new Error('Registration response lost'));
  const result = await f.client.enable();
  expect(result).toMatchObject({ state: 'error', enabled: false, canDisable: false });
  expect(f.request).toHaveBeenNthCalledWith(
    3,
    '/real/groups/group%2Fone/reminders/destinations?deviceId=device-identity-123456',
    { signal: expect.any(AbortSignal) },
  );
  expect(f.request).toHaveBeenNthCalledWith(
    4,
    '/real/groups/group%2Fone/reminders/destinations/destination-one',
    expect.objectContaining({ body: '{"enabled":false}' }),
  );
  expect(f.values.has('@rewind/private-reminder-association:account-one')).toBe(false);
});

it('uses the persisted device identity for recovery before load after a restart', async () => {
  const f = fixture();
  f.values.set('@rewind/private-reminder-device', 'persisted_device_987654');
  f.values.set('@rewind/private-reminder-association:account-one', '{"uncertain":true}');
  const state = await f.client.revoke();
  expect(state).toMatchObject({ state: 'revoked', enabled: false, canDisable: false });
  expect(f.request).toHaveBeenNthCalledWith(
    1,
    '/real/groups/group%2Fone/reminders/destinations?deviceId=persisted_device_987654',
    { signal: expect.any(AbortSignal) },
  );
  expect(f.request).toHaveBeenNthCalledWith(
    2,
    expect.stringContaining('/destination-one'),
    expect.objectContaining({ body: '{"enabled":false}' }),
  );
  expect(f.options.createDeviceId).not.toHaveBeenCalled();
});

it.each([
  null,
  {},
  { destinations: null },
  { destinations: [] },
  { destinations: [{ id: '../foreign', provider: 'webpush', enabled: true }] },
  { destinations: [{ id: 'own-id', provider: 'unknown', enabled: true }] },
  { destinations: [{ id: 'own-id', provider: 'expo', enabled: 'true' }] },
  { destinations: [{ id: 'own-id', provider: 'expo' }] },
  {
    destinations: [
      { id: 'one', provider: 'expo', enabled: true },
      { id: 'two', provider: 'expo', enabled: true },
    ],
  },
])(
  'keeps malformed or empty device lookup pending without disabling a guessed destination: %j',
  async (body) => {
    const f = fixture();
    f.values.set('@rewind/private-reminder-device', 'persisted_device_987654');
    f.values.set(
      '@rewind/private-reminder-association:account-one',
      '{"id":"older-id","uncertain":true}',
    );
    f.request.mockResolvedValueOnce(reply(body as object));
    expect(await f.client.revoke()).toMatchObject({ state: 'cleanup-pending', canEnable: false });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0][1]).toEqual({ signal: expect.any(AbortSignal) });
    expect(f.values.has('@rewind/private-reminder-association:account-one')).toBe(true);
  },
);

it.each([401, 403, 500])('keeps failed device lookup %s pending for retry', async (status) => {
  const f = fixture();
  f.values.set('@rewind/private-reminder-device', 'persisted_device_987654');
  f.values.set('@rewind/private-reminder-association:account-one', '{"uncertain":true}');
  f.request.mockResolvedValueOnce(reply({ destinations: [] }, status));
  expect(await f.client.revoke()).toMatchObject({ state: 'cleanup-pending' });
  expect(f.values.has('@rewind/private-reminder-association:account-one')).toBe(true);
  expect(await f.client.revoke()).toMatchObject({ state: 'revoked' });
});

it('keeps failed disable pending and retries the recovered destination without clearing the session marker', async () => {
  const f = fixture();
  f.values.set('@rewind/private-reminder-device', 'persisted_device_987654');
  f.values.set('@rewind/private-reminder-association:account-one', '{"uncertain":true}');
  f.request
    .mockResolvedValueOnce(
      reply({ destinations: [{ id: 'recovered-id', provider: 'expo', enabled: true }] }),
    )
    .mockRejectedValueOnce(new Error('Disable reply lost'));
  expect(await f.client.revoke()).toMatchObject({ state: 'cleanup-pending' });
  expect(f.values.get('@rewind/private-reminder-association:account-one')).toContain(
    'recovered-id',
  );
  expect(await f.client.revoke()).toMatchObject({ state: 'revoked', enabled: false });
});

it('waits for the original registration promise before looking up and disabling its result', async () => {
  const f = fixture();
  const registration = deferred<Response>();
  await f.client.load();
  f.request.mockImplementationOnce(() => registration.promise);
  const enabling = f.client.enable();
  for (let step = 0; step < 8; step++) await Promise.resolve();
  const revoking = f.client.revoke();
  for (let step = 0; step < 8; step++) await Promise.resolve();
  expect(f.request).toHaveBeenCalledTimes(2);
  registration.resolve(reply({ destination: null }));
  await enabling;
  expect(await revoking).toMatchObject({ state: 'revoked' });
  expect(f.request).toHaveBeenNthCalledWith(3, expect.stringContaining('?deviceId='), {
    signal: expect.any(AbortSignal),
  });
  expect(f.request).toHaveBeenNthCalledWith(
    4,
    expect.stringContaining('/destination-one'),
    expect.objectContaining({ body: '{"enabled":false}' }),
  );
});

it('does not disable a recovered destination after authorization changes during the lookup', async () => {
  const f = fixture();
  const lookup = deferred<Response>();
  let current = true;
  f.values.set('@rewind/private-reminder-device', 'persisted_device_987654');
  f.values.set('@rewind/private-reminder-association:account-one', '{"uncertain":true}');
  f.request.mockImplementationOnce(() => lookup.promise);
  const client = createPrivateReminderClient({ ...f.options, isCurrentContext: () => current });
  const revoking = client.revoke();
  for (let step = 0; step < 8; step++) await Promise.resolve();
  expect(f.request).toHaveBeenCalledTimes(1);
  current = false;
  lookup.resolve(
    reply({ destinations: [{ id: 'recovered-id', provider: 'webpush', enabled: true }] }),
  );
  expect(await revoking).toMatchObject({ state: 'cleanup-pending' });
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.prepared.unsubscribe).not.toHaveBeenCalled();
});

it('never invents a replacement device identity for an uncertain registration with missing persisted identity', async () => {
  const f = fixture();
  f.values.set('@rewind/private-reminder-association:account-one', '{"uncertain":true}');
  expect(await f.client.load()).toMatchObject({ state: 'cleanup-pending' });
  expect(await f.client.revoke()).toMatchObject({ state: 'cleanup-pending' });
  expect(f.options.createDeviceId).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
});

it('keeps invalid JSON recovery replies pending and never posts a disable', async () => {
  const f = fixture();
  f.values.set('@rewind/private-reminder-device', 'persisted_device_987654');
  f.values.set('@rewind/private-reminder-association:account-one', '{"uncertain":true}');
  const malformed = reply({});
  malformed.json = async () => {
    throw new Error('Malformed reply');
  };
  f.request.mockResolvedValueOnce(malformed);
  expect(await f.client.revoke()).toMatchObject({ state: 'cleanup-pending' });
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.values.has('@rewind/private-reminder-association:account-one')).toBe(true);
});

it('requires a disable acknowledgement even when the device-filtered row is already disabled', async () => {
  const f = fixture();
  f.values.set('@rewind/private-reminder-device', 'persisted_device_987654');
  f.values.set('@rewind/private-reminder-association:account-one', '{"uncertain":true}');
  f.request
    .mockResolvedValueOnce(
      reply({ destinations: [{ id: 'already-disabled', provider: 'expo', enabled: false }] }),
    )
    .mockResolvedValueOnce(reply({ disabled: false }));
  expect(await f.client.revoke()).toMatchObject({ state: 'cleanup-pending' });
  expect(f.request).toHaveBeenLastCalledWith(
    expect.stringContaining('/already-disabled'),
    expect.objectContaining({ body: '{"enabled":false}' }),
  );
  expect(f.values.has('@rewind/private-reminder-association:account-one')).toBe(true);
});
