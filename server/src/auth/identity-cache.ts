// Short-lived, per-database memory of who a signed-in request is (#261).
//
// Every authorised request used to re-read its session, selected group and
// membership, often twice. Over a network database that is most of a request's
// cost, so these stable facts are remembered for a few minutes. The server's
// own changes (sign-out, password reset, account deletion, group creation or
// selection, invite acceptance) clear them at once; a change made outside the
// server, such as a manual SQL edit, applies within IDENTITY_CACHE_TTL_MS.
import type { RewindDatabase } from '../db';

export const IDENTITY_CACHE_TTL_MS = 5 * 60 * 1000;

interface Entry<T> {
  value: T;
  cachedAt: number;
}

export interface CachedSession {
  accountId: string;
  account: Record<string, unknown>;
  absoluteExpiresAt: string;
  /** The idle expiry last written to the database. */
  persistedIdleExpiresAt: string;
}

interface IdentityCache {
  sessions: Map<string, Entry<CachedSession>>;
  selections: Map<string, Entry<string | null>>;
  memberships: Map<string, Entry<string | null>>;
}

const caches = new WeakMap<object, IdentityCache>();

function cacheFor(database: RewindDatabase): IdentityCache {
  let cache = caches.get(database);
  if (!cache) {
    cache = { sessions: new Map(), selections: new Map(), memberships: new Map() };
    caches.set(database, cache);
  }
  return cache;
}

function fresh<T>(map: Map<string, Entry<T>>, key: string, now: number): Entry<T> | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (now - entry.cachedAt >= IDENTITY_CACHE_TTL_MS || now < entry.cachedAt) {
    map.delete(key);
    return undefined;
  }
  return entry;
}

function remember<T>(map: Map<string, Entry<T>>, key: string, value: T, now: number): void {
  // Bound memory: a busy server drops the oldest entries.
  if (map.size >= 10_000) map.delete(map.keys().next().value as string);
  map.set(key, { value, cachedAt: now });
}

export function cachedSession(database: RewindDatabase, tokenHash: string, now: number) {
  return fresh(cacheFor(database).sessions, tokenHash, now)?.value;
}

export function rememberSession(
  database: RewindDatabase,
  tokenHash: string,
  session: CachedSession,
  now: number,
): void {
  remember(cacheFor(database).sessions, tokenHash, session, now);
}

export function forgetSession(database: RewindDatabase, tokenHash: string): void {
  cacheFor(database).sessions.delete(tokenHash);
}

/** The account's selected group id (null when none), from cache or `load`. */
export function selectedGroupId(
  database: RewindDatabase,
  accountId: string,
  now: number,
  load: () => string | null,
): string | null {
  const cache = cacheFor(database).selections;
  const hit = fresh(cache, accountId, now);
  if (hit) return hit.value;
  const value = load();
  remember(cache, accountId, value, now);
  return value;
}

/** The account's profile in the group (null when not a member). */
export function membershipProfileId(
  database: RewindDatabase,
  accountId: string,
  groupId: string,
  now: number,
  load: () => string | null,
): string | null {
  const cache = cacheFor(database).memberships;
  const key = `${accountId}\u0000${groupId}`;
  const hit = fresh(cache, key, now);
  if (hit) return hit.value;
  const value = load();
  remember(cache, key, value, now);
  return value;
}

/** Forget everything about one account (sessions, selection, memberships). */
export function forgetAccount(database: RewindDatabase, accountId: string): void {
  const cache = cacheFor(database);
  for (const [key, entry] of cache.sessions) {
    if (entry.value.accountId === accountId) cache.sessions.delete(key);
  }
  cache.selections.delete(accountId);
  for (const key of cache.memberships.keys()) {
    if (key.startsWith(`${accountId}\u0000`)) cache.memberships.delete(key);
  }
}

/** Forget everything (for example after an account deletion moved groups). */
export function forgetAllIdentities(database: RewindDatabase): void {
  caches.delete(database);
}
