import type { Cycle, CycleRepository } from '../domain/cycles';
import type {
  CreateGroupInput,
  CreateGroupResult,
  Group,
  GroupCreationRepository,
  GroupRepository,
  MemberProfile,
  ProfileRepository,
} from '../domain/profiles';
import {
  LOCAL_DEMO_CYCLE_DURATION_MS,
  LOCAL_GROUPS_STORAGE_KEY,
  normalizeGroupInput,
  validateGroupInput,
} from '../domain/groups';
import type { LocalGroupRecord } from './local-group-store';

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
  memberRoles: Object.fromEntries(
    profiles.map((profile) => [profile.id, profile.id === DEFAULT_MEMBER_ID ? 'owner' : 'member']),
  ),
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

const localGroups = new Map<string, { group: Group; cycle: Cycle }>();
let localGroupSequence = 0;
export { LOCAL_GROUPS_STORAGE_KEY };

export function hydrateLocalDemoData(records: LocalGroupRecord[] = []): void {
  localGroups.clear();
  for (const record of records) {
    localGroups.set(record.group.id, {
      group: { ...record.group, memberIds: [...record.group.memberIds] },
      cycle: {
        ...record.cycle,
        quota: { ...record.cycle.quota },
        contributionUsage: { ...record.cycle.contributionUsage },
      },
    });
  }
}

export function listLocalDemoGroups(): LocalGroupRecord[] {
  return [...localGroups.values()].map(({ group: storedGroup, cycle: storedCycle }) => ({
    group: { ...storedGroup, memberIds: [...storedGroup.memberIds] },
    cycle: {
      ...storedCycle,
      quota: { ...storedCycle.quota },
      contributionUsage: { ...storedCycle.contributionUsage },
    },
  }));
}

export const demoRepository: ProfileRepository &
  GroupRepository &
  CycleRepository &
  GroupCreationRepository = {
  listProfiles: () => profiles.map((profile) => ({ ...profile })),
  getGroupForMember(actingMemberId, preferredGroupId) {
    const resolved = preferredGroupId
      ? (localGroups.get(preferredGroupId)?.group ??
        (preferredGroupId === group.id ? group : undefined))
      : undefined;
    const membership = resolved?.memberIds.includes(actingMemberId)
      ? resolved
      : ([...localGroups.values()].find((local) => local.group.memberIds.includes(actingMemberId))
          ?.group ?? (group.memberIds.includes(actingMemberId) ? group : undefined));
    if (!membership) {
      return { kind: 'MembershipDenied' };
    }
    const actingMemberRole =
      membership.memberRoles?.[actingMemberId] ??
      (membership.memberIds[0] === actingMemberId ? 'owner' : 'member');
    return {
      ...membership,
      memberIds: [...membership.memberIds],
      memberRoles: membership.memberRoles ? { ...membership.memberRoles } : undefined,
      actingMemberRole,
    };
  },
  async getCurrentCycle(groupId, actingMemberId) {
    const local = localGroups.get(groupId);
    if (local) {
      if (!local.group.memberIds.includes(actingMemberId)) return { kind: 'MembershipDenied' };
      return {
        ...local.cycle,
        quota: { ...local.cycle.quota },
        contributionUsage: { ...local.cycle.contributionUsage },
      };
    }
    if (groupId !== group.id || !group.memberIds.includes(actingMemberId)) {
      return { kind: 'MembershipDenied' };
    }
    return {
      ...cycle,
      quota: { ...cycle.quota },
      contributionUsage: { ...cycle.contributionUsage },
    };
  },
  async createGroup(
    actingMemberId: string,
    input: CreateGroupInput,
    now = new Date(),
  ): Promise<CreateGroupResult> {
    const errors = validateGroupInput(input);
    if (errors.name) return { ok: false, field: 'name', reason: errors.name };
    if (errors.prompt) return { ok: false, field: 'prompt', reason: errors.prompt };
    const owner = profiles.find((profile) => profile.id === actingMemberId);
    if (!owner) return { ok: false, field: 'owner', reason: 'invalid_member' };
    const normalized = normalizeGroupInput(input);
    const suffix = `${now.getTime()}-${++localGroupSequence}`;
    const createdGroup: Group = {
      id: `local-group-${suffix}`,
      name: normalized.name,
      memberIds: [owner.id],
      currentCycleId: `local-cycle-${suffix}`,
      memberRoles: { [owner.id]: 'owner' },
      actingMemberRole: 'owner',
    };
    const createdCycle: Cycle = {
      id: createdGroup.currentCycleId,
      groupId: createdGroup.id,
      prompt: normalized.prompt,
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + LOCAL_DEMO_CYCLE_DURATION_MS).toISOString(),
      status: 'collecting',
      lockState: 'locked',
      quota: { maxCount: 5, maxSeconds: 30 },
      contributionUsage: { countUsed: 0, secondsUsed: 0 },
    };
    localGroups.set(createdGroup.id, { group: createdGroup, cycle: createdCycle });
    return { ok: true, group: { ...createdGroup, memberIds: [...createdGroup.memberIds] } };
  },
};

export async function resetLocalDemoData(): Promise<void> {
  localGroups.clear();
}
