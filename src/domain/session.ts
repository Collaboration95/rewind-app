/**
 * A local demo session is an explicit product concept, not an authentication
 * claim. The member ID is the stable synthetic identity selected for the demo.
 */
export const DEMO_ACCESS_KIND = 'demo' as const;
export const DEMO_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
export const DEMO_SESSION_STORAGE_KEY = 'rewind.local-demo.session.v1';

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

export interface DemoSessionStore {
  load(): Promise<DemoSession | null>;
  save(session: DemoSession): Promise<void>;
  clear(): Promise<void>;
}

export type DemoSessionLifecycleResult =
  | { status: 'valid'; session: DemoSession }
  | { status: 'expired'; session: DemoSession }
  | { status: 'invalidated'; session: DemoSession }
  | { status: 'invalid'; reason: 'malformed' };

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

/**
 * Validate a persisted client record before it can become the acting identity.
 * This intentionally checks only the local Demo contract; a configured runtime
 * still revalidates the session against its SQLite store.
 */
export function validateStoredDemoSession(
  value: unknown,
  now = new Date(),
): DemoSessionLifecycleResult {
  if (!isDemoSession(value)) return { status: 'invalid', reason: 'malformed' };
  const lifecycle = classifyDemoSession(value.expiresAt, value.invalidatedAt, now);
  return lifecycle === 'valid'
    ? { status: 'valid', session: value }
    : { status: lifecycle, session: value };
}

export function isDemoSession(value: unknown): value is DemoSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<DemoSession> & { actor?: Partial<DemoSessionActor> };
  return (
    typeof session.id === 'string' &&
    session.id.trim().length > 0 &&
    session.accessKind === DEMO_ACCESS_KIND &&
    typeof session.groupId === 'string' &&
    session.groupId.trim().length > 0 &&
    typeof session.startedAt === 'string' &&
    Number.isFinite(Date.parse(session.startedAt)) &&
    typeof session.expiresAt === 'string' &&
    Number.isFinite(Date.parse(session.expiresAt)) &&
    (session.invalidatedAt === null || typeof session.invalidatedAt === 'string') &&
    typeof session.actor?.memberId === 'string' &&
    session.actor.memberId.trim().length > 0 &&
    typeof session.actor.displayName === 'string' &&
    session.actor.displayName.trim().length > 0 &&
    session.actor.isSynthetic === true
  );
}
