import type {
  ReminderDestination,
  ReminderPayload,
  ReminderProvider,
  ReminderProviders,
  ReminderReceipt,
} from './outbox';
import { validReminderDestination } from './outbox';

export interface ReminderProviderConfig {
  expo?: { accessToken?: string };
  webpush?: { subject: string; publicKey: string; privateKey: string };
}
interface WebPushBinding {
  sendNotification(
    subscription: ReminderDestination,
    payload: string,
    options: {
      TTL: number;
      timeout: number;
      topic: string;
      vapidDetails: { subject: string; publicKey: string; privateKey: string };
    },
  ): Promise<{ statusCode: number }>;
}
const accepted = (): ReminderReceipt => ({ status: 'accepted', category: 'provider_accepted' });
const transient = (): ReminderReceipt => ({ status: 'transient', category: 'temporary_failure' });
const invalid = (): ReminderReceipt => ({ status: 'invalid', category: 'invalid_destination' });
function httpFailure(status: number): ReminderReceipt {
  if (status === 404 || status === 410) return invalid();
  if (status === 429) return { status: 'transient', category: 'rate_limited' };
  if (status >= 500) return transient();
  return { status: 'permanent', category: 'provider_rejected' };
}
function ticket(value: unknown): ReminderReceipt {
  if (!value || typeof value !== 'object') return transient();
  const row = value as { status?: unknown; id?: unknown; details?: { error?: unknown } };
  if (row.status === 'ok')
    return {
      ...accepted(),
      ...(typeof row.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row.id)
        ? { receiptId: row.id }
        : {}),
    };
  if (row.details?.error === 'DeviceNotRegistered') return invalid();
  if (row.details?.error === 'MessageRateExceeded')
    return { status: 'transient', category: 'rate_limited' };
  if (
    ['MessageTooBig', 'InvalidCredentials', 'MismatchSenderId'].includes(String(row.details?.error))
  )
    return { status: 'permanent', category: 'provider_rejected' };
  return transient();
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Provider response unavailable.');
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error('Provider response too large.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
/** Expo tickets/receipts establish provider acceptance, never phone delivery.
 * Protocol: https://docs.expo.dev/push-notifications/sending-notifications/ */
export function createExpoReminderProvider(
  config: { accessToken?: string } = {},
  fetcher: typeof fetch = fetch,
): ReminderProvider {
  const post = async (path: 'send' | 'getReceipts', body: unknown) => {
    const response = await fetcher(`https://exp.host/--/api/v2/push/${path}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { ok: false as const, result: httpFailure(response.status) };
    return { ok: true as const, body: (await boundedJson(response)) as { data?: unknown } };
  };
  return {
    async send(destination: ReminderDestination, payload: ReminderPayload) {
      const checked = validReminderDestination('expo', destination);
      if (!checked || !('token' in checked)) return invalid();
      try {
        const response = await post('send', {
          to: checked.token,
          title: payload.title,
          body: payload.body,
          data: payload.data,
          ttl: 900,
        });
        if (!response.ok) return response.result;
        const result = Array.isArray(response.body.data)
          ? response.body.data[0]
          : response.body.data;
        const receipt = ticket(result);
        // A malformed successful ticket must not cause an untracked resend.
        if (receipt.status === 'accepted' && !receipt.receiptId)
          return { status: 'accepted', category: 'receipt_unavailable' };
        return receipt;
      } catch {
        return transient();
      }
    },
    async receipt(id: string) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
        return { status: 'permanent', category: 'provider_rejected' };
      try {
        const response = await post('getReceipts', { ids: [id] });
        if (!response.ok) return response.result;
        const data = response.body.data;
        const value =
          data && typeof data === 'object' ? (data as Record<string, unknown>)[id] : null;
        return value ? ticket(value) : { status: 'pending', category: 'receipt_pending' };
      } catch {
        return transient();
      }
    },
  };
}
export function createWebPushReminderProvider(
  config: NonNullable<ReminderProviderConfig['webpush']>,
  binding: WebPushBinding,
): ReminderProvider {
  return {
    async send(destination, payload) {
      const checked = validReminderDestination('webpush', destination);
      if (!checked) return invalid();
      try {
        const result = await binding.sendNotification(checked, JSON.stringify(payload), {
          TTL: 900,
          timeout: 5000,
          // Stable opaque tag supports coalescing retries without media/group names.
          topic: payload.data.reminderId.replace(/-/g, '').slice(0, 32),
          vapidDetails: { ...config },
        });
        return result.statusCode >= 200 && result.statusCode < 300
          ? accepted()
          : httpFailure(result.statusCode);
      } catch (error) {
        const code =
          error && typeof error === 'object'
            ? (error as { statusCode?: unknown }).statusCode
            : null;
        return typeof code === 'number' ? httpFailure(code) : transient();
      }
    },
  };
}
/** Inert construction. Credentials remain caller configuration, not SQLite or
 * payload/log output. Provider operations happen only on explicit tick calls. */
export async function createConfiguredReminderProviders(
  config: ReminderProviderConfig | null | undefined,
  options: { fetcher?: typeof fetch; webpush?: WebPushBinding } = {},
): Promise<ReminderProviders> {
  if (!config) return {};
  const providers: ReminderProviders = {};
  if (config.expo) providers.expo = createExpoReminderProvider({ ...config.expo }, options.fetcher);
  if (config.webpush) {
    let binding = options.webpush;
    if (!binding) {
      const packageName = 'web-push';
      const sdk = await import(packageName);
      binding = sdk.default ?? sdk;
    }
    if (!binding || typeof binding.sendNotification !== 'function')
      throw new Error('Reminder provider unavailable.');
    providers.webpush = createWebPushReminderProvider({ ...config.webpush }, binding);
  }
  return providers;
}
