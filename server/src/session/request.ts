import type { URL } from 'node:url';

import type { RewindDatabase } from '../db';
import { validateDemoSession } from './index';
import type { DemoSession } from './contract';

/**
 * The only identity an HTTP request may use for protected Demo data.
 *
 * `memberId` and `groupId` query/body/header values are deliberately absent
 * from this type. A group id may still be supplied as a resource selector by
 * a route, but callers must prove that it matches this session context before
 * the route reads or mutates anything.
 */
export interface DemoRequestIdentity {
  sessionId: string;
  memberId: string;
  groupId: string;
  session: DemoSession;
}

export type DemoRequestIdentityFailure =
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'invalidated' }
  | { ok: true; identity: DemoRequestIdentity };

/** Resolve only the persisted session identity; never fall back to request data. */
export function extractDemoRequestIdentity(
  database: RewindDatabase,
  url: URL,
  now = new Date(),
): DemoRequestIdentityFailure {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return { ok: false, reason: 'missing' };

  const result = validateDemoSession(database, sessionId, now);
  if (result.status !== 'valid') return { ok: false, reason: result.status };

  return {
    ok: true,
    identity: {
      sessionId: result.session.id,
      memberId: result.session.actor.memberId,
      groupId: result.session.groupId,
      session: result.session,
    },
  };
}
