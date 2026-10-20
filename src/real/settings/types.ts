import type { AccountDeletionOutcome } from '../../auth/RealAccountProvider';
import type { PrivateReminderClient } from '../../reminders/private-reminder-client';
import type { MenuGroup } from '../Shell';

export type SettingsStep = 'main' | 'members' | 'groups' | 'invite' | 'prompt' | 'tz' | 'delete';

export interface SettingsGroup {
  memberId?: string;
  group: {
    id: string;
    name: string;
    role: 'owner' | 'member';
    maxMembers: number;
    timeZone?: string;
  };
  cycle: { prompt: string };
}

export interface SettingsMember {
  memberId: string;
  displayName: string;
  role: 'owner' | 'member';
}

export interface InviteControls {
  code: string | null;
  pending: boolean;
  feedback: string | null;
  create: () => void;
  revoke: () => void;
  copy: () => void;
  share: () => void;
}

export type Request = (path: string, init?: RequestInit) => Promise<Response>;

export interface SettingsScreenProps<T extends SettingsGroup> {
  step: SettingsStep;
  onNavigate: (step: SettingsStep) => void;
  onBack: () => void;
  account: { displayName: string; username: string; id: string };
  group: T | null;
  groups: MenuGroup[];
  members: SettingsMember[] | null;
  membersError: string | null;
  /** Codes made but not used yet; null while unknown. */
  pendingInvites: number | null;
  authenticatedRequest: Request;
  onGroupUpdated: (group: T) => void;
  reminderClient: PrivateReminderClient | null;
  invite: InviteControls;
  onSwitchGroup: (groupId: string) => Promise<boolean>;
  switchPending: boolean;
  onJoin: () => void;
  onCreate: () => void;
  signOut: { label: string; pending: boolean; onSignOut: () => void };
  notice?: string | null;
  /** Password for a password session; the typed word DELETE for a Cognito session. */
  onDeleteAccount: (credential: string) => Promise<AccountDeletionOutcome>;
  /** How this account signed in; absent means a password. */
  signInMethod?: 'cognito' | 'password';
  blocked: Set<string>;
  onBlockedChange: (profileId: string, blocked: boolean) => void;
}
