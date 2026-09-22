import type { RewindDatabase } from '../db';

export const QUEUE_DEFAULT_PAGE_SIZE = 50;
export const QUEUE_MAX_PAGE_SIZE = 100;
export const QUEUE_MAX_FILM_ATTEMPTS = 3;

export const QUEUE_KINDS = ['clip', 'film'] as const;
export const QUEUE_STATUSES = ['pending', 'processing', 'failed'] as const;

export type QueueJobKind = (typeof QUEUE_KINDS)[number];
export type QueueJobStatus = (typeof QUEUE_STATUSES)[number];
export type QueueFailureCategory =
  'invalid_metadata' | 'source_unavailable' | 'processing_failed' | 'unknown';

export interface QueueJobObservation {
  id: string;
  kind: QueueJobKind;
  status: QueueJobStatus;
  attempts: number;
  failureCategory: QueueFailureCategory | null;
  progress: number;
  createdAt: string;
  updatedAt: string;
  processingStartedAt: string | null;
  failedAt: string | null;
  retryable: boolean;
}

export interface QueueJobsPage {
  jobs: QueueJobObservation[];
  pagination: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}

export interface ListQueueJobsOptions {
  groupId: string;
  kind?: QueueJobKind;
  status?: QueueJobStatus;
  limit?: number;
  cursor?: string | null;
}

export class QueueQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueQueryError';
  }
}

interface QueueJobRow {
  id?: unknown;
  kind?: unknown;
  status?: unknown;
  attempts?: unknown;
  errorCode?: unknown;
  progress?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  processingStartedAt?: unknown;
  failedAt?: unknown;
}

interface QueueCursor {
  version: 1;
  groupId: string;
  kind: QueueJobKind | null;
  status: QueueJobStatus | null;
  createdAt: string;
  id: string;
}

function isQueueKind(value: string): value is QueueJobKind {
  return (QUEUE_KINDS as readonly string[]).includes(value);
}

function isQueueStatus(value: string): value is QueueJobStatus {
  return (QUEUE_STATUSES as readonly string[]).includes(value);
}

export function parseQueueKind(value: string | null | undefined): QueueJobKind | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isQueueKind(value)) throw new QueueQueryError('kind must be clip or film.');
  return value;
}

export function parseQueueStatus(value: string | null | undefined): QueueJobStatus | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isQueueStatus(value)) {
    throw new QueueQueryError('status must be pending, processing, or failed.');
  }
  return value;
}

export function parseQueueLimit(value: string | number | null | undefined): number {
  if (value === undefined || value === null || value === '') return QUEUE_DEFAULT_PAGE_SIZE;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > QUEUE_MAX_PAGE_SIZE) {
    throw new QueueQueryError(`limit must be an integer from 1 to ${QUEUE_MAX_PAGE_SIZE}.`);
  }
  return parsed;
}

function encodeCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(
  encoded: string,
  groupId: string,
  kind: QueueJobKind | undefined,
  status: QueueJobStatus | undefined,
): QueueCursor {
  if (encoded.length > 512) throw new QueueQueryError('cursor is invalid.');
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<QueueCursor>;
    if (
      parsed.version !== 1 ||
      parsed.groupId !== groupId ||
      (parsed.kind ?? null) !== (kind ?? null) ||
      (parsed.status ?? null) !== (status ?? null) ||
      typeof parsed.createdAt !== 'string' ||
      !parsed.createdAt ||
      typeof parsed.id !== 'string' ||
      !parsed.id ||
      (parsed.kind !== null && parsed.kind !== undefined && !isQueueKind(parsed.kind)) ||
      (parsed.status !== null && parsed.status !== undefined && !isQueueStatus(parsed.status))
    ) {
      throw new QueueQueryError('cursor is invalid.');
    }
    return {
      version: 1,
      groupId,
      kind: parsed.kind ?? null,
      status: parsed.status ?? null,
      createdAt: parsed.createdAt,
      id: parsed.id,
    };
  } catch (error) {
    if (error instanceof QueueQueryError) throw error;
    throw new QueueQueryError('cursor is invalid.');
  }
}

function safeFailureCategory(
  status: QueueJobStatus,
  errorCode: unknown,
): QueueFailureCategory | null {
  if (status !== 'failed') return null;
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

function mapQueueJob(row: QueueJobRow): QueueJobObservation {
  const rawKind = String(row.kind);
  const rawStatus = String(row.status);
  const kind: QueueJobKind = isQueueKind(rawKind) ? rawKind : 'clip';
  const status: QueueJobStatus = isQueueStatus(rawStatus) ? rawStatus : 'pending';
  const attempts = boundedNumber(row.attempts, 0, Number.MAX_SAFE_INTEGER);
  const progress = boundedNumber(row.progress, 0, 100);
  const createdAt = String(row.createdAt ?? '');
  const processingStartedAt = row.processingStartedAt ? String(row.processingStartedAt) : null;
  const updatedAt = String(row.updatedAt ?? processingStartedAt ?? createdAt);
  const failedAt = row.failedAt ? String(row.failedAt) : status === 'failed' ? updatedAt : null;
  return {
    id: String(row.id ?? ''),
    kind,
    status,
    attempts,
    failureCategory: safeFailureCategory(status, row.errorCode),
    progress,
    createdAt,
    updatedAt,
    processingStartedAt,
    failedAt,
    retryable:
      status === 'pending' ||
      (status === 'failed' && (kind === 'clip' || attempts < QUEUE_MAX_FILM_ATTEMPTS)),
  };
}

/** List only active queue states and return a filesystem/content-free read model. */
export function listQueueJobs(
  database: RewindDatabase,
  input: ListQueueJobsOptions,
): QueueJobsPage {
  if (!input.groupId) throw new QueueQueryError('groupId is required.');
  const kind = input.kind;
  const status = input.status;
  const limit = parseQueueLimit(input.limit);
  const cursor = input.cursor ? decodeCursor(input.cursor, input.groupId, kind, status) : null;

  const clauses = [
    'group_id = ?',
    "kind IN ('clip', 'film')",
    "status IN ('pending', 'processing', 'failed')",
  ];
  const parameters: (string | number)[] = [input.groupId];
  if (kind) {
    clauses.push('kind = ?');
    parameters.push(kind);
  }
  if (status) {
    clauses.push('status = ?');
    parameters.push(status);
  }
  if (cursor) {
    clauses.push('(created_at > ? OR (created_at = ? AND id > ?))');
    parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  const rows = database
    .prepare(
      `SELECT id, kind, status, attempt_count AS attempts,
              error_code AS errorCode, progress,
              created_at AS createdAt,
              COALESCE(updated_at, processing_started_at, created_at) AS updatedAt,
              processing_started_at AS processingStartedAt,
              failed_at AS failedAt
       FROM media_jobs
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(...parameters, limit + 1) as QueueJobRow[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const jobs = pageRows.map(mapQueueJob);
  const last = pageRows.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          version: 1,
          groupId: input.groupId,
          kind: kind ?? null,
          status: status ?? null,
          createdAt: String(last.createdAt ?? ''),
          id: String(last.id ?? ''),
        })
      : null;
  return { jobs, pagination: { limit, hasMore, nextCursor } };
}
