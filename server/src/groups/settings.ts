import type { RewindDatabase } from '../db';
import { getRealGroup } from './real';
import { nextWeeklyReminderAt, validateTimeZone } from '../reminders/schedule';

export function updateRealGroupSettings(
  database: RewindDatabase,
  accountId: string,
  groupId: string,
  input: { prompt: unknown; timeZone: unknown },
  now = new Date(),
  authorize: () => boolean = () => true,
) {
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.trim().length > 160)
    return { ok: false as const, reason: 'invalid_settings' };
  const timeZone = validateTimeZone(input.timeZone);
  if (!timeZone) return { ok: false as const, reason: 'invalid_settings' };
  database.exec('BEGIN IMMEDIATE');
  try {
    const group = getRealGroup(database, accountId, groupId);
    if (!authorize() || !group || group.group.role !== 'owner') {
      database.exec('ROLLBACK');
      return { ok: false as const, reason: 'forbidden' };
    }
    if (group.cycle.status !== 'collecting' || Date.parse(group.cycle.endsAt) <= now.getTime()) {
      database.exec('ROLLBACK');
      return { ok: false as const, reason: 'cycle_closed' };
    }
    database
      .prepare('UPDATE real_group_metadata SET time_zone = ? WHERE group_id = ?')
      .run(timeZone, groupId);
    database
      .prepare(
        "UPDATE cycles SET prompt = ? WHERE id = ? AND group_id = ? AND status = 'collecting'",
      )
      .run(input.prompt.trim(), group.cycle.id, groupId);
    database.exec('COMMIT');
    return { ok: true as const, group: getRealGroup(database, accountId, groupId) };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function getRealReminderPreference(
  database: RewindDatabase,
  accountId: string,
  groupId: string,
  now = new Date(),
) {
  const group = getRealGroup(database, accountId, groupId);
  if (!group) return null;
  const row = database
    .prepare(
      'SELECT enabled, snoozed_until AS snoozedUntil FROM real_group_reminder_preferences WHERE group_id = ? AND account_id = ?',
    )
    .get(groupId, accountId) as { enabled: number; snoozedUntil: string | null } | undefined;
  return {
    enabled: row?.enabled === 1,
    snoozedUntil:
      row?.snoozedUntil && Date.parse(row.snoozedUntil) > now.getTime() ? row.snoozedUntil : null,
    timeZone: group.group.timeZone,
    nextScheduledAt: nextWeeklyReminderAt(now, group.group.timeZone),
    delivery: {
      state: 'not-configured',
      message: 'Reminder delivery is not configured. Your preference is saved for this group.',
    },
  };
}

export function updateRealReminderPreference(
  database: RewindDatabase,
  accountId: string,
  groupId: string,
  input: { enabled: unknown; snoozedUntil: unknown },
  now = new Date(),
  authorize: () => boolean = () => true,
) {
  if (typeof input.enabled !== 'boolean' || !Number.isFinite(now.getTime()))
    return { ok: false as const, reason: 'invalid_preference' };
  const snoozedUntil = input.snoozedUntil;
  if (
    snoozedUntil !== null &&
    (typeof snoozedUntil !== 'string' ||
      !Number.isFinite(Date.parse(snoozedUntil)) ||
      Date.parse(snoozedUntil) <= now.getTime() ||
      Date.parse(snoozedUntil) > now.getTime() + 31 * 86_400_000)
  )
    return { ok: false as const, reason: 'invalid_preference' };
  database.exec('BEGIN IMMEDIATE');
  try {
    if (!authorize() || !getRealGroup(database, accountId, groupId)) {
      database.exec('ROLLBACK');
      return { ok: false as const, reason: 'forbidden' };
    }
    database
      .prepare(
        `INSERT INTO real_group_reminder_preferences (group_id, account_id, enabled, snoozed_until, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(group_id, account_id) DO UPDATE SET
      enabled = excluded.enabled, snoozed_until = excluded.snoozed_until, updated_at = excluded.updated_at`,
      )
      .run(
        groupId,
        accountId,
        input.enabled ? 1 : 0,
        snoozedUntil === null ? null : new Date(snoozedUntil as string).toISOString(),
        now.toISOString(),
      );
    database.exec('COMMIT');
    return {
      ok: true as const,
      preference: getRealReminderPreference(database, accountId, groupId, now),
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
