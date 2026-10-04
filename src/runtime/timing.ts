// User Timing marks for comparing performance before and after a change
// (#321). Names only: no identity, content or secret is ever recorded. Read
// them in browser DevTools (Performance panel) or with
// performance.getEntriesByType('measure').
const pending = new Set<string>();
let launchMeasured = false;

function userTiming(): Performance | null {
  const timing = globalThis.performance;
  return typeof timing?.mark === 'function' && typeof timing.measure === 'function' ? timing : null;
}

export function markStart(step: string): void {
  const timing = userTiming();
  if (!timing) return;
  try {
    timing.mark(`rewind:${step}:start`);
    pending.add(step);
  } catch {
    // Timing is diagnostic only.
  }
}

export function markEnd(step: string): void {
  const timing = userTiming();
  if (!timing || !pending.has(step)) return;
  pending.delete(step);
  try {
    timing.mark(`rewind:${step}:end`);
    timing.measure(`rewind:${step}`, `rewind:${step}:start`, `rewind:${step}:end`);
  } catch {
    // Timing is diagnostic only.
  }
}

/** Launch (time origin) to the first usable screen, once per app start. */
export function markLaunchReady(): void {
  const timing = userTiming();
  if (!timing || launchMeasured) return;
  launchMeasured = true;
  try {
    timing.measure('rewind:launch-to-ready', { start: 0, end: timing.now() });
  } catch {
    // Timing is diagnostic only.
  }
}
