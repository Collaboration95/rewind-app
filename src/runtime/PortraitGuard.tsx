import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { WARM } from '../ui/tokens';

// Phones held sideways are shorter than this; tablets and desktops are not.
const PHONE_LANDSCAPE_MAX_HEIGHT = 500;

/** `held` is how the device itself is held, when the browser knows. The
 * window alone is not enough: the iPhone keyboard shortens it until a phone
 * held upright looks sideways. */
export function isPhoneLandscape(
  width: number,
  height: number,
  held?: 'portrait' | 'landscape',
): boolean {
  if (held === 'portrait') return false;
  return width > height && height < PHONE_LANDSCAPE_MAX_HEIGHT;
}

function heldOrientation(): 'portrait' | 'landscape' | undefined {
  if (typeof window === 'undefined') return undefined;
  const type = window.screen?.orientation?.type;
  if (type) return type.startsWith('portrait') ? 'portrait' : 'landscape';
  // Safari before 16.4 has only the legacy angle.
  const angle = (window as { orientation?: number }).orientation;
  if (typeof angle === 'number') return Math.abs(angle) === 90 ? 'landscape' : 'portrait';
  return undefined;
}

const LandscapeAllowance = createContext<() => () => void>(() => () => undefined);

/** Camera screens call this so the app may be used in landscape while they are open. */
export function useAllowLandscape() {
  const register = useContext(LandscapeAllowance);
  useEffect(() => register(), [register]);
}

// Native builds lock portrait in app.json. Browsers, including the installed
// iPhone web app, cannot lock orientation, so cover the app in phone landscape
// instead of showing a broken layout, except on camera screens, which work in
// either orientation. Children stay mounted underneath.
export function PortraitGuard({ children }: { children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  const [landscapeScreens, setLandscapeScreens] = useState(0);
  const register = useCallback(() => {
    setLandscapeScreens((count) => count + 1);
    return () => setLandscapeScreens((count) => count - 1);
  }, []);
  const covered =
    Platform.OS === 'web' &&
    isPhoneLandscape(width, height, heldOrientation()) &&
    landscapeScreens === 0;
  return (
    <LandscapeAllowance.Provider value={register}>
      <View style={styles.root}>
        {children}
        {covered ? (
          <View accessibilityLiveRegion="polite" style={styles.cover} testID="portrait-guard">
            <Text style={styles.title}>Turn your phone upright</Text>
            <Text style={styles.body}>Rewind works in portrait.</Text>
          </View>
        ) : null}
      </View>
    </LandscapeAllowance.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  cover: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    alignItems: 'center',
    backgroundColor: WARM.bg,
    gap: 8,
    justifyContent: 'center',
    padding: 24,
  },
  title: { color: WARM.ink, fontSize: 20, fontWeight: '700' },
  body: { color: WARM.muted, fontSize: 15 },
});
