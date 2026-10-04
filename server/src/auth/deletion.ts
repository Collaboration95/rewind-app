import { safeRemoveOwnedPath } from '../contributions';
import type { RewindDatabase } from '../db';
import type { MediaStore } from '../media/store';
import { decodeMediaRef, isMediaRef } from '../media/store';

export interface StoredMediaPath {
  groupId: string;
  path: string;
}

/**
 * Permanently delete a real account and the content it owns (App Store
 * Guideline 5.1.1(v)). In one transaction:
 * - each group the account owns passes to its longest-standing other member,
 *   or is deleted with all its content when the account is the only member;
 * - the account's own clips and photos are tombstoned like a contributor
 *   delete, so no compiler or archive can serve them again;
 * - the account row is deleted, which cascades to its profile, memberships,
 *   sessions, chat messages, reactions, reminders, reports and blocks.
 * Compiled group films that already include the account's clips are kept,
 * because they belong to the whole group.
 * Returns the stored media to remove after the commit.
 */
export function purgeRealAccount(
  database: RewindDatabase,
  accountId: string,
  now = new Date(),
): StoredMediaPath[] {
  const media: StoredMediaPath[] = [];
  const collect = (rows: Record<string, unknown>[]) => {
    for (const row of rows)
      for (const key of ['outputPath', 'sourcePath'])
        if (typeof row[key] === 'string')
          media.push({ groupId: String(row.groupId), path: String(row[key]) });
  };
  database.exec('BEGIN IMMEDIATE');
  try {
    const profileId = (
      database.prepare('SELECT id FROM real_profiles WHERE account_id = ?').get(accountId) as
        { id: string } | undefined
    )?.id;

    const ownedGroups = database
      .prepare('SELECT group_id AS groupId FROM real_group_metadata WHERE owner_account_id = ?')
      .all(accountId) as { groupId: string }[];
    for (const { groupId } of ownedGroups) {
      const successor = database
        .prepare(
          `SELECT account_id AS accountId FROM real_group_memberships
           WHERE group_id = ? AND account_id <> ? ORDER BY accepted_at, account_id LIMIT 1`,
        )
        .get(groupId, accountId) as { accountId: string } | undefined;
      if (successor) {
        database
          .prepare('UPDATE real_group_metadata SET owner_account_id = ? WHERE group_id = ?')
          .run(successor.accountId, groupId);
        database
          .prepare(
            "UPDATE real_group_memberships SET role = 'owner' WHERE group_id = ? AND account_id = ?",
          )
          .run(groupId, successor.accountId);
        continue;
      }
      collect(
        database
          .prepare(
            `SELECT group_id AS groupId, output_path AS outputPath, source_path AS sourcePath
             FROM media_jobs WHERE group_id = ?
             UNION ALL
             SELECT group_id, NULL, source_path FROM staged_sources WHERE group_id = ?`,
          )
          .all(groupId, groupId) as Record<string, unknown>[],
      );
      database.prepare('DELETE FROM upload_intents WHERE group_id = ?').run(groupId);
      database.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
    }

    if (profileId) {
      const jobs = database
        .prepare(
          `SELECT j.id, j.group_id AS groupId, j.output_path AS outputPath,
                  j.source_path AS sourcePath, j.source_uri AS sourceUri
           FROM media_jobs j JOIN contributions c ON c.id = j.contribution_id
           WHERE c.member_id = ? AND j.kind <> 'film'`,
        )
        .all(profileId) as Record<string, unknown>[];
      collect(jobs);
      collect(
        database
          .prepare(
            'SELECT group_id AS groupId, source_path AS sourcePath FROM staged_sources WHERE member_id = ?',
          )
          .all(profileId) as Record<string, unknown>[],
      );
      const deletedAt = now.toISOString();
      for (const job of jobs) {
        database
          .prepare(
            `UPDATE media_jobs
             SET status = 'deleted', deleted_at = ?, output_path = NULL,
                 output_sha256 = NULL, output_bytes = NULL, output_verified_at = NULL,
                 source_uri = NULL, source_generation = NULL, source_path = NULL,
                 error_code = 'account_deleted'
             WHERE id = ?`,
          )
          .run(deletedAt, String(job.id));
        if (job.sourceUri)
          database
            .prepare('DELETE FROM media_metadata WHERE source_uri = ?')
            .run(String(job.sourceUri));
      }
    }

    // These references to the account do not cascade.
    database.prepare('DELETE FROM upload_intents WHERE account_id = ?').run(accountId);
    database
      .prepare(
        'UPDATE real_group_invites SET accepted_by_account_id = NULL WHERE accepted_by_account_id = ?',
      )
      .run(accountId);
    database.prepare('DELETE FROM real_accounts WHERE id = ?').run(accountId);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return media;
}

/** Best-effort removal of media files after the deletion commit. The database
 * no longer references them, so a missed file is unreachable, not exposed. */
export async function removeStoredMedia(
  media: StoredMediaPath[],
  options: {
    outputDir: string;
    stagingDir: string;
    mediaStore?: MediaStore;
    mediaEnvironment?: string;
  },
): Promise<void> {
  for (const { groupId, path } of media) {
    try {
      if (isMediaRef(path)) {
        if (options.mediaStore && options.mediaEnvironment)
          await options.mediaStore.delete(
            { environment: options.mediaEnvironment, groupId },
            decodeMediaRef(path),
          );
      } else {
        safeRemoveOwnedPath(path, options.outputDir);
        safeRemoveOwnedPath(path, options.stagingDir);
      }
    } catch {
      // Unreferenced media is left for the existing bounded cleanup.
    }
  }
}
