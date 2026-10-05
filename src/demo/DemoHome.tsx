import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useCapsule } from '../capsule/CapsuleProvider';
import { useCycleCountdown } from '../capsule/cycle-time';
import { RevealEducationPanel } from '../capsule/RevealEducationPanel';
import {
  ContributionStatusPanel,
  useOptionalContributionStatus,
  type ContributionStatus,
} from '../capture/contribution-status';
import type { ContributionLedgerView } from '../contributions/ContributionLedger';
import { ContributionLedgerSection } from '../contributions/ContributionLedgerSection';
import type { Cycle } from '../domain/cycles';
import { revealStateForCycle, type RevealEducationState } from '../domain/reveal-education';
import { HomeBody } from '../real/Home';
import { cycleWeek, filmCountdown, momentDay } from '../real/home-model';
import { weekMoments } from '../real/Moments';
import type { RuntimeClient } from '../runtime/local-runtime-client';
import { useDemoSession } from '../session/DemoSessionProvider';
import { Button, Glass } from '../ui/primitives';
import { FONT, WARM } from '../ui/tokens';

export function DemoHome({
  clock = Date.now,
  onAddMoment,
  onOpenMoments,
  onOpenArchive,
  revealState,
  runtimeClient,
}: {
  clock?: () => number;
  runtimeClient?: RuntimeClient | null;
  onAddMoment?: () => void;
  onOpenMoments?: () => void;
  onOpenArchive?: () => void;
  revealState?: RevealEducationState;
}) {
  const { state, retry } = useCapsule();
  const contributionStatus = useOptionalContributionStatus()?.status ?? null;

  if (state.status === 'loading') {
    return (
      <Glass accessible style={styles.statusPanel} testID="capsule-loading">
        <Text style={styles.label}>CURRENT CAPSULE</Text>
        <Text accessibilityLiveRegion="polite" style={styles.statusTitle}>
          Loading your group capsule…
        </Text>
        <Text style={styles.bodyText}>Your prompt and allowance will appear here.</Text>
      </Glass>
    );
  }

  if (state.status === 'denied') {
    return (
      <Glass accessible style={styles.statusPanel} testID="capsule-denied">
        <Text style={styles.label}>CURRENT CAPSULE</Text>
        <Text style={styles.statusTitle}>Capsule unavailable</Text>
        <Text accessibilityLiveRegion="assertive" style={styles.bodyText}>
          This group capsule is unavailable. Check your group access in Settings.
        </Text>
      </Glass>
    );
  }

  if (state.status === 'empty') {
    return (
      <Glass accessible style={styles.statusPanel} testID="capsule-empty">
        <Text style={styles.label}>CURRENT CAPSULE</Text>
        <Text style={styles.statusTitle}>No active capsule</Text>
        <Text accessibilityLiveRegion="polite" style={styles.bodyText}>
          {state.group.name} has no current collection cycle.
        </Text>
      </Glass>
    );
  }

  if (state.status === 'error') {
    return (
      <Glass accessible={false} style={styles.statusPanel} testID="capsule-error">
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
      </Glass>
    );
  }

  return (
    <ReadyDemoHome
      clock={clock}
      runtimeClient={runtimeClient}
      contributionStatus={contributionStatus}
      cycle={state.cycle}
      onAddMoment={onAddMoment}
      onOpenMoments={onOpenMoments}
      onOpenArchive={onOpenArchive}
      revealState={revealState}
    />
  );
}

function ReadyDemoHome({
  clock,
  contributionStatus,
  cycle,
  onAddMoment,
  onOpenMoments,
  onOpenArchive,
  revealState: revealStateProp,
  runtimeClient,
}: {
  clock: () => number;
  runtimeClient?: RuntimeClient | null;
  contributionStatus: ContributionStatus | null;
  cycle: Cycle;
  onAddMoment?: () => void;
  onOpenMoments?: () => void;
  onOpenArchive?: () => void;
  revealState?: RevealEducationState;
}) {
  const { session } = useDemoSession();
  const countdown = useCycleCountdown(cycle, clock);
  const revealState = revealStateProp ?? revealStateForCycle(cycle);

  const body = (view?: ContributionLedgerView, retry?: () => void) => {
    const page = view?.status === 'ready' ? view.page : null;
    const allowance = page?.allowance ?? cycle.contributionUsage;
    const { countUsed, secondsUsed } = allowance;
    const remainingCount = Math.max(0, cycle.quota.maxCount - countUsed);
    const remainingSeconds = Math.max(0, cycle.quota.maxSeconds - secondsUsed);
    const quotaLabel = `${countUsed} of ${cycle.quota.maxCount} contributions used. ${secondsUsed} of ${cycle.quota.maxSeconds} seconds used. ${remainingCount} contributions and ${remainingSeconds} seconds remaining.`;

    return (
      <View style={styles.stack} testID="capsule-ready">
        <View testID={view ? `contribution-ledger-${view.status}` : undefined}>
          <View accessibilityLabel={`Current prompt: ${cycle.prompt}`}>
            <View accessibilityLabel={quotaLabel}>
              <HomeBody
                header={null}
                countdown={filmCountdown(cycle.endsAt, clock())}
                week={cycleWeek(cycle, clock()).week}
                resetDays={cycleWeek(cycle, clock()).resetDays}
                prompt={cycle.prompt}
                countUsed={view?.status === 'loading' ? null : countUsed}
                secondsUsed={view?.status === 'loading' ? null : secondsUsed}
                maxCount={cycle.quota.maxCount}
                maxSeconds={cycle.quota.maxSeconds}
                moments={
                  page
                    ? weekMoments(page, cycleWeek(cycle, clock()).windowStart).map((entry) => ({
                        id: entry.contributionId,
                        mediaType: entry.mediaType,
                        seconds: Math.round(entry.durationSeconds),
                        day: momentDay(entry.createdAt, clock()),
                        failed: entry.state === 'failed',
                      }))
                    : []
                }
                cards={[]}
                premiereLeft={null}
                onOpenMoments={onOpenMoments ?? (() => undefined)}
                onWatch={onOpenArchive ?? (() => undefined)}
                onRetryFailed={onOpenMoments ?? (() => undefined)}
              />
            </View>
          </View>
        </View>
        {view?.status === 'error' || view?.status === 'denied' ? (
          <Glass style={styles.statusPanel}>
            <Text style={styles.bodyText}>
              {view.status === 'denied'
                ? 'Contributions unavailable for this Demo group.'
                : 'Contributions could not be loaded.'}
            </Text>
            {retry ? <Button label="Retry loading contributions" onPress={retry} /> : null}
          </Glass>
        ) : null}
        {countdown ? (
          <Text
            accessibilityLiveRegion="polite"
            style={styles.mutedText}
            accessibilityLabel={`Current capsule. ${countdown.label}.`}
            testID="cycle-countdown"
          >
            {countdown.label}
          </Text>
        ) : null}
        <ContributionStatusPanel status={contributionStatus} testID="home-contribution-status" />

        <RevealEducationPanel
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
  };
  return runtimeClient?.getContributionLedger && session ? (
    <ContributionLedgerSection
      client={runtimeClient}
      sessionId={session.id}
      groupId={cycle.groupId}
      memberId={session.actor.memberId}
      cycleId={cycle.id}
      render={body}
    />
  ) : (
    body()
  );
}

const styles = StyleSheet.create({
  stack: { gap: 18 },
  statusPanel: {
    backgroundColor: WARM.sheet,
    borderColor: WARM.line,
    borderRadius: 24,
    borderWidth: 1,
    gap: 8,
    minHeight: 142,
    padding: 16,
  },
  statusTitle: { color: WARM.ink, fontFamily: FONT.body, fontSize: 22, fontWeight: '700' },
  retryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: WARM.bg,
    borderColor: WARM.line,
    borderRadius: 24,
    borderWidth: 1,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  retryButtonText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 14, fontWeight: '700' },
  label: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  mutedText: { color: WARM.muted, fontFamily: FONT.body, fontSize: 14, marginTop: 4 },
  bodyText: { color: WARM.muted, fontFamily: FONT.body, fontSize: 14, lineHeight: 21 },
});
