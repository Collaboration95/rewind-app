import { randomUUID } from 'node:crypto';

import { advanceCycleWindow, type CycleClock } from './engine';
import { getCurrentCycle, type RewindDatabase } from '../db';
import { authorizeOwner, SAFE_DENIAL, type DeniedDecision } from '../policy';

export { CYCLE_DURATION_MS, createCycleEngine } from './engine';
export type { CycleClock, CycleDurationPreset } from './engine';

export const MAX_DEMO_ADVANCE_SECONDS = 28 * 24 * 60 * 60;

export interface AdvanceDemoCycleInput {
  groupId: string;
  actingMemberId: string | null | undefined;
  advanceSeconds: number;
  clock?: CycleClock;
}

export interface CycleAdvanceSuccess {
  ok: true;
  cycle: ReturnType<typeof getCurrentCycle>;
  eventId: string;
  advanceSeconds: number;
}

export type CycleAdvanceFailure =
  DeniedDecision | { ok: false; reason: 'invalid_request' } | { ok: false; reason: 'not_found' };
export type AdvanceDemoCycleResult = CycleAdvanceSuccess | CycleAdvanceFailure;

/**
 * Advance only a persisted local demonstration cycle. Authorization is
 * deliberately checked before input validation so non-owners receive the
 * same denial regardless of the requested amount or resource existence.
 */
export function advanceDemoCycle(
  database: RewindDatabase,
  input: AdvanceDemoCycleInput,
): AdvanceDemoCycleResult {
  const ownerDecision = authorizeOwner(database, input.groupId, input.actingMemberId);
  if (!ownerDecision.allowed) return SAFE_DENIAL;
  const actingMemberId = input.actingMemberId;
  if (!actingMemberId) return SAFE_DENIAL;
  if (
    !Number.isSafeInteger(input.advanceSeconds) ||
    input.advanceSeconds <= 0 ||
    input.advanceSeconds > MAX_DEMO_ADVANCE_SECONDS
  ) {
    return { ok: false, reason: 'invalid_request' };
  }

  const occurredAt = (input.clock ?? (() => new Date()))().toISOString();
  const eventId = `cycle-control-${randomUUID()}`;

  database.exec('BEGIN IMMEDIATE');
  try {
    const current = getCurrentCycle(database, input.groupId);
    if (!current) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    const nextWindow = advanceCycleWindow(current, input.advanceSeconds);
    database
      .prepare('UPDATE cycles SET starts_at = ?, ends_at = ? WHERE id = ? AND group_id = ?')
      .run(nextWindow.startsAt, nextWindow.endsAt, current.id, input.groupId);
    database
      .prepare(
        `INSERT INTO cycle_control_events
          (id, cycle_id, group_id, actor_member_id, advance_seconds,
           previous_starts_at, previous_ends_at, next_starts_at, next_ends_at, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        current.id,
        input.groupId,
        actingMemberId,
        input.advanceSeconds,
        current.startsAt,
        current.endsAt,
        nextWindow.startsAt,
        nextWindow.endsAt,
        occurredAt,
      );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  const cycle = getCurrentCycle(database, input.groupId);
  if (!cycle) return { ok: false, reason: 'not_found' };
  return { ok: true, cycle, eventId, advanceSeconds: input.advanceSeconds };
}
