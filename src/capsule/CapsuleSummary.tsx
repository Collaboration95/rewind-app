import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useCapsule } from './CapsuleProvider';
import { useCycleCountdown } from './cycle-time';
import type { Cycle } from '../domain/cycles';
import { COLORS } from '../theme';

export function CapsuleSummary({ clock = Date.now }: { clock?: () => number }) {
  const { state, retry } = useCapsule();

  if (state.status === 'loading') {
    return (
      <View accessible style={styles.statusPanel} testID="capsule-loading">
        <Text style={styles.label}>CURRENT CAPSULE</Text>
        <Text accessibilityLiveRegion="polite" style={styles.statusTitle}>
          Loading your group capsule…
        </Text>
        <Text style={styles.bodyText}>Your prompt and allowance will appear here.</Text>
      </View>
    );
  }

  if (state.status === 'denied') {
    return (
      <View accessible style={styles.statusPanel} testID="capsule-denied">
        <Text style={styles.label}>CURRENT CAPSULE</Text>
        <Text style={styles.statusTitle}>Capsule unavailable</Text>
        <Text accessibilityLiveRegion="assertive" style={styles.bodyText}>
          This demo member does not have access to a group capsule.
        </Text>
      </View>
    );
  }

  if (state.status === 'empty') {
    return (
      <View accessible style={styles.statusPanel} testID="capsule-empty">
        <Text style={styles.label}>CURRENT CAPSULE</Text>
        <Text style={styles.statusTitle}>No active capsule</Text>
        <Text accessibilityLiveRegion="polite" style={styles.bodyText}>
          {state.group.name} has no current collection cycle.
        </Text>
      </View>
    );
  }

  if (state.status === 'error') {
    return (
      <View accessible style={styles.statusPanel} testID="capsule-error">
        <Text style={styles.label}>CURRENT CAPSULE</Text>
        <Text style={styles.statusTitle}>Capsule unavailable</Text>
        <Text accessibilityLiveRegion="assertive" style={styles.bodyText}>
          We could not load this capsule. Try again when you are ready.
        </Text>
        <Pressable
          accessibilityHint="Loads the current group capsule again"
          accessibilityRole="button"
          onPress={retry}
          style={styles.retryButton}
        >
          <Text style={styles.retryButtonText}>Retry loading capsule</Text>
        </Pressable>
      </View>
    );
  }

  return <ReadyCapsuleSummary clock={clock} cycle={state.cycle} groupName={state.group.name} />;
}

function ReadyCapsuleSummary({
  clock,
  cycle,
  groupName,
}: {
  clock: () => number;
  cycle: Cycle;
  groupName: string;
}) {
  const countdown = useCycleCountdown(cycle, clock);
  if (!countdown) return null;

  const { countUsed, secondsUsed } = cycle.contributionUsage;
  const remainingCount = Math.max(0, cycle.quota.maxCount - countUsed);
  const remainingSeconds = Math.max(0, cycle.quota.maxSeconds - secondsUsed);
  const quotaLabel = `${countUsed} of ${cycle.quota.maxCount} contributions used. ${secondsUsed} of ${cycle.quota.maxSeconds} seconds used. ${remainingCount} contributions and ${remainingSeconds} seconds remaining.`;

  return (
    <View style={styles.stack} testID="capsule-ready">
      <View>
        <Text style={styles.label}>HOME</Text>
        <Text accessibilityRole="header" style={styles.title} testID="group-name">
          {groupName}
        </Text>
        <Text style={styles.mutedText}>Shared capsule · Sample group</Text>
      </View>

      <View
        accessible
        accessibilityLabel={`Current capsule. ${countdown.label}.`}
        style={styles.panel}
        testID="cycle-countdown-panel"
      >
        <Text style={styles.label}>CURRENT CAPSULE</Text>
        <Text style={styles.panelTitle}>Collection is open</Text>
        <Text accessibilityLiveRegion="polite" style={styles.countdown} testID="cycle-countdown">
          {countdown.label}
        </Text>
      </View>

      <View
        accessible
        accessibilityLabel={`Current prompt: ${cycle.prompt}`}
        style={styles.panel}
        testID="cycle-prompt"
      >
        <Text style={styles.label}>THIS CYCLE</Text>
        <Text style={styles.prompt}>{cycle.prompt}</Text>
      </View>

      <View
        accessible
        accessibilityLabel={quotaLabel}
        style={styles.quotaPanel}
        testID="cycle-quota"
      >
        <Text style={styles.label}>MY ALLOWANCE</Text>
        <Text style={styles.panelTitle}>
          {countUsed} of {cycle.quota.maxCount} contributions
        </Text>
        <Text style={styles.bodyText}>
          {secondsUsed} of {cycle.quota.maxSeconds} seconds used · {remainingCount} contributions
          and {remainingSeconds} seconds remaining
        </Text>
      </View>

      <View
        accessible
        accessibilityLabel="Contributions are collecting and locked. Unrevealed media and sharing are unavailable."
        style={styles.lockedPanel}
        testID="locked-state"
      >
        <Text style={styles.lockedLabel}>SEALED UNTIL REVEAL</Text>
        <Text style={styles.bodyText}>
          Contributions are locked while this cycle collects. Unrevealed media and sharing are
          unavailable.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 18 },
  statusPanel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
    minHeight: 142,
    padding: 16,
  },
  statusTitle: { color: COLORS.ink, fontSize: 22, fontWeight: '700' },
  retryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: COLORS.background,
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  retryButtonText: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  label: { color: COLORS.edge, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  title: { color: COLORS.ink, fontSize: 30, fontWeight: '700', marginTop: 6 },
  mutedText: { color: COLORS.muted, fontSize: 14, marginTop: 4 },
  panel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  panelTitle: { color: COLORS.ink, fontSize: 22, fontWeight: '700' },
  countdown: { color: COLORS.accent, fontSize: 18, fontWeight: '700' },
  prompt: { color: COLORS.ink, fontSize: 18, fontWeight: '600', lineHeight: 24 },
  quotaPanel: {
    borderBottomColor: COLORS.line,
    borderBottomWidth: 1,
    borderTopColor: COLORS.line,
    borderTopWidth: 1,
    gap: 8,
    paddingVertical: 14,
  },
  lockedPanel: {
    backgroundColor: COLORS.deep,
    borderColor: COLORS.edge,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  lockedLabel: { color: COLORS.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  bodyText: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
});
