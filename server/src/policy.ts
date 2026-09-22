import type { RewindDatabase } from './db';
import { isMember, isOwner } from './db';
import type { DemoRequestIdentity } from './session/request';

export type ProtectedResource =
  'group' | 'message' | 'contribution' | 'clip' | 'film' | 'download' | 'job';

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

/**
 * Hosted-route policy: bind both the actor and the selected group to the
 * validated Demo session before evaluating resource membership.
 */
export function authorizeSessionMember(
  database: RewindDatabase,
  groupId: string,
  identity: DemoRequestIdentity | null | undefined,
  resource: ProtectedResource,
): MembershipDecision {
  if (!identity || identity.groupId !== groupId) return SAFE_DENIAL;
  return authorizeMember(database, groupId, identity.memberId, resource);
}

export function authorizeSessionOwner(
  database: RewindDatabase,
  groupId: string,
  identity: DemoRequestIdentity | null | undefined,
): MembershipDecision {
  if (!identity || identity.groupId !== groupId) return SAFE_DENIAL;
  return authorizeOwner(database, groupId, identity.memberId);
}
