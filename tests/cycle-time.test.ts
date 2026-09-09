import { formatTimeRemaining, getRemainingSeconds } from '../src/capsule/cycle-time';
import type { Cycle } from '../src/domain/cycles';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');

const cycle: Cycle = {
  id: 'cycle',
  groupId: 'group',
  prompt: 'Prompt',
  startsAt: new Date(NOW - 60_000).toISOString(),
  endsAt: new Date(NOW + 2 * 60 * 60 * 1000 + 500).toISOString(),
  status: 'collecting',
  lockState: 'locked',
  quota: { maxCount: 5, maxSeconds: 30 },
  contributionUsage: { countUsed: 0, secondsUsed: 0 },
};

describe('cycle countdown formatting', () => {
  it('derives remaining time from cycle timestamps and clamps expired cycles', () => {
    expect(getRemainingSeconds(cycle, NOW)).toBe(7201);
    expect(getRemainingSeconds(cycle, NOW + 3 * 60 * 60 * 1000)).toBe(0);
  });

  it.each([
    [172_800, '2 days remaining'],
    [3_600, '1 hour remaining'],
    [120, '2 minutes remaining'],
    [1, '1 second remaining'],
    [0, 'Cycle ended'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatTimeRemaining(seconds)).toBe(expected);
  });
});
