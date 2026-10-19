export type CycleStatus = 'collecting' | 'revealing' | 'archived';
export type LockState = 'locked' | 'unlocked';

/** Public cycle history metadata; deliberately contains no media capability. */
export interface CycleHistoryEntry {
  id: string;
  prompt: string;
  startsAt: string;
  endsAt: string;
  status: CycleStatus;
  releaseStatus: 'unpublished' | 'published';
}

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
