import { createHash } from 'node:crypto';

import { getCurrentCycle, isMember } from '../db';
import type { RewindDatabase } from '../db';

export const MAX_CLIP_BYTES = 50 * 1024 * 1024;
export const MAX_CLIP_DURATION_SECONDS = 15;

export interface ClipUploadInput {
  idempotencyKey: string;
  sourceUri: string;
  mimeType: string;
  byteLength: number;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface PendingClipUpload {
  contribution: {
    id: string;
    cycleId: string;
    groupId: string;
    memberId: string;
    durationSeconds: number;
    createdAt: string;
  };
  job: {
    id: string;
    groupId: string;
    contributionId: string;
    kind: 'clip';
    status: 'pending' | 'cancelled';
    createdAt: string;
  };
  existing: boolean;
}

export type ClipUploadResult =
  | { ok: true; upload: PendingClipUpload }
  | {
      ok: false;
      reason: 'invalid_media' | 'invalid_key' | 'not_found' | 'quota_exceeded' | 'already_member';
    };

export type CancelClipUploadResult =
  { ok: true; contributionId: string; jobId: string } | { ok: false; reason: 'not_found' };

interface UploadRow {
  contributionId: string;
  cycleId: string;
  groupId: string;
  memberId: string;
  durationSeconds: number;
  contributionCreatedAt: string;
  jobId: string;
  jobStatus: string;
  jobCreatedAt: string;
}

function keyHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function idSuffix(key: string): string {
  return keyHash(key).slice(0, 16);
}

function mapUpload(row: UploadRow, existing: boolean): PendingClipUpload {
  return {
    contribution: {
      id: row.contributionId,
      cycleId: row.cycleId,
      groupId: row.groupId,
      memberId: row.memberId,
      durationSeconds: Number(row.durationSeconds),
      createdAt: row.contributionCreatedAt,
    },
    job: {
      id: row.jobId,
      groupId: row.groupId,
      contributionId: row.contributionId,
      kind: 'clip',
      status: row.jobStatus === 'cancelled' ? 'cancelled' : 'pending',
      createdAt: row.jobCreatedAt,
    },
    existing,
  };
}

export function validateClipUpload(input: ClipUploadInput): ClipUploadResult | null {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey)) {
    return { ok: false, reason: 'invalid_key' };
  }
  if (
    !input.sourceUri ||
    input.mimeType !== 'video/mp4' ||
    !Number.isInteger(input.byteLength) ||
    input.byteLength <= 0 ||
    input.byteLength > MAX_CLIP_BYTES ||
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds <= 0 ||
    input.durationSeconds > MAX_CLIP_DURATION_SECONDS ||
    !Number.isFinite(input.width) ||
    !Number.isFinite(input.height) ||
    input.width >= input.height ||
    input.hasAudio !== true
  ) {
    return { ok: false, reason: 'invalid_media' };
  }
  return null;
}

function existingUpload(
  database: RewindDatabase,
  key: string,
  groupId: string,
  memberId: string,
): PendingClipUpload | null {
  const row = database
    .prepare(
      `SELECT c.id AS contributionId, c.cycle_id AS cycleId, cy.group_id AS groupId,
              c.member_id AS memberId, c.duration_seconds AS durationSeconds,
              c.created_at AS contributionCreatedAt, j.id AS jobId, j.status AS jobStatus,
              j.created_at AS jobCreatedAt
       FROM media_jobs j
       JOIN contributions c ON c.id = j.contribution_id
       JOIN cycles cy ON cy.id = c.cycle_id
       WHERE j.idempotency_key = ? AND j.group_id = ? AND c.member_id = ? AND j.kind = 'clip'`,
    )
    .get(keyHash(key), groupId, memberId) as UploadRow | undefined;
  return row ? mapUpload(row, true) : null;
}

export function createClipUpload(
  database: RewindDatabase,
  groupId: string,
  memberId: string,
  input: ClipUploadInput,
  now = new Date(),
): ClipUploadResult {
  const validation = validateClipUpload(input);
  if (validation) return validation;
  if (!isMember(database, groupId, memberId)) return { ok: false, reason: 'not_found' };
  const key = keyHash(input.idempotencyKey);
  const existing = existingUpload(database, input.idempotencyKey, groupId, memberId);
  if (existing) return { ok: true, upload: existing };
  const cycle = getCurrentCycle(database, groupId);
  if (!cycle || cycle.status !== 'collecting') return { ok: false, reason: 'not_found' };
  if (
    cycle.contributionUsage.countUsed + 1 > cycle.quota.maxCount ||
    cycle.contributionUsage.secondsUsed + input.durationSeconds > cycle.quota.maxSeconds
  ) {
    return { ok: false, reason: 'quota_exceeded' };
  }

  const suffix = idSuffix(input.idempotencyKey);
  const contributionId = `contribution-${suffix}`;
  const jobId = `clip-job-${suffix}`;
  const createdAt = now.toISOString();
  database.exec('BEGIN');
  try {
    database
      .prepare(
        `INSERT INTO contributions
          (id, cycle_id, member_id, media_job_id, duration_seconds, created_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .run(contributionId, cycle.id, memberId, input.durationSeconds, createdAt);
    database
      .prepare(
        `INSERT INTO media_jobs
          (id, group_id, contribution_id, kind, status, output_path, created_at, idempotency_key)
         VALUES (?, ?, ?, 'clip', 'pending', NULL, ?, ?)`,
      )
      .run(jobId, groupId, contributionId, createdAt, key);
    database
      .prepare('UPDATE contributions SET media_job_id = ? WHERE id = ?')
      .run(jobId, contributionId);
    database
      .prepare(
        `UPDATE cycles
         SET count_used = count_used + 1, seconds_used = seconds_used + ?
         WHERE id = ?`,
      )
      .run(input.durationSeconds, cycle.id);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    if (String(error).includes('UNIQUE constraint failed: media_jobs.idempotency_key')) {
      const retried = existingUpload(database, input.idempotencyKey, groupId, memberId);
      if (retried) return { ok: true, upload: retried };
    }
    throw error;
  }
  return {
    ok: true,
    upload: mapUpload(
      {
        contributionId,
        cycleId: cycle.id,
        groupId,
        memberId,
        durationSeconds: input.durationSeconds,
        contributionCreatedAt: createdAt,
        jobId,
        jobStatus: 'pending',
        jobCreatedAt: createdAt,
      },
      false,
    ),
  };
}

export function cancelClipUpload(
  database: RewindDatabase,
  groupId: string,
  memberId: string,
  jobId: string,
): CancelClipUploadResult {
  const row = database
    .prepare(
      `SELECT j.id AS jobId, c.id AS contributionId, c.cycle_id AS cycleId,
              c.duration_seconds AS durationSeconds
       FROM media_jobs j JOIN contributions c ON c.id = j.contribution_id
       WHERE j.id = ? AND j.group_id = ? AND c.member_id = ? AND j.kind = 'clip'
         AND j.status = 'pending'`,
    )
    .get(jobId, groupId, memberId) as
    { jobId: string; contributionId: string; cycleId: string; durationSeconds: number } | undefined;
  if (!row) return { ok: false, reason: 'not_found' };
  database.exec('BEGIN');
  try {
    database.prepare('DELETE FROM media_jobs WHERE id = ?').run(row.jobId);
    database.prepare('DELETE FROM contributions WHERE id = ?').run(row.contributionId);
    database
      .prepare(
        `UPDATE cycles
         SET count_used = MAX(0, count_used - 1), seconds_used = MAX(0, seconds_used - ?)
         WHERE id = ?`,
      )
      .run(row.durationSeconds, row.cycleId);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, contributionId: row.contributionId, jobId: row.jobId };
}
