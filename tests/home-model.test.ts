import { parseFilmSegments } from '../src/domain/premiere';
import {
  cycleWeek,
  daysUntil,
  DAY_MS,
  homeCards,
  premiereLeft,
  shutterState,
} from '../src/real/home-model';

const start = Date.parse('2026-09-28T00:00:00Z');
const cycle = { id: 'c2', startsAt: '2026-09-28T00:00:00Z', endsAt: '2026-10-26T00:00:00Z' };
const allowance = { maxCount: 5, maxSeconds: 30, countUsed: 0, secondsUsed: 0 };

it('counts the cycle week and the weekly reset from the cycle start', () => {
  expect(cycleWeek(cycle, start + DAY_MS)).toMatchObject({ week: 1, resetDays: 6 });
  expect(cycleWeek(cycle, start + 8 * DAY_MS)).toMatchObject({ week: 2, resetDays: 6 });
  expect(cycleWeek(cycle, start + 27.5 * DAY_MS)).toMatchObject({ week: 4, resetDays: 1 });
  expect(daysUntil(cycle.endsAt, start + 27.5 * DAY_MS)).toBe(1);
  expect(daysUntil(cycle.endsAt, start + 40 * DAY_MS)).toBe(0);
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
