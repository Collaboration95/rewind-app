import type { RewindDatabase } from './db';
import { isMember, isOwner } from './db';

export type ProtectedResource = 'group' | 'message' | 'contribution' | 'clip' | 'film' | 'download';

export interface AllowedDecision {
  allowed: true;
}

export interface DeniedDecision {
  allowed: false;
  status: 403;
  error: 'forbidden';
  message: 'You do not have access to this resource.';
}

export type MembershipDecision = AllowedDecision | DeniedDecision;

export const SAFE_DENIAL: DeniedDecision = Object.freeze({
  allowed: false,
  status: 403,
  error: 'forbidden',
  message: 'You do not have access to this resource.',
});

export function authorizeMember(
  database: RewindDatabase,
  groupId: string,
  actingMemberId: string | null | undefined,
  _resource: ProtectedResource,
): MembershipDecision {
  if (!actingMemberId || !isMember(database, groupId, actingMemberId)) return SAFE_DENIAL;
  return { allowed: true };
}

export function authorizeOwner(
  database: RewindDatabase,
  groupId: string,
  actingMemberId: string | null | undefined,
): MembershipDecision {
  if (!actingMemberId || !isOwner(database, groupId, actingMemberId)) return SAFE_DENIAL;
  return { allowed: true };
}
