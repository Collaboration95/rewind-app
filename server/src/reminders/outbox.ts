import { createHash, randomUUID, ECDH } from 'node:crypto';
import type { RewindDatabase } from '../db';
import { validateRealSession } from '../auth';
import { getCurrentRealGroup, getRealGroup } from '../groups/real';
import { nextWeeklyReminderAt } from './schedule';

export type ReminderProviderName = 'expo' | 'webpush';
export type ReminderDestination =
  { token: string } | { endpoint: string; keys: { p256dh: string; auth: string } };
export type ReminderCategory =
  | 'provider_accepted'
  | 'receipt_pending'
  | 'receipt_unavailable'
  | 'invalid_destination'
  | 'rate_limited'
  | 'temporary_failure'
  | 'provider_rejected'
  | 'inactive'
  | 'unconfigured';
export interface ReminderReceipt {
  status: 'accepted' | 'pending' | 'transient' | 'invalid' | 'permanent';
  category: ReminderCategory;
  receiptId?: string;
}
export interface ReminderPayload {
  title: 'Rewind';
  body: string;
  data: { kind: 'weekly-reminder'; groupId: string; reminderId: string };
}
export interface ReminderProvider {
  send(destination: ReminderDestination, payload: ReminderPayload): Promise<ReminderReceipt>;
  receipt?(id: string): Promise<ReminderReceipt>;
}
export type ReminderProviders = Partial<Record<ReminderProviderName, ReminderProvider>>;
export interface ReminderActor {
  sessionToken: string;
  groupId: string;
}
const DAY_MS = 86400000;
const LEASE_MS = 60000;
const categories = new Set<ReminderCategory>([
  'provider_accepted',
  'receipt_pending',
  'receipt_unavailable',
  'invalid_destination',
  'rate_limited',
  'temporary_failure',
  'provider_rejected',
  'inactive',
  'unconfigured',
]);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function transaction<T>(db: RewindDatabase, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function actorAccount(db: RewindDatabase, actor: ReminderActor, now: Date) {
  const session = validateRealSession(db, actor.sessionToken, now);
  if (session.status !== 'valid') return null;
  const accountId = session.account.id;
  return getRealGroup(db, accountId, actor.groupId) &&
    getCurrentRealGroup(db, accountId)?.group.id === actor.groupId
    ? accountId
    : null;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function validReminderDestination(
  provider: unknown,
  input: unknown,
): ReminderDestination | null {
  const value = record(input);
  if (!value) return null;
  if (provider === 'expo')
    return Object.keys(value).length === 1 &&
      typeof value.token === 'string' &&
      /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{10,256}\]$/.test(value.token)
      ? { token: value.token }
      : null;
  if (
    provider !== 'webpush' ||
    Object.keys(value).sort().join(',') !== 'endpoint,keys' ||
    typeof value.endpoint !== 'string' ||
    value.endpoint.length > 2048
  )
    return null;
  const keys = record(value.keys);
  if (
    !keys ||
    Object.keys(keys).sort().join(',') !== 'auth,p256dh' ||
    typeof keys.auth !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(keys.auth) ||
    typeof keys.p256dh !== 'string' ||
    !/^[A-Za-z0-9_-]{87}$/.test(keys.p256dh) ||
    Buffer.from(keys.auth, 'base64url').length !== 16 ||
    Buffer.from(keys.p256dh, 'base64url').length !== 65
  )
    return null;
  try {
    const publicBytes = Buffer.from(keys.p256dh, 'base64url');
    if (
      publicBytes[0] !== 4 ||
      publicBytes.toString('base64url') !== keys.p256dh ||
      Buffer.from(keys.auth, 'base64url').toString('base64url') !== keys.auth
    )
      return null;
    ECDH.convertKey(publicBytes, 'prime256v1');
    const url = new URL(value.endpoint);
    // Restrict provider traffic to supported public push services; no arbitrary
    // URL, local address, credentials or configurable redirect is accepted.
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !(
        ['web.push.apple.com', 'updates.push.services.mozilla.com', 'fcm.googleapis.com'].includes(
          url.hostname,
        ) ||
        url.hostname.endsWith('.notify.windows.com') // Microsoft Edge (WNS)
      )
    )
      return null;
    return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
  } catch {
    return null;
  }
}
function publicDestination(row: DestinationRow) {
  return {
    id: row.id,
    provider: row.provider,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  };
}
interface DestinationRow {
  id: string;
  account_id: string;
  session_token_hash: string;
  device_key: string;
  provider: ReminderProviderName;
  destination_hash: string;
  destination_json: string;
  generation: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}
export function registerReminderDestination(
  db: RewindDatabase,
  actor: ReminderActor,
  input: { deviceId: unknown; provider: unknown; destination: unknown },
  now = new Date(),
) {
  const destination = validReminderDestination(input.provider, input.destination);
  if (
    !destination ||
    typeof input.deviceId !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(input.deviceId) ||
    !Number.isFinite(now.getTime())
  )
    return { ok: false as const, reason: 'invalid_destination' };
  return transaction(db, () => {
    const accountId = actorAccount(db, actor, now);
    if (!accountId) return { ok: false as const, reason: 'forbidden' };
    const provider = input.provider as ReminderProviderName;
    const identity = 'token' in destination ? destination.token : destination.endpoint;
    const hash = digest(identity);
    const existing = db
      .prepare('SELECT * FROM reminder_destinations WHERE provider = ? AND destination_hash = ?')
      .get(provider, hash) as DestinationRow | undefined;
    if (existing && existing.account_id !== accountId) {
      const live = db
        .prepare(
          'SELECT 1 FROM real_account_sessions WHERE token_hash = ? AND revoked_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ?',
        )
        .get(existing.session_token_hash, now.toISOString(), now.toISOString());
      if (live && existing.enabled === 1) return { ok: false as const, reason: 'forbidden' };
      db.prepare('DELETE FROM reminder_destinations WHERE id = ?').run(existing.id);
    }
    const deviceKey = digest(`${accountId}:${input.deviceId}`);
    const sameDevice = db
      .prepare('SELECT * FROM reminder_destinations WHERE account_id = ? AND device_key = ?')
      .get(accountId, deviceKey) as DestinationRow | undefined;
    // Identical destinations on another browser/device collapse to one record.
    const owned = sameDevice ?? (existing?.account_id === accountId ? existing : undefined);
    const id = owned?.id ?? randomUUID();
    const json = JSON.stringify(destination);
    const sessionHash = digest(actor.sessionToken);
    if (owned) {
      if (
        sameDevice &&
        existing &&
        existing.id !== sameDevice.id &&
        existing.account_id === accountId
      )
        db.prepare('DELETE FROM reminder_destinations WHERE id = ?').run(existing.id);
      const changed =
        owned.destination_json !== json ||
        owned.session_token_hash !== sessionHash ||
        owned.enabled !== 1;
      db.prepare(
        'UPDATE reminder_destinations SET session_token_hash = ?, device_key = ?, provider = ?, destination_hash = ?, destination_json = ?, enabled = 1, generation = generation + ?, updated_at = ? WHERE id = ? AND account_id = ?',
      ).run(
        sessionHash,
        deviceKey,
        provider,
        hash,
        json,
        changed ? 1 : 0,
        now.toISOString(),
        id,
        accountId,
      );
    } else
      db.prepare(
        'INSERT INTO reminder_destinations (id,account_id,session_token_hash,device_key,provider,destination_hash,destination_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)',
      ).run(
        id,
        accountId,
        sessionHash,
        deviceKey,
        provider,
        hash,
        json,
        now.toISOString(),
        now.toISOString(),
      );
    const row = db
      .prepare('SELECT * FROM reminder_destinations WHERE id = ?')
      .get(id) as unknown as DestinationRow;
    return { ok: true as const, destination: publicDestination(row) };
  });
}
export function listReminderDestinations(
  db: RewindDatabase,
  actor: ReminderActor,
  now = new Date(),
  deviceId?: string,
) {
  const accountId = actorAccount(db, actor, now);
  if (!accountId) return null;
  // A destination is registered to one exact session. A restored account with
  // a new session must explicitly re-register, even when the device ID matches.
  const publicForSession = (row: DestinationRow) => ({
    ...publicDestination(row),
    enabled: row.enabled === 1 && row.session_token_hash === digest(actor.sessionToken),
  });
  if (deviceId !== undefined) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(deviceId)) return null;
    return (
      db
        .prepare('SELECT * FROM reminder_destinations WHERE account_id = ? AND device_key = ?')
        .all(accountId, digest(`${accountId}:${deviceId}`)) as unknown as DestinationRow[]
    ).map(publicForSession);
  }
  return (
    db
      .prepare(
        'SELECT * FROM reminder_destinations WHERE account_id = ? ORDER BY updated_at DESC,id LIMIT 20',
      )
      .all(accountId) as unknown as DestinationRow[]
  ).map(publicForSession);
}
export function disableReminderDestination(
  db: RewindDatabase,
  actor: ReminderActor,
  id: string,
  now = new Date(),
) {
  return transaction(db, () => {
    const accountId = actorAccount(db, actor, now);
    if (!accountId) return false;
    return (
      Number(
        db
          .prepare(
            'UPDATE reminder_destinations SET enabled = 0, generation = generation + 1, updated_at = ? WHERE id = ? AND account_id = ?',
          )
          .run(now.toISOString(), id, accountId).changes,
      ) === 1
    );
  });
}
function latestSunday(now: Date, zone: string): string {
  let candidate = nextWeeklyReminderAt(new Date(now.getTime() - 8 * DAY_MS), zone);
  let result = candidate;
  for (let scan = 0; scan < 3 && Date.parse(candidate) <= now.getTime(); scan++) {
    result = candidate;
    candidate = nextWeeklyReminderAt(new Date(candidate), zone);
  }
  return result;
}
export function scanDueReminderJobs(
  db: RewindDatabase,
  now = new Date(),
  options: { limit?: number; after?: string } = {},
) {
  const limit = options.limit ?? 100;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isFinite(now.getTime()) ||
    (options.after !== undefined && options.after.length > 512)
  )
    throw new RangeError('Invalid reminder scan bounds.');
  return transaction(db, () => {
    const rows = db
      .prepare(
        `SELECT p.group_id,p.account_id,p.snoozed_until,p.updated_at,m.accepted_at,g.time_zone
      FROM real_group_reminder_preferences p JOIN real_group_memberships m ON m.group_id = p.group_id AND m.account_id = p.account_id
      JOIN real_group_metadata g ON g.group_id = p.group_id WHERE p.enabled = 1 AND p.group_id || ':' || p.account_id > ?
      ORDER BY p.group_id || ':' || p.account_id LIMIT ?`,
      )
      .all(options.after ?? '', limit) as unknown as {
      group_id: string;
      account_id: string;
      snoozed_until: string | null;
      updated_at: string;
      accepted_at: string;
      time_zone: string;
    }[];
    let queued = 0;
    for (const row of rows) {
      if (getCurrentRealGroup(db, row.account_id)?.group.id !== row.group_id) continue;
      const scheduledAt = latestSunday(now, row.time_zone);
      const scheduled = Date.parse(scheduledAt);
      if (
        scheduled > now.getTime() ||
        now.getTime() - scheduled > DAY_MS ||
        Date.parse(row.accepted_at) > scheduled ||
        Date.parse(row.updated_at) > scheduled ||
        (row.snoozed_until !== null && Date.parse(row.snoozed_until) > scheduled)
      )
        continue;
      const destination = db
        .prepare(
          `SELECT d.* FROM reminder_destinations d JOIN real_account_sessions s ON s.token_hash = d.session_token_hash
        WHERE d.account_id = ? AND s.account_id = d.account_id AND d.enabled = 1 AND s.revoked_at IS NULL
        AND s.idle_expires_at > ? AND s.absolute_expires_at > ? AND d.created_at <= ? ORDER BY d.updated_at DESC,d.id LIMIT 1`,
        )
        .get(row.account_id, now.toISOString(), now.toISOString(), scheduledAt) as
        DestinationRow | undefined;
      if (!destination) continue;
      const localSunday = new Intl.DateTimeFormat('en-CA', {
        timeZone: row.time_zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(scheduledAt));
      queued += Number(
        db
          .prepare(
            `INSERT INTO reminder_outbox (id,group_id,account_id,local_sunday,scheduled_at,destination_id,destination_generation,state,next_attempt_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'pending',?,?,?) ON CONFLICT(group_id,account_id,local_sunday) DO NOTHING`,
          )
          .run(
            randomUUID(),
            row.group_id,
            row.account_id,
            localSunday,
            scheduledAt,
            destination.id,
            destination.generation,
            scheduledAt,
            now.toISOString(),
            now.toISOString(),
          ).changes,
      );
    }
    const last = rows.at(-1);
    return {
      queued,
      scanned: rows.length,
      nextCursor: rows.length === limit && last ? `${last.group_id}:${last.account_id}` : null,
    };
  });
}
interface JobRow {
  id: string;
  group_id: string;
  account_id: string;
  scheduled_at: string;
  destination_id: string | null;
  destination_generation: number;
  state: string;
  attempts: number;
  receipt_attempts: number;
  provider_receipt: string | null;
  lease_id: string | null;
  lease_expires_at: string | null;
}
function eligible(db: RewindDatabase, job: JobRow, now: Date): DestinationRow | null {
  if (now.getTime() - Date.parse(job.scheduled_at) > DAY_MS) return null;
  if (getCurrentRealGroup(db, job.account_id)?.group.id !== job.group_id) return null;
  return (
    (db
      .prepare(
        `SELECT d.* FROM reminder_destinations d JOIN real_account_sessions s ON s.token_hash = d.session_token_hash
    JOIN real_group_reminder_preferences p ON p.account_id = d.account_id AND p.group_id = ?
    JOIN real_group_memberships m ON m.account_id = d.account_id AND m.group_id = p.group_id
    WHERE d.id = ? AND d.account_id = ? AND d.generation = ? AND d.enabled = 1
    AND s.account_id = d.account_id AND s.revoked_at IS NULL AND s.idle_expires_at > ? AND s.absolute_expires_at > ?
    AND p.enabled = 1 AND (p.snoozed_until IS NULL OR p.snoozed_until <= ?)`,
      )
      .get(
        job.group_id,
        job.destination_id,
        job.account_id,
        job.destination_generation,
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
      ) as DestinationRow | undefined) ?? null
  );
}
function safeReceipt(value: ReminderReceipt): ReminderReceipt {
  if (
    !value ||
    !['accepted', 'pending', 'transient', 'invalid', 'permanent'].includes(value.status) ||
    !categories.has(value.category) ||
    (value.receiptId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(value.receiptId))
  )
    return { status: 'transient', category: 'temporary_failure' };
  return value;
}
/** At-least-once provider sends: a crash after provider acceptance but before
 * the persisted receipt can repeat a send. The stable reminder ID supports
 * provider/client deduplication; queue creation itself is exactly once. */
export async function runReminderOutboxTick(
  db: RewindDatabase,
  providers: ReminderProviders,
  options: { now?: () => Date } = {},
) {
  const clock = options.now ?? (() => new Date());
  const now = clock();
  const names = (['expo', 'webpush'] as const).filter((name) => providers[name]);
  if (!names.length) return { claimed: false as const, category: 'unconfigured' as const };
  const claimed = transaction(db, () => {
    const candidates = db
      .prepare(
        `SELECT j.* FROM reminder_outbox j LEFT JOIN reminder_destinations d ON d.id = j.destination_id
      WHERE j.next_attempt_at <= ? AND j.state IN ('pending','retry','sending','awaiting_receipt')
      AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= ?) AND (d.provider IN (${names.map(() => '?').join(',')}) OR d.id IS NULL)
      ORDER BY j.next_attempt_at,j.id LIMIT 10`,
      )
      .all(now.toISOString(), now.toISOString(), ...names) as unknown as JobRow[];
    for (const job of candidates) {
      const destination = eligible(db, job, now);
      const receipt = job.state === 'awaiting_receipt';
      if (destination && receipt && job.receipt_attempts >= 3) {
        db.prepare(
          "UPDATE reminder_outbox SET state = 'accepted', response_category = 'receipt_unavailable', lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
        ).run(now.toISOString(), job.id);
        continue;
      }
      if (!destination || (!receipt && job.attempts >= 3)) {
        db.prepare(
          'UPDATE reminder_outbox SET state = ?, response_category = ?, lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?',
        ).run(
          destination ? 'failed' : 'cancelled',
          destination ? 'temporary_failure' : 'inactive',
          now.toISOString(),
          job.id,
        );
        continue;
      }
      const lease = randomUUID();
      db.prepare(
        `UPDATE reminder_outbox SET state = ?, attempts = attempts + ?, receipt_attempts = receipt_attempts + ?, lease_id = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`,
      ).run(
        receipt ? 'awaiting_receipt' : 'sending',
        receipt ? 0 : 1,
        receipt ? 1 : 0,
        lease,
        new Date(now.getTime() + LEASE_MS).toISOString(),
        now.toISOString(),
        job.id,
      );
      return { job, destination, receipt, lease };
    }
    return null;
  });
  if (!claimed) return { claimed: false as const, category: null };
  const { job, destination, receipt, lease } = claimed;
  const provider = providers[destination.provider]!;
  let result: ReminderReceipt;
  try {
    result = safeReceipt(
      receipt
        ? provider.receipt && job.provider_receipt
          ? await provider.receipt(job.provider_receipt)
          : { status: 'accepted', category: 'receipt_unavailable' }
        : await provider.send(JSON.parse(destination.destination_json) as ReminderDestination, {
            title: 'Rewind',
            body: 'Your weekly reminder is ready. Open Rewind to check your group.',
            data: { kind: 'weekly-reminder', groupId: job.group_id, reminderId: job.id },
          }),
    );
  } catch {
    result = { status: 'transient', category: 'temporary_failure' };
  }
  return transaction(db, () => {
    const current = db
      .prepare('SELECT lease_id,lease_expires_at FROM reminder_outbox WHERE id = ?')
      .get(job.id) as { lease_id: string; lease_expires_at: string } | undefined;
    const at = clock();
    if (
      !current ||
      current.lease_id !== lease ||
      Date.parse(current.lease_expires_at) <= at.getTime()
    )
      return { claimed: true as const, id: job.id, state: 'stale', category: null };
    const stillEligible = eligible(db, job, at);
    let state: string;
    let category = result.category;
    let next = at.toISOString();
    if (!stillEligible) {
      state = 'cancelled';
      category = 'inactive';
    } else if (result.status === 'invalid') {
      state = 'failed';
      db.prepare(
        'UPDATE reminder_destinations SET enabled = 0, generation = generation + 1, updated_at = ? WHERE id = ? AND generation = ?',
      ).run(at.toISOString(), destination.id, destination.generation);
    } else if (result.status === 'permanent') state = 'failed';
    else if (result.status === 'accepted') {
      state = !receipt && result.receiptId && provider.receipt ? 'awaiting_receipt' : 'accepted';
      if (state === 'awaiting_receipt') next = new Date(at.getTime() + 15 * 60000).toISOString();
    } else if (receipt) {
      state = job.receipt_attempts + 1 >= 3 ? 'accepted' : 'awaiting_receipt';
      if (state === 'accepted') category = 'receipt_unavailable';
      else next = new Date(at.getTime() + 5 * 60000).toISOString();
    } else {
      state = job.attempts + 1 >= 3 ? 'failed' : 'retry';
      if (state === 'retry')
        next = new Date(at.getTime() + 30000 * 2 ** job.attempts).toISOString();
    }
    db.prepare(
      'UPDATE reminder_outbox SET state = ?, response_category = ?, provider_receipt = COALESCE(?,provider_receipt), next_attempt_at = ?, lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_id = ?',
    ).run(state, category, result.receiptId ?? null, next, at.toISOString(), job.id, lease);
    return { claimed: true as const, id: job.id, state, category };
  });
}
export function listReminderOutbox(db: RewindDatabase, actor: ReminderActor, now = new Date()) {
  const accountId = actorAccount(db, actor, now);
  if (!accountId) return null;
  return db
    .prepare(
      'SELECT id,scheduled_at AS scheduledAt,state,attempts,receipt_attempts AS receiptAttempts,response_category AS category,updated_at AS updatedAt FROM reminder_outbox WHERE group_id = ? AND account_id = ? ORDER BY scheduled_at DESC,id LIMIT 20',
    )
    .all(actor.groupId, accountId);
}

export function reminderDeliveryStatus(
  db: RewindDatabase,
  accountId: string,
  providers: ReminderProviders,
  now = new Date(),
) {
  const names = (['expo', 'webpush'] as const).filter((name) => providers[name]);
  if (!names.length)
    return {
      state: 'not-configured',
      message: 'Reminder delivery is not configured. Your preference is saved for this group.',
    };
  const active = db
    .prepare(
      `SELECT d.id FROM reminder_destinations d
    JOIN real_account_sessions s ON s.token_hash = d.session_token_hash
    WHERE d.account_id = ? AND s.account_id = d.account_id AND d.enabled = 1
    AND d.provider IN (${names.map(() => '?').join(',')}) AND s.revoked_at IS NULL
    AND s.idle_expires_at > ? AND s.absolute_expires_at > ? LIMIT 1`,
    )
    .get(accountId, ...names, now.toISOString(), now.toISOString());
  return active
    ? {
        state: 'registered',
        message:
          'An active device is registered. A reminder worker must run; delivery is not confirmed.',
      }
    : {
        state: 'registration-required',
        message:
          'A reminder provider is configured. Register a supported device to receive reminders.',
      };
}
