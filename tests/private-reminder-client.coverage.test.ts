import {
  createPrivateReminderClient,
  type PrivateReminderSnapshot,
} from '../src/reminders/private-reminder-client';
import type { PreparedPushPlatform, PushPlatform } from '../src/reminders/push-platform';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const KEY = '@rewind/private-reminder-association:account-one';
const DEVICE_KEY = '@rewind/private-reminder-device';
const DEVICE = 'device-identity-123456';
const secret = { endpoint: 'https://push.invalid/secret', keys: { p256dh: 'k', auth: 'a' } };
const reply = (body: object, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

function fixture(overrides: { current?: () => boolean } = {}) {
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
  const platform: PushPlatform = { prepare: jest.fn(async () => prepared) };
  const request = jest.fn(async (path: string, options?: RequestInit): Promise<Response> => {
    if (path === '/real/reminders/config')
      return reply({ providers: ['webpush'], webPushPublicKey: 'public-key' });
    if (options?.method === 'POST' && path.endsWith('/destinations'))
      return reply({ destination: { id: 'destination-one', enabled: true, provider: 'webpush' } });
    if (options?.method === 'POST') return reply({ disabled: true });
    return reply({ destinations: [{ id: 'destination-one', provider: 'webpush', enabled: true }] });
  });
  const options = {
    isCurrentContext: overrides.current ?? (() => true),
    accountId: 'account-one',
    groupId: 'group-one',
    authenticatedRequest: request,
    platform,
    storage,
    createDeviceId: jest.fn(async () => DEVICE),
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

const snapshot = (value: PrivateReminderSnapshot) => ({
  state: value.state,
  enabled: value.enabled,
});

describe('load', () => {
  it('reports an enabled device when the server still lists its destination', async () => {
    const f = fixture();
    f.values.set(KEY, JSON.stringify({ id: 'destination-one' }));
    expect(await f.client.load()).toMatchObject({
      state: 'enabled',
      enabled: true,
      canEnable: false,
      canDisable: true,
    });
    expect(f.prepared.subscribe).not.toHaveBeenCalled();
  });

  it('reports available when the stored destination is gone or disabled on the server', async () => {
    const f = fixture();
    f.values.set(KEY, JSON.stringify({ id: 'destination-one' }));
    f.request.mockImplementation(async (path: string) =>
      path === '/real/reminders/config'
        ? reply({ providers: ['webpush'], webPushPublicKey: 'public-key' })
        : reply({ destinations: [{ id: 'destination-one', provider: 'webpush', enabled: false }] }),
    );
    expect(await f.client.load()).toMatchObject({ state: 'available', enabled: false });
  });

  it('ignores a stored destination id that is not an opaque identifier', async () => {
    const f = fixture();
    f.values.set(KEY, JSON.stringify({ id: '../escape' }));
    const loaded = await f.client.load();
    expect(loaded).toMatchObject({ state: 'available', canDisable: false });
    expect(f.request).not.toHaveBeenCalledWith(expect.stringContaining('destinations'));
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.client.load(), f.client.load()]);
    expect(a).toBe(b);
    expect(f.platform.prepare).toHaveBeenCalledTimes(1);
  });

  it('keeps a generated device identity so later loads reuse it', async () => {
    const f = fixture();
    await f.client.load();
    expect(f.values.get(DEVICE_KEY)).toBe(DEVICE);
    await createPrivateReminderClient({ ...f.options, createDeviceId: jest.fn() }).load();
    expect(f.options.createDeviceId).toHaveBeenCalledTimes(1);
  });

  it('shows an error when the device identity is not an opaque id', async () => {
    const f = fixture();
    f.options.createDeviceId.mockResolvedValue('short');
    const loaded = await createPrivateReminderClient(f.options).load();
    expect(loaded).toMatchObject({ state: 'error', canEnable: false });
    expect(f.values.has(DEVICE_KEY)).toBe(false);
  });

  it('shows an error when storage fails', async () => {
    const f = fixture();
    f.storage.getItem.mockRejectedValue(new Error('disk'));
    expect(await f.client.load()).toMatchObject({ state: 'error', canEnable: false });
  });

  it('shows an error, not a phantom success, when the config request fails', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(reply({}, 500));
    const loaded = await f.client.load();
    expect(loaded).toMatchObject({ state: 'error', canEnable: false });
    expect((await f.client.enable()).state).toBe('error');
    expect(f.prepared.subscribe).not.toHaveBeenCalled();
  });

  it('shows an error when the destination status request fails', async () => {
    const f = fixture();
    f.values.set(KEY, JSON.stringify({ id: 'destination-one' }));
    f.request.mockImplementation(async (path: string) =>
      path === '/real/reminders/config'
        ? reply({ providers: ['webpush'], webPushPublicKey: 'public-key' })
        : reply({}, 500),
    );
    expect(await f.client.load()).toMatchObject({ state: 'error' });
  });

  it('is unconfigured for web push without a public key', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(reply({ providers: ['webpush'], webPushPublicKey: null }));
    expect(await f.client.load()).toMatchObject({ state: 'unconfigured', canEnable: false });
  });

  it('is unconfigured when the server lists no provider array', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(reply({}));
    expect(await f.client.load()).toMatchObject({ state: 'unconfigured' });
  });

  it('reports denied after confirming no stale server association remains', async () => {
    const f = fixture();
    f.prepared.permission = jest.fn(async () => 'denied' as const);
    f.request.mockResolvedValueOnce(reply({ destinations: [] }));
    const loaded = await f.client.load();
    expect(loaded).toMatchObject({ state: 'denied', canEnable: false });
    expect(f.prepared.unsubscribe).toHaveBeenCalled();
  });

  it('keeps cleanup pending when a persisted cleanup cannot be confirmed', async () => {
    const f = fixture();
    f.values.set(KEY, JSON.stringify({ id: 'destination-one', cleanupPending: true }));
    f.request.mockImplementation(async (path: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? reply({}, 503)
        : reply({ destinations: [{ id: 'destination-one', provider: 'webpush', enabled: true }] }),
    );
    const loaded = await f.client.load();
    expect(loaded).toMatchObject({
      state: 'cleanup-pending',
      canEnable: false,
      canDisable: true,
      message: 'Device removal is unconfirmed; retry before switching accounts.',
    });
    expect(f.values.has(KEY)).toBe(true);
  });

  it('refuses to remove an uncertain registration when the device identity is missing', async () => {
    const f = fixture();
    f.values.set(KEY, JSON.stringify({ uncertain: true }));
    expect(await f.client.load()).toMatchObject({
      state: 'cleanup-pending',
      message: expect.stringContaining('device identity is unavailable'),
    });
  });

  it('is stale after the account context changes during load', async () => {
    let current = true;
    const f = fixture({ current: () => current });
    f.storage.getItem.mockImplementation(async () => {
      current = false;
      return null;
    });
    expect(await f.client.load()).toMatchObject({ state: 'revoked', canEnable: false });
  });

  it('is stale after revoke', async () => {
    const f = fixture();
    await f.client.load();
    await f.client.revoke();
    expect(await f.client.load()).toMatchObject({ state: 'revoked', canEnable: false });
  });
});

describe('enable', () => {
  it('refuses before the support check has run', async () => {
    const f = fixture();
    expect(await f.client.enable()).toMatchObject({ state: 'error', canEnable: false });
    expect(f.prepared.subscribe).not.toHaveBeenCalled();
  });

  it('is stale when the context has already changed', async () => {
    let current = true;
    const f = fixture({ current: () => current });
    await f.client.load();
    current = false;
    expect(await f.client.enable()).toMatchObject({ state: 'revoked' });
    expect(f.prepared.subscribe).not.toHaveBeenCalled();
  });

  it('is idempotent once enabled', async () => {
    const f = fixture();
    await f.client.load();
    await f.client.enable();
    const again = await f.client.enable();
    expect(snapshot(again)).toEqual({ state: 'enabled', enabled: true });
    expect(f.prepared.subscribe).toHaveBeenCalledTimes(1);
  });

  it('persists only the opaque destination id, never push material', async () => {
    const f = fixture();
    await f.client.load();
    await f.client.enable();
    expect(JSON.parse(f.values.get(KEY)!)).toEqual({ id: 'destination-one' });
    expect([...f.values.values()].join(' ')).not.toContain('push.invalid');
  });

  it('does not register into a context that changed while subscribing', async () => {
    let current = true;
    const f = fixture({ current: () => current });
    await f.client.load();
    f.prepared.subscribe = jest.fn(async () => {
      current = false;
      return secret;
    });
    // The new context is not ours to clean, so removal stays pending.
    expect(await f.client.enable()).toMatchObject({ state: 'cleanup-pending', canEnable: false });
    expect(f.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('removes the registration when the context changes after the server accepted it', async () => {
    let current = true;
    const f = fixture({ current: () => current });
    await f.client.load();
    f.request.mockImplementationOnce(async () => {
      const response = reply({
        destination: { id: 'destination-one', enabled: true, provider: 'webpush' },
      });
      current = false;
      return response;
    });
    const result = await f.client.enable();
    expect(result).toMatchObject({ state: 'cleanup-pending', canEnable: false });
  });

  it.each([400, 401, 403, 404, 405, 503])(
    'treats a %i registration rejection as certain, not a lost reply',
    async (status) => {
      const f = fixture();
      await f.client.load();
      f.request.mockImplementation(async (path: string, init?: RequestInit) => {
        if (init?.method === 'POST' && path.endsWith('/destinations')) return reply({}, status);
        return reply({ destinations: [] });
      });
      const result = await f.client.enable();
      expect(result).toMatchObject({ state: 'error', canEnable: true, enabled: false });
      expect(f.prepared.unsubscribe).toHaveBeenCalled();
      expect(f.values.has(KEY)).toBe(false);
    },
  );

  it('keeps an unexplained 500 registration failure pending until the server confirms', async () => {
    const f = fixture();
    await f.client.load();
    f.request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST' && path.endsWith('/destinations')) return reply({}, 500);
      return reply({ destinations: [] });
    });
    const result = await f.client.enable();
    expect(result).toMatchObject({ state: 'cleanup-pending', canEnable: false });
    expect(JSON.parse(f.values.get(KEY)!)).toMatchObject({ uncertain: true });
  });

  it.each<[string, object]>([
    ['no destination', {}],
    ['an unsafe id', { destination: { id: '../x', enabled: true, provider: 'webpush' } }],
    ['a disabled destination', { destination: { id: 'abc', enabled: false, provider: 'webpush' } }],
    ['another provider', { destination: { id: 'abc', enabled: true, provider: 'expo' } }],
  ])('rejects a registration reply with %s', async (_name, body) => {
    const f = fixture();
    await f.client.load();
    f.request.mockImplementation(async (path: string, init?: RequestInit) =>
      init?.method === 'POST' && path.endsWith('/destinations')
        ? reply(body)
        : reply({ destinations: [] }),
    );
    const result = await f.client.enable();
    expect(result.enabled).toBe(false);
    expect(result.state).not.toBe('enabled');
  });

  it('reports denied when the browser withdrew permission during registration', async () => {
    const f = fixture();
    await f.client.load();
    f.prepared.subscribe = jest.fn(async () => {
      throw new Error('Permission denied');
    });
    f.prepared.permission = jest.fn(async () => 'denied' as const);
    f.request.mockResolvedValue(reply({ destinations: [] }));
    const result = await f.client.enable();
    expect(result).toMatchObject({ state: 'denied', canEnable: false });
    expect(result.message).toMatch(/Allow them in device settings/);
  });

  it('reports a generic error when permission cannot be re-checked', async () => {
    const f = fixture();
    await f.client.load();
    f.prepared.subscribe = jest.fn(async () => {
      throw new Error('push service down');
    });
    f.prepared.permission = jest
      .fn<ReturnType<PreparedPushPlatform['permission']>, []>()
      .mockResolvedValueOnce('granted')
      .mockRejectedValueOnce(new Error('gone'));
    f.request.mockResolvedValue(reply({ destinations: [] }));
    expect(await f.client.enable()).toMatchObject({
      state: 'error',
      message: 'This device could not be registered. Check support and retry.',
    });
  });
  it('stops before the registration request when the context changes after saving the pending marker', async () => {
    let current = true;
    const f = fixture({ current: () => current });
    await f.client.load();
    f.storage.setItem.mockImplementation(async (key: string, value: string) => {
      f.values.set(key, value);
      if (value.includes('uncertain')) current = false;
    });
    expect(await f.client.enable()).toMatchObject({ state: 'cleanup-pending', canEnable: false });
    expect(f.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});

describe('recovering an uncertain registration', () => {
  function uncertain() {
    const f = fixture();
    f.values.set(KEY, JSON.stringify({ uncertain: true }));
    f.values.set(DEVICE_KEY, DEVICE);
    return f;
  }
  const lookup =
    (f: ReturnType<typeof fixture>, rows: unknown) => async (path: string, init?: RequestInit) => {
      if (path === '/real/reminders/config')
        return reply({ providers: ['webpush'], webPushPublicKey: 'public-key' });
      if (init?.method === 'POST') return reply({ disabled: true });
      return reply(rows as object);
    };

  it('disables the single device-filtered destination, then allows enabling again', async () => {
    const f = uncertain();
    f.request.mockImplementation(
      lookup(f, { destinations: [{ id: 'found-1', provider: 'webpush', enabled: true }] }),
    );
    expect(await f.client.load()).toMatchObject({ state: 'available', canEnable: true });
    expect(f.request).toHaveBeenCalledWith(
      `/real/groups/group-one/reminders/destinations?deviceId=${DEVICE}`,
      expect.anything(),
    );
    expect(f.request).toHaveBeenCalledWith(
      '/real/groups/group-one/reminders/destinations/found-1',
      expect.objectContaining({ body: '{"enabled":false}' }),
    );
    expect(f.values.has(KEY)).toBe(false);
  });

  it.each<[string, unknown]>([
    ['an array body', []],
    ['a null body', null],
    ['no rows', { destinations: [] }],
    [
      'two rows',
      {
        destinations: [
          { id: 'a', provider: 'webpush', enabled: true },
          { id: 'b', provider: 'webpush', enabled: true },
        ],
      },
    ],
    ['a non-array row list', { destinations: 'x' }],
    ['a non-object row', { destinations: ['x'] }],
    ['an unsafe row id', { destinations: [{ id: '../x', provider: 'webpush', enabled: true }] }],
    ['an unknown provider', { destinations: [{ id: 'a', provider: 'sms', enabled: true }] }],
    [
      'a non-boolean enabled flag',
      { destinations: [{ id: 'a', provider: 'webpush', enabled: 1 }] },
    ],
  ])('stays pending, and never disables a guess, for %s', async (_name, rows) => {
    const f = uncertain();
    f.request.mockImplementation(lookup(f, rows));
    expect(await f.client.load()).toMatchObject({ state: 'cleanup-pending', canEnable: false });
    expect(f.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(f.values.has(KEY)).toBe(true);
  });

  it('stays pending when the lookup fails', async () => {
    const f = uncertain();
    f.request.mockImplementation(async (path: string) => {
      if (path === '/real/reminders/config') return reply({ providers: ['webpush'] });
      throw new Error('offline');
    });
    expect(await f.client.load()).toMatchObject({ state: 'cleanup-pending' });
  });

  it('settles a pending cleanup without a destination once the server shows none', async () => {
    const f = fixture();
    f.values.set(KEY, JSON.stringify({ cleanupPending: true }));
    f.request.mockImplementation(lookup(f, { destinations: [] }));
    expect(await f.client.load()).toMatchObject({ state: 'available', canEnable: true });
    expect(f.values.has(KEY)).toBe(false);
  });

  it('does not start recovery for a context that is no longer current', async () => {
    let current = true;
    const f = fixture({ current: () => current });
    f.values.set(KEY, JSON.stringify({ cleanupPending: true }));
    f.prepared.permission = jest.fn(async () => 'granted' as const);
    f.platform.prepare = jest.fn(async () => {
      current = false;
      return f.prepared;
    });
    expect(await f.client.load()).toMatchObject({ state: 'cleanup-pending' });
    expect(f.request).not.toHaveBeenCalled();
  });
});

describe('permission revoked after registration', () => {
  it('keeps cleanup pending when the server association cannot be removed', async () => {
    const f = fixture();
    f.values.set(KEY, JSON.stringify({ id: 'destination-one' }));
    f.prepared.permission = jest.fn(async () => 'denied' as const);
    f.request.mockImplementation(async (_path: string, init?: RequestInit) =>
      init?.method === 'POST' ? reply({}, 503) : reply({}),
    );
    const loaded = await f.client.load();
    expect(loaded).toMatchObject({ state: 'cleanup-pending', canDisable: true, canEnable: false });
    expect(loaded.message).toMatch(/permission was revoked/);
  });
});

describe('disable', () => {
  async function enabledFixture() {
    const f = fixture();
    await f.client.load();
    await f.client.enable();
    return f;
  }

  it('returns to available once the server acknowledges and local push is removed', async () => {
    const f = await enabledFixture();
    expect(snapshot(await f.client.disable())).toEqual({ state: 'available', enabled: false });
    expect(f.values.has(KEY)).toBe(false);
    expect(f.prepared.unsubscribe).toHaveBeenCalled();
  });

  it('keeps cleanup pending when the disable request itself fails', async () => {
    const f = await enabledFixture();
    f.request.mockRejectedValueOnce(new Error('network down'));
    expect(await f.client.disable()).toMatchObject({
      state: 'cleanup-pending',
      canDisable: true,
      canEnable: false,
    });
    expect(f.values.has(KEY)).toBe(true);
  });

  it('keeps cleanup pending when the server does not confirm disabled: true', async () => {
    const f = await enabledFixture();
    f.request.mockResolvedValueOnce(reply({ disabled: false }));
    expect((await f.client.disable()).state).toBe('cleanup-pending');
  });

  it('keeps cleanup pending when the pending marker cannot be saved', async () => {
    const f = await enabledFixture();
    f.storage.setItem.mockRejectedValueOnce(new Error('quota'));
    const requestsBefore = f.request.mock.calls.length;
    expect(await f.client.disable()).toMatchObject({ state: 'cleanup-pending' });
    expect(f.request.mock.calls.length).toBe(requestsBefore);
  });

  it('keeps cleanup pending when local metadata cannot be removed', async () => {
    const f = await enabledFixture();
    f.storage.removeItem.mockRejectedValueOnce(new Error('locked'));
    expect(await f.client.disable()).toMatchObject({ state: 'cleanup-pending' });
    expect(snapshot(await f.client.disable())).toEqual({ state: 'available', enabled: false });
  });

  it('proceeds when local unsubscribe fails but the server confirmed removal', async () => {
    const f = await enabledFixture();
    f.prepared.unsubscribe = jest.fn(async () => {
      throw new Error('no registration');
    });
    expect(await f.client.disable()).toMatchObject({ state: 'available' });
  });

  it('keeps cleanup pending when persisted metadata cannot be read', async () => {
    const f = fixture();
    f.storage.getItem.mockRejectedValue(new Error('disk'));
    const result = await f.client.disable();
    expect(result).toMatchObject({
      state: 'cleanup-pending',
      message: 'Device registration removal is unconfirmed. Retry before switching accounts.',
    });
    expect(f.request).not.toHaveBeenCalled();
  });

  it('keeps cleanup pending when persisted metadata is corrupt', async () => {
    const f = fixture();
    f.values.set(KEY, '{not json');
    expect(await f.client.disable()).toMatchObject({ state: 'cleanup-pending' });
  });

  it('removes a stored destination without a prior load, even if capability discovery throws', async () => {
    const f = fixture();
    f.values.set(KEY, JSON.stringify({ id: 'destination-one' }));
    f.values.set(DEVICE_KEY, DEVICE);
    f.platform.prepare = jest.fn(async () => {
      throw new Error('no service worker');
    });
    expect(await f.client.disable()).toMatchObject({ state: 'available' });
    expect(f.request).toHaveBeenCalledWith(
      '/real/groups/group-one/reminders/destinations/destination-one',
      expect.objectContaining({ body: '{"enabled":false}' }),
    );
  });

  it('shares one cleanup between concurrent disable calls', async () => {
    const f = await enabledFixture();
    const [a, b] = await Promise.all([f.client.disable(), f.client.disable()]);
    expect(a).toBe(b);
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST').length).toBe(2);
  });
});

describe('request deadline', () => {
  it('turns a stalled support request into an error after 10 seconds', async () => {
    jest.useFakeTimers();
    try {
      const f = fixture();
      f.request.mockImplementation(
        (_path, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const loading = f.client.load();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(await loading).toMatchObject({ state: 'error', canEnable: false });
    } finally {
      jest.useRealTimers();
    }
  });
});
