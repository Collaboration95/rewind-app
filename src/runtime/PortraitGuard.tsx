import type { ReactNode } from 'react';
import { Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { COLORS } from '../theme';

// Phones held sideways are shorter than this; tablets and desktops are not.
const PHONE_LANDSCAPE_MAX_HEIGHT = 500;

export function isPhoneLandscape(width: number, height: number): boolean {
  return width > height && height < PHONE_LANDSCAPE_MAX_HEIGHT;
}

// Native builds lock portrait in app.json. Browsers, including the installed
// iPhone web app, cannot lock orientation, so cover the app in phone landscape
// instead of showing a broken layout. Children stay mounted underneath.
export function PortraitGuard({ children }: { children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  const covered = Platform.OS === 'web' && isPhoneLandscape(width, height);
  return (
    <View style={styles.root}>
      {children}
      {covered ? (
        <View accessibilityLiveRegion="polite" style={styles.cover} testID="portrait-guard">
          <Text style={styles.title}>Turn your phone upright</Text>
          <Text style={styles.body}>Rewind works in portrait.</Text>
        </View>
      ) : null}
    </View>
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
    backgroundColor: COLORS.background,
    gap: 8,
    justifyContent: 'center',
    padding: 24,
  },
  title: { color: COLORS.ink, fontSize: 20, fontWeight: '700' },
  body: { color: COLORS.muted, fontSize: 15 },
});
