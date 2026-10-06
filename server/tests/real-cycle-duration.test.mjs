import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';

const { parseConfig } = await import('../dist/config.js');
const { createRealAccount } = await import('../dist/auth/index.js');
const { createRealGroup, REAL_CYCLE_DURATION_MS } = await import('../dist/groups/real.js');

const NOW = new Date('2026-10-04T08:00:00.000Z');

test('REWIND_REAL_CYCLE_MINUTES sets the real cycle length, defaulting to four weeks', () => {
  assert.equal(parseConfig({}).realCycleDurationMs, REAL_CYCLE_DURATION_MS);
  assert.equal(parseConfig({ REWIND_REAL_CYCLE_MINUTES: '1440' }).realCycleDurationMs, 86_400_000);
  assert.throws(() => parseConfig({ REWIND_REAL_CYCLE_MINUTES: '0' }), /REWIND_REAL_CYCLE_MINUTES/);
  assert.throws(
    () => parseConfig({ REWIND_REAL_CYCLE_MINUTES: '40321' }),
    /REWIND_REAL_CYCLE_MINUTES/,
  );
});

test('a new real group uses the configured first-cycle length', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-real-cycle-`);
  const database = openFixtureDatabase(parseConfig({ REWIND_DATA_DIR: dataDir }));
  try {
    const owner = await createRealAccount(
      database,
      'cycle-owner',
      'Cycle Owner',
      'synthetic cycle password',
      NOW,
    );
    assert.equal(owner.ok, true);
    const created = createRealGroup(
      database,
      owner.account,
      { name: 'Short cycle', prompt: 'Prompt', maxMembers: 3 },
      NOW,
      10 * 60_000,
    );
    assert.equal(created.cycle.endsAt, '2026-10-04T08:10:00.000Z');
    const cycle = database
      .prepare('SELECT starts_at AS startsAt, ends_at AS endsAt FROM cycles WHERE id = ?')
      .get(created.cycle.id);
    assert.equal(Date.parse(cycle.endsAt) - Date.parse(cycle.startsAt), 10 * 60_000);
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
