import {
  DEFAULT_MEMBER_ID,
  demoRepository,
  resetLocalDemoData,
} from '../src/data/demo-repository';

describe('Synthetic demo repository', () => {
  afterEach(async () => {
    await resetLocalDemoData();
  });

  it('seeds five distinct synthetic members belonging to exactly one group', () => {
    const profiles = demoRepository.listProfiles();
    expect(profiles).toHaveLength(5);
    expect(new Set(profiles.map((profile) => profile.id)).size).toBe(5);
    expect(
      profiles.every(
        (profile) => profile.isSynthetic && profile.displayName && profile.avatarLabel,
      ),
    ).toBe(true);
    const groups = profiles.map((profile) => demoRepository.getGroupForMember(profile.id));
    expect(groups.every((group) => !('kind' in group))).toBe(true);
    expect(new Set(groups.map((group) => ('id' in group ? group.id : null))).size).toBe(1);
  });

  it('explicitly refuses group data for a synthetic non-member', () => {
    const outsider = { id: 'demo-outsider', displayName: 'Outsider', isSynthetic: true };
    expect(demoRepository.getGroupForMember(outsider.id)).toEqual({ kind: 'MembershipDenied' });
    expect(demoRepository.getGroupForMember('')).toEqual({ kind: 'MembershipDenied' });
  });

  it('seeds a collecting locked cycle with a zero contribution allowance used', async () => {
    const group = demoRepository.getGroupForMember(DEFAULT_MEMBER_ID);
    if ('kind' in group) throw new Error('Default member must belong to group');

    const cycle = await demoRepository.getCurrentCycle(group.id, DEFAULT_MEMBER_ID);
    if ('kind' in cycle) throw new Error('Default member must be able to read the cycle');
    expect(cycle).toMatchObject({
      groupId: group.id,
      prompt: 'What made you pause and smile?',
      status: 'collecting',
      lockState: 'locked',
      quota: { maxCount: 5, maxSeconds: 30 },
      contributionUsage: { countUsed: 0, secondsUsed: 0 },
    });
    expect(Date.parse(cycle.endsAt)).toBeGreaterThan(Date.parse(cycle.startsAt));
  });

  it('guards cycle reads and returns copied quota metadata', async () => {
    const denied = await demoRepository.getCurrentCycle('demo-group', 'demo-outsider');
    expect(denied).toEqual({ kind: 'MembershipDenied' });

    const first = await demoRepository.getCurrentCycle('demo-group', DEFAULT_MEMBER_ID);
    if ('kind' in first) throw new Error('Default member must belong to group');
    first.quota.maxCount = 99;
    first.contributionUsage.countUsed = 99;

    const second = await demoRepository.getCurrentCycle('demo-group', DEFAULT_MEMBER_ID);
    if ('kind' in second) throw new Error('Default member must belong to group');
    expect(second.quota.maxCount).toBe(5);
    expect(second.contributionUsage.countUsed).toBe(0);
  });

  it('returns fresh fixtures so callers cannot change seeded membership', () => {
    const profiles = demoRepository.listProfiles();
    profiles[0].displayName = 'Changed';
    profiles.pop();
    const group = demoRepository.getGroupForMember(DEFAULT_MEMBER_ID);
    if ('kind' in group) throw new Error('Default member must belong to group');
    group.memberIds.push('demo-outsider');
    expect(demoRepository.listProfiles()).toHaveLength(5);
    expect(demoRepository.listProfiles()[0].displayName).toBe('Amber');
    expect(demoRepository.getGroupForMember('demo-outsider')).toEqual({ kind: 'MembershipDenied' });
  });

  it('resolves the active session group before scanning other local memberships', async () => {
    const first = await demoRepository.createGroup(
      DEFAULT_MEMBER_ID,
      { name: 'First local group', prompt: 'First prompt' },
      new Date('2026-09-10T00:00:00.000Z'),
    );
    const second = await demoRepository.createGroup(
      DEFAULT_MEMBER_ID,
      { name: 'Second local group', prompt: 'Second prompt' },
      new Date('2026-09-10T00:00:01.000Z'),
    );
    if (!first.ok || !second.ok) throw new Error('Expected local groups to be created');

    expect(demoRepository.getGroupForMember(DEFAULT_MEMBER_ID, second.group.id)).toMatchObject({
      id: second.group.id,
      name: 'Second local group',
      actingMemberRole: 'owner',
    });
    expect(demoRepository.getGroupForMember('demo-2', 'demo-group')).toMatchObject({
      id: 'demo-group',
      actingMemberRole: 'member',
    });
  });
});
