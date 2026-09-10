export type MemberId = string;

export interface MemberProfile {
  id: MemberId;
  displayName: string;
  avatarLabel: string;
  isSynthetic: true;
}

export interface Group {
  id: string;
  name: string;
  memberIds: MemberId[];
  currentCycleId: string;
}

export interface MembershipDenied {
  kind: 'MembershipDenied';
}

export interface ProfileRepository {
  listProfiles(): MemberProfile[];
}

export interface GroupRepository {
  getGroupForMember(actingMemberId: MemberId): Group | MembershipDenied;
}

export interface AsyncGroupRepository {
  getGroupForMember(actingMemberId: MemberId): Promise<Group | MembershipDenied>;
}

export interface SelectionStore {
  load(): Promise<MemberId | null>;
  save(memberId: MemberId): Promise<void>;
}
