import AsyncStorage from '@react-native-async-storage/async-storage';

import type { SelectionStore } from '../domain/profiles';

export const SELECTION_KEY = 'rewind.local-demo.selected-member.v1';

export const selectionStore: SelectionStore = {
  load: () => AsyncStorage.getItem(SELECTION_KEY),
  save: (memberId) => AsyncStorage.setItem(SELECTION_KEY, memberId),
  clear: () => AsyncStorage.removeItem(SELECTION_KEY),
};
