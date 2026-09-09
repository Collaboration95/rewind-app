import type { MemberId, MembershipDenied } from './profiles';

export type CycleStatus = 'collecting' | 'revealing' | 'archived';
export type LockState = 'locked' | 'unlocked';

export interface ContributionQuota {
  maxCount: number;
  maxSeconds: number;
}

export interface ContributionUsage {
  countUsed: number;
  secondsUsed: number;
}

export interface Cycle {
  id: string;
  groupId: string;
  prompt: string;
  startsAt: string;
  endsAt: string;
  status: CycleStatus;
  lockState: LockState;
  quota: ContributionQuota;
  contributionUsage: ContributionUsage;
}

export interface CycleNotFound {
  kind: 'NotFound';
}

export interface RecoverableFailure {
  kind: 'RecoverableFailure';
}

export type CurrentCycleResult = Cycle | MembershipDenied | CycleNotFound | RecoverableFailure;

export interface CycleRepository {
  getCurrentCycle(groupId: string, actingMemberId: MemberId): Promise<CurrentCycleResult>;
}
