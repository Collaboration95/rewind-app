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
  name: 'The Sunday Circle',
  memberIds: profiles.map((profile) => profile.id),
  currentCycleId: 'demo-cycle',
};

export const demoRepository: ProfileRepository & GroupRepository = {
  listProfiles: () => profiles.map((profile) => ({ ...profile })),
  getGroupForMember(actingMemberId) {
    if (!group.memberIds.includes(actingMemberId)) {
      return { kind: 'MembershipDenied' };
    }
    return { ...group, memberIds: [...group.memberIds] };
  },
};
