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
  /** Present when the server can resolve the acting member's membership. */
  actingMemberRole?: 'owner' | 'member';
}

export type GroupCreateFailureReason = 'required' | 'too_long' | 'invalid' | 'invalid_member';

export interface CreateGroupInput {
  name: string;
  prompt: string;
}

export type CreateGroupResult =
  | { ok: true; group: Group }
  | { ok: false; field: 'name' | 'prompt' | 'owner'; reason: GroupCreateFailureReason };

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

export interface GroupCreationRepository {
  createGroup(
    actingMemberId: MemberId,
    input: CreateGroupInput,
    now?: Date,
  ): Promise<CreateGroupResult>;
}

export interface SelectionStore {
  load(): Promise<MemberId | null>;
  save(memberId: MemberId): Promise<void>;
  clear?(): Promise<void>;
}
