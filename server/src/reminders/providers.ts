import type {
  ReminderDestination,
  ReminderPayload,
  ReminderProvider,
  ReminderProviders,
  ReminderReceipt,
} from './outbox';
import { validReminderDestination } from './outbox';
import { validateReminderVapidConfig } from './config';

export const REMINDER_PROVIDER_TIMEOUT_MS = 5000;
export const REMINDER_PROVIDER_RESPONSE_MAX_BYTES = 65536;

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
function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}
function checkResponse(response: Response, expected: string): void {
  if (response.redirected || (response.url && response.url !== expected)) {
    cancelBody(response);
    throw new Error('Unexpected provider response.');
  }
}
async function deadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Provider deadline exceeded.'));
        }, REMINDER_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
async function boundedBody(response: Response, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (!response.body) return Buffer.alloc(0);
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > REMINDER_PROVIDER_RESPONSE_MAX_BYTES)
  ) {
    cancelBody(response);
    throw new Error('Provider response too large.');
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > REMINDER_PROVIDER_RESPONSE_MAX_BYTES)
        throw new Error('Provider response too large.');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel(); // cancellation itself must not extend the hard deadline
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
    return deadline(async (signal) => {
      const endpoint = `https://exp.host/--/api/v2/push/${path}`;
      const response = await fetcher(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}),
        },
        body: JSON.stringify(body),
      });
      checkResponse(response, endpoint);
      if (!response.ok) {
        cancelBody(response);
        return { ok: false as const, result: httpFailure(response.status) };
      }
      return {
        ok: true as const,
        body: JSON.parse((await boundedBody(response, signal)).toString('utf8')) as {
          data?: unknown;
        },
      };
    });
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
  config = validateReminderVapidConfig(config);
  return {
    async send(destination, payload) {
      const checked = validReminderDestination('webpush', destination);
      if (!checked) return invalid();
      try {
        const result = await deadline(() =>
          binding.sendNotification(checked, JSON.stringify(payload), {
            TTL: 900,
            timeout: REMINDER_PROVIDER_TIMEOUT_MS,
            // Stable opaque tag supports coalescing retries without media/group names.
            topic: payload.data.reminderId.replace(/-/g, '').slice(0, 32),
            vapidDetails: { ...config },
          }),
        );
        if (
          !Number.isInteger(result.statusCode) ||
          result.statusCode < 100 ||
          result.statusCode > 599
        )
          return transient();
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
    const vapid = validateReminderVapidConfig(config.webpush);
    if (!binding) {
      const packageName = 'web-push';
      const sdk = await import(packageName);
      const packaged = sdk.default ?? sdk;
      if (typeof packaged.generateRequestDetails !== 'function')
        throw new Error('Reminder provider unavailable.');
      const fetcher = options.fetcher ?? fetch;
      // SDK 3.6.7's sendNotification has an inactivity timeout and unbounded
      // response accumulation. Use its encryption/signing only; our transport
      // enforces total cancellation, body bounds and no redirect following.
      binding = {
        async sendNotification(subscription, payload, sendOptions) {
          return deadline(async (signal) => {
            const request = packaged.generateRequestDetails(subscription, payload, sendOptions) as {
              endpoint: string;
              method: string;
              headers: Record<string, string | number>;
              body: Uint8Array;
            };
            if (
              !('endpoint' in subscription) ||
              request.endpoint !== subscription.endpoint ||
              request.method !== 'POST' ||
              !(request.body instanceof Uint8Array) ||
              request.body.byteLength > REMINDER_PROVIDER_RESPONSE_MAX_BYTES
            )
              throw new Error('Invalid provider request.');
            const response = await fetcher(request.endpoint, {
              method: 'POST',
              redirect: 'error',
              signal,
              headers: Object.fromEntries(
                Object.entries(request.headers).map(([key, value]) => [key, String(value)]),
              ),
              body: new Uint8Array(request.body).buffer,
            });
            checkResponse(response, request.endpoint);
            if (!response.ok) cancelBody(response);
            else await boundedBody(response, signal);
            return { statusCode: response.status };
          });
        },
      };
    }
    if (!binding || typeof binding.sendNotification !== 'function')
      throw new Error('Reminder provider unavailable.');
    providers.webpush = createWebPushReminderProvider(vapid, binding);
  }
  return providers;
}
