import { randomUUID } from 'node:crypto';

import type { RewindDatabase } from '../db';

const REASON_MAX_LENGTH = 500;

/** Report one chat message, contribution or member (by profile id) in a group
 * the reporter belongs to. Reporting the same item twice stores one report. */
export function reportContent(
  database: RewindDatabase,
  accountId: string,
  groupId: string,
  input: { messageId?: unknown; contributionId?: unknown; memberId?: unknown; reason?: unknown },
  now = new Date(),
): 'reported' | 'invalid' | 'not_found' {
  const id = (value: unknown) => (typeof value === 'string' && value ? value : null);
  const messageId = id(input.messageId);
  const contributionId = id(input.contributionId);
  const memberId = id(input.memberId);
  if (input.messageId === '' || input.contributionId === '' || input.memberId === '')
    return 'invalid';
  const reason = input.reason === undefined ? '' : input.reason;
  if (
    [messageId, contributionId, memberId].filter(Boolean).length !== 1 ||
    typeof reason !== 'string' ||
    reason.length > REASON_MAX_LENGTH
  )
    return 'invalid';
  const member = database
    .prepare('SELECT 1 FROM real_group_memberships WHERE group_id = ? AND account_id = ?')
    .get(groupId, accountId);
  if (!member) return 'not_found';
  if (memberId) {
    const reported = database
      .prepare(
        `SELECT account_id AS accountId FROM real_group_memberships
         WHERE group_id = ? AND profile_id = ? AND account_id <> ?`,
      )
      .get(groupId, memberId, accountId) as { accountId: string } | undefined;
    if (!reported) return 'not_found';
    database
      .prepare(
        `INSERT OR IGNORE INTO member_reports
         (id, reporter_account_id, group_id, reported_account_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), accountId, groupId, reported.accountId, reason.trim(), now.toISOString());
    return 'reported';
  }
  const target = messageId
    ? database
        .prepare('SELECT 1 FROM messages WHERE id = ? AND group_id = ?')
        .get(messageId, groupId)
    : database
        .prepare(
          `SELECT 1 FROM contributions c JOIN cycles cy ON cy.id = c.cycle_id
           WHERE c.id = ? AND cy.group_id = ? AND c.deleted_at IS NULL`,
        )
        .get(contributionId, groupId);
  if (!target) return 'not_found';
  database
    .prepare(
      `INSERT OR IGNORE INTO content_reports
       (id, reporter_account_id, group_id, message_id, contribution_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      accountId,
      groupId,
      messageId,
      contributionId,
      reason.trim(),
      now.toISOString(),
    );
  return 'reported';
}

/** The group owner removes a moment for everyone. The author's allowance and
 * own correction are untouched; who removed it and when stay on the row. */
export function removeContribution(
  database: RewindDatabase,
  accountId: string,
  groupId: string,
  contributionId: string,
  now = new Date(),
): 'removed' | 'forbidden' | 'not_found' {
  const role = database
    .prepare('SELECT role FROM real_group_memberships WHERE group_id = ? AND account_id = ?')
    .get(groupId, accountId) as { role: string } | undefined;
  if (!role) return 'not_found';
  if (role.role !== 'owner') return 'forbidden';
  const found = database
    .prepare(
      `SELECT 1 FROM contributions c JOIN cycles cy ON cy.id = c.cycle_id
       WHERE c.id = ? AND cy.group_id = ?`,
    )
    .get(contributionId, groupId);
  if (!found) return 'not_found';
  database
    .prepare(
      `UPDATE contributions SET removed_at = ?, removed_by_account_id = ?
       WHERE id = ? AND removed_at IS NULL`,
    )
    .run(now.toISOString(), accountId, contributionId);
  return 'removed';
}

export interface FilmSegment {
  contributionId: string;
  startSeconds: number;
  durationSeconds: number;
  hidden: boolean;
  mine: boolean;
}

/** Freeze a compiled film's segment timing from its inputs, once. Call it
 * before anything can delete a contribution row the film was built from. */
export function freezeFilmSegments(database: RewindDatabase, filmId: string): void {
  const frozen = database
    .prepare('SELECT 1 AS done FROM film_segments WHERE film_job_id = ? LIMIT 1')
    .get(filmId) as { done?: number } | undefined;
  if (frozen?.done) return;
  const rows = database
    .prepare(
      `SELECT i.contribution_id AS contributionId,
              CASE WHEN clip.media_type = 'photo' THEN 3
                   ELSE COALESCE(clip.trim_end_seconds - clip.trim_start_seconds,
                                 c.duration_seconds) END AS durationSeconds
       FROM compilation_job_inputs i
       JOIN media_jobs clip ON clip.id = i.clip_job_id
       JOIN contributions c ON c.id = i.contribution_id
       WHERE i.job_id = ?
       ORDER BY i.position ASC, i.clip_job_id ASC`,
    )
    .all(filmId) as { contributionId: string; durationSeconds: number }[];
  const insert = database.prepare(
    `INSERT OR IGNORE INTO film_segments
       (film_job_id, position, contribution_id, start_seconds, duration_seconds)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let startSeconds = 0;
  // All or nothing: a partial set would read as frozen for good. A savepoint
  // also nests inside the account purge's transaction.
  database.exec('SAVEPOINT freeze_film_segments');
  try {
    rows.forEach((row, position) => {
      const durationSeconds = Math.round(Math.max(0, Number(row.durationSeconds)) * 1000) / 1000;
      insert.run(
        filmId,
        position,
        row.contributionId,
        Math.round(startSeconds * 1000) / 1000,
        durationSeconds,
      );
      startSeconds += durationSeconds;
    });
    database.exec('RELEASE freeze_film_segments');
  } catch (error) {
    database.exec('ROLLBACK TO freeze_film_segments');
    database.exec('RELEASE freeze_film_segments');
    throw error;
  }
}

/** The moments in a compiled film, in order, from its frozen timing. A
 * segment is hidden for this viewer when its author is blocked, the viewer
 * reported it, or it was deleted, removed or its author's account is gone.
 * Photos render as 3 seconds. */
export function filmSegments(
  database: RewindDatabase,
  filmId: string,
  viewerProfileId: string,
): FilmSegment[] {
  freezeFilmSegments(database, filmId);
  const rows = database
    .prepare(
      `SELECT s.position, c.id AS contributionId, s.start_seconds AS startSeconds,
              s.duration_seconds AS durationSeconds, CASE WHEN c.member_id = ? THEN 1 ELSE 0 END AS mine,
              (c.id IS NULL OR c.deleted_at IS NOT NULL OR c.removed_at IS NOT NULL
               OR EXISTS (SELECT 1 FROM account_blocks b
                          JOIN real_profiles viewer ON viewer.account_id = b.blocker_account_id
                          JOIN real_profiles author ON author.account_id = b.blocked_account_id
                          WHERE viewer.id = ? AND author.id = c.member_id)
               OR EXISTS (SELECT 1 FROM content_reports r
                          JOIN real_profiles viewer ON viewer.account_id = r.reporter_account_id
                          WHERE viewer.id = ? AND r.contribution_id = c.id)) AS hidden
       FROM film_segments s
       LEFT JOIN contributions c ON c.id = s.contribution_id
       WHERE s.film_job_id = ?
       ORDER BY s.position ASC`,
    )
    .all(viewerProfileId, viewerProfileId, viewerProfileId, filmId) as {
    position: number;
    contributionId: string | null;
    startSeconds: number;
    durationSeconds: number;
    mine: number;
    hidden: number;
  }[];
  return rows.map((row) => ({
    contributionId: row.contributionId ?? `deleted-${row.position}`,
    startSeconds: Number(row.startSeconds),
    durationSeconds: Number(row.durationSeconds),
    hidden: Boolean(row.hidden),
    mine: Boolean(row.mine),
  }));
}

/** Block a member, by profile id, who shares at least one group with the blocker. */
export function blockMember(
  database: RewindDatabase,
  accountId: string,
  profileId: string,
  now = new Date(),
): 'blocked' | 'not_found' {
  const target = database
    .prepare(
      `SELECT theirs.account_id AS accountId
       FROM real_group_memberships theirs
       JOIN real_group_memberships mine ON mine.group_id = theirs.group_id
       WHERE theirs.profile_id = ? AND mine.account_id = ? AND theirs.account_id <> ?
       LIMIT 1`,
    )
    .get(profileId, accountId, accountId) as { accountId: string } | undefined;
  if (!target) return 'not_found';
  database
    .prepare(
      `INSERT OR IGNORE INTO account_blocks (blocker_account_id, blocked_account_id, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(accountId, target.accountId, now.toISOString());
  return 'blocked';
}

export function unblockMember(database: RewindDatabase, accountId: string, profileId: string) {
  database
    .prepare(
      `DELETE FROM account_blocks WHERE blocker_account_id = ? AND blocked_account_id =
       (SELECT account_id FROM real_profiles WHERE id = ?)`,
    )
    .run(accountId, profileId);
}

export function listBlockedMembers(database: RewindDatabase, accountId: string) {
  return database
    .prepare(
      `SELECT p.id AS profileId, p.display_name AS displayName, b.created_at AS blockedAt
       FROM account_blocks b JOIN real_profiles p ON p.account_id = b.blocked_account_id
       WHERE b.blocker_account_id = ? ORDER BY b.created_at`,
    )
    .all(accountId) as { profileId: string; displayName: string; blockedAt: string }[];
}

/** Chat messages the viewer must not see: those by members they blocked and
 * those they reported. Metadata-only events carry no message id. */
export function isChatEventHidden(
  database: RewindDatabase,
  accountId: string,
  message: { id?: string; memberId: string },
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM account_blocks b JOIN real_profiles p ON p.account_id = b.blocked_account_id
         WHERE b.blocker_account_id = ? AND p.id = ?
         UNION ALL
         SELECT 1 FROM content_reports WHERE reporter_account_id = ? AND message_id = ?
         LIMIT 1`,
      )
      .get(accountId, message.memberId, accountId, message.id ?? null),
  );
}

/** Direct replies and reactions require a visible target and no block in
 * either direction. Shared group messages keep their existing visibility. */
export function canInteractWithChatMessage(
  database: RewindDatabase,
  viewerProfileId: string,
  message: { id: string; memberId: string },
): boolean {
  const viewer = database
    .prepare('SELECT account_id AS accountId FROM real_profiles WHERE id = ?')
    .get(viewerProfileId) as { accountId: string } | undefined;
  if (!viewer) return true;
  if (isChatEventHidden(database, viewer.accountId, message)) return false;
  return !database
    .prepare(
      `SELECT 1 FROM account_blocks b
       JOIN real_profiles author ON author.account_id = b.blocker_account_id
       WHERE author.id = ? AND b.blocked_account_id = ? LIMIT 1`,
    )
    .get(message.memberId, viewer.accountId);
}

/** The chat event as this viewer may see it: null when the message itself is
 * hidden, or without its reply preview when the quoted message is hidden. */
export function visibleChatEvent<
  E extends {
    message: { id?: string; memberId: string; replyTo?: { id: string; memberId: string } | null };
  },
>(database: RewindDatabase, accountId: string, event: E): E | null {
  if (isChatEventHidden(database, accountId, event.message)) return null;
  const replyTo = event.message.replyTo;
  if (replyTo && isChatEventHidden(database, accountId, replyTo))
    return { ...event, message: { ...event.message, replyTo: null } };
  return event;
}
