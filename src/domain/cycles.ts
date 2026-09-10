import type { MemberId, MembershipDenied } from './profiles';

export type CycleStatus = 'collecting' | 'revealing' | 'archived';
export type LockState = 'locked' | 'unlocked';

/**
 * The two supported local-demo cycle lengths. The server owns the lifecycle
 * calculation; this type keeps client control ports independent of transport
 * or UI frameworks.
 */
export type CycleDurationPreset = 'one-day' | 'four-week';

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

export interface InvalidCycleAdvance {
  kind: 'InvalidRequest';
}

export interface OwnerControlDenied {
  kind: 'OwnerControlDenied';
}

export type CycleAdvanceResult =
  Cycle | OwnerControlDenied | CycleNotFound | InvalidCycleAdvance | RecoverableFailure;

export interface CycleRepository {
  getCurrentCycle(groupId: string, actingMemberId: MemberId): Promise<CurrentCycleResult>;
}

/** A testable adapter for the owner-only local demonstration control. */
export interface CycleControlRepository {
  advanceDemoCycle(
    groupId: string,
    actingMemberId: MemberId,
    advanceSeconds: number,
  ): Promise<CycleAdvanceResult>;
}
