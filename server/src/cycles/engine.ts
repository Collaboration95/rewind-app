/**
 * Framework-free cycle timing engine for the local runtime.
 *
 * The engine accepts its clock as a dependency so policy and lifecycle tests
 * never need to wait for wall-clock time. Advancing a demo cycle moves its
 * boundaries backwards by the requested amount: the wall clock therefore
 * observes the same cycle as if the demonstration clock had moved forwards.
 */

export const CYCLE_DURATION_MS = Object.freeze({
  'one-day': 24 * 60 * 60 * 1000,
  'four-week': 28 * 24 * 60 * 60 * 1000,
});

export type CycleDurationPreset = keyof typeof CYCLE_DURATION_MS;
export type CycleClock = () => Date;

export interface CycleWindow {
  startsAt: string;
  endsAt: string;
}

export interface CycleLike extends CycleWindow {
  status: 'collecting' | 'revealing' | 'archived';
}

export type CyclePhase = 'upcoming' | 'collecting' | 'ended' | 'revealing' | 'archived';

export interface CycleEngine {
  now(): Date;
  durationMs(preset: CycleDurationPreset): number;
  createWindow(input: { preset: CycleDurationPreset; startsAt?: Date | string }): CycleWindow;
  phase(cycle: CycleLike): CyclePhase;
  remainingSeconds(cycle: CycleWindow): number;
  advanceWindow(window: CycleWindow, advanceSeconds: number): CycleWindow;
}

export function systemClock(): Date {
  return new Date();
}

function parseInstant(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError('Cycle instants must be valid ISO-8601 dates.');
  }
  return date;
}

export function cycleDurationMs(preset: CycleDurationPreset): number {
  const duration = CYCLE_DURATION_MS[preset];
  if (!duration) throw new RangeError(`Unsupported cycle duration preset: ${String(preset)}.`);
  return duration;
}

export function createCycleWindow(
  input: { preset: CycleDurationPreset; startsAt?: Date | string },
  clock: CycleClock = systemClock,
): CycleWindow {
  const startsAt = parseInstant(input.startsAt ?? clock());
  const endsAt = new Date(startsAt.getTime() + cycleDurationMs(input.preset));
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}

export function cyclePhase(cycle: CycleLike, now: Date): CyclePhase {
  if (cycle.status === 'revealing' || cycle.status === 'archived') return cycle.status;
  const nowMs = parseInstant(now).getTime();
  const startsAtMs = parseInstant(cycle.startsAt).getTime();
  const endsAtMs = parseInstant(cycle.endsAt).getTime();
  if (nowMs < startsAtMs) return 'upcoming';
  if (nowMs >= endsAtMs) return 'ended';
  return 'collecting';
}

export function remainingSeconds(window: CycleWindow, now: Date): number {
  const remainingMs = parseInstant(window.endsAt).getTime() - parseInstant(now).getTime();
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

export function advanceCycleWindow(window: CycleWindow, advanceSeconds: number): CycleWindow {
  if (!Number.isSafeInteger(advanceSeconds) || advanceSeconds <= 0) {
    throw new RangeError('Cycle advance must be a positive whole number of seconds.');
  }
  const deltaMs = advanceSeconds * 1000;
  const startsAt = parseInstant(window.startsAt);
  const endsAt = parseInstant(window.endsAt);
  return {
    startsAt: new Date(startsAt.getTime() - deltaMs).toISOString(),
    endsAt: new Date(endsAt.getTime() - deltaMs).toISOString(),
  };
}

export function createCycleEngine(clock: CycleClock = systemClock): CycleEngine {
  return {
    now: () => parseInstant(clock()),
    durationMs: cycleDurationMs,
    createWindow: (input) => createCycleWindow(input, clock),
    phase: (cycle) => cyclePhase(cycle, clock()),
    remainingSeconds: (cycle) => remainingSeconds(cycle, clock()),
    advanceWindow: advanceCycleWindow,
  };
}
