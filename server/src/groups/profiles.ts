import type { RewindDatabase } from '../db';

export interface RealGroupMemberSummary {
  memberId: string;
  displayName: string;
  role: 'owner' | 'member';
  joinedAt: string;
}

/** Return private member summaries only when the validated account belongs to the group. */
export function listRealGroupMemberSummaries(
  database: RewindDatabase,
  accountId: string,
  groupId: string,
  now = new Date(),
) {
  const group = database
    .prepare(
      `SELECT g.id, g.name
       FROM real_group_memberships access
       JOIN groups g ON g.id = access.group_id
       WHERE access.account_id = ? AND access.group_id = ?`,
    )
    .get(accountId, groupId) as { id: string; name: string } | undefined;
  if (!group) return null;

  const members = database
    .prepare(
      `SELECT profile.id AS memberId, profile.display_name AS displayName, membership.role,
              membership.accepted_at AS joinedAt
       FROM real_group_memberships membership
       JOIN real_profiles profile ON profile.id = membership.profile_id
       WHERE membership.group_id = ?
       ORDER BY CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,
                membership.accepted_at, lower(profile.display_name)`,
    )
    .all(group.id) as unknown as RealGroupMemberSummary[];
  const pendingInviteCount = database
    .prepare(
      `SELECT COUNT(*) AS count FROM real_group_invites
       WHERE group_id = ? AND status = 'active' AND expires_at > ?`,
    )
    .get(group.id, now.toISOString()) as { count: number };

  return {
    group: { id: group.id, name: group.name },
    members,
    pendingInviteCount: Number(pendingInviteCount.count),
  };
}
