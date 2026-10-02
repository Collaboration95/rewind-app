import { createHash, randomUUID } from 'node:crypto';

import { validateRealSession } from '../auth';
import {
  contributionQuotaWindow,
  ensureContributionQuotaWindow,
  reserveContributionAllowance,
} from '../contributions';
import { linkContributionReplacement } from '../contributions/ledger';
import { cyclePhase } from '../cycles/engine';
import type { RewindDatabase } from '../db';
import { probeClipWithFfmpeg, probePhotoWithFfmpeg } from '../ffmpeg';
import {
  MAX_CLIP_BYTES,
  recordClipMediaMetadata,
  validateClipUpload,
  type CaptureMode,
  type ServerClipMetadata,
} from './index';
import {
  decodeMediaRef,
  encodeMediaRef,
  MediaStoreError,
  putRef,
  validateRef,
  type MediaObjectRef,
  type MediaScope,
  type MediaStore,
} from './store';
import { materializeStoredMedia } from './store-files';

export const UPLOAD_INTENT_TTL_MS = 15 * 60 * 1000;
export type UploadTarget = Omit<MediaObjectRef, 'versionId'>;
export interface UploadCapability {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}
/** Runtime adapter signs exactly this target/checksum and supplies bounded,
 * stable version-keyset pages. Neither capability nor session token is persisted. */
export interface UploadIntentTransport {
  readonly backend: MediaObjectRef['backend'];
  readonly storeId: string;
  signPut(scope: MediaScope, target: UploadTarget): Promise<UploadCapability>;
  listVersions(
    scope: MediaScope,
    target: UploadTarget,
    cursor: string | null,
    limit: number,
  ): Promise<{ refs: MediaObjectRef[]; nextCursor: string | null }>;
}
export interface UploadIntentActor {
  sessionToken: string;
  groupId: string;
}
export interface UploadIntentRequest {
  idempotencyKey: string;
  mediaType: 'video' | 'photo';
  contentType: 'video/mp4' | 'image/jpeg' | 'image/png';
  byteLength: number;
  sha256: string;
  /** Planned contribution duration; a photo always uses three seconds. */
  durationSeconds: number;
  trimStartSeconds?: number;
  trimEndSeconds?: number;
  mode?: CaptureMode;
  replacesContributionId?: string;
}
interface NormalizedRequest extends UploadIntentRequest {
  mode: CaptureMode;
  trimStartSeconds: number;
  trimEndSeconds: number;
}
export interface UploadIntentDependencies {
  environment: string;
  store: MediaStore;
  transport: UploadIntentTransport;
  scratchDir: string;
  ffmpegBin: string;
  now?: () => Date;
  /** Trusted server adapter only; default is the real FFprobe boundary. */
  probe?: (
    path: string,
    mediaType: 'video' | 'photo',
  ) => Promise<Omit<ServerClipMetadata, 'sourceUri'>>;
}
export type UploadIntentFailure =
  | 'session_required'
  | 'forbidden'
  | 'invalid_request'
  | 'closed_cycle'
  | 'quota_exceeded'
  | 'idempotency_conflict'
  | 'not_found'
  | 'expired'
  | 'version_conflict'
  | 'invalid_media'
  | 'source_unavailable'
  | 'replacement_conflict'
  | 'storage_failed';
export type UploadIntentResult<T> =
  { ok: true; value: T } | { ok: false; reason: UploadIntentFailure };
export interface UploadIntentStatus {
  id: string;
  cycleId: string;
  profileId: string;
  state: 'open' | 'pinned' | 'completed' | 'expired';
  expiresAt: string;
  /** Opaque version identity supports retry after a lost completion response. */
  versionId: string | null;
  contributionId: string | null;
  jobId: string | null;
}
interface IntentRow {
  id: string;
  environment: string;
  group_id: string;
  account_id: string;
  profile_id: string;
  cycle_id: string;
  quota_window_start_at: string;
  idempotency_hash: string;
  request_hash: string;
  request_json: string;
  target_json: string;
  reserved_seconds: number;
  state: UploadIntentStatus['state'];
  pinned_ref: string | null;
  contribution_id: string | null;
  job_id: string | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
  cleanup_cursor: string | null;
  cleanup_complete: number;
}
interface Authority {
  accountId: string;
  profileId: string;
  groupId: string;
  cycleId: string;
  startsAt: string;
  endsAt: string;
  status: 'collecting' | 'revealing' | 'archived';
  maxCount: number;
  maxSeconds: number;
}
class IntentError extends Error {
  constructor(readonly reason: UploadIntentFailure) {
    super(reason);
  }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(reason: UploadIntentFailure): never {
  throw new IntentError(reason);
}
function clock(deps: UploadIntentDependencies): Date {
  const now = deps.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) fail('invalid_request');
  return now;
}
function transaction<T>(database: RewindDatabase, run: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      database.exec('BEGIN IMMEDIATE');
      break;
    } catch (error) {
      if (
        attempt >= 7 ||
        !/SQLITE_BUSY|database is locked/i.test(String((error as Error)?.message))
      )
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2 ** attempt);
    }
  }
  try {
    const value = run();
    database.exec('COMMIT');
    return value;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
function errorResult<T>(error: unknown): UploadIntentResult<T> {
  if (error instanceof IntentError) return { ok: false, reason: error.reason };
  if (error instanceof MediaStoreError)
    return {
      ok: false,
      reason:
        error.code === 'integrity_mismatch'
          ? 'invalid_media'
          : error.code === 'expired'
            ? 'expired'
            : 'source_unavailable',
    };
  return { ok: false, reason: 'storage_failed' };
}
function authorize(database: RewindDatabase, actor: UploadIntentActor, now: Date): Authority {
  if (!actor || typeof actor.sessionToken !== 'string') fail('session_required');
  const session = validateRealSession(database, actor.sessionToken, now);
  if (session.status !== 'valid') fail('session_required');
  const authority = database
    .prepare(
      `SELECT m.account_id AS accountId, m.profile_id AS profileId,
    m.group_id AS groupId, c.id AS cycleId, c.starts_at AS startsAt, c.ends_at AS endsAt,
    c.status, c.max_count AS maxCount, c.max_seconds AS maxSeconds
    FROM real_group_memberships m
    JOIN real_profiles p ON p.account_id = m.account_id AND p.id = m.profile_id
    JOIN profiles media_actor ON media_actor.id = p.id AND media_actor.is_synthetic = 0
    JOIN real_account_group_selections selected ON selected.account_id = m.account_id AND selected.group_id = m.group_id
    JOIN groups g ON g.id = m.group_id JOIN cycles c ON c.id = g.current_cycle_id AND c.group_id = g.id
    WHERE m.account_id = ? AND m.group_id = ? AND m.accepted_at IS NOT NULL`,
    )
    .get(session.account.id, actor.groupId) as Authority | undefined;
  if (!authority) fail('forbidden');
  return authority;
}
function collecting(authority: Authority, now: Date): void {
  try {
    if (cyclePhase(authority, now) !== 'collecting') fail('closed_cycle');
  } catch {
    fail('closed_cycle');
  }
}
function owned(
  database: RewindDatabase,
  id: string,
  authority: Authority,
  environment: string,
): IntentRow {
  const row = database
    .prepare(
      'SELECT * FROM upload_intents WHERE id = ? AND environment = ? AND group_id = ? AND account_id = ? AND profile_id = ?',
    )
    .get(id, environment, authority.groupId, authority.accountId, authority.profileId) as
    IntentRow | undefined;
  if (!row) fail('not_found');
  return row;
}
function status(row: IntentRow, now: Date): UploadIntentStatus {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    profileId: row.profile_id,
    state:
      row.state !== 'completed' && Date.parse(row.expires_at) <= now.getTime()
        ? 'expired'
        : row.state,
    expiresAt: row.expires_at,
    versionId: row.pinned_ref ? decodeMediaRef(row.pinned_ref).versionId : null,
    contributionId: row.contribution_id,
    jobId: row.job_id,
  };
}
function normalize(input: UploadIntentRequest): NormalizedRequest {
  if (
    !input ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey) ||
    !['video', 'photo'].includes(input.mediaType) ||
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 1 ||
    input.byteLength > MAX_CLIP_BYTES ||
    !/^[a-f0-9]{64}$/.test(input.sha256)
  )
    fail('invalid_request');
  const photo = input.mediaType === 'photo';
  if (
    photo
      ? !['image/jpeg', 'image/png'].includes(input.contentType)
      : input.contentType !== 'video/mp4'
  )
    fail('invalid_request');
  const duration = photo ? 3 : input.durationSeconds;
  const start = photo ? 0 : (input.trimStartSeconds ?? 0);
  const end = photo ? 3 : (input.trimEndSeconds ?? start + duration);
  if (
    !Number.isFinite(duration) ||
    duration < 0.5 ||
    duration > 15 ||
    !Number.isFinite(start) ||
    start < 0 ||
    !Number.isFinite(end) ||
    end > 15 ||
    Math.abs(end - start - duration) > 0.000001
  )
    fail('invalid_request');
  const mode = input.mode ?? 'soft-focus';
  if (
    !['soft-focus', 'high-contrast'].includes(mode) ||
    (input.replacesContributionId !== undefined &&
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.replacesContributionId))
  )
    fail('invalid_request');
  return {
    idempotencyKey: input.idempotencyKey,
    mediaType: input.mediaType,
    contentType: input.contentType,
    byteLength: input.byteLength,
    sha256: input.sha256,
    durationSeconds: duration,
    trimStartSeconds: start,
    trimEndSeconds: end,
    mode,
    ...(input.replacesContributionId
      ? { replacesContributionId: input.replacesContributionId }
      : {}),
  };
}
function quotaCycle(authority: Authority) {
  return {
    id: authority.cycleId,
    startsAt: authority.startsAt,
    endsAt: authority.endsAt,
    maxCount: authority.maxCount,
    maxSeconds: authority.maxSeconds,
  };
}
function checkQuota(
  database: RewindDatabase,
  authority: Authority,
  seconds: number,
  now: Date,
  excludeId = '',
): void {
  const window = ensureContributionQuotaWindow(
    database,
    quotaCycle(authority),
    authority.profileId,
    now,
  );
  const held = database
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(reserved_seconds), 0) AS seconds FROM upload_intents
    WHERE cycle_id = ? AND profile_id = ? AND quota_window_start_at = ?
      AND state IN ('open', 'pinned') AND expires_at > ? AND id <> ?`,
    )
    .get(authority.cycleId, authority.profileId, window.startsAt, now.toISOString(), excludeId) as {
    count: number;
    seconds: number;
  };
  if (
    window.countUsed + held.count >= window.maxCount ||
    window.secondsUsed + held.seconds + seconds > window.maxSeconds
  )
    fail('quota_exceeded');
}
function currentIntent(row: IntentRow, authority: Authority, now: Date): void {
  if (row.state === 'expired' || Date.parse(row.expires_at) <= now.getTime()) fail('expired');
  collecting(authority, now);
  if (
    authority.cycleId !== row.cycle_id ||
    contributionQuotaWindow(authority, now).startsAt !== row.quota_window_start_at
  )
    fail('closed_cycle');
}
function scope(row: IntentRow): MediaScope {
  return { environment: row.environment, groupId: row.group_id };
}
function target(row: IntentRow, deps: UploadIntentDependencies): UploadTarget {
  const value = JSON.parse(row.target_json) as UploadTarget;
  validateRef(
    scope(row),
    { ...value, versionId: 'pending' },
    deps.transport.backend,
    deps.transport.storeId,
    clock(deps),
    true,
  );
  if (
    value.prefix !== 'incoming' ||
    value.key !== `${row.environment}/${row.group_id}/incoming/${row.id}` ||
    value.expiresAt !== row.expires_at
  )
    fail('source_unavailable');
  return value;
}

/** HTTP must enforce secure origin/transport; this module revalidates session,
 * real membership, selection, cycle and quota inside each writer transaction. */
export async function requestUploadIntent(
  database: RewindDatabase,
  actor: UploadIntentActor,
  input: UploadIntentRequest,
  deps: UploadIntentDependencies,
): Promise<UploadIntentResult<{ intent: UploadIntentStatus; upload: UploadCapability | null }>> {
  try {
    const request = normalize(input);
    const now = clock(deps);
    const row = transaction(database, () => {
      const authority = authorize(database, actor, now);
      const key = digest(request.idempotencyKey);
      const requestHash = digest(JSON.stringify(request));
      const existing = database
        .prepare(
          'SELECT * FROM upload_intents WHERE environment = ? AND group_id = ? AND profile_id = ? AND idempotency_hash = ?',
        )
        .get(deps.environment, authority.groupId, authority.profileId, key) as
        IntentRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) fail('idempotency_conflict');
        if (existing.state !== 'completed' && status(existing, now).state !== 'expired')
          currentIntent(existing, authority, now);
        return existing;
      }
      collecting(authority, now);
      checkQuota(database, authority, request.durationSeconds, now);
      const boundary = contributionQuotaWindow(authority, now);
      const id = randomUUID();
      const expiresAt = new Date(
        Math.min(
          now.getTime() + UPLOAD_INTENT_TTL_MS,
          Date.parse(authority.endsAt),
          Date.parse(boundary.endsAt),
        ),
      ).toISOString();
      const { versionId: _version, ...allocated } = putRef(
        { environment: deps.environment, groupId: authority.groupId },
        {
          prefix: 'incoming',
          name: id,
          body: (async function* () {})(),
          sha256: request.sha256,
          byteLength: request.byteLength,
          contentType: request.contentType,
          expiresAt,
        },
        deps.transport.backend,
        deps.transport.storeId,
        'pending',
        now,
      );
      void _version;
      database
        .prepare(
          `INSERT INTO upload_intents
        (id,environment,group_id,account_id,profile_id,cycle_id,quota_window_start_at,idempotency_hash,request_hash,request_json,target_json,reserved_seconds,state,created_at,expires_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?)`,
        )
        .run(
          id,
          deps.environment,
          authority.groupId,
          authority.accountId,
          authority.profileId,
          authority.cycleId,
          boundary.startsAt,
          key,
          requestHash,
          JSON.stringify({ ...request, idempotencyKey: undefined }),
          JSON.stringify(allocated),
          request.durationSeconds,
          now.toISOString(),
          expiresAt,
          now.toISOString(),
        );
      return owned(database, id, authority, deps.environment);
    });
    if (['pinned', 'completed', 'expired'].includes(status(row, now).state))
      return { ok: true, value: { intent: status(row, now), upload: null } };
    const upload = await deps.transport.signPut(scope(row), target(row, deps));
    const latest = transaction(database, () => {
      const at = clock(deps);
      const authority = authorize(database, actor, at);
      const fresh = owned(database, row.id, authority, deps.environment);
      if (fresh.state !== 'completed') currentIntent(fresh, authority, at);
      return fresh;
    });
    if (
      upload.method !== 'PUT' ||
      typeof upload.url !== 'string' ||
      !Number.isFinite(Date.parse(upload.expiresAt)) ||
      Date.parse(upload.expiresAt) > Date.parse(row.expires_at) ||
      Date.parse(upload.expiresAt) <= clock(deps).getTime()
    )
      fail('storage_failed');
    return {
      ok: true,
      value: {
        intent: status(latest, clock(deps)),
        upload: latest.state === 'open' ? upload : null,
      },
    };
  } catch (error) {
    return errorResult(error);
  }
}

export function getUploadIntentStatus(
  database: RewindDatabase,
  actor: UploadIntentActor,
  intentId: string,
  deps: UploadIntentDependencies,
): UploadIntentResult<UploadIntentStatus> {
  try {
    const now = clock(deps);
    const authority = authorize(database, actor, now);
    return { ok: true, value: status(owned(database, intentId, authority, deps.environment), now) };
  } catch (error) {
    return errorResult(error);
  }
}

export async function completeUploadIntent(
  database: RewindDatabase,
  actor: UploadIntentActor,
  input: { intentId: string; versionId: string },
  deps: UploadIntentDependencies,
): Promise<UploadIntentResult<UploadIntentStatus>> {
  let snapshot: { dispose: () => Promise<void> } | undefined;
  try {
    if (
      !input ||
      typeof input.versionId !== 'string' ||
      !input.versionId ||
      input.versionId === 'null' ||
      input.versionId === 'pending' ||
      input.versionId.length > 1024
    )
      fail('invalid_request');
    const pinned = transaction(database, () => {
      const now = clock(deps);
      const authority = authorize(database, actor, now);
      const row = owned(database, input.intentId, authority, deps.environment);
      if (row.pinned_ref && decodeMediaRef(row.pinned_ref).versionId !== input.versionId)
        fail('version_conflict');
      if (row.state === 'completed') return row;
      currentIntent(row, authority, now);
      if (row.state === 'open') {
        const encoded = encodeMediaRef({ ...target(row, deps), versionId: input.versionId });
        const changed = database
          .prepare(
            "UPDATE upload_intents SET pinned_ref = ?, state = 'pinned', updated_at = ? WHERE id = ? AND state = 'open' AND pinned_ref IS NULL",
          )
          .run(encoded, now.toISOString(), row.id);
        if (Number(changed.changes) !== 1) fail('version_conflict');
      }
      return owned(database, row.id, authority, deps.environment);
    });
    if (pinned.state === 'completed') return { ok: true, value: status(pinned, clock(deps)) };
    const ref = decodeMediaRef(pinned.pinned_ref!);
    const request = JSON.parse(pinned.request_json) as NormalizedRequest;
    const materialized = await materializeStoredMedia(
      deps.store,
      scope(pinned),
      ref,
      deps.scratchDir,
    );
    snapshot = materialized;
    let observed: Omit<ServerClipMetadata, 'sourceUri'>;
    try {
      observed = deps.probe
        ? await deps.probe(materialized.path, request.mediaType)
        : request.mediaType === 'photo'
          ? {
              ...(await probePhotoWithFfmpeg(deps.ffmpegBin, materialized.path)),
              mediaType: 'photo',
            }
          : {
              ...(await probeClipWithFfmpeg(deps.ffmpegBin, materialized.path)),
              mediaType: 'video',
            };
    } catch {
      fail('invalid_media');
    }
    if (
      observed.byteLength !== ref.byteLength ||
      observed.mimeType !== ref.contentType ||
      (observed.mediaType ?? 'video') !== request.mediaType
    )
      fail('invalid_media');
    const sourceUri = `staged://${digest(pinned.id).slice(0, 24)}`;
    const metadata: ServerClipMetadata = { ...observed, sourceUri };
    if (
      validateClipUpload(
        {
          ...request,
          idempotencyKey: `intent-${pinned.id}`,
          mimeType: observed.mimeType,
          sourceUri,
          durationSeconds: observed.durationSeconds,
          width: observed.width,
          height: observed.height,
          hasAudio: observed.hasAudio,
        },
        observed.durationSeconds,
      )
    )
      fail('invalid_media');
    const seconds =
      request.mediaType === 'photo' ? 3 : request.trimEndSeconds - request.trimStartSeconds;
    const result = transaction(database, () => {
      const now = clock(deps);
      const authority = authorize(database, actor, now);
      const row = owned(database, pinned.id, authority, deps.environment);
      if (row.pinned_ref !== pinned.pinned_ref) fail('version_conflict');
      if (row.state === 'completed') return status(row, now);
      currentIntent(row, authority, now);
      if (row.state !== 'pinned') fail('version_conflict');
      checkQuota(database, authority, seconds, now, row.id);
      const reservation = reserveContributionAllowance(
        database,
        quotaCycle(authority),
        authority.profileId,
        seconds,
        now,
      );
      if ('reason' in reservation) fail('quota_exceeded');
      const contributionId = `contribution-${row.id}`;
      const jobId = `clip-job-${row.id}`;
      const key = digest(`upload-intent\0${row.id}`).slice(0, 32);
      recordClipMediaMetadata(database, metadata, now);
      database
        .prepare(
          `INSERT INTO staged_sources (source_id,source_uri,idempotency_key_hash,group_id,member_id,source_path,byte_length,status,created_at,claim_generation) VALUES (?,?,?,?,?,?,?,'staged',?,1)`,
        )
        .run(
          digest(row.id).slice(0, 24),
          sourceUri,
          key,
          row.group_id,
          row.profile_id,
          row.pinned_ref,
          ref.byteLength,
          now.toISOString(),
        );
      database
        .prepare(
          'INSERT INTO contributions (id,cycle_id,member_id,media_job_id,duration_seconds,created_at,quota_window_start_at) VALUES (?,?,?,NULL,?,?,?)',
        )
        .run(
          contributionId,
          row.cycle_id,
          row.profile_id,
          seconds,
          now.toISOString(),
          reservation.startsAt,
        );
      database
        .prepare(
          `INSERT INTO media_jobs (id,group_id,contribution_id,kind,status,created_at,idempotency_key,source_uri,source_generation,source_path,trim_start_seconds,trim_end_seconds,mode,updated_at,media_type) VALUES (?,?,?,'clip','pending',?,?,?,1,?,?,?,?,?,?)`,
        )
        .run(
          jobId,
          row.group_id,
          contributionId,
          now.toISOString(),
          key,
          sourceUri,
          row.pinned_ref,
          request.trimStartSeconds,
          request.trimEndSeconds,
          request.mode,
          now.toISOString(),
          request.mediaType,
        );
      database
        .prepare('UPDATE contributions SET media_job_id = ? WHERE id = ?')
        .run(jobId, contributionId);
      if (
        request.replacesContributionId &&
        !linkContributionReplacement(
          database,
          row.group_id,
          row.profile_id,
          request.replacesContributionId,
          contributionId,
        ).ok
      )
        fail('replacement_conflict');
      database
        .prepare(
          'UPDATE cycles SET count_used = count_used + 1, seconds_used = seconds_used + ? WHERE id = ?',
        )
        .run(seconds, row.cycle_id);
      const committed = database
        .prepare(
          "UPDATE upload_intents SET state = 'completed', contribution_id = ?, job_id = ?, updated_at = ? WHERE id = ? AND state = 'pinned' AND pinned_ref = ?",
        )
        .run(contributionId, jobId, now.toISOString(), row.id, row.pinned_ref);
      if (Number(committed.changes) !== 1) fail('version_conflict');
      return status(owned(database, row.id, authority, deps.environment), now);
    });
    await snapshot.dispose();
    snapshot = undefined;
    return { ok: true, value: result };
  } catch (error) {
    return errorResult(error);
  } finally {
    await snapshot?.dispose().catch(() => undefined);
  }
}

/** Inventory and deletes stay outside SQLite transactions; expiration is fenced
 * first, so a late completion cannot register bytes after cleanup begins. */
export async function cleanupUploadIntents(
  database: RewindDatabase,
  deps: UploadIntentDependencies,
  options: { limit?: number; versionLimit?: number } = {},
): Promise<{ expired: number; deleted: number; protected: number; failed: number }> {
  const limit = options.limit ?? 10;
  const versionLimit = options.versionLimit ?? 100;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(versionLimit) ||
    versionLimit < 1 ||
    versionLimit > 100
  )
    throw new RangeError('Invalid cleanup bounds.');
  const now = clock(deps);
  const report = { expired: 0, deleted: 0, protected: 0, failed: 0 };
  const rows = transaction(database, () => {
    const candidates = database
      .prepare(
        'SELECT * FROM upload_intents WHERE environment = ? AND cleanup_complete = 0 AND expires_at <= ? ORDER BY expires_at, id LIMIT ?',
      )
      .all(deps.environment, now.toISOString(), limit) as unknown as IntentRow[];
    for (const row of candidates)
      if (row.state !== 'completed' && row.state !== 'expired') {
        database
          .prepare(
            "UPDATE upload_intents SET state = 'expired', updated_at = ? WHERE id = ? AND state IN ('open','pinned')",
          )
          .run(now.toISOString(), row.id);
        report.expired++;
      }
    return candidates;
  });
  let remaining = versionLimit;
  for (const row of rows) {
    if (remaining === 0) break;
    try {
      const expected = target(row, deps);
      const page = await deps.transport.listVersions(
        scope(row),
        expected,
        row.cleanup_cursor,
        remaining,
      );
      if (
        page.refs.length > remaining ||
        (page.nextCursor !== null &&
          (typeof page.nextCursor !== 'string' ||
            page.nextCursor === row.cleanup_cursor ||
            page.nextCursor.length > 2048))
      )
        fail('storage_failed');
      remaining -= page.refs.length;
      let failed = false;
      for (const ref of page.refs) {
        try {
          validateRef(scope(row), ref, expected.backend, expected.storeId, now, true);
          if (ref.prefix !== 'incoming' || ref.key !== expected.key) fail('source_unavailable');
          const encoded = encodeMediaRef(ref);
          const accepted = row.pinned_ref ? decodeMediaRef(row.pinned_ref) : null;
          const pinnedValue =
            accepted &&
            accepted.backend === ref.backend &&
            accepted.storeId === ref.storeId &&
            accepted.key === ref.key &&
            accepted.versionId === ref.versionId
              ? row.pinned_ref
              : encoded;
          // A completed original remains protected until the pinned worker
          // finishes. Noncurrent versions of the same incoming key are removed.
          if (
            database
              .prepare(
                'SELECT 1 FROM media_jobs WHERE source_path = ? OR output_path = ? UNION ALL SELECT 1 FROM staged_sources WHERE source_path = ? LIMIT 1',
              )
              .get(pinnedValue, pinnedValue, pinnedValue)
          ) {
            report.protected++;
            continue;
          }
          await deps.store.delete(scope(row), ref);
          report.deleted++;
        } catch {
          report.failed++;
          failed = true;
        }
      }
      if (!failed)
        database
          .prepare(
            'UPDATE upload_intents SET cleanup_cursor = ?, cleanup_complete = ? WHERE id = ? AND environment = ? AND expires_at <= ?',
          )
          .run(
            page.nextCursor,
            page.nextCursor === null ? 1 : 0,
            row.id,
            deps.environment,
            now.toISOString(),
          );
    } catch {
      report.failed++;
    }
  }
  return report;
}
