import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCycleEngine,
  advanceCycleLifecycle,
  publishCycleRelease,
} from '../dist/cycles/index.js';
import { withBoundaryRuntime } from './helpers/boundary-runtime.mjs';

test('cycle engine rejects invalid time inputs and preserves exact phase boundaries', () => {
  let now = new Date('2026-10-18T08:00:00.000Z');
  const engine = createCycleEngine(() => now);
  const window = engine.createWindow({ preset: 'one-day' });
  for (const [instant, phase, seconds] of [
    ['2026-10-18T07:59:59.999Z', 'upcoming', 86401],
    [window.startsAt, 'collecting', 86400],
    ['2026-10-19T07:59:59.999Z', 'collecting', 1],
    [window.endsAt, 'ended', 0],
  ]) {
    now = new Date(instant);
    assert.equal(engine.phase({ ...window, status: 'collecting' }), phase);
    assert.equal(engine.remainingSeconds(window), seconds);
  }
  for (const seconds of [0, -1, 0.5, NaN, Infinity])
    assert.throws(() => engine.advanceWindow(window, seconds), RangeError);
  assert.throws(() => engine.durationMs('unknown'), RangeError);
  assert.throws(() => engine.createWindow({ preset: 'one-day', startsAt: 'invalid' }), RangeError);
  now = new Date(NaN);
  assert.throws(() => engine.now(), RangeError);
});

test('invalid persisted cycle times fail atomically and a corrected cycle can still close', async () => {
  await withBoundaryRuntime(async (c) => {
    const owner = await c.account('cycle-time-owner');
    const group = await c.group(owner);
    const input = {
      groupId: group.group.id,
      cycleId: group.cycle.id,
      clock: () => new Date(group.cycle.endsAt),
    };
    const setTimes = c.database.prepare(
      'UPDATE cycles SET starts_at = ?, ends_at = ?, release_status = ?, release_published_at = ? WHERE id = ?',
    );
    for (const [startsAt, endsAt, release, published] of [
      ['invalid-start', group.cycle.endsAt, 'unpublished', null],
      [group.cycle.startsAt, 'invalid-end', 'unpublished', null],
      [group.cycle.endsAt, group.cycle.endsAt, 'unpublished', null],
      [group.cycle.startsAt, group.cycle.endsAt, 'published', null],
      [group.cycle.startsAt, group.cycle.endsAt, 'published', 'invalid-published'],
    ]) {
      setTimes.run(startsAt, endsAt, release, published, group.cycle.id);
      assert.deepEqual(advanceCycleLifecycle(c.database, input), {
        ok: false,
        reason: 'invalid_state',
      });
      assert.equal(
        c.database.prepare('SELECT status FROM cycles WHERE id = ?').get(group.cycle.id).status,
        'collecting',
      );
      assert.equal(
        c.database
          .prepare('SELECT COUNT(*) AS n FROM cycles WHERE group_id = ?')
          .get(group.group.id).n,
        1,
      );
      assert.equal(
        c.database
          .prepare('SELECT COUNT(*) AS n FROM media_jobs WHERE group_id = ?')
          .get(group.group.id).n,
        0,
      );
      assert.equal(
        c.database
          .prepare('SELECT COUNT(*) AS n FROM cycle_lifecycle_events WHERE group_id = ?')
          .get(group.group.id).n,
        0,
      );
    }
    setTimes.run(group.cycle.startsAt, group.cycle.endsAt, 'unpublished', null, group.cycle.id);
    const closed = advanceCycleLifecycle(c.database, input);
    assert.equal(closed.ok, true);
    assert.equal(closed.action, 'revealing');
    assert.equal(closed.nextCycle.startsAt, group.cycle.endsAt);
  });
});

test('invalid lifecycle clocks and foreign cycles cannot create successors or publish releases', async () => {
  await withBoundaryRuntime(async (c) => {
    const owner = await c.account('cycle-error-owner');
    const first = await c.group(owner);
    const second = await c.group(owner);
    const input = { groupId: first.group.id, cycleId: first.cycle.id, clock: c.now };
    const waiting = advanceCycleLifecycle(c.database, input);
    assert.equal(waiting.action, 'waiting_for_boundary');
    assert.equal(waiting.nextCycle, null);
    assert.deepEqual(advanceCycleLifecycle(c.database, { ...input, clock: () => new Date(NaN) }), {
      ok: false,
      reason: 'invalid_request',
    });
    assert.deepEqual(publishCycleRelease(c.database, { ...input, publishedAt: 'invalid' }), {
      ok: false,
      reason: 'invalid_request',
    });
    for (const cycleId of ['missing-cycle', second.cycle.id]) {
      assert.deepEqual(advanceCycleLifecycle(c.database, { ...input, cycleId }), {
        ok: false,
        reason: 'not_found',
      });
      assert.deepEqual(publishCycleRelease(c.database, { ...input, cycleId }), {
        ok: false,
        reason: 'not_found',
      });
    }
    assert.deepEqual(publishCycleRelease(c.database, input), { ok: false, reason: 'not_ready' });
    assert.equal(
      c.database.prepare('SELECT COUNT(*) AS n FROM cycles WHERE group_id = ?').get(first.group.id)
        .n,
      1,
    );
    assert.equal(
      c.database
        .prepare('SELECT COUNT(*) AS n FROM media_jobs WHERE group_id = ?')
        .get(first.group.id).n,
      0,
    );
    const closed = advanceCycleLifecycle(c.database, {
      ...input,
      clock: () => new Date(first.cycle.endsAt),
    });
    assert.equal(closed.action, 'revealing');
    assert.equal(closed.nextCycle.startsAt, first.cycle.endsAt);
    assert.equal(closed.nextCycle.contributionUsage.countUsed, 0);
    assert.deepEqual(
      publishCycleRelease(c.database, {
        ...input,
        publishedAt: new Date(Date.parse(first.cycle.endsAt) - 1),
      }),
      { ok: false, reason: 'too_early' },
    );
    assert.deepEqual(
      publishCycleRelease(c.database, { ...input, publishedAt: first.cycle.endsAt }),
      { ok: false, reason: 'not_ready' },
    );
    const repeated = advanceCycleLifecycle(c.database, {
      ...input,
      clock: () => new Date(first.cycle.endsAt),
    });
    assert.equal(repeated.action, 'waiting_for_release');
    assert.equal(repeated.nextCycle.id, closed.nextCycle.id);
    assert.equal(
      c.database.prepare('SELECT COUNT(*) AS n FROM cycles WHERE group_id = ?').get(first.group.id)
        .n,
      2,
    );
    assert.equal(
      c.database
        .prepare('SELECT COUNT(*) AS n FROM media_jobs WHERE group_id = ?')
        .get(first.group.id).n,
      1,
    );
  });
});
