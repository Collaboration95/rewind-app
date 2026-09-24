import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { openDatabase, openDatabaseAt } = await import('../dist/db.js');
const { createClipUpload } = await import('../dist/media/index.js');
const { createCompilationJob, PROCESSING_CLAIM_LEASE_MS, processClipJob } =
  await import('../dist/jobs/index.js');
const {
  listWorkerCandidates,
  runWorkerTick,
  safeWorkerErrorLabel,
  startWorkerLoop,
  WORKER_MAX_CLIP_ATTEMPTS,
  WORKER_MAX_FILM_ATTEMPTS,
} = await import('../dist/jobs/worker.js');

async function withDatabase(run) {
  const dataDir = await mkdtemp(tmpdir() + '/rewind-durable-worker-test-');
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_FFMPEG_BIN: 'ffmpeg',
  });
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

function workerOptions(config, dataDir, extra = {}) {
  return {
    ffmpegBin: config.ffmpegBin,
    stagingDir: dataDir + '/media/staging',
    outputDir: dataDir + '/media/processed',
    ...extra,
  };
}

async function createSyntheticSource(path) {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:size=180x320:rate=12:duration=1',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:size=180x320:rate=12:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:sample_rate=44100:duration=2',
    '-c:v',
    'libx264',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map',
    '[v]',
    '-map',
    '2:a',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    path,
  ]);
}

/** Enqueue a real pending clip through the production intake path. */
async function enqueueClip(database, sourcePath, idempotencyKey) {
  const upload = createClipUpload(
    database,
    'demo-group',
    'demo-1',
    {
      idempotencyKey,
      sourceUri: sourcePath,
      mimeType: 'video/mp4',
      byteLength: 10_000,
      durationSeconds: 0.5,
      width: 180,
      height: 320,
      hasAudio: true,
      mode: 'soft-focus',
      trimStartSeconds: 1,
      trimEndSeconds: 1.5,
      sourceDurationSeconds: 2,
    },
    new Date('2026-09-10T12:00:00.000Z'),
  );
  assert.equal(upload.ok, true);
  if (!upload.ok) throw new Error('synthetic upload was rejected');
  return upload.upload.job.id;
}

function jobRow(database, jobId) {
  return database
    .prepare(
      'SELECT status, attempt_count AS attempts, error_code AS errorCode, ' +
        'output_path AS outputPath, processing_started_at AS processingStartedAt ' +
        'FROM media_jobs WHERE id = ?',
    )
    .get(jobId);
}

test('duplicate workers produce exactly one result for the same clip job', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    await mkdir(dataDir + '/media/staging', { recursive: true });
    const sourcePath = dataDir + '/media/staging/duplicate.mp4';
    await createSyntheticSource(sourcePath);
    const jobId = await enqueueClip(database, sourcePath, 'duplicate-worker-key');
    const options = workerOptions(config, dataDir);

    // Two workers poll the same durable queue concurrently, as two CLI
    // processes would, and must not both report a completed result.
    const ticks = await Promise.all([
      runWorkerTick(database, options),
      runWorkerTick(database, options),
    ]);

    const records = ticks.filter((tick) => tick.claimed).map((tick) => tick.record);
    assert.equal(records.filter((record) => record.outcome === 'ready').length, 1);
    assert.equal(records.filter((record) => record.jobId === jobId).length, 1);
    assert.equal(jobRow(database, jobId).status, 'ready');
  });
});

test('a stale processing claim is reclaimed after restart while a live claim is not', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    await mkdir(dataDir + '/media/staging', { recursive: true });
    const sourcePath = dataDir + '/media/staging/lease.mp4';
    await createSyntheticSource(sourcePath);
    const staleJobId = await enqueueClip(database, sourcePath, 'stale-lease-key');
    const liveJobId = await enqueueClip(database, sourcePath, 'live-lease-key');
    const options = workerOptions(config, dataDir);

    database
      .prepare('UPDATE media_jobs SET status = ?, processing_started_at = ? WHERE id = ?')
      .run(
        'processing',
        new Date(Date.now() - PROCESSING_CLAIM_LEASE_MS - 1_000).toISOString(),
        staleJobId,
      );
    database
      .prepare('UPDATE media_jobs SET status = ?, processing_started_at = ? WHERE id = ?')
      .run('processing', new Date().toISOString(), liveJobId);

    const candidates = listWorkerCandidates(database, options).map((job) => job.id);
    assert.ok(candidates.includes(staleJobId), 'an expired lease was not offered for reclaim');
    assert.ok(!candidates.includes(liveJobId), 'a live lease was offered for reclaim');

    // A restart reopens the same durable database and must fence correctly.
    const reopened = openDatabaseAt(config.databasePath);
    try {
      const tick = await runWorkerTick(reopened, options);
      assert.equal(tick.claimed, true);
      assert.equal(tick.record.jobId, staleJobId);
      assert.equal(tick.record.outcome, 'ready');
      assert.equal(jobRow(reopened, staleJobId).status, 'ready');
      assert.equal(jobRow(reopened, liveJobId).status, 'processing');
      assert.equal(jobRow(reopened, liveJobId).attempts, 0);

      const second = await runWorkerTick(reopened, options);
      assert.equal(second.claimed, false, 'a ready or live-claim job was claimed again');
    } finally {
      reopened.close();
    }
  });
});

test('retry then terminal state for a clip is deterministic at the durable cap', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    const missingSource = dataDir + '/media/staging/missing.mp4';
    const jobId = await enqueueClip(database, missingSource, 'retry-terminal-key');
    const options = workerOptions(config, dataDir);

    for (let attempt = 1; attempt <= WORKER_MAX_CLIP_ATTEMPTS; attempt += 1) {
      const tick = await runWorkerTick(database, options);
      assert.equal(tick.claimed, true);
      assert.equal(tick.record.jobId, jobId);
      assert.equal(tick.record.attempts, attempt);
      const row = jobRow(database, jobId);
      assert.equal(row.status, 'failed');
      assert.equal(row.errorCode, 'source_unavailable');
      assert.equal(
        tick.record.outcome,
        attempt < WORKER_MAX_CLIP_ATTEMPTS ? 'retryable' : 'terminal',
      );
      assert.equal(tick.record.failureCategory, 'source_unavailable');
      assert.equal(tick.record.terminal, attempt === WORKER_MAX_CLIP_ATTEMPTS);
    }

    assert.deepEqual(
      listWorkerCandidates(database, options).map((job) => job.id),
      [],
    );
    const afterCap = await runWorkerTick(database, options);
    assert.equal(afterCap.claimed, false, 'an exhausted clip job was claimed again');
  });
});

test('an exhausted film job is terminal and never claimed again', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    database.prepare("UPDATE cycles SET status = 'revealing' WHERE id = 'demo-cycle'").run();
    const created = createCompilationJob(database, {
      groupId: 'demo-group',
      cycleId: 'demo-cycle',
      createdAt: '2026-09-11T00:00:00.000Z',
    });
    assert.equal(created.ok, true);
    const jobId = created.job.id;
    const options = workerOptions(config, dataDir);

    // A film with no processed clips fails deterministically without FFmpeg.
    for (let attempt = 1; attempt <= WORKER_MAX_FILM_ATTEMPTS; attempt += 1) {
      const tick = await runWorkerTick(database, options);
      assert.equal(tick.claimed, true);
      assert.equal(tick.record.jobId, jobId);
      assert.equal(tick.record.jobKind, 'film');
      assert.equal(tick.record.attempts, attempt);
      assert.equal(
        tick.record.outcome,
        attempt < WORKER_MAX_FILM_ATTEMPTS ? 'retryable' : 'terminal',
      );
    }
    assert.equal(jobRow(database, jobId).status, 'failed');
    assert.deepEqual(
      listWorkerCandidates(database, options).map((job) => job.id),
      [],
    );
  });
});

test('graceful shutdown stops claiming and leaves work for the request-driven path', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    await mkdir(dataDir + '/media/staging', { recursive: true });
    const sourcePath = dataDir + '/media/staging/shutdown.mp4';
    await createSyntheticSource(sourcePath);
    const options = workerOptions(config, dataDir, { idleMs: 20 });

    const handle = startWorkerLoop(database, options);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await handle.stop();
    assert.equal(handle.completed(), 0);

    // Work that arrives after shutdown must not be claimed, even after several
    // idle intervals have passed.
    const jobId = await enqueueClip(database, sourcePath, 'shutdown-key');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(handle.completed(), 0);
    assert.equal(jobRow(database, jobId).status, 'pending');
    assert.ok(listWorkerCandidates(database, options).some((job) => job.id === jobId));

    // The existing request-driven processor still completes the job, which is
    // the controlled rollback contract for this migration.
    const processed = await processClipJob(database, { jobId, groupId: 'demo-group', ...options });
    assert.equal(processed.ok, true);
    assert.equal(jobRow(database, jobId).status, 'ready');
  });
});

test('candidate selection excludes terminal, ready, and out-of-scope rows', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    database.prepare("UPDATE cycles SET status = 'revealing' WHERE id = 'demo-cycle'").run();
    const film = createCompilationJob(database, {
      groupId: 'demo-group',
      cycleId: 'demo-cycle',
      createdAt: '2026-09-11T00:00:00.000Z',
    });
    assert.equal(film.ok, true);
    const insert = database.prepare(
      'INSERT INTO media_jobs (id, group_id, contribution_id, kind, status, created_at) ' +
        'VALUES (?, ?, NULL, ?, ?, ?)',
    );
    insert.run('worker-ready-clip', 'demo-group', 'clip', 'ready', '2026-09-10T00:00:00.000Z');
    insert.run('worker-deleted-clip', 'demo-group', 'clip', 'deleted', '2026-09-10T00:01:00.000Z');
    insert.run('worker-download', 'demo-group', 'download', 'pending', '2026-09-10T00:02:00.000Z');
    insert.run('worker-orphan-film', 'demo-group', 'film', 'pending', '2026-09-10T00:03:00.000Z');

    const options = workerOptions(config, dataDir);
    const ids = listWorkerCandidates(database, options).map((job) => job.id);
    assert.ok(!ids.includes('worker-ready-clip'));
    assert.ok(!ids.includes('worker-deleted-clip'));
    assert.ok(!ids.includes('worker-download'));
    assert.ok(!ids.includes('worker-orphan-film'), 'a cycle-less film was offered for work');
    assert.ok(ids.includes(film.job.id));

    assert.deepEqual(listWorkerCandidates(database, { ...options, groupId: 'other-group' }), []);
  });
});

test('loop failure labels stay stable and expose no path or FFmpeg detail', () => {
  const busy = Object.assign(new Error('SQLITE_BUSY: database is locked'), {
    code: 'SQLITE_BUSY',
  });
  assert.equal(safeWorkerErrorLabel(busy), 'database_busy');
  assert.equal(
    safeWorkerErrorLabel(new Error('/private/tmp/secret/ffmpeg exploded with token abc')),
    'worker_loop_failed',
  );
  assert.equal(safeWorkerErrorLabel(undefined), 'worker_loop_failed');
});
