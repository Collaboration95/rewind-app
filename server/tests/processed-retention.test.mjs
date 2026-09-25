import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const {
  applyProcessedMediaRetention,
  planProcessedMediaRetention,
  PROCESSED_RETENTION_AGE_MS,
  PROCESSED_RETENTION_DEFAULT_LIMIT,
  PROCESSED_RETENTION_MAX_LIMIT,
} = await import('../dist/jobs/retention.js');

async function fixture(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-retention-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir });
  const processedDir = resolve(dataDir, 'media', 'processed');
  await mkdir(processedDir, { recursive: true });
  const database = openDatabase(config);
  try {
    return await run({ dataDir, processedDir, database });
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function addOldFile(path, now) {
  await writeFile(path, 'processed bytes');
  const old = new Date(now.getTime() - PROCESSED_RETENTION_AGE_MS - 1000);
  await utimes(path, old, old);
}

function addJob(database, { id, status, outputPath, kind = 'clip' }) {
  database
    .prepare(
      `INSERT INTO media_jobs (id, group_id, contribution_id, kind, status, output_path, created_at)
     VALUES (?, 'demo-group', NULL, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, kind, status, outputPath);
}

test('retains active job outputs and every compilation input, including unverifiable failed bytes', async () => {
  await fixture(async ({ database, processedDir }) => {
    const now = new Date('2026-09-25T12:00:00.000Z');
    const names = [
      'pending.mp4',
      'processing.mp4',
      'ready.mp4',
      'film-input-unverifiable.mp4',
      'film-input-mismatch.mp4',
      'orphan.mp4',
    ];
    for (const name of names) await addOldFile(resolve(processedDir, name), now);
    addJob(database, {
      id: 'pending',
      status: 'pending',
      outputPath: resolve(processedDir, names[0]),
    });
    addJob(database, {
      id: 'processing',
      status: 'processing',
      outputPath: resolve(processedDir, names[1]),
    });
    addJob(database, { id: 'ready', status: 'ready', outputPath: resolve(processedDir, names[2]) });
    addJob(database, {
      id: 'failed-input-unverifiable',
      status: 'failed',
      outputPath: resolve(processedDir, names[3]),
    });
    addJob(database, {
      id: 'failed-input-mismatch',
      status: 'failed',
      outputPath: resolve(processedDir, names[4]),
    });
    database
      .prepare('UPDATE media_jobs SET output_sha256 = ?, output_bytes = 999 WHERE id = ?')
      .run('0'.repeat(64), 'failed-input-mismatch');
    addJob(database, { id: 'film', status: 'ready', outputPath: null, kind: 'film' });
    const contribution = database.prepare('SELECT id FROM contributions LIMIT 1').get().id;
    database
      .prepare(
        'INSERT INTO compilation_job_inputs (job_id, clip_job_id, contribution_id, position) VALUES (?, ?, ?, 0)',
      )
      .run('film', 'failed-input-unverifiable', contribution);
    const owner = database.prepare('SELECT cycle_id, member_id FROM contributions LIMIT 1').get();
    database
      .prepare(
        `INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
       VALUES ('retention-input-contribution', ?, ?, 1, '2026-01-01T00:00:00.000Z')`,
      )
      .run(owner.cycle_id, owner.member_id);
    database
      .prepare(
        'INSERT INTO compilation_job_inputs (job_id, clip_job_id, contribution_id, position) VALUES (?, ?, ?, 1)',
      )
      .run('film', 'failed-input-mismatch', 'retention-input-contribution');

    const plan = planProcessedMediaRetention(database, processedDir, { now });
    assert.deepEqual(
      plan.candidates.map((candidate) => candidate.reportName),
      ['orphan.mp4'],
    );
    assert.deepEqual(plan.skippedUnsafe, []);
  });
});

test('dry-run CLI reports sanitized names without deleting; apply revalidates references and is idempotent', async () => {
  await fixture(async ({ dataDir, database, processedDir }) => {
    const now = new Date();
    const orphan = resolve(processedDir, 'old report ?.mp4');
    await addOldFile(orphan, now);
    addJob(database, { id: 'later-reference', status: 'failed', outputPath: null });
    const { stdout } = await execFileAsync(
      process.execPath,
      ['server/dist/cli.js', 'retention', '--json'],
      {
        cwd: resolve(import.meta.dirname, '../..'),
        env: { ...process.env, REWIND_DATA_DIR: dataDir },
      },
    );
    const report = JSON.parse(stdout);
    assert.equal(report.mode, 'dry-run');
    assert.deepEqual(report.candidates, ['old_report__.mp4']);
    assert.equal(await readFile(orphan, 'utf8'), 'processed bytes');

    const plan = planProcessedMediaRetention(database, processedDir, { now });
    database
      .prepare("UPDATE media_jobs SET status = 'ready', output_path = ? WHERE id = ?")
      .run(orphan, 'later-reference');
    const result = applyProcessedMediaRetention(database, processedDir, plan);
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.skipped, ['old_report__.mp4']);
    assert.equal(await readFile(orphan, 'utf8'), 'processed bytes');

    database
      .prepare("UPDATE media_jobs SET status = 'failed', output_path = NULL WHERE id = ?")
      .run('later-reference');
    const finalPlan = planProcessedMediaRetention(database, processedDir, { now });
    assert.equal(applyProcessedMediaRetention(database, processedDir, finalPlan).deleted.length, 1);
    assert.equal(planProcessedMediaRetention(database, processedDir, { now }).candidates.length, 0);
  });
});

test('skips symlinks and applies the 24-hour cutoff and bounded limit', async () => {
  await fixture(async ({ database, processedDir }) => {
    const now = new Date();
    const outside = resolve(processedDir, '..', 'outside.mp4');
    await writeFile(outside, 'outside');
    await symlink(outside, resolve(processedDir, 'escape.mp4'));
    await addOldFile(resolve(processedDir, 'a.mp4'), now);
    await addOldFile(resolve(processedDir, 'b.mp4'), now);
    const recent = resolve(processedDir, 'recent.mp4');
    await writeFile(recent, 'recent');
    const allCandidates = planProcessedMediaRetention(database, processedDir, { now });
    assert.deepEqual(allCandidates.candidates.map((candidate) => candidate.reportName).sort(), [
      'a.mp4',
      'b.mp4',
    ]);
    const plan = planProcessedMediaRetention(database, processedDir, { now, limit: 1 });
    assert.equal(plan.candidates.length, 1);
    assert.deepEqual(plan.skippedUnsafe, ['escape.mp4']);
    assert.equal(plan.limit, 1);
    assert.equal(PROCESSED_RETENTION_DEFAULT_LIMIT, 100);
    assert.equal(PROCESSED_RETENTION_MAX_LIMIT, 500);
    assert.throws(
      () => planProcessedMediaRetention(database, processedDir, { limit: 501 }),
      RangeError,
    );
    assert.throws(
      () => planProcessedMediaRetention(database, processedDir, { limit: 0 }),
      RangeError,
    );
    assert.equal(await readFile(outside, 'utf8'), 'outside');
  });
});
