import { Pressable, StyleSheet, Text } from 'react-native';

import {
  getRevealEducationCopy,
  type RevealEducationState,
  type RevealEducationSurface,
} from '../domain/reveal-education';
import { Glass } from '../ui/primitives';
import { FONT, WARM } from '../ui/tokens';

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
    <Glass
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
    </Glass>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: WARM.sheet,
    borderColor: WARM.line,
    borderRadius: 24,
    borderWidth: 1,
    gap: 10,
    padding: 16,
  },
  label: {
    color: WARM.dangerInk,
    fontFamily: FONT.body,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  title: { color: WARM.ink, fontFamily: FONT.body, fontSize: 21, fontWeight: '700' },
  body: { color: WARM.ink, fontFamily: FONT.body, fontSize: 14, lineHeight: 21 },
  action: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: WARM.dangerInk,
    borderRadius: 24,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
  },
  actionText: { color: WARM.sheet, fontFamily: FONT.body, fontSize: 14, fontWeight: '800' },
});
