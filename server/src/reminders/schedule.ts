export const DEFAULT_GROUP_TIME_ZONE = 'UTC';

export function validateTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100 || !value.trim()) return null;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

function localParts(format: Intl.DateTimeFormat, time: Date) {
  const parts = Object.fromEntries(
    format.formatToParts(time).map(({ type, value }) => [type, value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function localTimestamp(parts: ReturnType<typeof localParts>) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** Resolve a wall-clock instant using the zone's actual offset at that instant. */
function resolveLocal(format: Intl.DateTimeFormat, wallTime: number): Date | null {
  let candidate = wallTime;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const observed = localTimestamp(localParts(format, new Date(candidate)));
    if (observed === wallTime) return new Date(candidate);
    candidate += wallTime - observed;
  }
  // A nonexistent local time is skipped rather than silently changing its hour.
  return null;
}

export function nextWeeklyReminderAt(after: Date, timeZone: string): string {
  const zone = validateTimeZone(timeZone);
  if (!zone || !Number.isFinite(after.getTime()))
    throw new RangeError('Invalid group reminder schedule.');
  const format = formatter(zone);
  const parts = localParts(format, after);
  const localDay = Date.UTC(parts.year, parts.month - 1, parts.day);
  const daysToSunday = (7 - new Date(localDay).getUTCDay()) % 7;
  const sunday = localDay + daysToSunday * 86_400_000 + 19 * 3_600_000;
  for (let week = 0; week < 3; week += 1) {
    const result = resolveLocal(format, sunday + week * 7 * 86_400_000);
    if (result && result.getTime() > after.getTime()) return result.toISOString();
  }
  throw new RangeError('No valid Sunday 19:00 reminder within the bounded schedule.');
}
