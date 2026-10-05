import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Icon } from '../ui/Icon';
import { Button, Glass, ProgressBar, rw } from '../ui/primitives';
import { FONT, WARM, serif } from '../ui/tokens';
import { plural, type HomeCard } from './home-model';

const isWeb = Platform.OS === 'web';

export interface HomeMoment {
  id: string;
  mediaType: 'photo' | 'video';
  seconds: number;
  day: string;
  failed: boolean;
}

/** H1–H7: countdown, week, prompt card with your allowance and this week's moments. */
export function HomeBody({
  header,
  countdown,
  week,
  resetDays,
  prompt,
  countUsed,
  secondsUsed,
  maxCount,
  maxSeconds,
  moments,
  cards,
  premiereLeft,
  onOpenMoments,
  onWatch,
  onRetryFailed,
  retryPending,
  rollKey,
  notices,
  demoCompact = false,
}: {
  header: ReactNode;
  countdown: { count: number; unit: string };
  week: number;
  resetDays: number;
  prompt: string;
  countUsed: number | null;
  secondsUsed: number | null;
  maxCount: number;
  maxSeconds: number;
  moments: HomeMoment[] | null;
  cards: HomeCard[];
  premiereLeft: string | null;
  onOpenMoments: () => void;
  onWatch: () => void;
  onRetryFailed: () => void;
  retryPending?: boolean;
  /** Bumped after sealing: the allowance row rolls in. */
  rollKey?: number;
  notices?: ReactNode;
  /** Demo's separate header leaves less space on short screens. */
  demoCompact?: boolean;
}) {
  const compact = useWindowDimensions().height < 720 && (cards.length > 0 || demoCompact);
  const used = countUsed ?? 0;
  const secs = secondsUsed ?? 0;
  return (
    <View testID="real-group-home">
      {header}
      {notices}
      {cards.map((card) => (
        <StatusCard
          key={card}
          card={card}
          onRetry={onRetryFailed}
          onWatch={onWatch}
          premiereLeft={premiereLeft}
          retryPending={retryPending}
        />
      ))}
      <View
        accessibilityLabel={`${plural(countdown.count, countdown.unit)} until our film`}
        style={[styles.hero, cards.length > 0 && styles.heroSlim, compact && styles.heroCompact]}
        testID="real-group-countdown"
      >
        <Text style={[styles.heroDays, compact && styles.heroDaysCompact]}>{countdown.count}</Text>
        <Text style={styles.heroLabel}>
          {countdown.unit}
          {countdown.count === 1 ? '' : 's'} until our film
        </Text>
      </View>
      <View style={styles.count}>
        <Text style={styles.week} testID="real-group-week">
          Week {week} of 4
        </Text>
        <Text style={styles.reset}>Your moments reset in {plural(resetDays, 'day')}</Text>
      </View>
      <Glass style={styles.card}>
        <Text style={styles.cardLabel}>This cycle’s prompt</Text>
        <Text style={styles.prompt} testID="real-group-cycle-prompt">
          {prompt}
        </Text>
        <Pressable
          accessibilityLabel={
            countUsed === null
              ? 'Your moments: loading'
              : `Your moments: ${used} of ${maxCount}, ${secs} of ${maxSeconds} seconds`
          }
          accessibilityRole="button"
          key={rollKey}
          onPress={onOpenMoments}
          style={({ pressed }) => [styles.mineRow, pressed && styles.pressed]}
          testID="real-group-allowance"
          {...(rollKey ? rw('roll') : {})}
        >
          <View accessibilityElementsHidden style={styles.pills}>
            {Array.from({ length: maxCount }, (_, index) => (
              <View
                key={index}
                style={[styles.pill, index < used && (isWeb ? undefined : styles.pillOnNative)]}
                {...(index < used ? rw('pills-on') : {})}
              />
            ))}
          </View>
          <Text style={styles.mineText}>
            {countUsed === null
              ? 'Loading…'
              : `You · ${used} of ${maxCount} · ${secs} of ${maxSeconds} s`}
          </Text>
          <View style={styles.go}>
            <Icon color={WARM.muted} name="chev" size={14} />
          </View>
        </Pressable>
        {moments === null ? null : moments.length === 0 ? (
          <Text style={styles.histNone}>Nothing sealed yet this week</Text>
        ) : (
          <View accessibilityLabel="Your moments this week" style={styles.hist}>
            {moments.map((moment) => (
              <View key={moment.id} style={[styles.chip, moment.failed && styles.chipBad]}>
                <Icon
                  color={WARM.muted}
                  name={moment.mediaType === 'photo' ? 'camera' : 'play'}
                  size={12}
                />
                <Text style={[styles.chipText, moment.failed && { color: WARM.dangerInk }]}>
                  {moment.day} · {moment.seconds} s
                </Text>
              </View>
            ))}
          </View>
        )}
      </Glass>
    </View>
  );
}

const CARD_COPY: Record<HomeCard, { title: string; body: string }> = {
  failed: { title: 'A moment didn’t finish', body: 'Retry it, or delete it and retake.' },
  developing: { title: 'Your film is developing', body: 'The last 4 weeks, ready soon.' },
  delayed: { title: 'Taking a little longer', body: 'Everyone hears when it’s ready.' },
  released: { title: 'Your film is here', body: 'Premiere' },
};

function StatusCard({
  card,
  premiereLeft,
  onWatch,
  onRetry,
  retryPending,
}: {
  card: HomeCard;
  premiereLeft: string | null;
  onWatch: () => void;
  onRetry: () => void;
  retryPending?: boolean;
}) {
  const copy = CARD_COPY[card];
  const body = card === 'released' ? `Premiere · ${premiereLeft ?? '24 h left'}` : copy.body;
  return (
    <Glass
      accessibilityRole="summary"
      extra="card-in"
      style={styles.stCard}
      testID={`real-home-card-${card}`}
    >
      <View style={styles.stText}>
        <Text style={styles.stTitle}>{copy.title}</Text>
        <Text style={styles.stBody}>{body}</Text>
      </View>
      {card === 'released' ? (
        <Pressable
          accessibilityRole="button"
          onPress={onWatch}
          style={({ pressed }) => [
            styles.watch,
            !isWeb && styles.watchNative,
            pressed && styles.pressed,
          ]}
          testID="real-home-watch"
          {...rw('btn')}
        >
          <View style={[styles.watchIcon, !isWeb && styles.peachNative]} {...rw('primary')}>
            <Icon color="#2a1a10" filled name="play" size={15} />
          </View>
          <Text style={styles.watchText}>Watch</Text>
        </Pressable>
      ) : null}
      {card === 'failed' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: Boolean(retryPending), disabled: Boolean(retryPending) }}
          disabled={retryPending}
          onPress={onRetry}
          style={[styles.mini, !isWeb && styles.peachNative]}
          testID="real-home-retry"
          {...rw('primary')}
        >
          <Text style={styles.miniText}>{retryPending ? 'Retrying…' : 'Retry'}</Text>
        </Pressable>
      ) : null}
      {card === 'developing' || card === 'delayed' ? (
        <View style={styles.stBar}>
          <ProgressBar label="Developing" slow={card === 'delayed'} width="100%" />
        </View>
      ) : null}
    </Glass>
  );
}

/** The full-body states (H10, H11, D1): a warm glow, a title, a line and actions. */
export function HomeState({
  header,
  title,
  body,
  action,
  onAction,
  alt,
  onAlt,
  dim,
  primary,
  testID,
  actionTestID,
  altTestID,
  children,
}: {
  header: ReactNode;
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
  alt?: string;
  onAlt?: () => void;
  /** Error and not-in-group states show a quieter glow. */
  dim?: boolean;
  primary?: boolean;
  testID?: string;
  actionTestID?: string;
  altTestID?: string;
  children?: ReactNode;
}) {
  return (
    <View testID={testID}>
      {header}
      <View accessibilityLiveRegion="polite" style={styles.st}>
        <View
          accessibilityElementsHidden
          style={[styles.motif, dim && (isWeb ? undefined : { opacity: 0.35 })]}
          {...(dim ? rw('muted-motif') : {})}
        >
          <View style={[styles.moGlow, !isWeb && styles.moGlowNative]} {...rw('mo-glow')} />
          <View style={[styles.moCore, !isWeb && styles.moCoreNative]} {...rw('mo-core')} />
        </View>
        <Text accessibilityRole="header" style={styles.stH}>
          {title}
        </Text>
        <Text style={styles.stP}>{body}</Text>
        {action && onAction ? (
          <Pressable
            accessibilityRole="button"
            onPress={onAction}
            style={({ pressed }) => [
              styles.stBtn,
              primary && styles.stBtnPrimary,
              pressed && styles.pressed,
            ]}
            testID={actionTestID}
          >
            <Text style={[styles.stBtnText, primary && { color: '#1d1208' }]}>{action}</Text>
          </Pressable>
        ) : null}
        {alt && onAlt ? (
          <Pressable
            accessibilityRole="button"
            onPress={onAlt}
            style={({ pressed }) => [styles.stBtn, styles.stAlt, pressed && styles.pressed]}
            testID={altTestID}
          >
            <Text style={styles.stBtnText}>{alt}</Text>
          </Pressable>
        ) : null}
        {children}
      </View>
    </View>
  );
}

export function LoadingState({ header }: { header: ReactNode }) {
  return (
    <View testID="real-group-loading">
      {header}
      <View style={styles.st}>
        <Text accessibilityRole="header" style={styles.loading}>
          Restoring your group…
        </Text>
      </View>
    </View>
  );
}

export { Button };

const styles = StyleSheet.create({
  pressed: { opacity: 0.82 },
  hero: { alignItems: 'center', height: 282, justifyContent: 'center' },
  heroSlim: { height: 210 },
  heroCompact: { height: 144 },
  heroDaysCompact: { letterSpacing: -3, ...serif(96, '300', 108) },
  heroDays: {
    color: WARM.heroInk,
    letterSpacing: -5,
    lineHeight: 120,
    ...serif(128, '300', 144),
  },
  heroLabel: { color: WARM.ink, ...serif(17) },
  count: { alignItems: 'center', gap: 6, marginBottom: 22, marginTop: 2 },
  week: { color: WARM.ink, letterSpacing: -0.45, ...serif(30) },
  reset: { color: WARM.muted, fontFamily: FONT.body, fontSize: 12.5 },
  card: { paddingBottom: 8, paddingHorizontal: 20, paddingTop: 18, zIndex: 1 },
  cardLabel: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 11,
    letterSpacing: 1.3,
    textTransform: 'uppercase',
  },
  prompt: {
    color: WARM.ink,
    letterSpacing: -0.25,
    lineHeight: 29,
    marginBottom: 14,
    marginTop: 8,
    maxWidth: 300,
    ...serif(25),
  },
  mineRow: {
    alignItems: 'center',
    borderTopColor: WARM.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 10,
    minHeight: 44,
  },
  pills: { flexDirection: 'row', gap: 5 },
  pill: { backgroundColor: WARM.line, borderRadius: 3, height: 6, width: 22 },
  pillOnNative: { backgroundColor: '#ee8a52' },
  mineText: {
    color: WARM.muted,
    flex: 1,
    fontFamily: FONT.body,
    fontSize: 12.5,
    textAlign: 'right',
  },
  go: { transform: [{ rotate: '-90deg' }] },
  hist: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingBottom: 12, paddingTop: 2 },
  histNone: { color: WARM.muted, fontFamily: FONT.body, fontSize: 12, paddingBottom: 12 },
  chip: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.55)',
    borderColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    paddingLeft: 7,
    paddingRight: 9,
    paddingVertical: 3,
  },
  chipBad: { borderColor: 'rgba(194, 69, 47, 0.5)' },
  chipText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 11.5 },
  stCard: {
    alignItems: 'center',
    borderRadius: 24,
    columnGap: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 6,
    paddingBottom: 14,
    paddingLeft: 18,
    paddingRight: 14,
    paddingTop: 14,
    rowGap: 10,
  },
  stText: { flex: 1, gap: 3, minWidth: 0 },
  stTitle: { color: WARM.ink, lineHeight: 21, ...serif(18) },
  stBody: { color: WARM.muted, fontFamily: FONT.body, fontSize: 12.5 },
  stBar: { flexBasis: '100%', marginTop: -6 },
  watch: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    minHeight: 44,
    paddingBottom: 5,
    paddingLeft: 5,
    paddingRight: 16,
    paddingTop: 5,
  },
  watchNative: { backgroundColor: 'rgba(255, 255, 255, 0.7)' },
  watchIcon: {
    alignItems: 'center',
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    paddingLeft: 2,
    width: 32,
  },
  peachNative: { backgroundColor: '#ffb784' },
  watchText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 14, fontWeight: '600' },
  mini: {
    alignItems: 'center',
    borderRadius: 999,
    height: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  miniText: { color: '#2a1a10', fontFamily: FONT.body, fontSize: 13.5, fontWeight: '600' },
  st: { alignItems: 'center', gap: 10, marginHorizontal: 6, marginTop: 18 },
  motif: { alignItems: 'center', height: 150, justifyContent: 'center', marginTop: 4, width: 200 },
  moGlow: { borderRadius: 85, height: 170, position: 'absolute', width: 170 },
  moGlowNative: { backgroundColor: 'rgba(240, 160, 120, 0.35)' },
  moCore: { borderRadius: 23, height: 46, width: 46 },
  moCoreNative: { backgroundColor: '#f7d2bd' },
  stH: {
    color: WARM.ink,
    letterSpacing: -0.3,
    lineHeight: 35,
    maxWidth: 300,
    textAlign: 'center',
    ...serif(31, '500'),
  },
  stP: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 300,
    textAlign: 'center',
  },
  stBtn: {
    borderColor: WARM.ink,
    borderRadius: 999,
    borderWidth: 1.5,
    marginTop: 10,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  stBtnPrimary: {
    backgroundColor: WARM.accent,
    borderColor: WARM.accent,
    boxShadow: '0 10px 24px -10px #e0703a',
  },
  stAlt: { marginTop: 0 },
  stBtnText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 15, fontWeight: '600' },
  loading: { color: WARM.ink, marginTop: 120, textAlign: 'center', ...serif(24) },
});
