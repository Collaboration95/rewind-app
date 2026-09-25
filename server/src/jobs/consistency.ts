import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, opendirSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { RewindDatabase } from '../db';
import { recordAuditEvent } from '../audit';
import { PROCESSING_CLAIM_LEASE_MS } from './index';
import { PROCESSED_RETENTION_AGE_MS } from './retention';

export const CONSISTENCY_DEFAULT_LIMIT = 100;
export const CONSISTENCY_MAX_LIMIT = 500;
export const CONSISTENCY_STALE_CLAIM_MS = PROCESSING_CLAIM_LEASE_MS;
export const CONSISTENCY_STALE_FILE_MS = PROCESSED_RETENTION_AGE_MS;

export type ConsistencyKind =
  | 'missing_output'
  | 'unreferenced_processed_file'
  | 'staged_without_file'
  | 'invalid_compilation_reference'
  | 'stale_processing_claim';

export interface ConsistencyFinding {
  kind: ConsistencyKind;
  id: string;
  key?: string;
  repairable: boolean;
  /** Opaque, sanitized relative file name; never an absolute path. */
  name?: string;
  generation?: number;
  claimStartedAt?: string | null;
  reason?: string;
}

interface CandidateFile {
  path: string;
  databasePaths: [string, string];
  name: string;
  device: number;
  inode: number;
  size: number;
  modifiedAtMs: number;
}

export interface ConsistencyPlan {
  limit: number;
  findings: ConsistencyFinding[];
  files: CandidateFile[];
  staleBefore: string;
  staleFileBefore: string;
}

function safeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return cleaned || createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function within(root: string, path: string): boolean {
  const tail = relative(root, path);
  return tail !== '' && tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
}

function safeStat(root: string, path: string): Omit<CandidateFile, 'databasePaths'> | null {
  const link = lstatSync(path);
  if (!link.isFile() || link.isSymbolicLink()) return null;
  const actual = realpathSync(path);
  if (!within(root, actual)) return null;
  const details = statSync(actual);
  if (!details.isFile()) return null;
  return {
    path: actual,
    name: safeName(relative(root, actual)),
    device: details.dev,
    inode: details.ino,
    size: details.size,
    modifiedAtMs: details.mtimeMs,
  };
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? CONSISTENCY_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONSISTENCY_MAX_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${CONSISTENCY_MAX_LIMIT}`);
  }
  return limit;
}

/** Read-only, bounded inspection. Database rows and file names are projected to safe IDs. */
export function planConsistencyRepair(
  database: RewindDatabase,
  processedDir: string,
  stagingDir: string,
  options: { now?: Date; limit?: number; staleClaimMs?: number } = {},
): ConsistencyPlan {
  const limit = boundedLimit(options.limit);
  const now = options.now ?? new Date();
  const staleMs = options.staleClaimMs ?? CONSISTENCY_STALE_CLAIM_MS;
  if (!Number.isSafeInteger(staleMs) || staleMs < 1)
    throw new RangeError('staleClaimMs must be positive');
  const processedRoot = realpathSync(processedDir);
  const requestedProcessedRoot = resolve(processedDir);
  const stagingRoot = realpathSync(stagingDir);
  const findings: ConsistencyFinding[] = [];
  const files: CandidateFile[] = [];
  const staleFileBefore = new Date(now.getTime() - CONSISTENCY_STALE_FILE_MS).toISOString();
  const outputRows = database
    .prepare(
      `SELECT id, kind, output_path AS outputPath, status, claim_generation AS generation,
            processing_started_at AS startedAt,
            EXISTS (
           SELECT 1 FROM audit_events repaired
            WHERE repaired.event_type = 'media.consistency_repaired'
              AND repaired.resource_id = 'job:' || media_jobs.id || ':consistency:' || media_jobs.claim_generation
            ) AS consistencyRepaired
       FROM media_jobs WHERE kind IN ('clip', 'film')
       ORDER BY created_at, id LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  for (const row of outputRows) {
    const key = String(row.id);
    const id = safeName(key);
    if (typeof row.outputPath === 'string' && row.outputPath) {
      try {
        const path = resolve(String(row.outputPath));
        if (!within(processedRoot, path)) throw new Error('outside processed root');
        const link = lstatSync(path);
        if (!link.isFile() || link.isSymbolicLink()) throw new Error('not regular');
      } catch {
        findings.push({
          kind: 'missing_output',
          id,
          key,
          repairable: false,
          reason: 'The original media bytes cannot be reconstructed safely.',
        });
      }
    } else if (row.status === 'ready') {
      findings.push({
        kind: 'missing_output',
        id,
        key,
        repairable: false,
        reason: 'The original media bytes cannot be reconstructed safely.',
      });
    }
    if (row.status === 'processing' && !row.consistencyRepaired) {
      const started = typeof row.startedAt === 'string' ? Date.parse(row.startedAt) : Number.NaN;
      if (!Number.isFinite(started) || started <= now.getTime() - staleMs) {
        findings.push({
          kind: 'stale_processing_claim',
          id,
          key,
          repairable: true,
          generation: Number(row.generation) || 0,
          claimStartedAt: typeof row.startedAt === 'string' ? row.startedAt : null,
        });
      }
    }
  }

  const compilationRows = database
    .prepare(
      `SELECT input.job_id AS jobId, input.clip_job_id AS clipJobId,
            input.contribution_id AS inputContributionId,
            film.kind AS filmKind, film.group_id AS filmGroupId, film.cycle_id AS filmCycleId,
            filmCycle.group_id AS filmCycleGroupId,
            clip.kind AS clipKind, clip.group_id AS clipGroupId, clip.cycle_id AS clipCycleId,
            clip.contribution_id AS clipContributionId,
            clipCycle.group_id AS clipCycleGroupId,
            contribution.cycle_id AS contributionCycleId,
            contributionCycle.group_id AS contributionGroupId
       FROM compilation_job_inputs input
       LEFT JOIN media_jobs film ON film.id = input.job_id
       LEFT JOIN cycles filmCycle ON filmCycle.id = film.cycle_id
       LEFT JOIN media_jobs clip ON clip.id = input.clip_job_id
       LEFT JOIN cycles clipCycle ON clipCycle.id = clip.cycle_id
       LEFT JOIN contributions contribution ON contribution.id = input.contribution_id
       LEFT JOIN cycles contributionCycle ON contributionCycle.id = contribution.cycle_id
       ORDER BY input.job_id, input.position LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  for (const row of compilationRows) {
    const invalid =
      row.filmKind !== 'film' ||
      row.clipKind !== 'clip' ||
      row.contributionCycleId === null ||
      row.filmCycleId === null ||
      row.clipCycleId === null ||
      row.filmCycleId !== row.clipCycleId ||
      row.filmGroupId !== row.clipGroupId ||
      row.filmGroupId !== row.filmCycleGroupId ||
      row.clipGroupId !== row.clipCycleGroupId ||
      row.clipGroupId !== row.contributionGroupId ||
      row.clipCycleId !== row.contributionCycleId ||
      row.clipContributionId !== row.inputContributionId;
    if (invalid)
      findings.push({
        kind: 'invalid_compilation_reference',
        id: safeName(String(row.jobId ?? row.clipJobId ?? 'unknown')),
        repairable: false,
        reason: 'The correct group, cycle, and contribution binding is ambiguous.',
      });
  }

  const stagedRows = database
    .prepare(
      `SELECT source_id AS id, source_path AS sourcePath, status,
              claim_generation AS generation, claim_expires_at AS claimExpiresAt
         FROM staged_sources ORDER BY source_id LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  for (const row of stagedRows) {
    if (row.status === 'pending' && !row.sourcePath) continue;
    const expiry =
      typeof row.claimExpiresAt === 'string' ? Date.parse(row.claimExpiresAt) : Number.NaN;
    const claimExpired = !Number.isFinite(expiry) || expiry <= now.getTime();
    if (row.status === 'pending' && !claimExpired) continue;
    let exists = false;
    if (typeof row.sourcePath === 'string' && row.sourcePath) {
      try {
        const path = resolve(String(row.sourcePath));
        exists = within(stagingRoot, path) && Boolean(safeStat(stagingRoot, path));
      } catch {
        exists = false;
      }
    }
    if (!exists)
      findings.push({
        kind: 'staged_without_file',
        id: safeName(String(row.id)),
        repairable: false,
        generation: Number(row.generation) || 0,
        reason: 'The intake capability owner and retry state require domain cleanup.',
      });
  }

  const directory = opendirSync(processedRoot);
  try {
    for (let scanned = 0; scanned < limit; scanned += 1) {
      const entry = directory.readSync();
      if (!entry) break;
      const name = entry.name;
      if (findings.length >= limit) break;
      try {
        const path = resolve(processedRoot, name);
        const file = safeStat(processedRoot, path);
        if (!file) continue;
        const databasePaths: [string, string] = [resolve(requestedProcessedRoot, name), file.path];
        const referenced = database
          .prepare('SELECT 1 FROM media_jobs WHERE output_path IN (?, ?) LIMIT 1')
          .get(...databasePaths);
        if (referenced) continue;
        if (file.modifiedAtMs > Date.parse(staleFileBefore)) {
          findings.push({
            kind: 'unreferenced_processed_file',
            id: safeName(name),
            name: safeName(name),
            repairable: false,
            reason: 'The file is younger than the shared 24-hour cleanup horizon.',
          });
          continue;
        }
        files.push({ ...file, databasePaths });
        findings.push({
          kind: 'unreferenced_processed_file',
          id: safeName(name),
          name: safeName(name),
          repairable: true,
        });
      } catch {
        /* inaccessible entries are omitted from the sanitized report */
      }
    }
  } finally {
    directory.closeSync();
  }
  return {
    limit,
    findings: findings.slice(0, limit),
    files: files.slice(0, limit),
    staleBefore: new Date(now.getTime() - staleMs).toISOString(),
    staleFileBefore,
  };
}

/** Revalidate under the SQLite writer lock; DB fixes, audit rows and file deletions share one transaction. */
export function applyConsistencyRepair(
  database: RewindDatabase,
  processedDir: string,
  plan: ConsistencyPlan,
): { repaired: string[]; skipped: string[] } {
  const root = realpathSync(processedDir);
  const repaired: string[] = [];
  const skipped: string[] = [];
  const quarantined: { source: string; path: string; name: string }[] = [];
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const finding of plan.findings) {
      if (finding.kind !== 'stale_processing_claim' || !finding.repairable) continue;
      if (!finding.key) {
        skipped.push(finding.id);
        continue;
      }
      const result = database
        .prepare(
          `UPDATE media_jobs SET claim_generation = claim_generation + 1,
                updated_at = ?, failed_at = NULL
          WHERE id = ? AND status = 'processing' AND claim_generation = ?
            AND processing_started_at IS ?
            AND (processing_started_at IS NULL OR processing_started_at <= ?)`,
        )
        .run(
          new Date().toISOString(),
          finding.key,
          finding.generation ?? -1,
          finding.claimStartedAt ?? null,
          plan.staleBefore,
        );
      if (Number(result.changes) === 1) {
        repaired.push(finding.id);
        recordAuditEvent(database, {
          eventType: 'media.consistency_repaired',
          resourceId: `job:${finding.key}:consistency:${(finding.generation ?? 0) + 1}`,
          result: 'success',
        });
      } else skipped.push(finding.id);
    }
    for (const file of plan.files) {
      try {
        const path = resolve(file.path);
        const ref = database
          .prepare(
            `SELECT EXISTS (
               SELECT 1 FROM media_jobs WHERE output_path IN (?, ?)
             ) OR EXISTS (
               SELECT 1 FROM staged_sources WHERE source_path IN (?, ?)
             ) AS referenced`,
          )
          .get(...file.databasePaths, ...file.databasePaths) as { referenced: number };
        const fresh = safeStat(root, path);
        if (
          !within(root, path) ||
          ref.referenced ||
          !fresh ||
          fresh.device !== file.device ||
          fresh.inode !== file.inode ||
          fresh.size !== file.size ||
          fresh.modifiedAtMs !== file.modifiedAtMs ||
          fresh.modifiedAtMs > Date.parse(plan.staleFileBefore)
        ) {
          skipped.push(file.name);
          continue;
        }
        const audit = recordAuditEvent(database, {
          eventType: 'media.consistency_repaired',
          resourceId: `file:${createHash('sha256').update(file.name).digest('hex')}:consistency`,
          result: 'success',
        });
        try {
          const quarantinePath = resolve(root, `.rewind-consistency-${randomUUID()}.tmp`);
          if (!within(root, quarantinePath)) throw new Error('invalid quarantine path');
          renameSync(path, quarantinePath);
          quarantined.push({ source: path, path: quarantinePath, name: file.name });
        } catch (error) {
          database.prepare('DELETE FROM audit_events WHERE id = ?').run(audit.id);
          throw error;
        }
      } catch {
        skipped.push(file.name);
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* A failed COMMIT can leave SQLite's transaction open for rollback. */
    }
    for (const file of quarantined.reverse()) {
      try {
        lstatSync(file.source);
        skipped.push(file.name);
      } catch {
        try {
          renameSync(file.path, file.source);
        } catch {
          skipped.push(file.name);
        }
      }
    }
    throw error;
  }
  for (const file of quarantined) {
    try {
      unlinkSync(file.path);
      repaired.push(file.name);
    } catch {
      skipped.push(file.name);
    }
  }
  return { repaired, skipped };
}
