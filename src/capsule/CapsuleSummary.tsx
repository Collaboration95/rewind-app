import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { useCapsule, type CapsuleState } from './CapsuleProvider';
import { getRemainingSeconds, useCycleCountdown } from './cycle-time';
import { demoRepository } from '../data/demo-repository';
import type { Cycle } from '../domain/cycles';
import {
  getRevealEducationCopy,
  revealStateForCycle,
  type RevealEducationState,
} from '../domain/reveal-education';
import { useI18n } from '../i18n/LanguageProvider';
import { COLORS, FONTS } from '../theme';
import { ActionButton, Eyebrow, Panel, Quiet } from '../ui/kit';
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
  const { language, t } = useI18n();
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
      <View style={styles.intro}>
        {ready ? null : <Eyebrow>{t('HOME')}</Eyebrow>}
        <Text
          accessibilityRole="header"
          style={[styles.heading, language === 'zh' && styles.headingZh]}
          testID="route-heading-home"
        >
          {ready ? t('Make a little room for today.') : t('Your current cycle')}
        </Text>
      </View>
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
      memberIds={state.group.memberIds}
      onAddMoment={onAddMoment}
      onOpenArchive={onOpenArchive}
      revealState={forcedReveal ?? revealState}
    />,
  );
}

function Sprockets() {
  return (
    <View style={styles.sprockets}>
      {Array.from({ length: 16 }, (_, index) => (
        <View key={index} style={styles.sprocket} />
      ))}
    </View>
  );
}

const MEMBER_TONES = ['#6B4F3A', '#44524C', '#58465A', '#7A5B3C', '#3F4A5C', '#5E4B44'];
const PROFILE_LABELS = new Map(
  demoRepository.listProfiles().map((profile) => [profile.id, profile.avatarLabel]),
);

const STATUS_WORD: Record<RevealEducationState, string> = {
  delayed: 'DELAYED',
  locked: 'SEALED',
  processing: 'DEVELOPING',
  released: 'RELEASED',
};

/** Negative tones for the illustrative print; no group media is ever shown. */
const EXPOSURE: Record<RevealEducationState, readonly [string, string, string]> = {
  delayed: ['#231F1D', '#171413', '#2A201B'],
  locked: ['#2A221D', '#161312', '#3B2518'],
  processing: ['#2E2620', '#1A1614', '#4A2D1C'],
  released: ['#4A3526', '#2B211B', '#8A5634'],
};

function ReadyCapsuleSummary({
  afterContribution,
  clock,
  contributionStatus,
  cycle,
  groupName,
  memberIds,
  onAddMoment,
  onOpenArchive,
  revealState: revealStateProp,
}: {
  afterContribution?: ReactNode;
  clock: () => number;
  contributionStatus: ContributionStatus | null;
  cycle: Cycle;
  groupName: string;
  memberIds: string[];
  onAddMoment?: () => void;
  onOpenArchive?: () => void;
  revealState?: RevealEducationState;
}) {
  const { t } = useI18n();
  const countdown = useCycleCountdown(cycle, clock);
  const revealState = revealStateProp ?? revealStateForCycle(cycle);
  const copy = getRevealEducationCopy('home', revealState);
  const memberCount = memberIds.length;

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
  const collecting = revealState === 'locked';
  const action =
    revealState === 'released'
      ? { glyph: 'play' as const, label: t('Watch group film'), onPress: onOpenArchive }
      : revealState === 'processing' || revealState === 'delayed'
        ? { glyph: 'none' as const, label: t('Check Archive'), onPress: onOpenArchive }
        : { glyph: 'record' as const, label: t('Add a moment'), onPress: onAddMoment };
  const actionDisabled = collecting && allowanceUsed;

  return (
    <View style={styles.readyStack} testID="capsule-ready">
      {/* The sealed print: the prompt is the photograph nobody has seen yet. */}
      <View style={styles.printStage}>
        <View aria-hidden style={[styles.backPrint, styles.backPrintFar]} />
        <View aria-hidden style={[styles.backPrint, styles.backPrintNear]} />
        <View style={styles.print}>
          <LinearGradient
            colors={EXPOSURE[revealState]}
            end={{ x: 0.85, y: 1 }}
            start={{ x: 0.15, y: 0 }}
            style={styles.exposure}
          >
            <View aria-hidden pointerEvents="none" style={styles.glowAnchor}>
              {GLOW_SIZES.map((size) => (
                <View
                  key={size}
                  style={[
                    styles.glowRing,
                    {
                      borderRadius: size / 2,
                      height: size,
                      marginLeft: -size / 2,
                      marginTop: -size / 2,
                      width: size,
                    },
                  ]}
                />
              ))}
            </View>
            <View style={styles.exposureTop}>
              <Text style={styles.exposureLabel}>{t('CURRENT PROMPT')}</Text>
              <View style={styles.statusPill}>
                <View
                  style={[styles.statusDot, revealState === 'released' && styles.statusDotLive]}
                />
                <Text style={styles.statusText}>{t(STATUS_WORD[revealState])}</Text>
              </View>
            </View>
            <Text
              accessibilityLabel={t('Current prompt: {prompt}', { prompt: t(cycle.prompt) })}
              style={styles.prompt}
              testID="cycle-prompt"
            >
              {t(cycle.prompt)}
            </Text>
          </LinearGradient>

          <View style={styles.chin}>
            <View
              accessible
              accessibilityLabel={`${t(copy.title)}. ${t(copy.body)}`}
              style={styles.chinCopy}
              testID={`home-reveal-${revealState}`}
            >
              <Text style={styles.chinTitle}>{t(copy.title)}</Text>
              <Text style={styles.chinBody}>{t(copy.body)}</Text>
            </View>
            {collecting ? (
              <View
                accessible
                accessibilityLabel={t('Collection time left: {time}.', { time: collectionTime })}
                style={styles.chinTime}
              >
                <Text style={styles.chinTimeValue} testID="cycle-countdown">
                  {collectionTime}
                </Text>
                <Text style={styles.chinTimeCaption}>{t('collection time left')}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>

      {/* The roll: one frame per allowed contribution. */}
      <View accessible accessibilityLabel={quotaLabel} style={styles.roll} testID="cycle-quota">
        <View style={styles.rollHead}>
          <Text style={styles.rollLabel}>{t('YOUR ROLL')}</Text>
          <Text style={styles.rollFigures}>
            <Text style={styles.rollFigureStrong}>
              {t('{count} of {max} left', { count: remainingCount, max: cycle.quota.maxCount })}
            </Text>
            {'   '}
            {t('{seconds}s of {max}s', { max: cycle.quota.maxSeconds, seconds: remainingSeconds })}
          </Text>
        </View>
        <View aria-hidden style={styles.strip}>
          <Sprockets />
          <View style={styles.frames}>
            {Array.from({ length: cycle.quota.maxCount }, (_, index) => (
              <View key={index} style={[styles.frame, index < countUsed && styles.frameUsed]}>
                <Text style={[styles.frameNumber, index < countUsed && styles.frameNumberUsed]}>
                  {String(index + 1).padStart(2, '0')}
                </Text>
              </View>
            ))}
          </View>
          <Sprockets />
        </View>
      </View>

      <View style={styles.actionBlock}>
        <Pressable
          accessibilityHint={collecting ? t('Opens Camera to add a still or a clip') : undefined}
          accessibilityRole="button"
          accessibilityState={{ disabled: actionDisabled }}
          disabled={actionDisabled}
          onPress={action.onPress}
          style={({ pressed }) => [
            styles.action,
            actionDisabled && styles.actionDisabled,
            pressed && !actionDisabled && styles.actionPressed,
          ]}
          testID="home-primary-action"
        >
          {action.glyph === 'record' ? (
            <View aria-hidden style={[styles.recordRing, actionDisabled && styles.glyphDisabled]}>
              <View style={[styles.recordDot, actionDisabled && styles.glyphFillDisabled]} />
            </View>
          ) : action.glyph === 'play' ? (
            <View aria-hidden style={styles.playGlyph} />
          ) : null}
          <Text style={[styles.actionLabel, actionDisabled && styles.actionLabelDisabled]}>
            {action.label}
          </Text>
        </Pressable>
        {actionDisabled ? (
          <Quiet testID="home-allowance-used">{t('Allowance used. Chat remains available.')}</Quiet>
        ) : collecting ? (
          <Text style={styles.actionHint}>
            {t('Photos stay on this device. Submitted clips stay sealed until reveal.')}
          </Text>
        ) : null}
      </View>

      <View style={styles.groupRow}>
        <View aria-hidden style={styles.avatars}>
          {memberIds.slice(0, 5).map((id, index) => (
            <View
              key={id}
              style={[
                styles.memberAvatar,
                { backgroundColor: MEMBER_TONES[index % MEMBER_TONES.length], zIndex: 10 - index },
                index > 0 && styles.memberAvatarOverlap,
              ]}
            >
              <Text style={styles.memberInitial}>
                {(PROFILE_LABELS.get(id) ?? id).slice(0, 1).toUpperCase()}
              </Text>
            </View>
          ))}
        </View>
        <Text accessibilityRole="header" style={styles.groupText}>
          {t(memberCount === 1 ? '{group} · {count} member' : '{group} · {count} members', {
            count: memberCount,
            group: groupName,
          })}
        </Text>
      </View>

      <ContributionStatusPanel status={contributionStatus} testID="home-contribution-status" />
      {afterContribution}
    </View>
  );
}

const IVORY = '#F6EEE1';
const GLOW_SIZES = Array.from({ length: 18 }, (_, index) => 320 - index * 16);

const styles = StyleSheet.create({
  stack: { gap: 22 },
  intro: { gap: 6 },
  heading: {
    color: COLORS.ink,
    fontFamily: FONTS.display,
    fontSize: 40,
    letterSpacing: -0.6,
    lineHeight: 44,
    maxWidth: 262,
  },
  headingZh: { fontSize: 32, letterSpacing: 1, lineHeight: 42, maxWidth: '100%' },
  statusPanel: { minHeight: 142 },
  errorPanel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.accent,
    borderLeftWidth: 3,
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
    minHeight: 142,
    padding: 17,
  },
  statusTitle: { color: COLORS.ink, fontSize: 19, fontWeight: '700' },
  bodyText: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  readyStack: { gap: 22 },

  printStage: { paddingBottom: 6, paddingHorizontal: 6, paddingTop: 10 },
  backPrint: {
    backgroundColor: '#CFC5B4',
    borderRadius: 3,
    bottom: 8,
    left: 14,
    position: 'absolute',
    right: 14,
    top: 6,
  },
  backPrintFar: { backgroundColor: '#5E574D', opacity: 0.6, transform: [{ rotate: '4deg' }] },
  backPrintNear: { backgroundColor: '#9C9383', opacity: 0.75, transform: [{ rotate: '-3.2deg' }] },
  print: {
    backgroundColor: COLORS.print,
    borderRadius: 3,
    elevation: 14,
    padding: 11,
    paddingBottom: 0,
    shadowColor: '#000000',
    shadowOffset: { height: 18, width: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 28,
    transform: [{ rotate: '-1deg' }],
  },
  exposure: {
    borderRadius: 1.5,
    gap: 28,
    justifyContent: 'space-between',
    minHeight: 210,
    overflow: 'hidden',
    padding: 18,
    paddingBottom: 20,
  },
  glowAnchor: { bottom: 18, position: 'absolute', right: 30 },
  glowRing: { backgroundColor: '#E08A4E', opacity: 0.032, position: 'absolute' },
  exposureTop: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  exposureLabel: {
    color: 'rgba(246, 238, 225, 0.62)',
    fontFamily: FONTS.sansSemiBold,
    fontSize: 10,
    letterSpacing: 1.8,
  },
  statusPill: {
    alignItems: 'center',
    borderColor: 'rgba(246, 238, 225, 0.28)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  statusDot: { backgroundColor: COLORS.accent, borderRadius: 3, height: 5, width: 5 },
  statusDotLive: { backgroundColor: '#9FD3A8' },
  statusText: {
    color: 'rgba(246, 238, 225, 0.82)',
    fontFamily: FONTS.sansSemiBold,
    fontSize: 9.5,
    letterSpacing: 1.6,
  },
  prompt: {
    color: IVORY,
    fontFamily: FONTS.display,
    fontSize: 33,
    letterSpacing: -0.3,
    lineHeight: 37,
    maxWidth: 290,
  },
  chin: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 14,
    justifyContent: 'space-between',
    minHeight: 78,
    paddingBottom: 16,
    paddingHorizontal: 5,
    paddingTop: 14,
  },
  chinCopy: { flex: 1, gap: 3 },
  chinTitle: {
    color: COLORS.printInk,
    fontFamily: FONTS.displayItalic,
    fontSize: 21,
    lineHeight: 24,
  },
  chinBody: { color: COLORS.printMuted, fontFamily: FONTS.sans, fontSize: 11.5, lineHeight: 16 },
  chinTime: { alignItems: 'flex-end', gap: 1 },
  chinTimeValue: {
    color: COLORS.printInk,
    fontFamily: FONTS.display,
    fontSize: 30,
    letterSpacing: -0.4,
    lineHeight: 32,
  },
  chinTimeCaption: {
    color: COLORS.printMuted,
    fontFamily: FONTS.sansMedium,
    fontSize: 9.5,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },

  roll: { gap: 12 },
  rollHead: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between' },
  rollLabel: {
    color: COLORS.edge,
    fontFamily: FONTS.sansSemiBold,
    fontSize: 10.5,
    letterSpacing: 1.8,
  },
  rollFigures: { color: COLORS.muted, fontFamily: FONTS.sans, fontSize: 12.5 },
  rollFigureStrong: { color: COLORS.ink, fontFamily: FONTS.sansMedium },
  strip: {
    backgroundColor: COLORS.deep,
    borderColor: COLORS.line,
    borderRadius: 6,
    borderWidth: 1,
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  sprockets: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2 },
  sprocket: { backgroundColor: '#2B2723', borderRadius: 1.5, height: 4, width: 7 },
  frames: { flexDirection: 'row', gap: 5 },
  frame: {
    alignItems: 'flex-start',
    backgroundColor: '#1D1A18',
    borderRadius: 2,
    flex: 1,
    height: 30,
    justifyContent: 'flex-end',
    padding: 5,
  },
  frameUsed: { backgroundColor: COLORS.accent },
  frameNumber: {
    color: COLORS.muted,
    fontFamily: FONTS.sansSemiBold,
    fontSize: 8.5,
    letterSpacing: 0.6,
  },
  frameNumberUsed: { color: COLORS.accentInk },

  actionBlock: { gap: 12 },
  action: {
    alignItems: 'center',
    backgroundColor: COLORS.accent,
    borderRadius: 999,
    flexDirection: 'row',
    gap: 11,
    justifyContent: 'center',
    minHeight: 58,
    paddingHorizontal: 24,
    shadowColor: COLORS.accent,
    shadowOffset: { height: 10, width: 0 },
    shadowOpacity: 0.22,
    shadowRadius: 24,
  },
  actionPressed: { opacity: 0.86, transform: [{ scale: 0.985 }] },
  actionDisabled: { backgroundColor: COLORS.paper, shadowOpacity: 0 },
  actionLabel: {
    color: COLORS.accentInk,
    fontFamily: FONTS.sansSemiBold,
    fontSize: 16,
    letterSpacing: 0.1,
  },
  actionLabelDisabled: { color: COLORS.muted },
  recordRing: {
    alignItems: 'center',
    borderColor: COLORS.accentInk,
    borderRadius: 8,
    borderWidth: 1.6,
    height: 16,
    justifyContent: 'center',
    width: 16,
  },
  recordDot: { backgroundColor: COLORS.accentInk, borderRadius: 3.5, height: 7, width: 7 },
  glyphDisabled: { borderColor: COLORS.muted },
  glyphFillDisabled: { backgroundColor: COLORS.muted },
  playGlyph: {
    borderBottomColor: 'transparent',
    borderBottomWidth: 6,
    borderLeftColor: COLORS.accentInk,
    borderLeftWidth: 10,
    borderTopColor: 'transparent',
    borderTopWidth: 6,
    height: 0,
    width: 0,
  },
  actionHint: {
    color: COLORS.faint,
    fontFamily: FONTS.sans,
    fontSize: 12,
    textAlign: 'center',
  },

  groupRow: {
    alignItems: 'center',
    borderTopColor: COLORS.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingTop: 20,
  },
  avatars: { flexDirection: 'row' },
  memberAvatar: {
    alignItems: 'center',
    borderColor: COLORS.background,
    borderRadius: 16,
    borderWidth: 2,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  memberAvatarOverlap: { marginLeft: -9 },
  memberInitial: { color: COLORS.ink, fontFamily: FONTS.sansSemiBold, fontSize: 11.5 },
  groupText: {
    color: COLORS.muted,
    flexShrink: 1,
    fontFamily: FONTS.sansMedium,
    fontSize: 13.5,
  },
});
