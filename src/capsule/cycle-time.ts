import { useEffect, useState } from 'react';

import type { Cycle } from '../domain/cycles';

export function getRemainingSeconds(cycle: Cycle, nowMs: number): number {
  const endMs = Date.parse(cycle.endsAt);
  if (!Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.ceil((endMs - nowMs) / 1000));
}

export function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return 'Cycle ended';

  const units = [
    { amount: 24 * 60 * 60, label: 'day' },
    { amount: 60 * 60, label: 'hour' },
    { amount: 60, label: 'minute' },
    { amount: 1, label: 'second' },
  ];

  const unit = units.find(({ amount }) => seconds >= amount) ?? units[units.length - 1];
  const value = Math.ceil(seconds / unit.amount);
  return `${value} ${unit.label}${value === 1 ? '' : 's'} remaining`;
}

export function useCycleCountdown(cycle: Cycle | null, clock: () => number = Date.now) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!cycle || cycle.status !== 'collecting') return;

    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [clock, cycle]);

  if (!cycle) return null;

  const seconds = getRemainingSeconds(cycle, clock());
  return { seconds, label: formatTimeRemaining(seconds) };
}
