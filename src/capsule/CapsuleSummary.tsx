import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useCapsule, type CapsuleState } from './CapsuleProvider';
import { getRemainingSeconds, useCycleCountdown } from './cycle-time';
import { RevealEducationPanel } from './RevealEducationPanel';
import type { Cycle } from '../domain/cycles';
import { revealStateForCycle, type RevealEducationState } from '../domain/reveal-education';
import { useI18n } from '../i18n/LanguageProvider';
import { COLORS } from '../theme';
import { ActionButton, Eyebrow, Panel, Quiet, ScreenIntro, Stats } from '../ui/kit';
import {
  ContributionStatusPanel,
  useOptionalContributionStatus,
  type ContributionStatus,
} from '../capture/contribution-status';

export type HomeDebugScenario =
  'loading' | 'empty' | 'denied' | 'error' | 'processing' | 'delayed' | 'released' | 'quota';

type Translate = ReturnType<typeof useI18n>['t'];

/** Labelled design fixture used only when debug forces a ready-only state. */
const FIXTURE_CYCLE: Cycle = {
  id: 'debug-fixture-cycle',
  groupId: 'debug-fixture-group',
  prompt: 'What made you pause and smile?',
  startsAt: '2026-09-27T00:00:00.000Z',
  endsAt: '2099-01-01T00:00:00.000Z',
  status: 'collecting',
  lockState: 'locked',
  quota: { maxCount: 5, maxSeconds: 30 },
  contributionUsage: { countUsed: 0, secondsUsed: 0 },
};

export function formatCollectionTime(seconds: number, t: Translate): string {
  if (seconds <= 0) return t('Cycle ended');
  const units = [
    { amount: 24 * 60 * 60, one: '{count} day', many: '{count} days' },
    { amount: 60 * 60, one: '{count} hour', many: '{count} hours' },
    { amount: 60, one: '{count} minute', many: '{count} minutes' },
    { amount: 1, one: '{count} second', many: '{count} seconds' },
  ];
  const unit = units.find(({ amount }) => seconds >= amount) ?? units[units.length - 1];
  const count = Math.ceil(seconds / unit.amount);
  return t(count === 1 ? unit.one : unit.many, { count });
}

function forcedCapsuleState(real: CapsuleState, scenario: HomeDebugScenario | null): CapsuleState {
  const fixtureGroup = {
    id: 'debug-fixture-group',
    name: 'Weekend People',
    memberIds: ['demo-1', 'demo-2', 'demo-3', 'demo-4', 'demo-5'],
    currentCycleId: FIXTURE_CYCLE.id,
  };
  switch (scenario) {
    case 'loading':
      return { status: 'loading', group: null, cycle: null };
    case 'denied':
      return { status: 'denied', group: null, cycle: null };
    case 'error':
      return { status: 'error', group: real.group, cycle: null };
    case 'empty':
      return { status: 'empty', group: real.group ?? fixtureGroup, cycle: null };
    case 'processing':
    case 'delayed':
    case 'released':
    case 'quota': {
      const ready =
        real.status === 'ready'
          ? real
          : { status: 'ready' as const, group: fixtureGroup, cycle: FIXTURE_CYCLE };
      if (scenario !== 'quota') return ready;
      return {
        ...ready,
        cycle: {
          ...ready.cycle,
          contributionUsage: {
            countUsed: ready.cycle.quota.maxCount,
            secondsUsed: ready.cycle.quota.maxSeconds,
          },
        },
      };
    }
    default:
      return real;
  }
}

/**
 * Concept A Home: the prompt, the member's allowance, and the next action sit
 * in one working card; contribution and reveal status follow below it.
 */
export function CapsuleSummary({
  afterContribution,
  clock = Date.now,
  contributionStatusOverride,
  debugScenario = null,
  onAddMoment,
  onOpenArchive,
  onOpenSettings,
  revealState,
}: {
  afterContribution?: ReactNode;
  clock?: () => number;
  contributionStatusOverride?: ContributionStatus | null;
  debugScenario?: HomeDebugScenario | null;
  onAddMoment?: () => void;
  onOpenArchive?: () => void;
  onOpenSettings?: () => void;
  revealState?: RevealEducationState;
}) {
  const { t } = useI18n();
  const { state: realState, retry } = useCapsule();
  const realContribution = useOptionalContributionStatus()?.status ?? null;
  const contributionStatus =
    contributionStatusOverride === undefined ? realContribution : contributionStatusOverride;
  const state = forcedCapsuleState(realState, debugScenario);
  const forcedReveal =
    debugScenario === 'processing' || debugScenario === 'delayed' || debugScenario === 'released'
      ? debugScenario
      : undefined;

  // One persistent heading keeps web focus stable while the capsule loads.
  const ready = state.status === 'ready';
  const frame = (content: ReactNode) => (
    <View style={styles.stack}>
      <ScreenIntro
        eyebrow={ready ? t('THIS CYCLE') : t('HOME')}
        headingTestID="route-heading-home"
        title={ready ? t('Make a little room for today.') : t('Your current cycle')}
      />
      {content}
    </View>
  );

  if (state.status === 'loading') {
    return frame(
      <Panel
        accessibilityLabel={t('Loading your group capsule…')}
        live="polite"
        body={t('Your prompt and allowance will appear here.')}
        style={styles.statusPanel}
        testID="capsule-loading"
        title={t('Loading your group capsule…')}
      />,
    );
  }

  if (state.status === 'denied') {
    return frame(
      <Panel
        live="assertive"
        body={t('This member cannot access the group.')}
        style={styles.statusPanel}
        testID="capsule-denied"
        title={t('Access unavailable')}
      >
        {onOpenSettings ? (
          <ActionButton label={t('Open Settings')} onPress={onOpenSettings} />
        ) : null}
      </Panel>,
    );
  }

  if (state.status === 'empty') {
    return frame(
      <Panel
        live="polite"
        body={t('{group} has no current collection cycle.', { group: state.group.name })}
        style={styles.statusPanel}
        testID="capsule-empty"
        title={t('No active capsule')}
      >
        {onOpenSettings ? (
          <ActionButton label={t('Open Settings')} onPress={onOpenSettings} />
        ) : null}
      </Panel>,
    );
  }

  if (state.status === 'error') {
    return frame(
      <View accessible={false} style={styles.errorPanel} testID="capsule-error">
        <Text style={styles.statusTitle}>{t('Could not load your capsule')}</Text>
        <Text accessibilityLiveRegion="assertive" style={styles.bodyText}>
          {t('Connection unavailable. Try again.')}
        </Text>
        <ActionButton
          accessibilityHint={t('Loads the current group capsule again')}
          label={t('Retry loading capsule')}
          onPress={retry}
        />
      </View>,
    );
  }

  return frame(
    <ReadyCapsuleSummary
      afterContribution={afterContribution}
      clock={clock}
      contributionStatus={contributionStatus}
      cycle={state.cycle}
      groupName={state.group.name}
      memberCount={state.group.memberIds.length}
      onAddMoment={onAddMoment}
      onOpenArchive={onOpenArchive}
      revealState={forcedReveal ?? revealState}
    />,
  );
}

function ReadyCapsuleSummary({
  afterContribution,
  clock,
  contributionStatus,
  cycle,
  groupName,
  memberCount,
  onAddMoment,
  onOpenArchive,
  revealState: revealStateProp,
}: {
  afterContribution?: ReactNode;
  clock: () => number;
  contributionStatus: ContributionStatus | null;
  cycle: Cycle;
  groupName: string;
  memberCount: number;
  onAddMoment?: () => void;
  onOpenArchive?: () => void;
  revealState?: RevealEducationState;
}) {
  const { t } = useI18n();
  const countdown = useCycleCountdown(cycle, clock);
  const revealState = revealStateProp ?? revealStateForCycle(cycle);

  const { countUsed, secondsUsed } = cycle.contributionUsage;
  const remainingCount = Math.max(0, cycle.quota.maxCount - countUsed);
  const remainingSeconds = Math.max(0, cycle.quota.maxSeconds - secondsUsed);
  const allowanceUsed = remainingCount === 0 || remainingSeconds === 0;
  const collectionSeconds = countdown?.seconds ?? getRemainingSeconds(cycle, clock());
  const collectionTime = formatCollectionTime(collectionSeconds, t);
  const quotaLabel = t(
    '{used} of {max} contributions used. {secondsUsed} of {maxSeconds} seconds used. {count} contributions and {seconds} seconds remaining.',
    {
      count: remainingCount,
      max: cycle.quota.maxCount,
      maxSeconds: cycle.quota.maxSeconds,
      seconds: remainingSeconds,
      secondsUsed,
      used: countUsed,
    },
  );
  const filmAction =
    revealState === 'released' ? (
      <ActionButton
        full
        label={t('Watch group film')}
        onPress={onOpenArchive}
        testID="home-primary-action"
        variant="primary"
      />
    ) : revealState === 'processing' || revealState === 'delayed' ? (
      <ActionButton
        full
        label={t('Check Archive')}
        onPress={onOpenArchive}
        testID="home-primary-action"
        variant="primary"
      />
    ) : (
      <ActionButton
        accessibilityHint={t('Opens Camera to add a still or a clip')}
        disabled={allowanceUsed}
        full
        label={t('Add a moment')}
        onPress={onAddMoment}
        testID="home-primary-action"
        variant="primary"
      />
    );

  return (
    <View style={styles.stack} testID="capsule-ready">
      <View style={styles.workCard}>
        <Eyebrow>{t('CURRENT PROMPT')}</Eyebrow>
        <Text
          accessibilityLabel={t('Current prompt: {prompt}', { prompt: t(cycle.prompt) })}
          style={styles.prompt}
          testID="cycle-prompt"
        >
          {t(cycle.prompt)}
        </Text>
        <Stats
          accessibilityLabel={`${quotaLabel} ${t('Collection time left: {time}.', { time: collectionTime })}`}
          items={[
            {
              caption: t('{seconds} seconds remaining', { seconds: remainingSeconds }),
              value: t('{count} contributions', { count: remainingCount }),
            },
            {
              caption: t('collection time left'),
              testID: 'cycle-countdown',
              value: collectionTime,
            },
          ]}
          testID="cycle-quota"
        />
        {filmAction}
        {allowanceUsed && revealState === 'locked' ? (
          <Quiet testID="home-allowance-used">{t('Allowance used. Chat remains available.')}</Quiet>
        ) : null}
      </View>

      <Quiet>
        {t(memberCount === 1 ? '{group} · {count} member' : '{group} · {count} members', {
          count: memberCount,
          group: groupName,
        })}
      </Quiet>

      <ContributionStatusPanel status={contributionStatus} testID="home-contribution-status" />
      {afterContribution}

      <RevealEducationPanel
        onAction={onOpenArchive ?? (() => undefined)}
        state={revealState}
        surface="home"
        testID={`home-reveal-${revealState}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 16 },
  statusPanel: { minHeight: 142 },
  errorPanel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.accent,
    borderLeftWidth: 3,
    borderRadius: 9,
    borderWidth: 1,
    gap: 10,
    minHeight: 142,
    padding: 17,
  },
  statusTitle: { color: COLORS.ink, fontSize: 19, fontWeight: '700' },
  bodyText: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  workCard: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 9,
    borderWidth: 1,
    gap: 12,
    padding: 17,
  },
  prompt: { color: COLORS.ink, fontSize: 19, fontWeight: '700', lineHeight: 26 },
});
