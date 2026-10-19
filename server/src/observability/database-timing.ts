// Per-request database accounting. The HTTP server runs each request inside
// a store; the PostgreSQL bridge adds every statement, server round trip and
// blocked millisecond to it. Reported as a Server-Timing header and in the
// REWIND_REQUEST_TIMING log line.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface DatabaseTiming {
  statements: number;
  roundTrips: number;
  milliseconds: number;
}

const store = new AsyncLocalStorage<DatabaseTiming>();

export function newDatabaseTiming(): DatabaseTiming {
  return { statements: 0, roundTrips: 0, milliseconds: 0 };
}

export function withDatabaseTiming<T>(timing: DatabaseTiming, run: () => T): T {
  return store.run(timing, run);
}

export function recordDatabaseCall(roundTrips: number, milliseconds: number): void {
  const timing = store.getStore();
  if (!timing) return;
  timing.statements += 1;
  timing.roundTrips += roundTrips;
  timing.milliseconds += milliseconds;
}

export function serverTimingHeader(timing: DatabaseTiming): string {
  return `db;dur=${timing.milliseconds.toFixed(1)};desc="${timing.statements} statements, ${timing.roundTrips} round trips"`;
}
