import AsyncStorage from '@react-native-async-storage/async-storage';
import { defaultPushPlatform, type PreparedPushPlatform, type PushPlatform } from './push-platform';

export interface PrivateReminderSnapshot {
  state:
    | 'available'
    | 'enabled'
    | 'denied'
    | 'unsupported'
    | 'unconfigured'
    | 'error'
    | 'cleanup-pending'
    | 'revoked';
  enabled: boolean;
  canEnable: boolean;
  canDisable: boolean;
  message: string;
}
export interface PrivateReminderClient {
  load(): Promise<PrivateReminderSnapshot>;
  enable(): Promise<PrivateReminderSnapshot>;
  disable(): Promise<PrivateReminderSnapshot>;
  // Await before changing server-selected group or clearing the original session.
  revoke(): Promise<PrivateReminderSnapshot>;
}
interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
const DEVICE_KEY = '@rewind/private-reminder-device';
const associationKey = (accountId: string) => `@rewind/private-reminder-association:${accountId}`;
const jsonOptions = (body: object): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function createPrivateReminderClient({
  accountId,
  groupId,
  authenticatedRequest: sendRequest,
  isCurrentContext,
  platform = defaultPushPlatform(),
  storage = AsyncStorage,
  createDeviceId = async () => (await import('expo-crypto')).randomUUID(),
}: {
  accountId: string;
  groupId: string;
  authenticatedRequest: (path: string, options?: RequestInit) => Promise<Response>;
  // Must compare the active account/session and server-selected group.
  isCurrentContext: () => boolean;
  platform?: PushPlatform;
  storage?: Storage;
  createDeviceId?: () => Promise<string>;
}): PrivateReminderClient {
  const path = `/real/groups/${encodeURIComponent(groupId)}/reminders/destinations`;
  const key = associationKey(accountId);
  let epoch = 0;
  let closed = false;
  let prepared: PreparedPushPlatform | undefined;
  let deviceId: string | undefined;
  let destinationId: string | undefined;
  let publicKey: string | null = null;
  let ready = false;
  let enabled = false;
  let cleanupPending = false;
  let registrationUncertain = false;
  let enabling: Promise<PrivateReminderSnapshot> | undefined;
  let loading: Promise<PrivateReminderSnapshot> | undefined;
  let cleaning: Promise<PrivateReminderSnapshot> | undefined;

  async function authenticatedRequest(path: string, options: RequestInit = {}) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Reminder request timed out.'));
      }, 10_000);
    });
    try {
      // The total deadline includes JSON consumption. The race also bounds
      // transports that do not honor abort after returning response headers.
      return await Promise.race([
        (async () => {
          const response = await sendRequest(path, { ...options, signal: controller.signal });
          const body: unknown = response.ok ? await response.json() : undefined;
          return { ok: response.ok, status: response.status, body };
        })(),
        deadline,
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  const result = (
    state: PrivateReminderSnapshot['state'],
    message: string,
  ): PrivateReminderSnapshot => ({
    state,
    enabled,
    canEnable: ready && !closed && isCurrentContext() && !cleanupPending && !enabled,
    canDisable: !!destinationId || cleanupPending || enabled,
    message,
  });
  const stale = () =>
    result(
      cleanupPending ? 'cleanup-pending' : 'revoked',
      'This reminder context has changed. Open the current group to continue.',
    );

  async function recoverUncertainDestination(): Promise<boolean> {
    if (!registrationUncertain) return true;
    if (!isCurrentContext()) return false;
    try {
      // Recovery must use the identity that crossed the registration boundary,
      // including after restart. Never generate a new identity for a lookup.
      deviceId ??= (await storage.getItem(DEVICE_KEY)) ?? undefined;
      if (!deviceId || !/^[A-Za-z0-9_-]{16,128}$/.test(deviceId) || !isCurrentContext())
        return false;
      const response = await authenticatedRequest(
        `${path}?deviceId=${encodeURIComponent(deviceId)}`,
      );
      if (!response.ok || !isCurrentContext()) return false;
      const body = response.body;
      if (!isCurrentContext() || !body || typeof body !== 'object' || Array.isArray(body))
        return false;
      const rows = (body as { destinations?: unknown }).destinations;
      // The account/device key is unique. Empty or ambiguous lookup results do
      // not prove that a lost registration is safe to forget.
      if (!Array.isArray(rows) || rows.length !== 1) return false;
      const row: unknown = rows[0];
      if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
      const candidate = row as { id?: unknown; provider?: unknown; enabled?: unknown };
      if (
        typeof candidate.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.id) ||
        (candidate.provider !== 'expo' && candidate.provider !== 'webpush') ||
        typeof candidate.enabled !== 'boolean'
      )
        return false;
      destinationId = candidate.id;
      // Keep uncertainty durable until the exact recovered row is disabled.
      await storage.setItem(key, JSON.stringify({ id: destinationId, uncertain: true }));
      return isCurrentContext();
    } catch {
      return false;
    }
  }

  async function cleanup(): Promise<boolean> {
    cleanupPending = true;
    if (destinationId || registrationUncertain) {
      try {
        await storage.setItem(
          key,
          JSON.stringify({
            id: destinationId,
            uncertain: registrationUncertain,
            cleanupPending: true,
          }),
        );
      } catch {
        return false;
      }
    }
    const recovered = await recoverUncertainDestination();
    let confirmed = recovered;
    if (destinationId && !isCurrentContext()) confirmed = false;
    if (recovered && destinationId && isCurrentContext()) {
      try {
        const response = await authenticatedRequest(
          `${path}/${encodeURIComponent(destinationId)}`,
          jsonOptions({ enabled: false }),
        );
        if (
          !response.ok ||
          (response.body as { disabled?: boolean } | null)?.disabled !== true ||
          !isCurrentContext()
        )
          confirmed = false;
        else registrationUncertain = false;
      } catch {
        confirmed = false;
      }
    }
    try {
      if (isCurrentContext()) await prepared?.unsubscribe();
      else confirmed = false;
    } catch {
      confirmed = false;
    }
    if (confirmed) {
      try {
        await storage.removeItem(key);
        destinationId = undefined;
        enabled = false;
        cleanupPending = false;
      } catch {
        confirmed = false;
      }
    }
    return confirmed;
  }

  async function load(): Promise<PrivateReminderSnapshot> {
    ready = false;
    const context = epoch;
    const active = () => !closed && isCurrentContext() && context === epoch;
    try {
      const persisted = await storage.getItem(key);
      if (!active()) return stale();
      if (persisted) {
        const metadata = JSON.parse(persisted) as {
          id?: unknown;
          uncertain?: boolean;
          cleanupPending?: boolean;
        };
        registrationUncertain = metadata.uncertain === true;
        cleanupPending = registrationUncertain || metadata.cleanupPending === true;
        if (typeof metadata.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(metadata.id))
          destinationId = metadata.id;
      }
      deviceId = (await storage.getItem(DEVICE_KEY)) ?? undefined;
      if (!deviceId && registrationUncertain)
        return result(
          'cleanup-pending',
          'The registered device identity is unavailable. Server removal remains unconfirmed.',
        );
      deviceId ??= await createDeviceId();
      if (!active()) return stale();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(deviceId)) throw new Error('device');
      await storage.setItem(DEVICE_KEY, deviceId);
      const capability = await platform.prepare();
      if (!active()) return stale();
      if ('unsupported' in capability) return result('unsupported', capability.unsupported);
      prepared = capability;
      if (cleanupPending && !(await cleanup()))
        return result(
          'cleanup-pending',
          'Device removal is unconfirmed; retry before switching accounts.',
        );
      if (!active()) return stale();
      const permission = await prepared.permission();
      if (!active()) return stale();
      if (permission === 'denied') {
        ready = false;
        if (!(await cleanup()))
          return result(
            'cleanup-pending',
            'Notification permission was revoked; server removal is unconfirmed. Retry before switching accounts.',
          );
        return result(
          'denied',
          'Notifications are denied. Allow them in device settings, then check again.',
        );
      }
      const response = await authenticatedRequest('/real/reminders/config');
      if (!response.ok) throw new Error('config');
      const config = response.body as {
        providers?: string[];
        webPushPublicKey?: string | null;
      };
      if (!active()) return stale();
      publicKey = config.webPushPublicKey ?? null;
      ready =
        Array.isArray(config.providers) &&
        config.providers.includes(prepared.provider) &&
        (prepared.provider !== 'webpush' || !!publicKey);
      if (!ready)
        return result(
          'unconfigured',
          'Remote reminder delivery is not configured. Group preferences remain usable.',
        );
      if (destinationId) {
        const status = await authenticatedRequest(path);
        if (!status.ok) throw new Error('status');
        const body = status.body as { destinations?: { id: string; enabled: boolean }[] };
        if (!active()) return stale();
        enabled =
          body.destinations?.some((item) => item.id === destinationId && item.enabled === true) ===
          true;
      }
      return result(
        enabled ? 'enabled' : 'available',
        enabled
          ? 'This device is registered. Reminder delivery is not confirmed.'
          : 'Enable remote reminders for this device with the button below.',
      );
    } catch {
      ready = false;
      return active()
        ? result('error', 'Reminder support could not be checked. Retry when connected.')
        : stale();
    }
  }

  async function enable(): Promise<PrivateReminderSnapshot> {
    if (!isCurrentContext()) return stale();
    if (!ready || !prepared || !deviceId || closed || cleanupPending)
      return result('error', 'Check reminder support before enabling this device.');
    if (enabled)
      return result('enabled', 'This device is registered. Reminder delivery is not confirmed.');
    const context = epoch;
    const active = () => !closed && isCurrentContext() && context === epoch;
    try {
      // The platform call starts before any await in response to the press gesture.
      const destination = await prepared.subscribe(publicKey, active);
      if (!active()) {
        await cleanup();
        return stale();
      }
      // Persist ambiguity before crossing the registration boundary so a lost
      // reply can be recovered using the authorized device-filtered GET.
      await storage.setItem(key, JSON.stringify({ id: destinationId, uncertain: true }));
      if (!active()) {
        await cleanup();
        return stale();
      }
      registrationUncertain = true;
      const response = await authenticatedRequest(
        path,
        jsonOptions({ deviceId, provider: prepared.provider, destination }),
      );
      if (!response.ok) {
        // These guarded route responses reject without registering a destination.
        if ([400, 401, 403, 404, 405, 503].includes(response.status)) registrationUncertain = false;
        throw new Error('registration');
      }
      const body = response.body as {
        destination?: { id?: string; enabled?: boolean; provider?: string };
      };
      if (
        !body.destination?.id ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(body.destination.id) ||
        body.destination.enabled !== true ||
        body.destination.provider !== prepared.provider
      )
        throw new Error('registration');
      destinationId = body.destination.id;
      registrationUncertain = false;
      // Only the opaque public ID persists. Never store the token, endpoint or keys.
      await storage.setItem(key, JSON.stringify({ id: destinationId }));
      if (!active()) {
        await cleanup();
        return stale();
      }
      enabled = true;
      return result('enabled', 'This device is registered. Reminder delivery is not confirmed.');
    } catch {
      const removed = await cleanup();
      if (!active()) return stale();
      if (!removed)
        return result(
          'cleanup-pending',
          'Device registration removal is unconfirmed. Retry before switching accounts.',
        );
      const denied = await prepared.permission().catch(() => 'default');
      if (denied === 'denied') ready = false;
      return result(
        denied === 'denied' ? 'denied' : 'error',
        denied === 'denied'
          ? 'Notifications are denied. Allow them in device settings, then check again.'
          : 'This device could not be registered. Check support and retry.',
      );
    }
  }

  function remove(revoke: boolean): Promise<PrivateReminderSnapshot> {
    epoch += 1;
    cleanupPending = true;
    if (revoke) {
      closed = true;
      ready = false;
    }
    if (cleaning) return cleaning;
    cleaning = (async () => {
      await loading;
      await enabling;
      // load may have been fenced before reading the persisted ID.
      if (!destinationId) {
        try {
          const persisted = await storage.getItem(key);
          const metadata = persisted
            ? (JSON.parse(persisted) as { id?: string; uncertain?: boolean })
            : null;
          const id = metadata?.id;
          registrationUncertain ||= metadata?.uncertain === true;
          if (id && /^[A-Za-z0-9_-]{1,128}$/.test(id)) destinationId = id;
        } catch {
          cleanupPending = true;
          return result(
            'cleanup-pending',
            'Device registration removal is unconfirmed. Retry before switching accounts.',
          );
        }
      }
      if (!prepared) {
        try {
          const capability = await platform.prepare();
          if (!('unsupported' in capability)) prepared = capability;
        } catch {
          cleanupPending = true;
          return result(
            'cleanup-pending',
            'Device registration removal is unconfirmed. Retry before switching accounts.',
          );
        }
      }
      const confirmed = await cleanup();
      return confirmed
        ? result(
            closed ? 'revoked' : 'available',
            'Remote reminder association removed from this device.',
          )
        : result(
            'cleanup-pending',
            'Device registration removal is unconfirmed. Retry before switching accounts.',
          );
    })().finally(() => {
      cleaning = undefined;
    });
    return cleaning;
  }
  return {
    load() {
      if (closed) return Promise.resolve(stale());
      if (cleaning) return cleaning;
      if (enabling) return enabling;
      return (loading ??= load().finally(() => {
        loading = undefined;
      }));
    },
    enable() {
      return (enabling ??= enable().finally(() => {
        enabling = undefined;
      }));
    },
    disable: () => remove(false),
    revoke: () => remove(true),
  };
}
