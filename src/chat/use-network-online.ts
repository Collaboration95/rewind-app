import { addNetworkStateListener, getNetworkStateAsync } from 'expo-network';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function networkOnline(
  state: { isConnected?: boolean | null; isInternetReachable?: boolean | null } | null | undefined,
): boolean {
  if (!state) return true;
  return state.isConnected !== false && state.isInternetReachable !== false;
}

/** Tracks native reachability on iOS/Android and browser connectivity on web. */
export function useNetworkOnline(): boolean {
  const [online, setOnline] = useState(browserOnline);

  useEffect(() => {
    if (Platform.OS === 'web') {
      if (
        typeof window === 'undefined' ||
        typeof window.addEventListener !== 'function' ||
        typeof window.removeEventListener !== 'function'
      )
        return;
      const update = () => setOnline(browserOnline());
      window.addEventListener('online', update);
      window.addEventListener('offline', update);
      update();
      return () => {
        window.removeEventListener('online', update);
        window.removeEventListener('offline', update);
      };
    }

    let mounted = true;
    const subscription = addNetworkStateListener((state) => {
      setOnline(networkOnline(state));
    });
    void getNetworkStateAsync().then(
      (state) => {
        if (mounted) setOnline(networkOnline(state));
      },
      () => {
        if (mounted) setOnline(true);
      },
    );
    return () => {
      mounted = false;
      subscription?.remove?.();
    };
  }, []);

  return online;
}
