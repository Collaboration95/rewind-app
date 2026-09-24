import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { deleteContribution } = await import('../dist/contributions/index.js');
const {
  ContributionLedgerQueryError,
  LEDGER_INDEX_NAME,
  ensureContributionLedgerSchema,
  contributionLedgerSchemaReady,
  linkContributionReplacement,
  listContributionLedger,
  parseLedgerLimit,
  parseLedgerState,
} = await import('../dist/contributions/ledger.js');
const { createClipUpload, recordClipMediaMetadata } = await import('../dist/media/index.js');

const validInput = {
  sourceUri: 'file:///tmp/ledger-clip.mp4',
  mimeType: 'video/mp4',
  byteLength: 1024,
  durationSeconds: 6,
  width: 720,
  height: 1280,
  hasAudio: true,
};

async function withLedgerDatabase(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-contribution-ledger-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  ensureContributionLedgerSchema(database);
  try {
    return await run({ config, database, dataDir });
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function registerMetadata(database, input = validInput) {
  recordClipMediaMetadata(database, {
    sourceUri: input.sourceUri,
    mimeType: 'video/mp4',
    byteLength: input.byteLength,
    durationSeconds: input.durationSeconds,
    width: input.width,
    height: input.height,
    hasAudio: true,
  });
}

/** Insert one clip contribution plus its job directly, so every state is
 * reachable without running FFmpeg. */
function insertContribution(database, options) {
  const {
    id,
    jobId,
    memberId = 'demo-1',
    durationSeconds = 4,
    createdAt = '2026-09-09T00:00:00.000Z',
    jobStatus = 'pending',
    errorCode = null,
    deletedAt = null,
  } = options;
  database
    .prepare(
      `INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at, deleted_at)
       VALUES (?, 'demo-cycle', ?, ?, ?, ?)`,
    )
    .run(id, memberId, durationSeconds, createdAt, deletedAt);
  if (jobId) {
    database
      .prepare(
        `INSERT INTO media_jobs
           (id, group_id, contribution_id, kind, status, output_path, created_at,
            error_code, progress, attempt_count, updated_at)
         VALUES (?, 'demo-group', ?, 'clip', ?, '/private/secret-output.mp4', ?, ?, ?, ?, ?)`,
      )
      .run(
        jobId,
        id,
        jobStatus,
        createdAt,
        errorCode,
        jobStatus === 'ready' ? 100 : 0,
        jobStatus === 'failed' ? 2 : 0,
        createdAt,
      );
  }
}

test('ledger schema is repaired idempotently and exposes its readiness probe', () => {
  return withLedgerDatabase(async ({ database }) => {
    assert.equal(contributionLedgerSchemaReady(database), true);
    ensureContributionLedgerSchema(database);
    ensureContributionLedgerSchema(database);
    assert.equal(contributionLedgerSchemaReady(database), true);

    const columns = database
      .prepare('PRAGMA table_info(contributions)')
      .all()
      .map((row) => row.name);
    assert.equal(columns.includes('replaced_by_contribution_id'), true);
    const indexes = database.prepare('PRAGMA index_list(contributions)').all();
    assert.equal(
      indexes.some((row) => row.name === LEDGER_INDEX_NAME),
      true,
    );
  });
});

test('the ledger reports every lifecycle state with duration and redacted metadata', () => {
  return withLedgerDatabase(async ({ database }) => {
    insertContribution(database, {
      id: 'c-queued',
      jobId: 'j-queued',
      jobStatus: 'pending',
      createdAt: '2026-09-09T00:00:00.000Z',
      durationSeconds: 3,
    });
    insertContribution(database, {
      id: 'c-processing',
      jobId: 'j-processing',
      jobStatus: 'processing',
      createdAt: '2026-09-09T01:00:00.000Z',
      durationSeconds: 5,
    });
    insertContribution(database, {
      id: 'c-sealed',
      jobId: 'j-sealed',
      jobStatus: 'ready',
      createdAt: '2026-09-09T02:00:00.000Z',
      durationSeconds: 7,
    });
    insertContribution(database, {
      id: 'c-failed',
      jobId: 'j-failed',
      jobStatus: 'failed',
      errorCode: 'process_failed',
      createdAt: '2026-09-09T03:00:00.000Z',
      durationSeconds: 2,
    });
    insertContribution(database, {
      id: 'c-deleted',
      jobId: 'j-deleted',
      jobStatus: 'deleted',
      deletedAt: '2026-09-09T04:30:00.000Z',
      createdAt: '2026-09-09T04:00:00.000Z',
      durationSeconds: 6,
    });

    const page = listContributionLedger(database, {
      groupId: 'demo-group',
      memberId: 'demo-1',
      limit: 50,
    });
    assert.equal(page.cycleId, 'demo-cycle');
    // The deterministic Demo fixture seeds one ready clip for demo-1, so the
    // ledger must report it as a real sealed entry rather than hide it.
    assert.deepEqual(
      page.entries.map((entry) => [entry.contributionId, entry.state]),
      [
        ['demo-contribution', 'sealed'],
        ['c-queued', 'queued'],
        ['c-processing', 'processing'],
        ['c-sealed', 'sealed'],
        ['c-failed', 'failed'],
        ['c-deleted', 'deleted'],
      ],
    );
    assert.equal(
      page.entries.find((entry) => entry.contributionId === 'demo-contribution').durationSeconds,
      3,
    );

    const byId = Object.fromEntries(page.entries.map((entry) => [entry.contributionId, entry]));
    assert.equal(byId['c-queued'].retryable, true);
    assert.equal(byId['c-processing'].retryable, false);
    assert.equal(byId['c-sealed'].retryable, false);
    assert.equal(byId['c-sealed'].durationSeconds, 7);
    assert.equal(byId['c-failed'].failureCategory, 'processing_failed');
    assert.equal(byId['c-failed'].attempts, 2);
    assert.equal(byId['c-processing'].progress, 0);
    assert.equal(byId['c-deleted'].restored.seconds, 6);
    assert.equal(byId['c-deleted'].replaced, false);
    assert.equal(byId['c-queued'].restored, null);

    // Sealed is a metadata label only: no capability, path, or share leaks.
    const serialized = JSON.stringify(page);
    assert.doesNotMatch(
      serialized,
      /private|secret-output|output_path|source_uri|download|share|thumbnail/i,
    );
    assert.deepEqual(Object.keys(byId['c-sealed']).sort(), [
      'attempts',
      'contributionId',
      'createdAt',
      'durationSeconds',
      'failureCategory',
      'jobId',
      'progress',
      'replaced',
      'restored',
      'retryable',
      'state',
      'updatedAt',
    ]);
  });
});

test('the ledger is self-only inside the selected group and current cycle', () => {
  return withLedgerDatabase(async ({ database }) => {
    database.exec(`
      INSERT INTO profiles (id, display_name, avatar_label, is_synthetic)
        VALUES ('ledger-outsider', 'Ledger Outsider', 'Ledger Outsider', 1);
      INSERT INTO groups (id, name, current_cycle_id)
        VALUES ('ledger-other-group', 'Ledger Other Group', 'ledger-other-cycle');
      INSERT INTO cycles
        (id, group_id, prompt, starts_at, ends_at, status, lock_state,
         max_count, max_seconds, count_used, seconds_used)
        VALUES ('ledger-other-cycle', 'ledger-other-group', 'Other prompt',
                '2026-09-08T00:00:00.000Z', '2026-09-15T00:00:00.000Z',
                'collecting', 'locked', 5, 30, 0, 0);
      INSERT INTO memberships (group_id, member_id, role, accepted_at)
        VALUES ('ledger-other-group', 'ledger-outsider', 'member', '2026-09-01T00:00:00.000Z');
      INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
        VALUES ('foreign-contribution', 'ledger-other-cycle', 'ledger-outsider', 4,
                '2026-09-09T00:00:00.000Z');
      INSERT INTO media_jobs (id, group_id, contribution_id, kind, status, created_at)
        VALUES ('foreign-job', 'ledger-other-group', 'foreign-contribution', 'clip', 'ready',
                '2026-09-09T00:00:00.000Z');
    `);
    insertContribution(database, { id: 'own-clip', jobId: 'own-job', jobStatus: 'ready' });
    insertContribution(database, {
      id: 'peer-clip',
      jobId: 'peer-job',
      memberId: 'demo-2',
      jobStatus: 'ready',
      createdAt: '2026-09-09T00:30:00.000Z',
    });

    const own = listContributionLedger(database, {
      groupId: 'demo-group',
      memberId: 'demo-1',
    });
    assert.deepEqual(
      own.entries.map((entry) => entry.contributionId),
      ['demo-contribution', 'own-clip'],
    );
    // A member cannot read another member's ledger by re-scoping the query.
    const peer = listContributionLedger(database, {
      groupId: 'demo-group',
      memberId: 'demo-2',
    });
    assert.deepEqual(
      peer.entries.map((entry) => entry.contributionId),
      ['peer-clip'],
    );
    const foreign = listContributionLedger(database, {
      groupId: 'ledger-other-group',
      memberId: 'ledger-outsider',
    });
    assert.deepEqual(
      foreign.entries.map((entry) => entry.contributionId),
      ['foreign-contribution'],
    );
    // The foreign cycle id proves the scope is resolved per group.
    assert.equal(foreign.cycleId, 'ledger-other-cycle');
    assert.equal(own.cycleId, 'demo-cycle');
  });
});

test('deletion stays deleted until an explicit accepted replacement links it', () => {
  return withLedgerDatabase(async ({ database }) => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const sourceUri = 'file:///tmp/ledger-replace.mp4';
    registerMetadata(database, { ...validInput, sourceUri, durationSeconds: 7 });
    const original = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      { ...validInput, sourceUri, durationSeconds: 7, idempotencyKey: 'ledger-original-key' },
      now,
    );
    assert.equal(original.ok, true);
    if (!original.ok) return;
    database
      .prepare("UPDATE media_jobs SET status = 'ready' WHERE id = ?")
      .run(original.upload.job.id);

    assert.equal(
      deleteContribution(database, 'demo-group', 'demo-1', original.upload.contribution.id, now).ok,
      true,
    );
    const afterDelete = listContributionLedger(database, {
      groupId: 'demo-group',
      memberId: 'demo-1',
      now,
    });
    const deletedEntry = afterDelete.entries.find(
      (entry) => entry.contributionId === original.upload.contribution.id,
    );
    assert.equal(deletedEntry.state, 'deleted');
    assert.equal(deletedEntry.replaced, false);
    assert.equal(deletedEntry.restored.seconds, 7);
    // The correction budget is now spent, which the ledger reports honestly.
    assert.equal(afterDelete.allowance.deletionsUsed, 1);
    assert.equal(afterDelete.allowance.deletionAvailability, 'used');

    registerMetadata(database, {
      ...validInput,
      sourceUri: 'file:///tmp/ledger-replacement.mp4',
      durationSeconds: 6,
    });
    const replacement = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      {
        ...validInput,
        sourceUri: 'file:///tmp/ledger-replacement.mp4',
        idempotencyKey: 'ledger-replacement-key',
      },
      now,
    );
    assert.equal(replacement.ok, true);
    if (!replacement.ok) return;

    // A normal accepted upload does not identify a deleted target. Until an
    // explicit replacement acceptance links these two rows, the old row must
    // remain deleted even when the new row was submitted in the same window.
    const unlinked = listContributionLedger(database, {
      groupId: 'demo-group',
      memberId: 'demo-1',
      now,
    });
    assert.equal(
      unlinked.entries.find((entry) => entry.contributionId === original.upload.contribution.id)
        .state,
      'deleted',
    );

    const link = linkContributionReplacement(
      database,
      'demo-group',
      'demo-1',
      original.upload.contribution.id,
      replacement.upload.contribution.id,
    );
    assert.deepEqual(link, {
      ok: true,
      replacedContributionId: original.upload.contribution.id,
      replacementContributionId: replacement.upload.contribution.id,
    });

    const afterLink = listContributionLedger(database, {
      groupId: 'demo-group',
      memberId: 'demo-1',
      now,
    });
    const replacedEntry = afterLink.entries.find(
      (entry) => entry.contributionId === original.upload.contribution.id,
    );
    const replacementEntry = afterLink.entries.find(
      (entry) => entry.contributionId === replacement.upload.contribution.id,
    );
    assert.equal(replacedEntry.state, 'replaced');
    assert.equal(replacedEntry.replaced, true);
    // Only the target changed; the replacement keeps its own live state.
    assert.equal(replacementEntry.state, 'queued');
    assert.equal(replacementEntry.replaced, false);
    // A relabel is refused, so history cannot be rewritten twice.
    assert.deepEqual(
      linkContributionReplacement(
        database,
        'demo-group',
        'demo-1',
        original.upload.contribution.id,
        replacement.upload.contribution.id,
      ),
      { ok: false, reason: 'already_replaced' },
    );
  });
});

test('replacement linking refuses cross-member, cross-window, and non-deleted targets', () => {
  return withLedgerDatabase(async ({ database }) => {
    insertContribution(database, {
      id: 'live-target',
      jobId: 'live-job',
      jobStatus: 'ready',
    });
    insertContribution(database, {
      id: 'other-member-target',
      jobId: 'other-member-job',
      memberId: 'demo-2',
      jobStatus: 'deleted',
      deletedAt: '2026-09-09T01:00:00.000Z',
      createdAt: '2026-09-09T00:00:00.000Z',
    });

    assert.deepEqual(
      linkContributionReplacement(database, 'demo-group', 'demo-1', 'live-target', 'live-target'),
      { ok: false, reason: 'target_mismatch' },
    );
    assert.deepEqual(
      linkContributionReplacement(
        database,
        'demo-group',
        'demo-1',
        'live-target',
        'other-member-target',
      ),
      { ok: false, reason: 'not_deleted' },
    );
    assert.deepEqual(
      linkContributionReplacement(
        database,
        'demo-group',
        'demo-1',
        'other-member-target',
        'live-target',
      ),
      { ok: false, reason: 'not_found' },
    );
    assert.deepEqual(
      linkContributionReplacement(
        database,
        'ledger-missing-group',
        'demo-1',
        'live-target',
        'other-member-target',
      ),
      { ok: false, reason: 'not_found' },
    );
    assert.equal(
      database
        .prepare('SELECT replaced_by_contribution_id AS linked FROM contributions WHERE id = ?')
        .get('live-target').linked,
      null,
    );
  });
});

test('ledger pagination is bounded and its cursor is bound to member and state', () => {
  return withLedgerDatabase(async ({ database }) => {
    for (let index = 0; index < 3; index += 1) {
      insertContribution(database, {
        id: `page-${index}`,
        jobId: `page-job-${index}`,
        jobStatus: 'pending',
        createdAt: `2026-09-09T0${index}:00:00.000Z`,
      });
    }
    insertContribution(database, {
      id: 'page-ready',
      jobId: 'page-ready-job',
      jobStatus: 'ready',
      createdAt: '2026-09-09T05:00:00.000Z',
    });

    const first = listContributionLedger(database, {
      groupId: 'demo-group',
      memberId: 'demo-1',
      state: 'queued',
      limit: 2,
    });
    assert.deepEqual(
      first.entries.map((entry) => entry.contributionId),
      ['page-0', 'page-1'],
    );
    assert.equal(first.pagination.hasMore, true);
    assert.equal(first.pagination.limit, 2);

    const second = listContributionLedger(database, {
      groupId: 'demo-group',
      memberId: 'demo-1',
      state: 'queued',
      limit: 2,
      cursor: first.pagination.nextCursor,
    });
    assert.deepEqual(
      second.entries.map((entry) => entry.contributionId),
      ['page-2'],
    );
    assert.equal(second.pagination.hasMore, false);
    assert.equal(second.pagination.nextCursor, null);

    // A cursor minted for one member or state cannot be replayed for another.
    assert.throws(
      () =>
        listContributionLedger(database, {
          groupId: 'demo-group',
          memberId: 'demo-2',
          state: 'queued',
          limit: 2,
          cursor: first.pagination.nextCursor,
        }),
      ContributionLedgerQueryError,
    );
    assert.throws(
      () =>
        listContributionLedger(database, {
          groupId: 'demo-group',
          memberId: 'demo-1',
          state: 'sealed',
          limit: 2,
          cursor: first.pagination.nextCursor,
        }),
      ContributionLedgerQueryError,
    );
    assert.throws(
      () =>
        listContributionLedger(database, {
          groupId: 'demo-group',
          memberId: 'demo-1',
          cursor: 'not-a-cursor',
        }),
      ContributionLedgerQueryError,
    );

    assert.deepEqual(parseLedgerState('sealed'), 'sealed');
    assert.equal(parseLedgerState(''), undefined);
    assert.throws(() => parseLedgerState('processing-ish'), ContributionLedgerQueryError);
    assert.equal(parseLedgerLimit(undefined), 50);
    assert.throws(() => parseLedgerLimit(0), ContributionLedgerQueryError);
    assert.throws(() => parseLedgerLimit(101), ContributionLedgerQueryError);
    assert.throws(
      () => listContributionLedger(database, { groupId: '', memberId: 'demo-1' }),
      ContributionLedgerQueryError,
    );
  });
});

test('ledger allowance impact tracks the current window and cycle phase', () => {
  return withLedgerDatabase(async ({ database }) => {
    // The seeded fixture cycle starts at seed time and runs one day, so an
    // explicit clock lands inside it regardless of when the suite runs.
    const cycle = database
      .prepare('SELECT starts_at AS startsAt, ends_at AS endsAt FROM cycles WHERE id = ?')
      .get('demo-cycle');
    const cycleStart = new Date(cycle.startsAt);
    const inside = new Date(cycleStart.getTime() + 60_000);
    const afterEnd = new Date(new Date(cycle.endsAt).getTime() + 60_000);

    // Before any submission the ledger reports a truthful empty allowance.
    const empty = listContributionLedger(database, {
      groupId: 'demo-group',
      memberId: 'demo-3',
      now: inside,
    });
    assert.deepEqual(empty.entries, []);
    assert.equal(empty.allowance.deletionsUsed, 0);
    assert.equal(empty.allowance.deletionAvailability, 'available');

    const sourceUri = 'file:///tmp/ledger-allowance.mp4';
    registerMetadata(database, { ...validInput, sourceUri, durationSeconds: 6 });
    const upload = createClipUpload(
      database,
      'demo-group',
      'demo-3',
      { ...validInput, sourceUri, durationSeconds: 6, idempotencyKey: 'ledger-allowance-key' },
      inside,
    );
    assert.equal(upload.ok, true);
    if (!upload.ok) return;
    database
      .prepare("UPDATE media_jobs SET status = 'ready' WHERE id = ?")
      .run(upload.upload.job.id);

    const reserved = listContributionLedger(database, {
      groupId: 'demo-group',
      memberId: 'demo-3',
      now: inside,
    });
    assert.equal(reserved.allowance.countUsed, 1);
    assert.equal(reserved.allowance.secondsUsed, 6);
    assert.equal(reserved.allowance.maxCount, 5);
    assert.equal(reserved.allowance.maxSeconds, 30);
    assert.equal(reserved.entries[0].state, 'sealed');

    // Once the cycle is no longer collecting, a correction is unavailable even
    // though the window still records zero deletions used.
    const closed = listContributionLedger(database, {
      groupId: 'demo-group',
      memberId: 'demo-3',
      now: afterEnd,
    });
    assert.equal(closed.allowance.deletionsUsed, 0);
    assert.equal(closed.allowance.deletionAvailability, 'unavailable');
    // Media stays metadata-only in every phase, including after the boundary.
    assert.equal(closed.entries[0].state, 'sealed');
    assert.doesNotMatch(JSON.stringify(closed), /private|output_path|source_uri|download|share/i);
  });
});

test('current-week allowance does not inherit usage or correction from the previous week', () => {
  return withLedgerDatabase(async ({ database }) => {
    const cycle = database
      .prepare('SELECT starts_at AS startsAt FROM cycles WHERE id = ?')
      .get('demo-cycle');
    const start = new Date(cycle.startsAt);
    const lastWeek = start.toISOString();
    const lastWeekEnd = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const current = new Date(start.getTime() + 8 * 24 * 60 * 60 * 1000);
    database
      .prepare(
        `INSERT INTO contribution_quota_windows
          (id, cycle_id, member_id, window_start_at, window_end_at,
           max_count, max_seconds, count_used, seconds_used, deletions_used)
         VALUES ('prior-week', 'demo-cycle', 'demo-4', ?, ?, 5, 30, 4, 26, 1)`,
      )
      .run(lastWeek, lastWeekEnd);

    const page = listContributionLedger(database, {
      groupId: 'demo-group',
      memberId: 'demo-4',
      now: current,
    });
    assert.deepEqual(page.allowance, {
      maxCount: 5,
      maxSeconds: 30,
      countUsed: 0,
      secondsUsed: 0,
      deletionsUsed: 0,
      deletionAvailability: 'available',
    });
  });
});
