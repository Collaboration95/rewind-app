import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { openDatabase, openDatabaseAt } = await import('../dist/db.js');
const { createClipUpload } = await import('../dist/media/index.js');
const { createCompilationJob, PROCESSING_CLAIM_LEASE_MS, processClipJob } =
  await import('../dist/jobs/index.js');
const { listQueueJobs } = await import('../dist/jobs/queue.js');
const {
  listWorkerCandidates,
  runWorkerTick,
  safeWorkerErrorLabel,
  startWorkerLoop,
  WORKER_MAX_CLIP_ATTEMPTS,
  WORKER_MAX_FILM_ATTEMPTS,
  WORKER_MIN_IDLE_MS,
  workerIdleMs,
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

function interleaveAfterCandidateSelection(database, interleave) {
  let waiting = true;
  return {
    exec: (...args) => database.exec(...args),
    prepare(sql) {
      const statement = database.prepare(sql);
      if (!waiting || !sql.includes('ORDER BY created_at ASC, id ASC')) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === 'all') {
            return (...args) => {
              const rows = target.all(...args);
              if (waiting) {
                waiting = false;
                interleave(rows);
              }
              return rows;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

async function waitForFile(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('Timed out waiting for the worker FFmpeg wrapper.');
}

test('duplicate workers produce exactly one result for the same clip job', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    await mkdir(dataDir + '/media/staging', { recursive: true });
    const sourcePath = dataDir + '/media/staging/duplicate.mp4';
    await createSyntheticSource(sourcePath);
    const jobId = await enqueueClip(database, sourcePath, 'duplicate-worker-key');
    const options = workerOptions(config, dataDir);

    const secondConnection = openDatabaseAt(config.databasePath);
    try {
      const ticks = await Promise.all([
        runWorkerTick(database, options),
        runWorkerTick(secondConnection, options),
      ]);
      const records = ticks.filter((tick) => tick.claimed).map((tick) => tick.record);
      assert.equal(records.filter((record) => record.outcome === 'ready').length, 1);
      assert.equal(records.filter((record) => record.jobId === jobId).length, 1);
      assert.equal(jobRow(database, jobId).status, 'ready');
      assert.equal(jobRow(secondConnection, jobId).status, 'ready');
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'job.completed' AND resource_id = ?",
          )
          .get('job:' + jobId).count,
        1,
      );
      assert.equal(
        database
          .prepare(
            "SELECT actor_member_id AS actor FROM audit_events WHERE event_type = 'job.completed' AND resource_id = ?",
          )
          .get('job:' + jobId).actor,
        null,
        'a system worker has no human actor',
      );
    } finally {
      secondConnection.close();
    }
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

test('automatic clip retries stop at the cap while request retries remain available', async () => {
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
        attempt < WORKER_MAX_CLIP_ATTEMPTS ? 'retryable' : 'automatic_exhausted',
      );
      assert.equal(tick.record.failureCategory, 'source_unavailable');
      assert.equal(tick.record.requestRetryable, true);
      assert.equal(tick.record.terminal, false);
    }

    assert.deepEqual(
      listWorkerCandidates(database, options).map((job) => job.id),
      [],
    );
    const afterCap = await runWorkerTick(database, options);
    assert.equal(afterCap.claimed, false, 'an exhausted clip job was claimed again');
    assert.equal(
      listQueueJobs(database, { groupId: 'demo-group', status: 'failed' }).jobs.find(
        (job) => job.id === jobId,
      )?.retryable,
      true,
    );
    const manual = await processClipJob(database, { jobId, groupId: 'demo-group', ...options });
    assert.equal(manual.ok, false);
    assert.equal(jobRow(database, jobId).attempts, WORKER_MAX_CLIP_ATTEMPTS + 1);
  });
});

test('worker claim enforces the automatic clip cap after candidate selection', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    const missingSource = dataDir + '/media/staging/worker-cap-race.mp4';
    const jobId = await enqueueClip(database, missingSource, 'worker-cap-race-key');
    database
      .prepare('UPDATE media_jobs SET status = ?, attempt_count = ? WHERE id = ?')
      .run('failed', 2, jobId);
    let interleaved = false;
    const racingDatabase = interleaveAfterCandidateSelection(database, (candidates) => {
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].id, jobId);
      assert.equal(candidates[0].attempts, 2);
      interleaved = true;
      // Another worker claims and fails attempt three after this worker's
      // candidate snapshot but before its writer-locked claim.
      database
        .prepare('UPDATE media_jobs SET status = ?, attempt_count = ? WHERE id = ?')
        .run('failed', 3, jobId);
    });

    const tick = await runWorkerTick(racingDatabase, workerOptions(config, dataDir));
    assert.equal(interleaved, true);
    assert.deepEqual(tick, { claimed: false, reason: 'idle' });
    assert.equal(jobRow(database, jobId).attempts, WORKER_MAX_CLIP_ATTEMPTS);
    assert.equal(jobRow(database, jobId).status, 'failed');

    // The cap is worker-only; a request-driven retry remains allowed.
    const manual = await processClipJob(database, {
      jobId,
      groupId: 'demo-group',
      ...workerOptions(config, dataDir),
    });
    assert.deepEqual(manual, {
      ok: false,
      jobId,
      status: 'failed',
      reason: 'processing_failed',
      message: 'The clip could not be processed. Retry the job.',
    });
    assert.equal(jobRow(database, jobId).attempts, WORKER_MAX_CLIP_ATTEMPTS + 1);
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
      assert.equal(tick.record.requestRetryable, attempt < WORKER_MAX_FILM_ATTEMPTS);
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

test('graceful shutdown waits for in-flight FFmpeg and skips the next claim', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    await mkdir(dataDir + '/media/staging', { recursive: true });
    const firstSource = dataDir + '/media/staging/in-flight-first.mp4';
    const nextSource = dataDir + '/media/staging/in-flight-next.mp4';
    await createSyntheticSource(firstSource);
    await createSyntheticSource(nextSource);
    const firstJobId = await enqueueClip(database, firstSource, 'in-flight-first-key');
    const nextJobId = await enqueueClip(database, nextSource, 'in-flight-next-key');

    const realFfmpeg = (await execFileAsync('which', ['ffmpeg'])).stdout.trim();
    const wrapperPath = dataDir + '/rewind-worker-ffmpeg-wrapper';
    const startedPath = dataDir + '/ffmpeg-wrapper-started';
    const releasePath = dataDir + '/ffmpeg-wrapper-release';
    await writeFile(
      wrapperPath,
      [
        '#!/bin/sh',
        'printf started > "$REWIND_WORKER_TEST_STARTED"',
        'while [ ! -f "$REWIND_WORKER_TEST_RELEASE" ]; do sleep 0.01; done',
        'exec "$REWIND_WORKER_TEST_REAL_FFMPEG" "$@"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const envKeys = [
      'REWIND_WORKER_TEST_STARTED',
      'REWIND_WORKER_TEST_RELEASE',
      'REWIND_WORKER_TEST_REAL_FFMPEG',
    ];
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.REWIND_WORKER_TEST_STARTED = startedPath;
    process.env.REWIND_WORKER_TEST_RELEASE = releasePath;
    process.env.REWIND_WORKER_TEST_REAL_FFMPEG = realFfmpeg;

    let handle;
    const records = [];
    try {
      handle = startWorkerLoop(
        database,
        workerOptions(config, dataDir, {
          ffmpegBin: wrapperPath,
          idleMs: 50,
          onResult: (record) => records.push(record),
        }),
      );
      await waitForFile(startedPath);
      assert.equal(jobRow(database, firstJobId).status, 'processing');

      let stopResolved = false;
      const stopping = handle.stop().then(() => {
        stopResolved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(stopResolved, false, 'stop resolved while FFmpeg was still blocked');
      assert.equal(handle.completed(), 0);

      await writeFile(releasePath, 'continue');
      await stopping;
      assert.equal(jobRow(database, firstJobId).status, 'ready');
      assert.equal(jobRow(database, nextJobId).status, 'pending');
      assert.equal(handle.completed(), 1);
      assert.deepEqual(
        records.map((record) => record.jobId),
        [firstJobId],
      );
    } finally {
      await writeFile(releasePath, 'continue').catch(() => undefined);
      if (handle) await handle.stop();
      for (const key of envKeys) {
        const value = previousEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test('repeated idle waits do not retain callbacks for elapsed ticks', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    const idleTimers = new Map();
    const idleMs = 53;
    let firedIdleTicks = 0;
    let clearedAfterFire = 0;
    let handle;

    globalThis.setTimeout = (callback, delay, ...args) => {
      let fired = false;
      const timer = nativeSetTimeout(
        (...callbackArgs) => {
          fired = true;
          if (delay === idleMs) firedIdleTicks += 1;
          callback(...callbackArgs);
        },
        delay,
        ...args,
      );
      if (delay === idleMs) idleTimers.set(timer, () => fired);
      return timer;
    };
    globalThis.clearTimeout = (timer) => {
      if (idleTimers.get(timer)?.()) clearedAfterFire += 1;
      return nativeClearTimeout(timer);
    };

    try {
      handle = startWorkerLoop(database, workerOptions(config, dataDir, { idleMs }));
      const deadline = Date.now() + 5_000;
      while (firedIdleTicks < 3) {
        assert.ok(Date.now() < deadline, 'worker did not complete repeated idle ticks');
        await new Promise((resolve) => setImmediate(resolve));
      }

      await handle.stop();
      assert.equal(clearedAfterFire, 0, 'shutdown revisited timers from elapsed idle ticks');
    } finally {
      if (handle) await handle.stop();
      globalThis.setTimeout = nativeSetTimeout;
      globalThis.clearTimeout = nativeClearTimeout;
    }
  });
});

test('stale ready clip and film candidates do not consume the worker job limit', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    await mkdir(dataDir + '/media/staging', { recursive: true });
    const sourcePath = dataDir + '/media/staging/remaining-claim.mp4';
    await createSyntheticSource(sourcePath);
    const actualClipId = await enqueueClip(database, sourcePath, 'remaining-claim-key');

    const staleClipId = 'worker-stale-ready-clip';
    database
      .prepare(
        'INSERT INTO media_jobs (id, group_id, contribution_id, kind, status, created_at) ' +
          'VALUES (?, ?, NULL, ?, ?, ?)',
      )
      .run(staleClipId, 'demo-group', 'clip', 'pending', '2026-09-10T00:00:00.000Z');
    database.prepare("UPDATE cycles SET status = 'revealing' WHERE id = 'demo-cycle'").run();
    const createdFilm = createCompilationJob(database, {
      groupId: 'demo-group',
      cycleId: 'demo-cycle',
      createdAt: '2026-09-10T01:00:00.000Z',
    });
    assert.equal(createdFilm.ok, true);

    let interleaved = false;
    const racingDatabase = interleaveAfterCandidateSelection(database, (candidates) => {
      assert.deepEqual(
        candidates.map((candidate) => candidate.id),
        [staleClipId, createdFilm.job.id, actualClipId],
      );
      interleaved = true;
      database
        .prepare("UPDATE media_jobs SET status = 'ready', output_path = ? WHERE id = ?")
        .run('completed-by-another-clip-worker.mp4', staleClipId);
      database
        .prepare("UPDATE media_jobs SET status = 'ready', output_path = ? WHERE id = ?")
        .run('completed-by-another-film-worker.mp4', createdFilm.job.id);
    });
    const records = [];
    const handle = startWorkerLoop(
      racingDatabase,
      workerOptions(config, dataDir, {
        maxJobs: 1,
        onResult: (record) => records.push(record),
      }),
    );

    await handle.done;
    assert.equal(interleaved, true);
    assert.equal(handle.completed(), 1);
    assert.equal(records.length, 1);
    assert.equal(records[0].jobId, actualClipId);
    assert.equal(records[0].status, 'ready');
    assert.equal(jobRow(database, staleClipId).status, 'ready');
    assert.equal(jobRow(database, createdFilm.job.id).status, 'ready');
    assert.equal(jobRow(database, actualClipId).status, 'ready');
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

test('persistent loop rejects on a claim error instead of reporting a clean stop', async () => {
  const failure = new Error('/private/secret/sqlite failure');
  const database = {
    prepare: () => {
      throw failure;
    },
  };
  const handle = startWorkerLoop(database, workerOptions({ ffmpegBin: 'ffmpeg' }, '/tmp'));
  await assert.rejects(handle.done, (error) => error === failure);
  assert.equal(handle.completed(), 0);
});

test('worker CLI exits nonzero with a safe label after a persistent loop failure', async () => {
  await withDatabase(async ({ config }) => {
    const child = spawn(process.execPath, ['server/dist/cli.js', 'worker', '--idle-ms', '50'], {
      env: { ...process.env, REWIND_DATA_DIR: config.dataDir, REWIND_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let removed = false;
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!removed && stdout.includes('Rewind durable worker (')) {
        removed = true;
        // Corrupt only this isolated test database after startup. The next
        // claim query must fail, and the CLI must expose a failing exit code.
        try {
          const connection = new DatabaseSync(config.databasePath);
          connection.exec('PRAGMA foreign_keys = OFF; DROP TABLE media_jobs;');
          connection.close();
        } catch {
          // A repeated stdout chunk may observe the table already removed.
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 5_000);
    try {
      assert.equal(await finished, 1);
      assert.match(stderr, /Worker loop error: worker_loop_failed/);
      assert.doesNotMatch(stderr, /\/private\/|SQLITE_ERROR|no such table/);
      assert.doesNotMatch(stdout, /Worker stopped after/);
    } finally {
      clearTimeout(timer);
    }
  });
});

test('--once --json emits one parseable summary and zero idle is rejected', async () => {
  await withDatabase(async ({ config }) => {
    const env = { ...process.env, REWIND_DATA_DIR: config.dataDir };
    const { stdout } = await execFileAsync(
      process.execPath,
      ['server/dist/cli.js', 'worker', '--once', '--json'],
      { env },
    );
    assert.deepEqual(JSON.parse(stdout), { jobs: [], drained: 0 });
    assert.equal(stdout.trim().split('\n').length, 1);
    await assert.rejects(
      execFileAsync(process.execPath, ['server/dist/cli.js', 'worker', '--idle-ms', '0'], { env }),
      /--idle-ms must be an integer from 50/,
    );
    assert.equal(workerIdleMs(0), WORKER_MIN_IDLE_MS);
  });
});
