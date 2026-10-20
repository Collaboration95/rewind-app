import {
  DAY_MS,
  WEEK_MS,
  awaitingServer,
  cycleWeek,
  filmCountdown,
  homeCards,
  momentDay,
  nextBoundary,
  plural,
  premiereLeft,
  premiereRelease,
  shutterState,
  type HomeRelease,
} from '../src/real/home-model';

const HOUR = 60 * 60 * 1000;
const start = Date.parse('2026-09-28T00:00:00.000Z');
const cycle = {
  id: 'current',
  startsAt: '2026-09-28T00:00:00.000Z',
  endsAt: '2026-10-26T00:00:00.000Z',
};
const release = (
  cycleId: string,
  state: HomeRelease['state'],
  publishedAt: string | null = '2026-09-27T00:00:00.000Z',
): HomeRelease => ({ cycleId, endsAt: '2026-09-27T00:00:00.000Z', publishedAt, state });

describe('plural', () => {
  it('uses the singular only for exactly one', () => {
    expect(plural(1, 'day')).toBe('1 day');
    expect(plural(0, 'day')).toBe('0 days');
    expect(plural(2, 'moment')).toBe('2 moments');
  });
});

describe('filmCountdown', () => {
  it('counts in days, hours then minutes, rounding up', () => {
    const end = cycle.endsAt;
    const at = (msBefore: number) => filmCountdown(end, Date.parse(end) - msBefore);
    expect(at(2 * DAY_MS + 1)).toEqual({ count: 3, unit: 'day' });
    expect(at(DAY_MS)).toEqual({ count: 1, unit: 'day' });
    expect(at(DAY_MS - 1)).toEqual({ count: 24, unit: 'hour' });
    expect(at(HOUR)).toEqual({ count: 1, unit: 'hour' });
    expect(at(HOUR - 1)).toEqual({ count: 60, unit: 'minute' });
    expect(at(90 * 1000)).toEqual({ count: 2, unit: 'minute' });
  });

  it('never goes negative and tolerates an unparseable instant', () => {
    expect(filmCountdown(cycle.endsAt, Date.parse(cycle.endsAt) + DAY_MS)).toEqual({
      count: 0,
      unit: 'minute',
    });
    expect(filmCountdown('never', start)).toEqual({ count: 0, unit: 'minute' });
  });
});

describe('cycleWeek', () => {
  it('stays within weeks 1 to 4 and resets on the seven-day window', () => {
    expect(cycleWeek(cycle, start - 5 * DAY_MS)).toMatchObject({ week: 1, windowStart: start });
    expect(cycleWeek(cycle, start + WEEK_MS)).toMatchObject({
      week: 2,
      windowStart: start + WEEK_MS,
      resetAt: start + 2 * WEEK_MS,
    });
    // After the end the clock is held inside the final window.
    expect(cycleWeek(cycle, Date.parse(cycle.endsAt) + 10 * DAY_MS)).toMatchObject({
      week: 4,
      windowStart: start + 3 * WEEK_MS,
    });
  });

  it('fits short local cycles inside one window and never reports zero days', () => {
    const short = {
      id: 's',
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: '2026-10-01T00:10:00.000Z',
    };
    const result = cycleWeek(short, Date.parse(short.startsAt) + 5 * 60 * 1000);
    expect(result.resetAt).toBe(Date.parse(short.endsAt));
    expect(result.resetDays).toBe(1);
    expect(result.windowStart).toBe(Date.parse(short.startsAt));
  });

  it('copes with an inverted cycle', () => {
    const inverted = { id: 'i', startsAt: cycle.endsAt, endsAt: cycle.startsAt };
    expect(cycleWeek(inverted, start).week).toBe(1);
  });
});

describe('nextBoundary', () => {
  it('is the allowance reset while a cycle is running', () => {
    expect(nextBoundary(cycle, undefined, start + DAY_MS)).toBe(start + WEEK_MS);
  });

  it('is the cycle end once the final reset coincides with it', () => {
    const now = Date.parse(cycle.endsAt) - HOUR;
    expect(nextBoundary(cycle, [], now)).toBe(Date.parse(cycle.endsAt));
  });

  it('prefers an earlier premiere expiry from a previous cycle', () => {
    const published = new Date(start + 2 * DAY_MS - 20 * HOUR).toISOString();
    const releases = [release('previous', 'premiere', published)];
    expect(nextBoundary(cycle, releases, start + DAY_MS)).toBe(Date.parse(published) + DAY_MS);
  });

  it('ignores the current cycle, non-premieres and premieres already over', () => {
    const now = start + DAY_MS;
    const published = new Date(start - 3 * DAY_MS).toISOString();
    expect(
      nextBoundary(
        cycle,
        [
          release('current', 'premiere', new Date(now - HOUR).toISOString()),
          release('older', 'processing'),
          release('oldest', 'premiere', published),
        ],
        now,
      ),
    ).toBe(start + WEEK_MS);
  });

  it('uses the end of the release when it has no publish time', () => {
    const r = release('previous', 'premiere', null);
    const now = Date.parse(r.endsAt) + 2 * HOUR;
    expect(nextBoundary(cycle, [r], now)).toBe(Date.parse(r.endsAt) + DAY_MS);
  });

  it('is null when nothing is ahead', () => {
    expect(nextBoundary(cycle, [], Date.parse(cycle.endsAt) + DAY_MS)).toBeNull();
  });
});

describe('awaitingServer', () => {
  const mid = start + 2 * DAY_MS;

  it('is false when a quiet cycle is running', () => {
    expect(awaitingServer(cycle, undefined, mid)).toBe(false);
    expect(awaitingServer(cycle, [release('previous', 'archived')], mid)).toBe(false);
  });

  it('is true once the cycle has ended but the server has not rolled over', () => {
    expect(awaitingServer(cycle, [], Date.parse(cycle.endsAt))).toBe(true);
  });

  it('is true while an earlier film is processing or delayed', () => {
    expect(awaitingServer(cycle, [release('previous', 'processing')], mid)).toBe(true);
    expect(awaitingServer(cycle, [release('previous', 'delayed')], mid)).toBe(true);
  });

  it('ignores a processing release belonging to the current cycle', () => {
    expect(awaitingServer(cycle, [release('current', 'processing')], mid)).toBe(false);
  });

  it('is true only after a premiere has run its 24 hours', () => {
    const published = '2026-09-30T00:00:00.000Z';
    const premiere = release('previous', 'premiere', published);
    expect(awaitingServer(cycle, [premiere], Date.parse(published) + DAY_MS - 1)).toBe(false);
    expect(awaitingServer(cycle, [premiere], Date.parse(published) + DAY_MS)).toBe(true);
  });
});

describe('homeCards', () => {
  it('is empty with nothing to report', () => {
    expect(homeCards(undefined, 'current', false)).toEqual([]);
    expect(homeCards([release('current', 'premiere')], 'current', false)).toEqual([]);
  });

  it('shows a delayed film before one still developing', () => {
    expect(
      homeCards([release('a', 'processing'), release('b', 'delayed')], 'current', false),
    ).toEqual(['delayed']);
    expect(homeCards([release('a', 'processing')], 'current', true)).toEqual([
      'developing',
      'failed',
    ]);
  });

  it('shows only the failed card when a moment failed and nothing is released', () => {
    expect(homeCards([], 'current', true)).toEqual(['failed']);
  });
});

describe('premiereRelease and premiereLeft', () => {
  it('finds the premiere from an earlier cycle', () => {
    const premiere = release('previous', 'premiere');
    expect(
      premiereRelease(
        [release('current', 'premiere'), release('x', 'delayed'), premiere],
        'current',
      ),
    ).toBe(premiere);
    expect(premiereRelease(undefined, 'current')).toBeUndefined();
  });

  it('counts the premiere hours left, between 1 and 24', () => {
    const published = '2026-09-30T00:00:00.000Z';
    const r = release('previous', 'premiere', published);
    const at = Date.parse(published);
    expect(premiereLeft(r, at)).toBe('24 h left');
    expect(premiereLeft(r, at - 5 * HOUR)).toBe('24 h left');
    expect(premiereLeft(r, at + 23 * HOUR + 1)).toBe('1 h left');
    expect(premiereLeft(r, at + 3 * DAY_MS)).toBe('1 h left');
  });

  it('falls back to the end of the cycle without a publish time', () => {
    const r = release('previous', 'premiere', null);
    expect(premiereLeft(r, Date.parse(r.endsAt) + 6 * HOUR)).toBe('18 h left');
  });
});

describe('shutterState', () => {
  it('is ready with the default allowance before the ledger has loaded', () => {
    expect(shutterState(null, 3)).toEqual({
      kind: 'ready',
      left: 5,
      label: 'Add a moment · 5 of 5 left',
    });
  });

  it('counts down the remaining moments', () => {
    expect(
      shutterState({ maxCount: 5, maxSeconds: 30, countUsed: 4, secondsUsed: 12 }, 2),
    ).toMatchObject({ kind: 'ready', left: 1, label: 'Add a moment · 1 of 5 left' });
  });

  it('reports a used count with the singular and plural reset', () => {
    const used = { maxCount: 3, maxSeconds: 30, countUsed: 4, secondsUsed: 4 };
    expect(shutterState(used, 1)).toEqual({
      kind: 'used',
      label: "This week's 3 moments are used · resets in 1 day",
      tip: 'All 3 used · resets in 1 day',
    });
  });

  it('reports used seconds when the count still has room', () => {
    expect(shutterState({ maxCount: 5, maxSeconds: 30, countUsed: 1, secondsUsed: 31 }, 2)).toEqual(
      {
        kind: 'used',
        label: "This week's 30 seconds are used · resets in 2 days",
        tip: '30 s used · resets in 2 days',
      },
    );
  });
});

describe('momentDay', () => {
  it('says Today for a moment from the same local day', () => {
    const now = new Date(2026, 9, 14, 20, 0, 0).getTime();
    expect(momentDay(new Date(2026, 9, 14, 6, 0, 0).toISOString(), now)).toBe('Today');
  });

  it('names the local weekday for other days', () => {
    const now = new Date(2026, 9, 14, 20, 0, 0).getTime();
    // 12 Oct 2026 is a Monday; 11 Oct is a Sunday.
    expect(momentDay(new Date(2026, 9, 12, 9, 0, 0).toISOString(), now)).toBe('Mon');
    expect(momentDay(new Date(2026, 9, 11, 9, 0, 0).toISOString(), now)).toBe('Sun');
  });

  it('is blank for an unparseable timestamp', () => {
    expect(momentDay('garbage', Date.now())).toBe('');
  });
});
