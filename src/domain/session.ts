/**
 * A local demo session is an explicit product concept, not an authentication
 * claim. The member ID is the stable synthetic identity selected for the demo.
 */
export const DEMO_ACCESS_KIND = 'demo' as const;
export const DEMO_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

export type DemoAccessKind = typeof DEMO_ACCESS_KIND;

export interface DemoSessionActor {
  memberId: string;
  displayName: string;
  isSynthetic: true;
}

export interface DemoSession {
  id: string;
  accessKind: DemoAccessKind;
  actor: DemoSessionActor;
  groupId: string;
  startedAt: string;
  expiresAt: string;
  invalidatedAt: string | null;
}

export type SessionInvalidReason = 'missing' | 'not_demo' | 'expired' | 'invalidated';

export type SessionValidation =
  | { status: 'valid'; session: DemoSession }
  | {
      status: 'invalid';
      reason: Exclude<SessionInvalidReason, 'expired' | 'invalidated'>;
      sessionId: string;
    }
  | { status: 'expired'; reason: 'expired'; session: DemoSession }
  | { status: 'invalidated'; reason: 'invalidated'; session: DemoSession };

export function demoSessionExpiry(
  startedAt: string,
  lifetimeMs = DEMO_SESSION_LIFETIME_MS,
): string {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs))
    throw new RangeError('Demo session start must be an ISO-8601 instant.');
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
    throw new RangeError('Demo session lifetime must be a positive finite duration.');
  }
  return new Date(startedAtMs + lifetimeMs).toISOString();
}

export function classifyDemoSession(
  expiresAt: string,
  invalidatedAt: string | null,
  now = new Date(),
): 'valid' | 'expired' | 'invalidated' {
  if (invalidatedAt) return 'invalidated';
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return 'expired';
  return now.getTime() < expiresAtMs ? 'valid' : 'expired';
}
