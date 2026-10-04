import { randomUUID } from 'node:crypto';

import type { RewindDatabase } from '../db';

const REASON_MAX_LENGTH = 500;

/** Report one chat message or contribution in a group the reporter belongs to.
 * Reporting the same item twice is accepted and stores one report. */
export function reportContent(
  database: RewindDatabase,
  accountId: string,
  groupId: string,
  input: { messageId?: unknown; contributionId?: unknown; reason?: unknown },
  now = new Date(),
): 'reported' | 'invalid' | 'not_found' {
  const messageId = typeof input.messageId === 'string' && input.messageId ? input.messageId : null;
  const contributionId =
    typeof input.contributionId === 'string' && input.contributionId ? input.contributionId : null;
  if (input.messageId === '' || input.contributionId === '') return 'invalid';
  const reason = input.reason === undefined ? '' : input.reason;
  if (
    Boolean(messageId) === Boolean(contributionId) ||
    typeof reason !== 'string' ||
    reason.length > REASON_MAX_LENGTH
  )
    return 'invalid';
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
  const member = database
    .prepare('SELECT 1 FROM real_group_memberships WHERE group_id = ? AND account_id = ?')
    .get(groupId, accountId);
  if (!target || !member) return 'not_found';
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
