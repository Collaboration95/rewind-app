/** Server-side mirror of the framework-independent demo session constants. */
export const DEMO_ACCESS_KIND = 'demo' as const;
export const DEMO_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

export interface DemoSessionActor {
  memberId: string;
  displayName: string;
  isSynthetic: true;
}

export interface DemoSession {
  id: string;
  accessKind: typeof DEMO_ACCESS_KIND;
  actor: DemoSessionActor;
  groupId: string;
  startedAt: string;
  expiresAt: string;
  invalidatedAt: string | null;
}

export function demoSessionExpiry(
  startedAt: string,
  lifetimeMs = DEMO_SESSION_LIFETIME_MS,
): string {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    throw new RangeError('Demo session start must be an ISO-8601 instant.');
  }
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
