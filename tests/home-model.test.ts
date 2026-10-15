import type { ContributionLedgerEntry, ContributionLedgerPage } from '../src/domain/contributions';
import { parseFilmSegments } from '../src/domain/premiere';
import {
  cycleWeek,
  filmCountdown,
  DAY_MS,
  homeCards,
  premiereLeft,
  shutterState,
} from '../src/real/home-model';
import { weekMoments } from '../src/real/Moments';

const start = Date.parse('2026-09-28T00:00:00Z');
const cycle = { id: 'c2', startsAt: '2026-09-28T00:00:00Z', endsAt: '2026-10-26T00:00:00Z' };
const allowance = { maxCount: 5, maxSeconds: 30, countUsed: 0, secondsUsed: 0 };

it('counts the cycle week and the weekly reset from the cycle start', () => {
  expect(cycleWeek(cycle, start + DAY_MS)).toMatchObject({ week: 1, resetDays: 6 });
  expect(cycleWeek(cycle, start + 8 * DAY_MS)).toMatchObject({ week: 2, resetDays: 6 });
  expect(cycleWeek(cycle, start + 27.5 * DAY_MS)).toMatchObject({ week: 4, resetDays: 1 });
  // The final day counts in hours, not "1 day" (the Archive used to say that).
  expect(filmCountdown(cycle.endsAt, start + 27.5 * DAY_MS)).toEqual({ count: 12, unit: 'hour' });
  expect(filmCountdown(cycle.endsAt, start + 40 * DAY_MS)).toEqual({ count: 0, unit: 'minute' });
});

it('greys the shutter on whichever limit is reached first', () => {
  expect(shutterState(allowance, 3)).toEqual({
    kind: 'ready',
    left: 5,
    label: 'Add a moment · 5 of 5 left',
  });
  expect(shutterState({ ...allowance, countUsed: 5 }, 1)).toMatchObject({
    kind: 'used',
    tip: 'All 5 used · resets in 1 day',
  });
  expect(shutterState({ ...allowance, countUsed: 2, secondsUsed: 30 }, 3)).toMatchObject({
    kind: 'used',
    tip: '30 s used · resets in 3 days',
  });
});

it('shows the newest news card for earlier cycles only', () => {
  const release = (cycleId: string, state: 'processing' | 'delayed' | 'premiere') => ({
    cycleId,
    endsAt: cycle.startsAt,
    publishedAt: cycle.startsAt,
    state,
  });
  expect(homeCards([release('c1', 'premiere'), release('c0', 'delayed')], 'c2', true)).toEqual([
    'released',
    'failed',
  ]);
  expect(homeCards([release('c2', 'premiere'), release('c1', 'processing')], 'c2', false)).toEqual([
    'developing',
  ]);
  expect(premiereLeft(release('c1', 'premiere'), start + 6 * 60 * 60 * 1000)).toBe('18 h left');
});

it('rejects a malformed segment list as a whole', () => {
  const good = {
    contributionId: 'a',
    startSeconds: 0,
    durationSeconds: 3,
    hidden: false,
    mine: true,
  };
  expect(parseFilmSegments([good])).toEqual([good]);
  expect(parseFilmSegments([good, { ...good, durationSeconds: 0 }])).toBeUndefined();
  expect(parseFilmSegments('nope')).toBeUndefined();
});

it('counts only moments from the current weekly window', () => {
  const entry = (contributionId: string, createdAt: string, state = 'sealed') =>
    ({ contributionId, createdAt, state }) as ContributionLedgerEntry;
  const page = {
    entries: [
      entry('last-week', '2026-10-01T10:00:00Z'),
      entry('this-week', '2026-10-09T10:00:00Z'),
      entry('deleted', '2026-10-09T11:00:00Z', 'deleted'),
    ],
  } as ContributionLedgerPage;
  expect(
    weekMoments(page, Date.parse('2026-10-08T00:00:00Z')).map((m) => m.contributionId),
  ).toEqual(['this-week']);
});

it('uses days, hours and minutes at the countdown boundaries', () => {
  const end = Date.parse(cycle.endsAt);
  expect(filmCountdown(cycle.endsAt, end - DAY_MS)).toEqual({ count: 1, unit: 'day' });
  expect(filmCountdown(cycle.endsAt, end - 23.5 * 60 * 60 * 1000)).toEqual({
    count: 24,
    unit: 'hour',
  });
  expect(filmCountdown(cycle.endsAt, end - 60 * 60 * 1000)).toEqual({ count: 1, unit: 'hour' });
  expect(filmCountdown(cycle.endsAt, end - 59.2 * 60 * 1000)).toEqual({
    count: 60,
    unit: 'minute',
  });
  expect(filmCountdown(cycle.endsAt, end - 1000)).toEqual({ count: 1, unit: 'minute' });
  expect(filmCountdown(cycle.endsAt, end)).toEqual({ count: 0, unit: 'minute' });
});
