import type { DemoSession } from './session';
import type { Group } from './profiles';

export const INVITE_CODE_LENGTH = 8;
export const INVITE_CODE_PATTERN = /^[A-Z0-9]{8}$/;

/**
 * Invite codes are commonly copied with surrounding or grouping whitespace.
 * Normalize that presentation detail before applying the exact code contract.
 */
export function normalizeInviteCode(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

export function isValidInviteCode(value: string): boolean {
  return INVITE_CODE_PATTERN.test(normalizeInviteCode(value));
}

export type InviteStatus = 'active' | 'used' | 'expired';

export interface LocalInvite {
  id: string;
  code: string;
  groupId: string;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface InviteAcceptance {
  invite: LocalInvite;
  group: Group;
  session: DemoSession;
}
