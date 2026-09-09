import { DEFAULT_MEMBER_ID, demoRepository } from '../src/data/demo-repository';

describe('Synthetic demo repository', () => {
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
});
