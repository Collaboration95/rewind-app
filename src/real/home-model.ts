// Pure helpers for the real-account Home (spec H1–H11): which state it is in,
// the countdown, the week of the cycle and what the shutter does. No React.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
export const PHOTO_SECONDS = 3;
export const CLIP_MAX_SECONDS = 15;

export type ReleaseState = 'processing' | 'delayed' | 'premiere' | 'archived';

export interface HomeRelease {
  cycleId: string;
  endsAt: string;
  publishedAt: string | null;
  state: ReleaseState;
}

export interface HomeCycle {
  id: string;
  startsAt: string;
  endsAt: string;
}

export interface Allowance {
  maxCount: number;
  maxSeconds: number;
  countUsed: number;
  secondsUsed: number;
}

export type HomeCard = 'failed' | 'developing' | 'delayed' | 'released';

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Whole days left, rounded up, never below 0. */
export function daysUntil(iso: string, now: number): number {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / DAY_MS);
}

/**
 * The week of the 4-week cycle and when the allowance resets. The server
 * resets allowances every 7 days from the cycle start; short local cycles
 * (make run-real) fit inside one window.
 */
export function cycleWeek(cycle: HomeCycle, now: number) {
  const start = Date.parse(cycle.startsAt);
  const end = Date.parse(cycle.endsAt);
  const length = Math.max(1, end - start);
  const elapsed = Math.min(Math.max(0, now - start), length - 1);
  const week = Math.min(4, Math.floor((elapsed / length) * 4) + 1);
  const windowIndex = Math.floor(elapsed / WEEK_MS);
  const windowStart = start + windowIndex * WEEK_MS;
  const reset = Math.min(windowStart + WEEK_MS, end);
  return {
    week,
    windowStart,
    resetDays: Math.max(1, Math.ceil((reset - now) / DAY_MS)),
  };
}

/** The status card under the header, newest news first. */
export function homeCards(
  releases: HomeRelease[] | undefined,
  currentCycleId: string,
  hasFailedMoment: boolean,
): HomeCard[] {
  const previous = (releases ?? []).filter((release) => release.cycleId !== currentCycleId);
  const cards: HomeCard[] = [];
  if (previous.some((release) => release.state === 'premiere')) cards.push('released');
  else if (previous.some((release) => release.state === 'delayed')) cards.push('delayed');
  else if (previous.some((release) => release.state === 'processing')) cards.push('developing');
  if (hasFailedMoment) cards.push('failed');
  return cards;
}

export function premiereRelease(releases: HomeRelease[] | undefined, currentCycleId: string) {
  return (releases ?? []).find(
    (release) => release.cycleId !== currentCycleId && release.state === 'premiere',
  );
}

/** "18 h left" for the 24-hour premiere. */
export function premiereLeft(release: HomeRelease, now: number): string {
  const started = Date.parse(release.publishedAt ?? release.endsAt);
  const hours = Math.max(1, Math.ceil((started + DAY_MS - now) / (60 * 60 * 1000)));
  return `${Math.min(24, hours)} h left`;
}

export type ShutterState =
  { kind: 'ready'; left: number; label: string } | { kind: 'used'; label: string; tip: string };

/** The dock shutter: grey once 5 moments or 30 seconds are used, whichever comes first. */
export function shutterState(allowance: Allowance | null, resetDays: number): ShutterState {
  const maxCount = allowance?.maxCount ?? 5;
  const countUsed = allowance?.countUsed ?? 0;
  const left = Math.max(0, maxCount - countUsed);
  const reset = plural(resetDays, 'day');
  if (allowance && countUsed >= maxCount)
    return {
      kind: 'used',
      label: `This week's ${maxCount} moments are used · resets in ${reset}`,
      tip: `All ${maxCount} used · resets in ${reset}`,
    };
  if (allowance && allowance.secondsUsed >= allowance.maxSeconds)
    return {
      kind: 'used',
      label: `This week's ${allowance.maxSeconds} seconds are used · resets in ${reset}`,
      tip: `${allowance.maxSeconds} s used · resets in ${reset}`,
    };
  return { kind: 'ready', left, label: `Add a moment · ${left} of ${maxCount} left` };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon", or "Today" for a moment from today, as on Home and in Your moments. */
export function momentDay(iso: string, now: number): string {
  const date = new Date(iso);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return 'Today';
  return WEEKDAYS[date.getDay()] ?? '';
}
