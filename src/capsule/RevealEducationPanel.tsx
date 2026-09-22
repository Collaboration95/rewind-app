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
  return (
    <View
      accessible={false}
      accessibilityLabel={`${copy.title}. ${copy.body}`}
      style={styles.panel}
      testID={testID}
    >
      <Text style={styles.label}>{state === 'released' ? 'RELEASED' : 'REVEAL STATUS'}</Text>
      <Text accessibilityRole="header" style={styles.title}>
        {copy.title}
      </Text>
      <Text accessibilityLiveRegion="polite" style={styles.body}>
        {copy.body}
      </Text>
      <Pressable
        accessibilityHint={`Next action: ${label}`}
        accessibilityRole="button"
        onPress={onAction}
        style={styles.action}
      >
        <Text style={styles.actionText}>{label}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: COLORS.deep,
    borderColor: COLORS.edge,
    borderRadius: 10,
    borderWidth: 1,
    gap: 10,
    padding: 16,
  },
  label: { color: COLORS.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  title: { color: COLORS.paper, fontSize: 21, fontWeight: '700' },
  body: { color: COLORS.paper, fontSize: 14, lineHeight: 21 },
  action: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
  },
  actionText: { color: COLORS.deep, fontSize: 14, fontWeight: '800' },
});
