import type { RewindDatabase } from '../db';
import { runReminderOutboxTick, scanDueReminderJobs, type ReminderProviders } from './outbox';

export const REMINDER_LOOP_INTERVAL_MS = 60_000;
const MAX_JOBS_PER_TICK = 10;
const MAX_SCAN_PAGES_PER_TICK = 10;

/**
 * Queue due weekly reminders and send pending ones once a minute while the
 * runtime is up. Ticks never overlap, and a failed tick is retried next time.
 */
export function startReminderLoop(
  openDatabase: () => Promise<RewindDatabase>,
  providers: ReminderProviders,
  options: { intervalMs?: number; now?: () => Date; onError?: (message: string) => void } = {},
) {
  let database: RewindDatabase | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;
  // Scan pages are bounded; keep the cursor so later preferences are reached.
  let cursor: string | null = null;
  const now = options.now ?? (() => new Date());

  const tick = () => {
    if (stopped || running) return running;
    running = (async () => {
      try {
        database ??= await openDatabase();
        for (let page = 0; page < MAX_SCAN_PAGES_PER_TICK; page++) {
          const scan = scanDueReminderJobs(database, now(), cursor ? { after: cursor } : {});
          cursor = scan.nextCursor ?? null;
          if (!cursor) break;
        }
        for (let job = 0; job < MAX_JOBS_PER_TICK && !stopped; job++) {
          const result = await runReminderOutboxTick(database, providers, { now });
          if (!result.claimed) break;
        }
      } catch {
        options.onError?.('Reminder loop: tick failed; retrying next interval.');
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? REMINDER_LOOP_INTERVAL_MS);
  timer.unref?.();
  void tick();

  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
      database?.close();
      database = null;
    },
  };
}
