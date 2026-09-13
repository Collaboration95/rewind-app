import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase, openDatabaseAt } = await import('../dist/db.js');
const {
  claimCompilationJob,
  createCompilationJob,
  getCompilationJob,
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
