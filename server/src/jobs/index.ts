import type { RewindDatabase } from '../db';
import { recordAuditEvent } from '../audit';

export interface AuditedJobInput<T> {
  jobId: string;
  actorMemberId?: string | null;
  run: () => Promise<T> | T;
}

function jobResourceId(jobId: string): string {
  return `job:${jobId}`;
}

export function recordJobStarted(
  database: RewindDatabase,
  jobId: string,
  actorMemberId?: string | null,
): void {
  recordAuditEvent(database, {
    eventType: 'job.started',
    actorMemberId,
    resourceId: jobResourceId(jobId),
    result: 'success',
  });
}

export function recordJobCompleted(
  database: RewindDatabase,
  jobId: string,
  actorMemberId?: string | null,
): void {
  recordAuditEvent(database, {
    eventType: 'job.completed',
    actorMemberId,
    resourceId: jobResourceId(jobId),
    result: 'success',
  });
}

export function recordJobFailed(
  database: RewindDatabase,
  jobId: string,
  actorMemberId?: string | null,
): void {
  recordAuditEvent(database, {
    eventType: 'job.failed',
    actorMemberId,
    resourceId: jobResourceId(jobId),
    result: 'failure',
  });
}

/** Run a local job while preserving its failure semantics and safe trace. */
export async function runAuditedJob<T>(
  database: RewindDatabase,
  input: AuditedJobInput<T>,
): Promise<T> {
  recordJobStarted(database, input.jobId, input.actorMemberId);
  try {
    const value = await input.run();
    recordJobCompleted(database, input.jobId, input.actorMemberId);
    return value;
  } catch (error) {
    recordJobFailed(database, input.jobId, input.actorMemberId);
    throw error;
  }
}
