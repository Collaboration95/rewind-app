import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RewindDatabase } from '../db';
import { QUEUE_MAX_FILM_ATTEMPTS } from '../jobs/queue';

// Fixed words that appear in server routes. Any other segment (identifiers,
// usernames, emails, capabilities, unknown paths) is logged as ':id', so a
// timing line can never carry identity or content.
const ROUTE_WORDS = new Set([
  'accept',
  'access',
  'advance',
  'allowance',
  'api',
  'archive',
  'auth',
  'clips',
  'complete',
  'config',
  'contributions',
  'current',
  'cycles',
  'delete',
  'destinations',
  'download',
  'films',
  'groups',
  'health',
  'history',
  'intents',
  'invites',
  'jobs',
  'ledger',
  'login',
  'logout',
  'media',
  'members',
  'messages',
  'premiere',
  'process',
  'profiles',
  'prompt',
  'reactions',
  'real',
  'realtime',
  'reconcile',
  'register',
  'reminders',
  'replace',
  'reset',
  'reveal',
  'session',
  'sessions',
  'settings',
  'source',
  'status',
  'upload',
  'upload-intents',
  'version',
  'webpush',
]);

/** Route template for timing logs: no query, only known route words. */
export function requestRoute(url: string | undefined): string {
  const path = (url ?? '/').split('?', 1)[0] || '/';
  return path
    .split('/')
    .slice(0, 12)
    .map((segment) => (segment === '' || ROUTE_WORDS.has(segment) ? segment : ':id'))
    .join('/');
}

/** No request data or exception object enters this projection. */
export function requestObservation() {
  const requestId = randomUUID();
  const started = performance.now();
  let emitted = false;
  return {
    requestId,
    /** Opt-in (REWIND_REQUEST_TIMING) latency line for every finished request (#321). */
    timing(method: string | undefined, url: string | undefined, status: number): void {
      console.log(
        JSON.stringify({
          event: 'api.request',
          requestId,
          method: /^[A-Z]{3,7}$/.test(method ?? '') ? method : 'OTHER',
          route: requestRoute(url),
          statusCode: Number.isInteger(status) ? status : 0,
          durationMs: Math.min(86_400_000, Math.max(0, Math.round(performance.now() - started))),
        }),
      );
    },
    failure(status: number): void {
      if (emitted) return;
      emitted = true;
      const statusCode = Number.isInteger(status) && status >= 500 && status <= 599 ? status : 500;
      console.error(
        JSON.stringify({
          event: 'api.failure',
          requestId,
          statusCode,
          durationMs: Math.min(86_400_000, Math.max(0, Math.round(performance.now() - started))),
        }),
      );
    },
  };
}

/** Fixed numeric projections only; never load paths, content, destinations or identities. */
export function operationalSnapshot(database: RewindDatabase, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid observation clock.');
  const at = now.toISOString();
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const count = (sql: string, ...parameters: (string | number)[]): number => {
    const row = database.prepare(sql).get(...parameters) as { value: number | null };
    return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(Number(row.value ?? 0))));
  };
  // Terminal jobs clear their processing timestamp. The existing audit pairs
  // retain start/end times without requiring a schema change or private fields.
  const recordedDuration = (event: 'job.completed' | 'job.failed') =>
    count(
      `SELECT MAX(MAX(0, (julianday(terminal.occurred_at) - julianday(
        (SELECT MAX(started.occurred_at) FROM audit_events started
         WHERE started.event_type = 'job.started'
           AND started.resource_id = terminal.resource_id
           AND started.occurred_at <= terminal.occurred_at)
      )) * 86400000)) AS value
       FROM audit_events terminal
       WHERE terminal.event_type = ? AND terminal.resource_id IS NOT NULL
         AND terminal.occurred_at >= ? AND terminal.occurred_at <= ?`,
      event,
      since,
      at,
    );
  const jobs = {
    pending: count(
      "SELECT COUNT(*) AS value FROM media_jobs WHERE kind IN ('clip','film') AND status = 'pending'",
    ),
    processing: count(
      "SELECT COUNT(*) AS value FROM media_jobs WHERE kind IN ('clip','film') AND status = 'processing'",
    ),
    failed: count(
      "SELECT COUNT(*) AS value FROM media_jobs WHERE kind IN ('clip','film') AND status = 'failed'",
    ),
    exhaustedFilms: count(
      "SELECT COUNT(*) AS value FROM media_jobs WHERE kind = 'film' AND status = 'failed' AND attempt_count >= ?",
      QUEUE_MAX_FILM_ATTEMPTS,
    ),
    oldestActiveAgeSeconds: count(
      "SELECT MAX(MAX(0, (julianday(?) - julianday(created_at)) * 86400)) AS value FROM media_jobs WHERE kind IN ('clip','film') AND status IN ('pending','processing')",
      at,
    ),
    longestRecordedFailedAttemptMs: recordedDuration('job.failed'),
    longestRecordedCompletedAttemptMs: recordedDuration('job.completed'),
  };
  const auditCount = (event: string) =>
    count(
      'SELECT COUNT(*) AS value FROM audit_events WHERE event_type = ? AND occurred_at >= ? AND occurred_at <= ?',
      event,
      since,
      at,
    );
  const reminderCount = (state: string) =>
    count('SELECT COUNT(*) AS value FROM reminder_outbox WHERE state = ?', state);
  return {
    schemaVersion: 1,
    observedAt: at,
    eventWindowHours: 24,
    jobs,
    storage: {
      integrityFailures: auditCount('media.integrity_failed'),
      quarantined: auditCount('media.consistency_quarantined'),
      repairFailures: auditCount('media.consistency_repair_failed'),
    },
    reminders: {
      failed: reminderCount('failed'),
      retry: reminderCount('retry'),
      sending: reminderCount('sending'),
      awaitingReceipt: reminderCount('awaiting_receipt'),
      overdue: count(
        "SELECT COUNT(*) AS value FROM reminder_outbox WHERE state IN ('pending','retry','awaiting_receipt') AND next_attempt_at < ?",
        at,
      ),
      expiredLeases: count(
        "SELECT COUNT(*) AS value FROM reminder_outbox WHERE state = 'sending' AND lease_expires_at < ?",
        at,
      ),
    },
    scheduler: {
      receiptsLast24Hours: count(
        'SELECT COUNT(*) AS value FROM cycle_lifecycle_events WHERE occurred_at >= ? AND occurred_at <= ?',
        since,
        at,
      ),
      overdueCollecting: count(
        "SELECT COUNT(*) AS value FROM cycles c JOIN real_group_metadata r ON r.group_id = c.group_id WHERE c.status = 'collecting' AND c.ends_at <= ?",
        at,
      ),
      unpublishedRevealing: count(
        "SELECT COUNT(*) AS value FROM cycles c JOIN real_group_metadata r ON r.group_id = c.group_id WHERE c.status = 'revealing' AND c.release_status = 'unpublished'",
      ),
    },
  };
}
