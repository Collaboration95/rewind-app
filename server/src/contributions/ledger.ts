import type { RewindDatabase } from '../db';
import { cyclePhase } from '../cycles/engine';

/**
 * Metadata-only contribution ledger for one member inside the group's current
 * cycle.
 *
 * This module is the read model for issue #158. It deliberately exposes no
 * filesystem path, source URI, output path, share link, thumbnail, player, or
 * download capability: before the cycle reveal a contribution is described by
 * lifecycle metadata only. The projection is a whitelist, so a later schema
 * addition cannot leak through by default.
 *
 * The queue observability contract from #146 (server/src/jobs/queue.ts) is
 * reused as a pattern - opaque group-bound keyset cursor, bounded page size,
 * redacted failure categories, and a total order on (created_at, id) - but the
 * ledger keeps its own vocabulary. The queue read model reports only active
 * work; the ledger is a durable history that also reports durable outcomes
 * (sealed, deleted, replaced).
 */

export const LEDGER_DEFAULT_PAGE_SIZE = 50;
export const LEDGER_MAX_PAGE_SIZE = 100;

/**
 * Client-facing lifecycle vocabulary. 'sealed' is the client word for the
 * server's 'ready' job status; it labels readiness metadata and never implies
 * that the media is addressable.
 */
export const LEDGER_STATES = [
  'queued',
  'processing',
  'sealed',
  'failed',
  'deleted',
  'replaced',
] as const;

export type LedgerState = (typeof LEDGER_STATES)[number];

export type LedgerFailureCategory =
  'invalid_metadata' | 'source_unavailable' | 'processing_failed' | 'unknown';

export interface LedgerEntry {
  contributionId: string;
  jobId: string | null;
  state: LedgerState;
  durationSeconds: number;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  progress: number;
  failureCategory: LedgerFailureCategory | null;
  retryable: boolean;
  /** True only when this tombstone was superseded by an accepted replacement. */
  replaced: boolean;
  /** Exact allowance this entry returns when corrected, otherwise null. */
  restored: { count: 1; seconds: number } | null;
}

export interface LedgerAllowance {
  maxCount: number;
  maxSeconds: number;
  countUsed: number;
  secondsUsed: number;
  deletionsUsed: number;
  deletionAvailability: 'available' | 'used' | 'unavailable';
}

export interface ContributionLedgerPage {
  cycleId: string;
  memberId: string;
  allowance: LedgerAllowance;
  entries: LedgerEntry[];
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null };
}

export interface ListContributionLedgerOptions {
  groupId: string;
  memberId: string;
  state?: LedgerState;
  limit?: number;
  cursor?: string | null;
  /** Injectable clock, matching getCurrentCycle and deleteContribution. */
  now?: Date;
}

export class ContributionLedgerQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContributionLedgerQueryError';
  }
}

/**
 * The durable distinction between 'deleted' and 'replaced' is an explicit
 * replacement link. Setting it is the only thing that converts an accepted
 * deletion into a replacement tombstone.
 */
export const REPLACED_BY_COLUMN = 'replaced_by_contribution_id';
export const LEDGER_INDEX_NAME = 'contributions_ledger_member_idx';

const LEDGER_INDEX_COLUMNS = ['cycle_id', 'member_id', 'created_at', 'id'] as const;

interface LedgerRow {
  contributionId?: unknown;
  jobId?: unknown;
  jobStatus?: unknown;
  durationSeconds?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  attempts?: unknown;
  progress?: unknown;
  errorCode?: unknown;
  deletedAt?: unknown;
  replacedBy?: unknown;
}

interface LedgerCursor {
  version: 1;
  groupId: string;
  memberId: string;
  cycleId: string;
  state: LedgerState | null;
  createdAt: string;
  id: string;
}

function tableColumns(database: RewindDatabase, table: string): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[]).map((row) =>
      String(row.name),
    ),
  );
}

function indexMatches(
  database: RewindDatabase,
  name: string,
  unique: boolean,
  columns: readonly string[],
  table: string,
): boolean {
  const row = database
    .prepare("SELECT sql, tbl_name AS tblName FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name) as { sql?: string | null; tblName?: unknown } | undefined;
  if (!row || row.sql === null || row.sql === undefined) return false;
  if (String(row.tblName ?? '') !== table) return false;
  const declared = (
    database.prepare(`PRAGMA index_info(${name})`).all() as { name?: unknown }[]
  ).map((info) => String(info.name));
  if (declared.length !== columns.length) return false;
  if (!declared.every((column, position) => column === columns[position])) return false;
  const entry = (
    database.prepare(`PRAGMA index_list(${table})`).all() as { name?: unknown; unique?: unknown }[]
  ).find((candidate) => String(candidate.name) === name);
  return Boolean(Number(entry?.unique)) === unique;
}

/** True when the ledger's additive column and scope index are both present. */
export function contributionLedgerSchemaReady(database: RewindDatabase): boolean {
  return (
    tableColumns(database, 'contributions').has(REPLACED_BY_COLUMN) &&
    indexMatches(database, LEDGER_INDEX_NAME, false, LEDGER_INDEX_COLUMNS, 'contributions')
  );
}

/**
 * Apply the ledger schema repair-style so an interrupted upgrade converges on
 * the same shape as a fresh install. Exported for the ordered migration hook in
 * server/src/db.ts; this module never writes during normal request handling.
 */
export function ensureContributionLedgerSchema(database: RewindDatabase): void {
  if (!tableColumns(database, 'contributions').has(REPLACED_BY_COLUMN)) {
    database.exec(
      `ALTER TABLE contributions ADD COLUMN ${REPLACED_BY_COLUMN} TEXT REFERENCES contributions(id) ON DELETE SET NULL`,
    );
  }
  if (!indexMatches(database, LEDGER_INDEX_NAME, false, LEDGER_INDEX_COLUMNS, 'contributions')) {
    database.exec(`DROP INDEX IF EXISTS ${LEDGER_INDEX_NAME}`);
    database.exec(
      `CREATE INDEX ${LEDGER_INDEX_NAME} ON contributions (cycle_id, member_id, created_at, id)`,
    );
  }
}

function isLedgerState(value: string): value is LedgerState {
  return (LEDGER_STATES as readonly string[]).includes(value);
}

export function parseLedgerState(value: string | null | undefined): LedgerState | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isLedgerState(value)) {
    throw new ContributionLedgerQueryError(`state must be one of ${LEDGER_STATES.join(', ')}.`);
  }
  return value;
}

export function parseLedgerLimit(value: string | number | null | undefined): number {
  if (value === undefined || value === null || value === '') return LEDGER_DEFAULT_PAGE_SIZE;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > LEDGER_MAX_PAGE_SIZE) {
    throw new ContributionLedgerQueryError(
      `limit must be an integer from 1 to ${LEDGER_MAX_PAGE_SIZE}.`,
    );
  }
  return parsed;
}

function encodeCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(
  encoded: string,
  groupId: string,
  memberId: string,
  cycleId: string,
  state: LedgerState | undefined,
): LedgerCursor {
  if (encoded.length > 512) throw new ContributionLedgerQueryError('cursor is invalid.');
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<LedgerCursor>;
    if (
      parsed.version !== 1 ||
      parsed.groupId !== groupId ||
      parsed.memberId !== memberId ||
      parsed.cycleId !== cycleId ||
      (parsed.state ?? null) !== (state ?? null) ||
      typeof parsed.createdAt !== 'string' ||
      !parsed.createdAt ||
      typeof parsed.id !== 'string' ||
      !parsed.id ||
      (parsed.state !== null && parsed.state !== undefined && !isLedgerState(parsed.state))
    ) {
      throw new ContributionLedgerQueryError('cursor is invalid.');
    }
    return {
      version: 1,
      groupId,
      memberId,
      cycleId,
      state: parsed.state ?? null,
      createdAt: parsed.createdAt,
      id: parsed.id,
    };
  } catch (error) {
    if (error instanceof ContributionLedgerQueryError) throw error;
    throw new ContributionLedgerQueryError('cursor is invalid.');
  }
}

function safeFailureCategory(state: LedgerState, errorCode: unknown): LedgerFailureCategory | null {
  if (state !== 'failed') return null;
  switch (String(errorCode ?? '')) {
    case 'invalid_metadata':
      return 'invalid_metadata';
    case 'source_unavailable':
      return 'source_unavailable';
    case 'process_failed':
    case 'cleanup_failed':
      return 'processing_failed';
    default:
      return 'unknown';
  }
}

function boundedNumber(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(maximum, Math.floor(parsed))) : fallback;
}

/**
 * Resolve the same cycle a member contributes to. This mirrors getCurrentCycle
 * without importing it, so the read model stays a leaf module that the HTTP
 * layer can wire up without an import cycle.
 */
interface CurrentCycle {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
}

function currentCycle(database: RewindDatabase, groupId: string): CurrentCycle | null {
  const row = database
    .prepare(
      `SELECT id, starts_at AS startsAt, ends_at AS endsAt, status FROM cycles
       WHERE group_id = ? AND (
             id = (SELECT current_cycle_id FROM groups WHERE id = ?)
          OR NOT EXISTS (
            SELECT 1 FROM cycles selected
            WHERE selected.id = (SELECT current_cycle_id FROM groups WHERE id = ?)
              AND selected.group_id = ?))
       ORDER BY CASE WHEN id = (SELECT current_cycle_id FROM groups WHERE id = ?) THEN 0 ELSE 1 END,
                starts_at DESC
       LIMIT 1`,
    )
    .get(groupId, groupId, groupId, groupId, groupId) as
    { id?: unknown; startsAt?: unknown; endsAt?: unknown; status?: unknown } | undefined;
  if (!row?.id) return null;
  return {
    id: String(row.id),
    startsAt: String(row.startsAt ?? ''),
    endsAt: String(row.endsAt ?? ''),
    status: String(row.status ?? ''),
  };
}

function stateCondition(state: LedgerState): string {
  const active = `c.deleted_at IS NULL AND c.${REPLACED_BY_COLUMN} IS NULL`;
  switch (state) {
    case 'replaced':
      return `c.${REPLACED_BY_COLUMN} IS NOT NULL`;
    case 'deleted':
      return `c.deleted_at IS NOT NULL AND c.${REPLACED_BY_COLUMN} IS NULL`;
    case 'sealed':
      return `${active} AND j.status = 'ready'`;
    case 'processing':
      return `${active} AND j.status = 'processing'`;
    case 'failed':
      return `${active} AND (j.status = 'failed' OR j.status IS NULL)`;
    case 'queued':
      return `${active} AND j.status = 'pending'`;
  }
}

function mapEntry(row: LedgerRow): LedgerEntry {
  const rawStatus = String(row.jobStatus ?? '');
  const deletedAt = row.deletedAt ? String(row.deletedAt) : null;
  const replaced = row.replacedBy !== null && row.replacedBy !== undefined;
  const state: LedgerState = replaced
    ? 'replaced'
    : deletedAt
      ? 'deleted'
      : rawStatus === 'ready'
        ? 'sealed'
        : rawStatus === 'processing'
          ? 'processing'
          : rawStatus === 'failed'
            ? 'failed'
            : rawStatus === 'pending'
              ? 'queued'
              : 'failed';
  const durationSeconds = boundedNumber(row.durationSeconds, 0, Number.MAX_SAFE_INTEGER);
  const createdAt = String(row.createdAt ?? '');
  return {
    contributionId: String(row.contributionId ?? ''),
    jobId: row.jobId === null || row.jobId === undefined ? null : String(row.jobId),
    state,
    durationSeconds,
    createdAt,
    updatedAt: String(row.updatedAt ?? deletedAt ?? createdAt),
    attempts: boundedNumber(row.attempts, 0, Number.MAX_SAFE_INTEGER),
    progress: boundedNumber(row.progress, 0, 100),
    failureCategory: safeFailureCategory(state, row.errorCode),
    retryable: state === 'queued' || state === 'failed',
    replaced,
    restored:
      state === 'deleted' || state === 'replaced'
        ? { count: 1 as const, seconds: durationSeconds }
        : null,
  };
}

function readAllowance(
  database: RewindDatabase,
  cycleId: string,
  memberId: string,
  correctable: boolean,
): LedgerAllowance {
  const row = database
    .prepare(
      `SELECT max_count AS maxCount, max_seconds AS maxSeconds,
              count_used AS countUsed, seconds_used AS secondsUsed,
              deletions_used AS deletionsUsed
       FROM contribution_quota_windows
       WHERE cycle_id = ? AND member_id = ?
       ORDER BY window_start_at DESC LIMIT 1`,
    )
    .get(cycleId, memberId) as Record<string, unknown> | undefined;
  if (!row) {
    // No reservation exists yet, so no correction has been consumed either.
    return {
      maxCount: 0,
      maxSeconds: 0,
      countUsed: 0,
      secondsUsed: 0,
      deletionsUsed: 0,
      deletionAvailability: 'available',
    };
  }
  const deletionsUsed = Math.max(0, Math.floor(Number(row.deletionsUsed)) || 0);
  const availability: LedgerAllowance['deletionAvailability'] = !correctable
    ? 'unavailable'
    : deletionsUsed >= 1
      ? 'used'
      : 'available';
  return {
    maxCount: Math.max(0, Math.floor(Number(row.maxCount)) || 0),
    maxSeconds: Math.max(0, Math.floor(Number(row.maxSeconds)) || 0),
    countUsed: Math.max(0, Math.floor(Number(row.countUsed)) || 0),
    secondsUsed: Math.max(0, Math.floor(Number(row.secondsUsed)) || 0),
    deletionsUsed,
    deletionAvailability: availability,
  };
}

function emptyAllowance(): LedgerAllowance {
  return {
    maxCount: 0,
    maxSeconds: 0,
    countUsed: 0,
    secondsUsed: 0,
    deletionsUsed: 0,
    deletionAvailability: 'unavailable',
  };
}

/**
 * List one member's contributions in the group's current cycle.
 *
 * Scope is self-only on purpose: a group-wide ledger would disclose other
 * members' contribution count, duration, and timing before the reveal. The
 * caller must already have authorised the session as a member of groupId.
 */
export function listContributionLedger(
  database: RewindDatabase,
  options: ListContributionLedgerOptions,
): ContributionLedgerPage {
  const { groupId, memberId } = options;
  if (!groupId) throw new ContributionLedgerQueryError('groupId is required.');
  if (!memberId) throw new ContributionLedgerQueryError('memberId is required.');
  const state = options.state;
  const limit = parseLedgerLimit(options.limit);
  const cycle = currentCycle(database, groupId);
  if (!cycle) {
    return {
      cycleId: '',
      memberId,
      allowance: emptyAllowance(),
      entries: [],
      pagination: { limit, hasMore: false, nextCursor: null },
    };
  }
  const cycleId = cycle.id;
  // A correction is only meaningful while the cycle is still collecting, which
  // is exactly the condition `deleteContribution` re-checks before mutating.
  let correctable = false;
  try {
    correctable =
      cyclePhase(
        {
          startsAt: cycle.startsAt,
          endsAt: cycle.endsAt,
          status: cycle.status as 'collecting' | 'revealing' | 'archived',
        },
        options.now ?? new Date(),
      ) === 'collecting';
  } catch {
    correctable = false;
  }
  const cursor = options.cursor
    ? decodeCursor(options.cursor, groupId, memberId, cycleId, state)
    : null;

  const clauses = ['c.cycle_id = ?', 'c.member_id = ?', 'cy.group_id = ?'];
  const parameters: (string | number)[] = [cycleId, memberId, groupId];
  if (state) clauses.push(`(${stateCondition(state)})`);
  if (cursor) {
    clauses.push('(c.created_at > ? OR (c.created_at = ? AND c.id > ?))');
    parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  const rows = database
    .prepare(
      `SELECT c.id AS contributionId, j.id AS jobId, j.status AS jobStatus,
              c.duration_seconds AS durationSeconds, c.created_at AS createdAt,
              COALESCE(j.updated_at, j.processing_started_at, c.created_at) AS updatedAt,
              j.attempt_count AS attempts, j.progress AS progress, j.error_code AS errorCode,
              c.deleted_at AS deletedAt, c.${REPLACED_BY_COLUMN} AS replacedBy
       FROM contributions c
       JOIN cycles cy ON cy.id = c.cycle_id
       LEFT JOIN media_jobs j ON j.contribution_id = c.id AND j.kind = 'clip'
       WHERE ${clauses.join(' AND ')}
       ORDER BY c.created_at ASC, c.id ASC
       LIMIT ?`,
    )
    .all(...parameters, limit + 1) as LedgerRow[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    cycleId,
    memberId,
    allowance: readAllowance(database, cycleId, memberId, correctable),
    entries: pageRows.map(mapEntry),
    pagination: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              version: 1,
              groupId,
              memberId,
              cycleId,
              state: state ?? null,
              createdAt: String(last.createdAt ?? ''),
              id: String(last.contributionId ?? ''),
            })
          : null,
    },
  };
}

export type LinkReplacementFailure =
  'not_found' | 'already_replaced' | 'not_deleted' | 'target_mismatch';

export type LinkReplacementResult =
  | { ok: true; replacedContributionId: string; replacementContributionId: string }
  | { ok: false; reason: LinkReplacementFailure };

/**
 * Record that an accepted replacement supersedes one deleted contribution.
 *
 * Only this explicit link converts a 'deleted' tombstone into 'replaced', and
 * only the named target changes. The guard keeps the correction inside one
 * member, one cycle, and the same seven-day allowance window, and refuses to
 * relabel a row twice so a later submission cannot rewrite history.
 */
export function linkContributionReplacement(
  database: RewindDatabase,
  groupId: string,
  memberId: string,
  replacedContributionId: string,
  replacementContributionId: string,
): LinkReplacementResult {
  if (!replacedContributionId || !replacementContributionId) {
    return { ok: false, reason: 'not_found' };
  }
  if (replacedContributionId === replacementContributionId) {
    return { ok: false, reason: 'target_mismatch' };
  }
  const update = database
    .prepare(
      `UPDATE contributions
       SET ${REPLACED_BY_COLUMN} = ?
       WHERE id = ? AND member_id = ? AND deleted_at IS NOT NULL
         AND ${REPLACED_BY_COLUMN} IS NULL
         AND cycle_id = (SELECT cycle_id FROM contributions WHERE id = ? AND member_id = ?)
         AND quota_window_start_at = (
               SELECT quota_window_start_at FROM contributions WHERE id = ? AND member_id = ?)
         AND EXISTS (
               SELECT 1 FROM contributions replacement
               JOIN cycles cy ON cy.id = replacement.cycle_id
               WHERE replacement.id = ? AND replacement.member_id = ? AND cy.group_id = ?)`,
    )
    .run(
      replacementContributionId,
      replacedContributionId,
      memberId,
      replacementContributionId,
      memberId,
      replacementContributionId,
      memberId,
      replacementContributionId,
      memberId,
      groupId,
    );
  if (Number(update.changes) === 1) {
    return { ok: true, replacedContributionId, replacementContributionId };
  }
  const own = database
    .prepare(
      `SELECT c.deleted_at AS deletedAt, c.${REPLACED_BY_COLUMN} AS replacedBy
       FROM contributions c JOIN cycles cy ON cy.id = c.cycle_id
       WHERE c.id = ? AND c.member_id = ? AND cy.group_id = ?`,
    )
    .get(replacedContributionId, memberId, groupId) as
    { deletedAt?: unknown; replacedBy?: unknown } | undefined;
  if (!own) return { ok: false, reason: 'not_found' };
  if (own.replacedBy !== null && own.replacedBy !== undefined) {
    return { ok: false, reason: 'already_replaced' };
  }
  if (!own.deletedAt) return { ok: false, reason: 'not_deleted' };
  return { ok: false, reason: 'target_mismatch' };
}
