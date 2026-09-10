import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Cycle } from '../domain/cycles';
import { LOCAL_GROUPS_STORAGE_KEY } from '../domain/groups';
import type { Group } from '../domain/profiles';

export interface LocalGroupRecord {
  group: Group;
  cycle: Cycle;
}

function isRecord(value: unknown): value is LocalGroupRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LocalGroupRecord>;
  return Boolean(
    candidate.group &&
    candidate.cycle &&
    typeof candidate.group.id === 'string' &&
    typeof candidate.group.name === 'string' &&
    Array.isArray(candidate.group.memberIds) &&
    typeof candidate.group.currentCycleId === 'string' &&
    typeof candidate.cycle.id === 'string' &&
    typeof candidate.cycle.groupId === 'string' &&
    typeof candidate.cycle.prompt === 'string',
  );
}

export const localGroupStore = {
  async load(): Promise<LocalGroupRecord[]> {
    const encoded = await AsyncStorage.getItem(LOCAL_GROUPS_STORAGE_KEY);
    if (!encoded) return [];
    try {
      const parsed: unknown = JSON.parse(encoded);
      return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
    } catch {
      return [];
    }
  },
  save(records: LocalGroupRecord[]): Promise<void> {
    return AsyncStorage.setItem(LOCAL_GROUPS_STORAGE_KEY, JSON.stringify(records));
  },
  clear(): Promise<void> {
    return AsyncStorage.removeItem(LOCAL_GROUPS_STORAGE_KEY);
  },
};
