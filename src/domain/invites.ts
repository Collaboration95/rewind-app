import type { DemoSession } from './session';
import type { Group } from './profiles';

export type InviteStatus = 'active' | 'used' | 'expired';

export interface LocalInvite {
  id: string;
  code: string;
  groupId: string;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface InviteAcceptance {
  invite: LocalInvite;
  group: Group;
  session: DemoSession;
}
