import AsyncStorage from '@react-native-async-storage/async-storage';

export type SignOutMarker = 'pending' | 'remote-revoked';

export interface SignOutMarkerStore {
  read(): Promise<SignOutMarker | null>;
  write(marker: SignOutMarker): Promise<void>;
  clear(): Promise<void>;
}

const SIGN_OUT_MARKER_KEY = 'rewind.real-account.sign-out-pending';

export const signOutMarkerStore: SignOutMarkerStore = {
  async read() {
    const value = await AsyncStorage.getItem(SIGN_OUT_MARKER_KEY);
    if (value === null) return null;
    return value === 'remote-revoked' ? 'remote-revoked' : 'pending';
  },
  write: (marker) => AsyncStorage.setItem(SIGN_OUT_MARKER_KEY, marker),
  clear: () => AsyncStorage.removeItem(SIGN_OUT_MARKER_KEY),
};
