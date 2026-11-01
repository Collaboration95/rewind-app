import type { InviteLinkPayload } from '../invites/deep-links';

export interface RealInvite extends InviteLinkPayload {
  id: string;
  groupId: string;
  status: 'active';
  createdAt: string;
}

export function displayInviteCode(code: string): string {
  const normalized = code.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z]{6}$/.test(normalized)
    ? `${normalized.slice(0, 3)}-${normalized.slice(3)}`
    : normalized;
}

export interface RealGroup {
  memberId?: string;
  group: {
    id: string;
    name: string;
    role: 'owner' | 'member';
    maxMembers: number;
    timeZone?: string;
  };
  cycle: {
    id: string;
    prompt: string;
    startsAt: string;
    endsAt: string;
    quota: { maxCount: number; maxSeconds: number };
    contributionUsage: { countUsed: number; secondsUsed: number };
    contributionCount: number;
  };
  releases?: RealGroupRelease[];
}

export interface RealGroupRelease {
  cycleId: string;
  endsAt: string;
  publishedAt: string | null;
  state: 'processing' | 'delayed' | 'premiere' | 'archived';
}

export interface RealGroupMembers {
  group: { id: string; name: string };
  members: { memberId: string; displayName: string; role: 'owner' | 'member'; joinedAt: string }[];
  pendingInviteCount: number;
}

export async function readGroup(response: Response): Promise<RealGroup | null> {
  if (!response.ok) throw new Error('Your group could not be loaded. Retry when connected.');
  const body = (await response.json()) as { group?: RealGroup | null };
  return body.group ?? null;
}

export async function readGroupMembers(response: Response): Promise<RealGroupMembers> {
  if (!response.ok) throw new Error('Group members could not be loaded. Retry when connected.');
  return (await response.json()) as RealGroupMembers;
}
