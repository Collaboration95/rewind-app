import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { migrateDatabase, openDatabase, openDatabaseAt } = await import('../dist/db.js');
const {
  claimCompilationJob,
  createCompilationJob,
  getCompilationJob,
  reconcileCompilationJobInputs,
  updateCompilationJobProgress,
} = await import('../dist/jobs/index.js');
const { advanceCycleLifecycle } = await import('../dist/cycles/index.js');

async function withDatabase(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-compilation-jobs-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  try {
    return await run({ config, database, dataDir });
  } finally {
    try {
      database.close();
    } catch {
      // A restart test may already have closed this handle.
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('cycle boundary creates one persistent film job from processed non-raw clips', async () => {
  await withDatabase(async ({ database }) => {
    database
      .prepare('UPDATE cycles SET starts_at = ?, ends_at = ? WHERE id = ?')
      .run('2026-09-10T00:00:00.000Z', '2026-09-11T00:00:00.000Z', 'demo-cycle');
    database.exec(`
      INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
        VALUES ('safe-contribution', 'demo-cycle', 'demo-2', 4, '2026-09-10T01:00:00.000Z');
      INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, output_path, created_at, source_path)
        VALUES ('safe-clip', 'demo-group', 'safe-contribution', 'clip', 'ready',
                '/private/processed/safe.mp4', '2026-09-10T01:00:00.000Z', NULL);
      INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
        VALUES ('raw-contribution', 'demo-cycle', 'demo-3', 4, '2026-09-10T02:00:00.000Z');
      INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, output_path, created_at, source_path)
        VALUES ('raw-clip', 'demo-group', 'raw-contribution', 'clip', 'ready',
                '/private/processed/raw.mp4', '2026-09-10T02:00:00.000Z', '/private/raw.mp4');
      INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
        VALUES ('pending-contribution', 'demo-cycle', 'demo-4', 4, '2026-09-10T03:00:00.000Z');
      INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, output_path, created_at, source_path)
        VALUES ('pending-clip', 'demo-group', 'pending-contribution', 'clip', 'pending',
                NULL, '2026-09-10T03:00:00.000Z', '/private/raw-pending.mp4');
      INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at, deleted_at)
        VALUES ('deleted-contribution', 'demo-cycle', 'demo-2', 4,
                '2026-09-10T04:00:00.000Z', '2026-09-10T04:01:00.000Z');
      INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, output_path, created_at, source_path)
        VALUES ('deleted-clip', 'demo-group', 'deleted-contribution', 'clip', 'ready',
                '/private/processed/deleted.mp4', '2026-09-10T04:00:00.000Z', NULL);
    `);

    const transitioned = advanceCycleLifecycle(database, {
      groupId: 'demo-group',
      clock: () => new Date('2026-09-11T00:00:00.000Z'),
    });
    assert.equal(transitioned.ok, true);
    const films = database
      .prepare(
        `SELECT id, status, cycle_id AS cycleId, input_count AS inputCount,
                progress, completed_count AS completedCount
         FROM media_jobs WHERE kind = 'film' AND cycle_id = 'demo-cycle'`,
      )
      .all();
    assert.equal(films.length, 1);
    assert.equal(films[0].status, 'pending');
    assert.equal(films[0].inputCount, 1);
    assert.equal(films[0].progress, 0);
    assert.equal(films[0].completedCount, 0);
    assert.deepEqual(
      database
        .prepare(
          'SELECT clip_job_id AS clipJobId FROM compilation_job_inputs WHERE job_id = ? ORDER BY position',
        )
        .all(films[0].id)
        .map((row) => ({ clipJobId: row.clipJobId })),
      [{ clipJobId: 'safe-clip' }],
    );

    const repeat = advanceCycleLifecycle(database, {
      groupId: 'demo-group',
      clock: () => new Date('2026-09-11T00:01:00.000Z'),
    });
    assert.equal(repeat.action, 'waiting_for_release');
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM media_jobs WHERE kind = 'film' AND cycle_id IS NOT NULL",
        )
        .get().count,
      1,
    );
    const existing = createCompilationJob(database, {
      groupId: 'demo-group',
      cycleId: 'demo-cycle',
    });
    assert.equal(existing.ok, true);
    assert.equal(existing.created, false);
  });
});

test('compilation claims and progress survive a restart without duplicate jobs', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    database.prepare('UPDATE cycles SET status = ? WHERE id = ?').run('revealing', 'demo-cycle');
    database.exec(`
      INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
        VALUES ('restart-contribution', 'demo-cycle', 'demo-2', 4, '2026-09-10T01:00:00.000Z');
      INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, output_path, created_at, source_path)
        VALUES ('restart-clip', 'demo-group', 'restart-contribution', 'clip', 'ready',
                '/private/processed/restart.mp4', '2026-09-10T01:00:00.000Z', NULL);
    `);
    const created = createCompilationJob(database, {
      groupId: 'demo-group',
      cycleId: 'demo-cycle',
      createdAt: '2026-09-11T00:00:00.000Z',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const firstClaim = claimCompilationJob(database, {
      jobId: created.job.id,
      now: '2026-09-11T00:00:00.000Z',
    });
    assert.equal(firstClaim.ok, true);
    if (!firstClaim.ok) return;
    assert.equal(firstClaim.action, 'claimed');
    assert.equal(firstClaim.job.claimGeneration, 1);
    assert.equal(
      updateCompilationJobProgress(database, {
        jobId: created.job.id,
        claimGeneration: firstClaim.job.claimGeneration,
        completedCount: 1,
        now: '2026-09-11T00:00:00.000Z',
      }).progress,
      100,
    );
    const beforeRestart = database
      .prepare('SELECT COUNT(*) AS count FROM media_jobs WHERE kind = ? AND cycle_id = ?')
      .get('film', 'demo-cycle').count;
    assert.equal(beforeRestart, 1);
    const databasePath = config.databasePath;
    database.close();

    const reopened = openDatabaseAt(databasePath);
    try {
      const job = getCompilationJob(reopened, created.job.id);
      assert.equal(job.inputCount, 1);
      assert.equal(job.completedCount, 1);
      const active = claimCompilationJob(reopened, {
        jobId: created.job.id,
        now: '2026-09-11T00:01:00.000Z',
      });
      assert.equal(active.ok, true);
      assert.equal(active.action, 'already_processing');
      const resumed = claimCompilationJob(reopened, {
        jobId: created.job.id,
        now: '2026-09-11T00:16:00.000Z',
      });
      assert.equal(resumed.ok, true);
      assert.equal(resumed.action, 'claimed');
      assert.equal(resumed.job.claimGeneration, 2);
      assert.equal(
        reopened
          .prepare(
            "SELECT COUNT(*) AS count FROM media_jobs WHERE kind = 'film' AND cycle_id IS NOT NULL",
          )
          .get().count,
        1,
      );
    } finally {
      reopened.close();
    }
  });
});

test('compilation excludes tombstones and a worker claim reconciles stale inputs atomically', async () => {
  await withDatabase(async ({ database }) => {
    database.prepare('UPDATE cycles SET status = ? WHERE id = ?').run('revealing', 'demo-cycle');
    database.exec(`
      INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
        VALUES ('reconcile-valid', 'demo-cycle', 'demo-2', 4, '2026-09-10T01:00:00.000Z'),
               ('reconcile-deleted', 'demo-cycle', 'demo-3', 4, '2026-09-10T02:00:00.000Z'),
               ('reconcile-pending', 'demo-cycle', 'demo-4', 4, '2026-09-10T03:00:00.000Z'),
               ('reconcile-kind', 'demo-cycle', 'demo-2', 4, '2026-09-10T04:00:00.000Z');
      INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, output_path, created_at, source_path)
        VALUES ('reconcile-valid-clip', 'demo-group', 'reconcile-valid', 'clip', 'ready',
                '/private/processed/reconcile-valid.mp4', '2026-09-10T01:00:00.000Z', NULL),
               ('reconcile-deleted-clip', 'demo-group', 'reconcile-deleted', 'clip', 'ready',
                '/private/processed/reconcile-deleted.mp4', '2026-09-10T02:00:00.000Z', NULL),
               ('reconcile-pending-clip', 'demo-group', 'reconcile-pending', 'clip', 'pending',
                NULL, '2026-09-10T03:00:00.000Z', '/private/raw-pending.mp4'),
               ('reconcile-wrong-kind', 'demo-group', 'reconcile-kind', 'film', 'ready',
                '/private/processed/reconcile-film.mp4', '2026-09-10T04:00:00.000Z', NULL);
      UPDATE contributions SET deleted_at = '2026-09-10T05:00:00.000Z'
        WHERE id = 'reconcile-deleted';
    `);
    const created = createCompilationJob(database, {
      groupId: 'demo-group',
      cycleId: 'demo-cycle',
      createdAt: '2026-09-11T00:00:00.000Z',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    database
      .prepare(
        `INSERT INTO compilation_job_inputs (job_id, clip_job_id, contribution_id, position)
         VALUES (?, 'reconcile-deleted-clip', 'reconcile-deleted', 1),
                (?, 'reconcile-pending-clip', 'reconcile-pending', 2),
                (?, 'reconcile-wrong-kind', 'reconcile-kind', 3)`,
      )
      .run(created.job.id, created.job.id, created.job.id);
    database
      .prepare(
        `UPDATE media_jobs SET input_count = 4, completed_count = 3, progress = 75 WHERE id = ?`,
      )
      .run(created.job.id);

    const reconciled = reconcileCompilationJobInputs(database, created.job.id);
    assert.equal(reconciled?.inputCount, 1);
    assert.equal(reconciled?.completedCount, 1);
    assert.equal(reconciled?.progress, 100);
    assert.deepEqual(reconciled?.clipJobIds, ['reconcile-valid-clip']);
    assert.deepEqual(
      database
        .prepare(
          'SELECT clip_job_id AS clipJobId, contribution_id AS contributionId, position FROM compilation_job_inputs WHERE job_id = ?',
        )
        .all(created.job.id)
        .map((row) => ({ ...row })),
      [{ clipJobId: 'reconcile-valid-clip', contributionId: 'reconcile-valid', position: 0 }],
    );

    // Reintroduce a tombstoned input to prove the worker's claim path repeats
    // the same fence immediately before it hands the snapshot to a consumer.
    database
      .prepare(
        `INSERT INTO compilation_job_inputs (job_id, clip_job_id, contribution_id, position)
         VALUES (?, 'reconcile-deleted-clip', 'reconcile-deleted', 1)`,
      )
      .run(created.job.id);
    const claimed = claimCompilationJob(database, {
      jobId: created.job.id,
      now: '2026-09-11T00:00:00.000Z',
    });
    assert.equal(claimed.ok, true);
    if (claimed.ok) {
      assert.equal(claimed.action, 'claimed');
      assert.deepEqual(claimed.job.clipJobIds, ['reconcile-valid-clip']);
      assert.equal(claimed.job.inputCount, 1);
    }
  });
});

test('progress heartbeats renew only the current fenced claim lease', async () => {
  await withDatabase(async ({ database }) => {
    database.prepare('UPDATE cycles SET status = ? WHERE id = ?').run('revealing', 'demo-cycle');
    database.exec(`
      INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
        VALUES ('lease-contribution', 'demo-cycle', 'demo-2', 4, '2026-09-10T01:00:00.000Z');
      INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, output_path, created_at, source_path)
        VALUES ('lease-clip', 'demo-group', 'lease-contribution', 'clip', 'ready',
                '/private/processed/lease.mp4', '2026-09-10T01:00:00.000Z', NULL);
    `);
    const created = createCompilationJob(database, {
      groupId: 'demo-group',
      cycleId: 'demo-cycle',
      createdAt: '2026-09-11T00:00:00.000Z',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const claimed = claimCompilationJob(database, {
      jobId: created.job.id,
      now: '2026-09-11T00:00:00.000Z',
      leaseMs: 1000,
    });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;

    const renewed = updateCompilationJobProgress(database, {
      jobId: created.job.id,
      claimGeneration: claimed.job.claimGeneration,
      completedCount: 0,
      now: '2026-09-11T00:00:00.900Z',
    });
    assert.equal(renewed?.processingStartedAt, '2026-09-11T00:00:00.900Z');
    const stillOwned = claimCompilationJob(database, {
      jobId: created.job.id,
      now: '2026-09-11T00:00:01.500Z',
      leaseMs: 1000,
    });
    assert.equal(stillOwned.ok, true);
    assert.equal(stillOwned.action, 'already_processing');

    const reclaimed = claimCompilationJob(database, {
      jobId: created.job.id,
      now: '2026-09-11T00:00:02.000Z',
      leaseMs: 1000,
    });
    assert.equal(reclaimed.ok, true);
    if (!reclaimed.ok) return;
    assert.equal(reclaimed.action, 'claimed');
    assert.equal(reclaimed.job.claimGeneration, claimed.job.claimGeneration + 1);
    assert.equal(
      updateCompilationJobProgress(database, {
        jobId: created.job.id,
        claimGeneration: claimed.job.claimGeneration,
        completedCount: 1,
        now: '2026-09-11T00:00:02.100Z',
      }),
      null,
    );
    assert.equal(
      database
        .prepare('SELECT claim_generation AS claimGeneration FROM media_jobs WHERE id = ?')
        .get(created.job.id).claimGeneration,
      reclaimed.job.claimGeneration,
    );
  });
});

test('recorded compilation migration repairs malformed input shape and keeps valid rows', async () => {
  await withDatabase(async ({ database }) => {
    database.exec(`
      DROP INDEX compilation_job_inputs_order_idx;
      DROP INDEX media_jobs_cycle_idx;
      DROP INDEX media_jobs_one_film_per_cycle_idx;
      ALTER TABLE compilation_job_inputs RENAME TO compilation_job_inputs_broken;
      CREATE TABLE compilation_job_inputs (
        job_id TEXT,
        clip_job_id TEXT,
        contribution_id TEXT,
        position TEXT
      );
      INSERT INTO compilation_job_inputs VALUES
        ('demo-film', 'demo-clip', 'demo-contribution', '0'),
        ('demo-film', 'demo-clip', 'demo-contribution', '1'),
        ('missing-job', 'demo-clip', 'demo-contribution', '2'),
        ('demo-film', 'demo-clip', 'missing-contribution', '3'),
        ('demo-film', 'demo-clip', 'demo-contribution', '-1');
      DROP TABLE compilation_job_inputs_broken;
      CREATE INDEX media_jobs_cycle_idx ON media_jobs (kind);
      CREATE INDEX media_jobs_one_film_per_cycle_idx ON media_jobs (cycle_id);
    `);
    // The durable migration receipt remains present; migrateDatabase must use
    // the shape validator and repair rather than trusting the receipt.
    const { migrateDatabase } = await import('../dist/db.js');
    migrateDatabase(database);

    assert.equal(
      database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'compilation_job_inputs'",
        )
        .get()
        .sql.includes('REFERENCES media_jobs'),
      true,
    );
    assert.deepEqual(
      database
        .prepare(
          'SELECT job_id AS jobId, clip_job_id AS clipJobId, contribution_id AS contributionId, position FROM compilation_job_inputs',
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          jobId: 'demo-film',
          clipJobId: 'demo-clip',
          contributionId: 'demo-contribution',
          position: 0,
        },
      ],
    );
    assert.deepEqual(
      database
        .prepare('PRAGMA foreign_key_list(compilation_job_inputs)')
        .all()
        .map((row) => ({ from: row.from, table: row.table, onDelete: row.on_delete }))
        .sort((left, right) => left.from.localeCompare(right.from)),
      [
        { from: 'clip_job_id', table: 'media_jobs', onDelete: 'CASCADE' },
        { from: 'contribution_id', table: 'contributions', onDelete: 'CASCADE' },
        { from: 'job_id', table: 'media_jobs', onDelete: 'CASCADE' },
      ],
    );
    assert.deepEqual(
      database
        .prepare('PRAGMA index_info(compilation_job_inputs_order_idx)')
        .all()
        .map((row) => row.name),
      ['job_id', 'position'],
    );
    assert.deepEqual(
      database
        .prepare('PRAGMA index_info(media_jobs_cycle_idx)')
        .all()
        .map((row) => row.name),
      ['cycle_id', 'kind', 'created_at'],
    );
  });
});

test('recorded deletion migration repairs a malformed active-contribution index', async () => {
  await withDatabase(async ({ database }) => {
    database.exec(`
      DROP INDEX contributions_active_cycle_idx;
      CREATE INDEX contributions_active_cycle_idx ON contributions (member_id);
    `);
    // Migration 010 is already recorded on a fresh install. Its durable
    // marker must not suppress shape repair on the next process start.
    migrateDatabase(database);
    assert.deepEqual(
      database
        .prepare('PRAGMA index_info(contributions_active_cycle_idx)')
        .all()
        .map((row) => row.name),
      ['cycle_id', 'member_id', 'deleted_at', 'created_at'],
    );
  });
});
