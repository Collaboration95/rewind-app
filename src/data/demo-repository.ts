import type { Cycle, CycleRepository } from '../domain/cycles';
import type { Group, GroupRepository, MemberProfile, ProfileRepository } from '../domain/profiles';

export const DEFAULT_MEMBER_ID = 'demo-1';

// Synthetic fixtures only. Every read returns a copy so callers cannot change membership.
const profiles: MemberProfile[] = ['Amber', 'Birch', 'Clover', 'Dune', 'Echo'].map(
  (name, index) => ({
    id: `demo-${index + 1}`,
    displayName: name,
    avatarLabel: `${name}, sample member`,
    isSynthetic: true,
  }),
);

const group: Group = {
  id: 'demo-group',
  name: 'Weekend People',
  memberIds: profiles.map((profile) => profile.id),
  currentCycleId: 'demo-cycle',
};

const cycle: Cycle = {
  id: 'demo-cycle',
  groupId: group.id,
  prompt: 'What made you pause and smile?',
  startsAt: new Date().toISOString(),
  endsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
  status: 'collecting',
  lockState: 'locked',
  quota: {
    maxCount: 5,
    maxSeconds: 30,
  },
  contributionUsage: {
    countUsed: 0,
    secondsUsed: 0,
  },
};

export const demoRepository: ProfileRepository & GroupRepository & CycleRepository = {
  listProfiles: () => profiles.map((profile) => ({ ...profile })),
  getGroupForMember(actingMemberId) {
    if (!group.memberIds.includes(actingMemberId)) {
      return { kind: 'MembershipDenied' };
    }
    return { ...group, memberIds: [...group.memberIds] };
  },
  async getCurrentCycle(groupId, actingMemberId) {
    if (groupId !== group.id || !group.memberIds.includes(actingMemberId)) {
      return { kind: 'MembershipDenied' };
    }
    return {
      ...cycle,
      quota: { ...cycle.quota },
      contributionUsage: { ...cycle.contributionUsage },
    };
  },
};
