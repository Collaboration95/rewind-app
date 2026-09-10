import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  DEMO_SESSION_LIFETIME_MS,
  DEMO_SESSION_STORAGE_KEY,
  isDemoSession,
  type DemoSession,
  type DemoSessionStore,
} from '../domain/session';

/**
 * AsyncStorage is used only for the local Demo access record. It is not a
 * credential store and the record contains no secret or security claim.
 */
export const demoSessionStore: DemoSessionStore = {
  async load() {
    const encoded = await AsyncStorage.getItem(DEMO_SESSION_STORAGE_KEY);
    if (!encoded) return null;
    try {
      const value: unknown = JSON.parse(encoded);
      return isDemoSession(value) ? value : null;
    } catch {
      return null;
    }
  },
  save: (session) => AsyncStorage.setItem(DEMO_SESSION_STORAGE_KEY, JSON.stringify(session)),
  clear: () => AsyncStorage.removeItem(DEMO_SESSION_STORAGE_KEY),
};

let localSessionSequence = 0;

export function createOfflineDemoSession(
  memberId: string,
  displayName: string,
  groupId: string,
  now = new Date(),
): DemoSession {
  const startedAt = now.toISOString();
  const id = `offline-demo-${now.getTime()}-${++localSessionSequence}`;
  return {
    id,
    accessKind: 'demo',
    actor: { memberId, displayName, isSynthetic: true },
    groupId,
    startedAt,
    expiresAt: new Date(now.getTime() + DEMO_SESSION_LIFETIME_MS).toISOString(),
    invalidatedAt: null,
  };
}
