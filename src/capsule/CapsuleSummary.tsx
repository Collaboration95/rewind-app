import { DarkroomRoll } from './DarkroomRoll';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useCapsule } from './CapsuleProvider';
import { useCycleCountdown } from './cycle-time';
import { RevealEducationPanel } from './RevealEducationPanel';
import type { Cycle } from '../domain/cycles';
import { revealStateForCycle, type RevealEducationState } from '../domain/reveal-education';
import { COLORS } from '../theme';
import {
  ContributionStatusPanel,
  useOptionalContributionStatus,
  type ContributionStatus,
} from '../capture/contribution-status';

export function CapsuleSummary({
  clock = Date.now,
  onAddMoment,
  onOpenArchive,
  revealState,
}: {
  clock?: () => number;
  onAddMoment?: () => void;
  onOpenArchive?: () => void;
  revealState?: RevealEducationState;
}) {
  const { state, retry } = useCapsule();
  const contributionStatus = useOptionalContributionStatus()?.status ?? null;

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
      <View accessible={false} style={styles.statusPanel} testID="capsule-error">
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

  return (
    <ReadyCapsuleSummary
      clock={clock}
      contributionStatus={contributionStatus}
      cycle={state.cycle}
      groupName={state.group.name}
      onAddMoment={onAddMoment}
      onOpenArchive={onOpenArchive}
      revealState={revealState}
    />
  );
}

function ReadyCapsuleSummary({
  clock,
  contributionStatus,
  cycle,
  groupName,
  onAddMoment,
  onOpenArchive,
  revealState: revealStateProp,
}: {
  clock: () => number;
  contributionStatus: ContributionStatus | null;
  cycle: Cycle;
  groupName: string;
  onAddMoment?: () => void;
  onOpenArchive?: () => void;
  revealState?: RevealEducationState;
}) {
  const countdown = useCycleCountdown(cycle, clock);
  const revealState = revealStateProp ?? revealStateForCycle(cycle);

  const { countUsed, secondsUsed } = cycle.contributionUsage;
  const remainingCount = Math.max(0, cycle.quota.maxCount - countUsed);
  const remainingSeconds = Math.max(0, cycle.quota.maxSeconds - secondsUsed);
  const quotaLabel = `${countUsed} of ${cycle.quota.maxCount} contributions used. ${secondsUsed} of ${cycle.quota.maxSeconds} seconds used. ${remainingCount} contributions and ${remainingSeconds} seconds remaining.`;

  return (
    <View style={styles.stack} testID="capsule-ready">
      <View>
        <Text accessibilityRole="header" style={styles.title} testID="group-name">
          {groupName}
        </Text>
        <Text style={styles.mutedText}>
          ● {revealState === 'locked' ? 'COLLECTING · SEALED ROLL' : revealState.toUpperCase()}
        </Text>
      </View>

      <DarkroomRoll
        seconds={revealState === 'locked' ? (countdown?.seconds ?? 0) : 0}
        released={revealState === 'released'}
      />
      {countdown && revealState === 'locked' ? (
        <View
          accessible
          accessibilityLabel={`Current capsule. ${countdown.label}.`}
          style={styles.panel}
          testID="cycle-countdown-panel"
        >
          <Text style={styles.countdown} testID="cycle-countdown">
            {countdown.label}
          </Text>
        </View>
      ) : null}

      <ContributionStatusPanel status={contributionStatus} testID="home-contribution-status" />

      <View
        accessible
        accessibilityLabel={`Current prompt: ${cycle.prompt}`}
        style={styles.panel}
        testID="cycle-prompt"
      >
        <Text style={styles.label}>THIS CYCLE’S PROMPT</Text>
        <Text style={styles.prompt}>{cycle.prompt}</Text>
      </View>

      <View
        accessible
        accessibilityLabel={quotaLabel}
        style={styles.quotaPanel}
        testID="cycle-quota"
      >
        <Text style={styles.label}>YOUR ROLL</Text>
        <Text style={styles.panelTitle}>
          {countUsed} of {cycle.quota.maxCount} contributions
        </Text>
        <Text style={styles.bodyText}>
          {secondsUsed} of {cycle.quota.maxSeconds} seconds used · {remainingCount} contributions
          and {remainingSeconds} seconds remaining
        </Text>
      </View>

      <View accessible={false} style={styles.meter}>
        {Array.from({ length: Math.min(cycle.quota.maxCount, 20) }, (_, i) => (
          <View key={i} style={[styles.meterSegment, i < countUsed && styles.meterUsed]} />
        ))}
      </View>
      <RevealEducationPanel
        actionLabel={revealState === 'locked' ? 'Add to the roll' : 'Open Archive'}
        onAction={
          revealState === 'locked'
            ? (onAddMoment ?? (() => undefined))
            : (onOpenArchive ?? (() => undefined))
        }
        state={revealState}
        surface="home"
        testID={`home-reveal-${revealState}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  meter: { flexDirection: 'row', gap: 5, marginTop: -6 },
  meterSegment: { flex: 1, height: 4, backgroundColor: COLORS.line, borderRadius: 2 },
  meterUsed: { backgroundColor: COLORS.accent },
  stack: { gap: 12 },
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
  title: { color: COLORS.ink, fontSize: 25, fontWeight: '700', marginTop: 6 },
  mutedText: { color: COLORS.accent, fontSize: 11, letterSpacing: 1.5, marginTop: 10 },
  panel: { gap: 8 },
  panelTitle: { color: COLORS.ink, fontSize: 17, fontWeight: '700' },
  countdown: { color: COLORS.accent, fontSize: 12, fontWeight: '700' },
  prompt: { color: COLORS.ink, fontSize: 25, fontWeight: '500', lineHeight: 30 },
  quotaPanel: {
    borderBottomColor: COLORS.line,
    borderBottomWidth: 0,
    borderTopColor: COLORS.line,
    borderTopWidth: 1,
    gap: 8,
    paddingVertical: 10,
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
