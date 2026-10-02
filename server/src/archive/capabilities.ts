import { createHash, randomBytes } from 'node:crypto';
import type { RewindDatabase } from '../db';

export const MEDIA_CAPABILITY_TTL_MS = 2 * 60 * 1000;
export const MEDIA_CAPABILITY_MAX_COUNT = 4096;

export interface MediaCapability {
  sessionHash: string;
  accountId: string;
  groupId: string;
  memberId: string;
  jobId: string;
  kind: 'film' | 'clip';
  purpose: 'play' | 'download';
  outputPath: string;
  sha256: string;
  byteLength: number;
  expiresAt: number;
}

/** Short-lived asset capabilities contain no application session token or object path. */
export class MediaCapabilities {
  private readonly grants = new Map<string, MediaCapability>();

  issue(
    input: Omit<MediaCapability, 'sessionHash' | 'expiresAt'> & { sessionToken: string },
    now: Date,
  ): string {
    for (const [key, grant] of this.grants)
      if (grant.expiresAt <= now.getTime()) this.grants.delete(key);
    while (this.grants.size >= MEDIA_CAPABILITY_MAX_COUNT)
      this.grants.delete(this.grants.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    const { sessionToken, ...asset } = input;
    this.grants.set(createHash('sha256').update(token).digest('hex'), {
      ...asset,
      sessionHash: createHash('sha256').update(sessionToken).digest('hex'),
      expiresAt: now.getTime() + MEDIA_CAPABILITY_TTL_MS,
    });
    return `/media/access/${token}`;
  }

  resolve(
    database: RewindDatabase,
    token: string,
    now: Date,
    presentedSession?: string | null,
  ): MediaCapability | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !Number.isFinite(now.getTime())) return null;
    const key = createHash('sha256').update(token).digest('hex');
    const grant = this.grants.get(key);
    if (!grant || grant.expiresAt <= now.getTime()) {
      this.grants.delete(key);
      return null;
    }
    if (
      presentedSession &&
      createHash('sha256').update(presentedSession).digest('hex') !== grant.sessionHash
    )
      return null;
    const session = database
      .prepare(
        `SELECT 1 AS valid FROM real_account_sessions s
      JOIN real_group_memberships m ON m.account_id = s.account_id AND m.group_id = ? AND m.profile_id = ?
      JOIN real_account_group_selections selected ON selected.account_id = s.account_id AND selected.group_id = m.group_id
      WHERE s.token_hash = ? AND s.account_id = ? AND s.revoked_at IS NULL
        AND m.accepted_at IS NOT NULL AND s.idle_expires_at > ? AND s.absolute_expires_at > ?`,
      )
      .get(
        grant.groupId,
        grant.memberId,
        grant.sessionHash,
        grant.accountId,
        now.toISOString(),
        now.toISOString(),
      );
    if (!session) return null;
    const output = database
      .prepare(
        `SELECT 1 AS valid FROM media_jobs j
      LEFT JOIN contributions clip ON clip.id = j.contribution_id
      JOIN cycles c ON c.id = CASE WHEN j.kind = 'film' THEN j.cycle_id ELSE clip.cycle_id END AND c.group_id = j.group_id
      WHERE j.id = ? AND j.group_id = ? AND j.kind = ? AND j.status = 'ready'
        AND j.deleted_at IS NULL AND j.output_path = ? AND j.output_sha256 = ? AND j.output_bytes = ?
        AND j.output_verified_at IS NOT NULL AND c.release_status = 'published' AND c.release_published_at IS NOT NULL
        AND (j.kind = 'film' OR (clip.member_id = ? AND clip.deleted_at IS NULL))`,
      )
      .get(
        grant.jobId,
        grant.groupId,
        grant.kind,
        grant.outputPath,
        grant.sha256,
        grant.byteLength,
        grant.memberId,
      );
    return output ? grant : null;
  }
}
