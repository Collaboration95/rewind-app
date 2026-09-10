import { randomUUID } from 'node:crypto';

import type { RewindDatabase } from '../db';
import { getGroup, getCurrentCycle } from '../db';
import { createCycleWindow } from '../cycles/engine';

export const GROUP_NAME_MAX_LENGTH = 80;
export const PROMPT_MAX_LENGTH = 160;

export interface CreateGroupInput {
  name: string;
  prompt: string;
  now?: Date;
}

export type CreateGroupResult =
  | { ok: true; group: ReturnType<typeof getGroup>; cycle: ReturnType<typeof getCurrentCycle> }
  | { ok: false; field: 'name' | 'prompt' | 'owner'; reason: 'required' | 'too_long' | 'invalid' };

function normalize(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

export function createGroup(
  database: RewindDatabase,
  ownerMemberId: string,
  input: CreateGroupInput,
): CreateGroupResult {
  const name = normalize(input.name);
  const prompt = normalize(input.prompt);
  if (!name) return { ok: false, field: 'name', reason: 'required' };
  if (name.length > GROUP_NAME_MAX_LENGTH) return { ok: false, field: 'name', reason: 'too_long' };
  if (!prompt) return { ok: false, field: 'prompt', reason: 'required' };
  if (prompt.length > PROMPT_MAX_LENGTH) return { ok: false, field: 'prompt', reason: 'too_long' };

  const owner = database
    .prepare('SELECT id FROM profiles WHERE id = ? AND is_synthetic = 1')
    .get(ownerMemberId) as { id?: string } | undefined;
  if (!owner?.id) return { ok: false, field: 'owner', reason: 'invalid' };

  const startedAt = (input.now ?? new Date()).toISOString();
  const groupId = `local-group-${randomUUID()}`;
  const cycleId = `local-cycle-${randomUUID()}`;
  const { endsAt } = createCycleWindow({ preset: 'one-day', startsAt: startedAt });

  database.exec('BEGIN');
  try {
    database
      .prepare('INSERT INTO groups (id, name, current_cycle_id) VALUES (?, ?, NULL)')
      .run(groupId, name);
    database
      .prepare(
        `INSERT INTO cycles
          (id, group_id, prompt, starts_at, ends_at, status, lock_state, max_count, max_seconds, count_used, seconds_used)
         VALUES (?, ?, ?, ?, ?, 'collecting', 'locked', 5, 30, 0, 0)`,
      )
      .run(cycleId, groupId, prompt, startedAt, endsAt);
    database.prepare('UPDATE groups SET current_cycle_id = ? WHERE id = ?').run(cycleId, groupId);
    database
      .prepare(
        "INSERT INTO memberships (group_id, member_id, role, accepted_at) VALUES (?, ?, 'owner', ?)",
      )
      .run(groupId, ownerMemberId, startedAt);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  return {
    ok: true,
    group: getGroup(database, groupId, ownerMemberId),
    cycle: getCurrentCycle(database, groupId),
  };
}
