import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  getRevealEducationCopy,
  type RevealEducationState,
  type RevealEducationSurface,
} from '../domain/reveal-education';
import { COLORS } from '../theme';

export function RevealEducationPanel({
  actionLabel,
  onAction,
  state,
  surface,
  testID,
}: {
  actionLabel?: string;
  onAction: () => void | Promise<void>;
  state: RevealEducationState;
  surface: RevealEducationSurface;
  testID: string;
}) {
  const copy = getRevealEducationCopy(surface, state);
  const label = actionLabel ?? copy.actionLabel;
  const action = (
    <Pressable
      accessibilityHint={`Next action: ${label}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onAction}
      style={styles.action}
    >
      {surface === 'home' && state === 'locked' ? (
        <View
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.cameraIcon}
        >
          <View style={styles.cameraTop} />
          <View style={styles.cameraBody}>
            <View style={styles.cameraLens} />
            <View style={styles.cameraLight} />
          </View>
        </View>
      ) : null}
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
  return (
    <View
      accessible={false}
      accessibilityLabel={`${copy.title}. ${copy.body}`}
      style={[styles.panel, surface === 'home' && styles.homePanel]}
      testID={testID}
    >
      {surface === 'home' ? action : null}
      <Text style={styles.label}>{state === 'released' ? 'RELEASED' : 'REVEAL STATUS'}</Text>
      <Text accessibilityRole="header" style={styles.title}>
        {copy.title}
      </Text>
      <Text accessibilityLiveRegion="polite" style={styles.body}>
        {copy.body}
      </Text>
      {surface !== 'home' ? action : null}
    </View>
  );
}

const styles = StyleSheet.create({
  cameraIcon: { width: 23, height: 21, flexShrink: 0, justifyContent: 'flex-end' },
  cameraTop: {
    position: 'absolute',
    top: 1,
    left: 6,
    width: 11,
    height: 6,
    borderWidth: 1.8,
    borderColor: COLORS.deep,
    borderRadius: 2,
    backgroundColor: COLORS.accent,
  },
  cameraBody: {
    height: 16,
    borderWidth: 1.8,
    borderColor: COLORS.deep,
    borderRadius: 3,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraLens: { width: 9, height: 9, borderWidth: 1.8, borderColor: COLORS.deep, borderRadius: 5 },
  cameraLight: {
    position: 'absolute',
    right: 2,
    top: 2,
    width: 2,
    height: 2,
    borderRadius: 1,
    backgroundColor: COLORS.deep,
  },
  homePanel: { backgroundColor: COLORS.background, borderWidth: 0, padding: 0, gap: 8 },
  panel: {
    backgroundColor: COLORS.deep,
    borderColor: COLORS.edge,
    borderRadius: 10,
    borderWidth: 1,
    gap: 10,
    padding: 16,
  },
  label: { color: COLORS.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  title: { color: COLORS.ink, fontSize: 21, fontWeight: '700' },
  body: { color: COLORS.ink, fontSize: 14, lineHeight: 21 },
  action: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: COLORS.accent,
    borderRadius: 28,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  actionText: {
    color: COLORS.deep,
    fontSize: 14,
    fontWeight: '800',
    flexShrink: 1,
    textAlign: 'center',
  },
});
