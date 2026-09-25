/** The current-cycle ledger contains metadata only. Media locations and
 * playback capabilities are deliberately absent from this contract. */
export const CONTRIBUTION_LEDGER_STATES = [
  'queued',
  'processing',
  'sealed',
  'failed',
  'deleted',
  'replaced',
] as const;

export type ContributionLedgerState = (typeof CONTRIBUTION_LEDGER_STATES)[number];
export type ContributionFailureCategory =
  'invalid_metadata' | 'source_unavailable' | 'processing_failed' | 'unknown';

export interface ContributionLedgerEntry {
  contributionId: string;
  jobId: string | null;
  state: ContributionLedgerState;
  durationSeconds: number;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  progress: number;
  failureCategory: ContributionFailureCategory | null;
  retryable: boolean;
  replaced: boolean;
  restored: { count: 1; seconds: number } | null;
}

export interface ContributionLedgerAllowance {
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
  allowance: ContributionLedgerAllowance;
  entries: ContributionLedgerEntry[];
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseEntry(value: unknown): ContributionLedgerEntry | null {
  const entry = record(value);
  if (!entry) return null;
  const state = entry.state;
  const category = entry.failureCategory;
  const restored = entry.restored === null ? null : record(entry.restored);
  if (
    !safeId(entry.contributionId) ||
    (entry.jobId !== null && !safeId(entry.jobId)) ||
    !CONTRIBUTION_LEDGER_STATES.includes(state as ContributionLedgerState) ||
    !nonNegativeNumber(entry.durationSeconds) ||
    entry.durationSeconds === 0 ||
    !validInstant(entry.createdAt) ||
    !validInstant(entry.updatedAt) ||
    !nonNegativeNumber(entry.attempts) ||
    !nonNegativeNumber(entry.progress) ||
    entry.progress > 100 ||
    (category !== null &&
      category !== 'invalid_metadata' &&
      category !== 'source_unavailable' &&
      category !== 'processing_failed' &&
      category !== 'unknown') ||
    typeof entry.retryable !== 'boolean' ||
    typeof entry.replaced !== 'boolean' ||
    (restored !== null && (restored?.count !== 1 || !nonNegativeNumber(restored.seconds)))
  )
    return null;
  if (
    (state === 'replaced') !== entry.replaced ||
    (state === 'deleted' || state === 'replaced') !== (restored !== null)
  )
    return null;
  return {
    contributionId: entry.contributionId,
    jobId: entry.jobId,
    state: state as ContributionLedgerState,
    durationSeconds: entry.durationSeconds,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    attempts: entry.attempts,
    progress: entry.progress,
    failureCategory: category as ContributionFailureCategory | null,
    retryable: entry.retryable,
    replaced: entry.replaced,
    restored: restored === null ? null : { count: 1, seconds: restored.seconds as number },
  };
}

/** Validate and copy the server response so unexpected fields never reach UI. */
export function parseContributionLedgerPage(value: unknown): ContributionLedgerPage | null {
  const page = record(value);
  const allowance = record(page?.allowance);
  const pagination = record(page?.pagination);
  if (
    !page ||
    !allowance ||
    !pagination ||
    (page.cycleId !== '' && !safeId(page.cycleId)) ||
    !safeId(page.memberId) ||
    !Array.isArray(page.entries) ||
    !nonNegativeNumber(allowance.maxCount) ||
    !nonNegativeNumber(allowance.maxSeconds) ||
    !nonNegativeNumber(allowance.countUsed) ||
    !nonNegativeNumber(allowance.secondsUsed) ||
    !nonNegativeNumber(allowance.deletionsUsed) ||
    (allowance.deletionAvailability !== 'available' &&
      allowance.deletionAvailability !== 'used' &&
      allowance.deletionAvailability !== 'unavailable') ||
    !Number.isSafeInteger(pagination.limit) ||
    (pagination.limit as number) < 1 ||
    (pagination.limit as number) > 100 ||
    typeof pagination.hasMore !== 'boolean' ||
    (pagination.nextCursor !== null &&
      (typeof pagination.nextCursor !== 'string' ||
        !/^[A-Za-z0-9_-]{1,512}$/.test(pagination.nextCursor))) ||
    (pagination.hasMore && pagination.nextCursor === null) ||
    (!pagination.hasMore && pagination.nextCursor !== null) ||
    page.entries.length > (pagination.limit as number)
  )
    return null;
  const entries = page.entries.map(parseEntry);
  if (entries.some((entry) => entry === null)) return null;
  if (new Set(entries.map((entry) => entry?.contributionId)).size !== entries.length) return null;
  return {
    cycleId: page.cycleId,
    memberId: page.memberId,
    allowance: {
      maxCount: allowance.maxCount,
      maxSeconds: allowance.maxSeconds,
      countUsed: allowance.countUsed,
      secondsUsed: allowance.secondsUsed,
      deletionsUsed: allowance.deletionsUsed,
      deletionAvailability: allowance.deletionAvailability,
    },
    entries: entries as ContributionLedgerEntry[],
    pagination: {
      limit: pagination.limit as number,
      hasMore: pagination.hasMore,
      nextCursor: pagination.nextCursor,
    },
  };
}
