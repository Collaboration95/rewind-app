import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { backfillMediaIntegrity, migrateDatabase, openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { createClipUpload, recordClipMediaMetadata } = await import('../dist/media/index.js');
const {
  hashFile,
  hashFileSync,
  hashFileWithIdentity,
  openMediaWithIntegrity,
  verifyMediaIntegrity,
} = await import('../dist/media/integrity.js');
const { processClipJob, PROCESSING_CLAIM_LEASE_MS } = await import('../dist/jobs/index.js');
const { deleteContribution } = await import('../dist/contributions/index.js');
const { createCompilationJob, getCompilationJob, processCompilationJob } =
  await import('../dist/jobs/index.js');

const NOT_FOUND = {
  error: 'not_found',
  message: 'The requested resource was not found.',
};

async function withDatabase(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-integrity-test-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_FFMPEG_BIN: 'ffmpeg',
  });
  const database = openDatabase(config);
  try {
    return await run({ config, database, dataDir });
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** A real, playable portrait MP4 so finalization hashes genuine bytes. */
async function createSyntheticSource(path) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:size=180x320:rate=12:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=44100:duration=2',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      path,
    ],
    { maxBuffer: 2_000_000 },
  );
}

async function finalizeOneClip({ database, config, dataDir }, key = 'integrity-clip-1') {
  const stagingDir = resolve(dataDir, 'media', 'staging');
  const sourcePath = resolve(stagingDir, `${key}.mp4`);
  await createSyntheticSource(sourcePath);
  recordClipMediaMetadata(database, {
    sourceUri: sourcePath,
    mimeType: 'video/mp4',
    byteLength: 10_000,
    durationSeconds: 2,
    width: 180,
    height: 320,
    hasAudio: true,
  });
  const upload = createClipUpload(
    database,
    'demo-group',
    'demo-1',
    {
      idempotencyKey: key,
      sourceUri: sourcePath,
      mimeType: 'video/mp4',
      byteLength: 10_000,
      durationSeconds: 1,
      width: 180,
      height: 320,
      hasAudio: true,
      mode: 'soft-focus',
      trimStartSeconds: 0.5,
      trimEndSeconds: 1.5,
      sourceDurationSeconds: 2,
    },
    // The seeded demo cycle is collecting on this instant; real wall-clock
    // time would place it past its end.
    new Date('2026-09-10T12:00:00.000Z'),
  );
  assert.equal(upload.ok, true);
  if (!upload.ok) throw new Error('synthetic upload was rejected');
  const outputDir = resolve(dataDir, 'media', 'processed');
  const result = await processClipJob(database, {
    jobId: upload.upload.job.id,
    ffmpegBin: config.ffmpegBin,
    stagingDir,
    outputDir,
  });
  assert.deepEqual(result, { ok: true, jobId: upload.upload.job.id, status: 'ready' });
  return upload.upload.job.id;
}

function storedIntegrity(database, jobId) {
  return database
    .prepare(
      `SELECT output_path AS outputPath, output_sha256 AS sha256,
              output_bytes AS byteLength, output_verified_at AS verifiedAt
       FROM media_jobs WHERE id = ?`,
    )
    .get(jobId);
}

test('finalization persists a matching SHA-256 and byte length for a real clip', async () => {
  await withDatabase(async (context) => {
    const { database } = context;
    const jobId = await finalizeOneClip(context);
    const row = storedIntegrity(database, jobId);
    assert.equal(typeof row.sha256, 'string');
    assert.match(row.sha256, /^[0-9a-f]{64}$/);
    assert.ok(row.byteLength > 0);
    assert.ok(row.verifiedAt);

    const bytes = await readFile(row.outputPath);
    assert.equal(row.byteLength, bytes.length);
    assert.equal(row.sha256, createHash('sha256').update(bytes).digest('hex'));

    const result = await verifyMediaIntegrity(database, jobId, row.outputPath);
    assert.equal(result.outcome, 'verified');
  });
});

test('a tampered finalized clip is unavailable, audited, and still not served', async () => {
  await withDatabase(async (context) => {
    const { database, config } = context;
    const jobId = await finalizeOneClip(context, 'integrity-tamper-1');
    const row = storedIntegrity(database, jobId);

    // Same length, different bytes: only a content digest can catch this.
    const original = await readFile(row.outputPath);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0xff;
    await writeFile(row.outputPath, tampered);

    const result = await verifyMediaIntegrity(database, jobId, row.outputPath);
    assert.equal(result.outcome, 'mismatch');
    assert.equal(result.expectedSha256, row.sha256);
    assert.notEqual(result.observedSha256, row.sha256);

    database
      .prepare(
        `UPDATE cycles SET status = 'revealing', release_status = 'published',
           release_published_at = ? WHERE id = 'demo-cycle'`,
      )
      .run(new Date().toISOString());
    const server = createRuntimeServer(config, database);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: 'demo-1' }),
      });
      const session = await sessionResponse.json();
      const query = `groupId=demo-group&sessionId=${encodeURIComponent(session.session.id)}`;

      const archive = await fetch(`${baseUrl}/archive?${query}`);
      assert.equal(archive.status, 200);
      const archiveBody = await archive.json();
      assert.deepEqual(
        archiveBody.archive.clips.map((clip) => clip.id),
        [],
        'a tampered clip must not be advertised in the archive',
      );

      const download = await fetch(`${baseUrl}/clips/${jobId}/download?${query}`);
      assert.equal(download.status, 404);
      assert.deepEqual(await download.json(), NOT_FOUND);

      const audit = database
        .prepare(
          `SELECT event_type AS eventType, resource_id AS resourceId, result
           FROM audit_events WHERE event_type = 'media.integrity_failed'`,
        )
        .all()
        .map((row) => ({ ...row }));
      assert.deepEqual(audit, [
        { eventType: 'media.integrity_failed', resourceId: `clip:${jobId}`, result: 'denied' },
      ]);

      // Repeated requests must not multiply the durable audit rows.
      await fetch(`${baseUrl}/clips/${jobId}/download?${query}`);
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'media.integrity_failed'",
          )
          .get().count,
        1,
      );
    } finally {
      await new Promise((close) => server.close(close));
    }
  });
});

test('concurrent connections record one integrity audit event', async () => {
  await withDatabase(async ({ database, config }) => {
    const workerScript = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const { recordIntegrityFailure } = require(workerData.integrityModule);

      const startBarrier = new Int32Array(workerData.startBarrier);
      const startCount = Atomics.add(startBarrier, 0, 1);
      if (startCount === 0) {
        if (Atomics.wait(startBarrier, 0, 1, 10000) === 'timed-out') {
          throw new Error('timed out waiting for the second audit worker');
        }
      } else {
        Atomics.notify(startBarrier, 0, 1);
      }

      const auditBarrier = new Int32Array(workerData.auditBarrier);
      const database = new DatabaseSync(workerData.databasePath);
      database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
      let transactionActive = false;
      const connection = new Proxy(database, {
        get(target, property) {
          if (property === 'exec') {
            return (sql) => {
              const result = target.exec(sql);
              if (/^\\s*BEGIN\\b/i.test(sql)) transactionActive = true;
              if (/^\\s*(COMMIT|END|ROLLBACK)\\b/i.test(sql)) transactionActive = false;
              return result;
            };
          }
          if (property === 'prepare') {
            return (sql) => {
              const statement = target.prepare(sql);
              if (sql.includes('SELECT occurred_at AS occurredAt') && sql.includes('FROM audit_events')) {
                return {
                  get(...params) {
                    const row = statement.get(...params);
                    // Force both connections to finish the old check before
                    // either can insert. The fixed implementation already
                    // owns SQLite's writer lock here, so only one can reach
                    // this query at a time and no barrier wait is needed.
                    if (!transactionActive) {
                      const count = Atomics.add(auditBarrier, 0, 1);
                      if (count === 0) {
                        if (Atomics.wait(auditBarrier, 0, 1, 10000) === 'timed-out') {
                          throw new Error('timed out synchronizing concurrent audit checks');
                        }
                      } else {
                        Atomics.notify(auditBarrier, 0, 1);
                      }
                    }
                    return row;
                  },
                };
              }
              return statement;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      try {
        const result = recordIntegrityFailure(connection, workerData.input);
        parentPort.postMessage({ result });
      } finally {
        database.close();
      }
    `;
    const workerData = {
      databasePath: config.databasePath,
      integrityModule: resolve(process.cwd(), 'server/dist/media/integrity.js'),
      startBarrier: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      auditBarrier: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      input: {
        jobId: 'integrity-concurrent-audit',
        kind: 'clip',
        result: {
          outcome: 'mismatch',
          expectedSha256: 'a'.repeat(64),
          expectedByteLength: 10,
          observedSha256: 'b'.repeat(64),
          observedByteLength: 10,
        },
        timestamp: '2026-09-25T00:00:00.000Z',
      },
    };
    const runWorker = () =>
      new Promise((resolveWorker, rejectWorker) => {
        const worker = new Worker(workerScript, { eval: true, workerData });
        let message;
        worker.once('message', (value) => {
          message = value;
        });
        worker.once('error', rejectWorker);
        worker.once('exit', (code) => {
          if (code !== 0) {
            rejectWorker(new Error(`audit worker exited with code ${code}`));
          } else if (message) {
            resolveWorker(message);
          } else {
            rejectWorker(new Error('audit worker exited without a result'));
          }
        });
      });

    const outcomes = await Promise.all([runWorker(), runWorker()]);
    assert.deepEqual(
      outcomes.map(({ result }) => result).sort(),
      [false, true],
      'only one concurrent caller should insert the deduplicated event',
    );
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE event_type = 'media.integrity_failed'
             AND resource_id = 'clip:integrity-concurrent-audit'`,
        )
        .get().count,
      1,
      'separate SQLite connections must leave exactly one audit row',
    );
  });
});

test('a truncated finalized clip is unavailable and never streamed', async () => {
  await withDatabase(async (context) => {
    const { database, config } = context;
    const jobId = await finalizeOneClip(context, 'integrity-truncate-1');
    const row = storedIntegrity(database, jobId);
    const original = await readFile(row.outputPath);
    await writeFile(row.outputPath, original.subarray(0, Math.max(1, original.length - 64)));

    const result = await verifyMediaIntegrity(database, jobId, row.outputPath);
    assert.equal(result.outcome, 'mismatch');
    assert.equal(result.expectedByteLength, original.length);
    assert.ok(result.observedByteLength < original.length);

    database
      .prepare(
        `UPDATE cycles SET status = 'revealing', release_status = 'published',
           release_published_at = ? WHERE id = 'demo-cycle'`,
      )
      .run(new Date().toISOString());
    const server = createRuntimeServer(config, database);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: 'demo-1' }),
      });
      const session = await sessionResponse.json();
      const query = `groupId=demo-group&sessionId=${encodeURIComponent(session.session.id)}`;
      const download = await fetch(`${baseUrl}/clips/${jobId}/download?${query}`);
      assert.equal(download.status, 404);
      assert.deepEqual(await download.json(), NOT_FOUND);
    } finally {
      await new Promise((close) => server.close(close));
    }
  });
});

test('a missing or unreadable output is reported unavailable rather than silently served', async () => {
  await withDatabase(async (context) => {
    const { database } = context;
    const jobId = await finalizeOneClip(context, 'integrity-missing-1');
    const row = storedIntegrity(database, jobId);
    await rm(row.outputPath, { force: true });
    const result = await verifyMediaIntegrity(database, jobId, row.outputPath);
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.expectedSha256, row.sha256);
  });
});

for (const damage of ['deleted', 'zero-byte']) {
  test(`HTTP audits a ${damage} finalized output once and returns 404`, async () => {
    await withDatabase(async (context) => {
      const { database, config } = context;
      const jobId = await finalizeOneClip(context, `integrity-${damage}-http`);
      const row = storedIntegrity(database, jobId);
      if (damage === 'deleted') await rm(row.outputPath);
      else await writeFile(row.outputPath, Buffer.alloc(0));

      database
        .prepare(
          `UPDATE cycles SET status = 'revealing', release_status = 'published',
             release_published_at = ? WHERE id = 'demo-cycle'`,
        )
        .run(new Date().toISOString());
      const server = createRuntimeServer(config, database);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      try {
        const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberId: 'demo-1' }),
        });
        const session = await sessionResponse.json();
        const query = `groupId=demo-group&sessionId=${encodeURIComponent(session.session.id)}`;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const download = await fetch(`${baseUrl}/clips/${jobId}/download?${query}`);
          assert.equal(download.status, 404);
          assert.deepEqual(await download.json(), NOT_FOUND);
        }
        const archive = await fetch(`${baseUrl}/archive?${query}`);
        assert.equal(archive.status, 200);
        assert.equal(
          (await archive.json()).archive.clips.some((clip) => clip.id === jobId),
          false,
        );
        const audit = database
          .prepare(
            `SELECT event_type AS eventType, resource_id AS resourceId, result
             FROM audit_events WHERE event_type = 'media.integrity_failed'`,
          )
          .all()
          .map((event) => ({ ...event }));
        assert.deepEqual(audit, [
          { eventType: 'media.integrity_failed', resourceId: `clip:${jobId}`, result: 'denied' },
        ]);
      } finally {
        await new Promise((close) => server.close(close));
      }
    });
  });
}

test('deletion and failed processing clear the output path and integrity metadata together', async () => {
  await withDatabase(async (context) => {
    const { database, config, dataDir } = context;
    const deletedJobId = await finalizeOneClip(context, 'integrity-delete-row');
    const contribution = database
      .prepare('SELECT contribution_id AS id FROM media_jobs WHERE id = ?')
      .get(deletedJobId);
    const deleted = deleteContribution(
      database,
      'demo-group',
      'demo-1',
      contribution.id,
      new Date('2026-09-10T12:01:00.000Z'),
      { outputDir: resolve(dataDir, 'media', 'processed') },
    );
    assert.equal(deleted.ok, true);
    const deletedRow = database
      .prepare(
        `SELECT status, output_path AS outputPath, output_sha256 AS sha256,
                output_bytes AS byteLength, output_verified_at AS verifiedAt
         FROM media_jobs WHERE id = ?`,
      )
      .get(deletedJobId);
    assert.deepEqual(
      { ...deletedRow },
      {
        status: 'deleted',
        outputPath: null,
        sha256: null,
        byteLength: null,
        verifiedAt: null,
      },
    );

    const failedJobId = await finalizeOneClip(context, 'integrity-failed-row');
    database
      .prepare(
        `UPDATE media_jobs SET status = 'failed',
           source_path = ? WHERE id = ?`,
      )
      .run(resolve(dataDir, 'media', 'staging', 'missing.mp4'), failedJobId);
    const failed = await processClipJob(database, {
      jobId: failedJobId,
      ffmpegBin: config.ffmpegBin,
      stagingDir: resolve(dataDir, 'media', 'staging'),
      outputDir: resolve(dataDir, 'media', 'processed'),
    });
    assert.equal(failed.ok, false);
    const failedRow = database
      .prepare(
        `SELECT status, output_path AS outputPath, output_sha256 AS sha256,
                output_bytes AS byteLength, output_verified_at AS verifiedAt
         FROM media_jobs WHERE id = ?`,
      )
      .get(failedJobId);
    assert.deepEqual(
      { ...failedRow },
      {
        status: 'failed',
        outputPath: null,
        sha256: null,
        byteLength: null,
        verifiedAt: null,
      },
    );
  });
});

test('a zero-row ready update cannot complete clip finalization', async () => {
  await withDatabase(async (context) => {
    const { database, config, dataDir } = context;
    const stagingDir = resolve(dataDir, 'media', 'staging');
    const sourcePath = resolve(stagingDir, 'integrity-stale-fence.mp4');
    await createSyntheticSource(sourcePath);
    recordClipMediaMetadata(database, {
      sourceUri: sourcePath,
      mimeType: 'video/mp4',
      byteLength: 10_000,
      durationSeconds: 2,
      width: 180,
      height: 320,
      hasAudio: true,
    });
    const upload = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      {
        idempotencyKey: 'integrity-stale-fence',
        sourceUri: sourcePath,
        mimeType: 'video/mp4',
        byteLength: 10_000,
        durationSeconds: 1,
        width: 180,
        height: 320,
        hasAudio: true,
        mode: 'soft-focus',
        trimStartSeconds: 0.5,
        trimEndSeconds: 1.5,
      },
      new Date('2026-09-10T12:00:00.000Z'),
    );
    assert.equal(upload.ok, true);
    if (!upload.ok) return;
    database.exec(
      `CREATE TRIGGER ignore_clip_ready_157
       BEFORE UPDATE OF status ON media_jobs
       WHEN OLD.id = '${upload.upload.job.id}' AND NEW.status = 'ready'
       BEGIN SELECT RAISE(IGNORE); END`,
    );
    const result = await processClipJob(database, {
      jobId: upload.upload.job.id,
      ffmpegBin: config.ffmpegBin,
      stagingDir,
      outputDir: resolve(dataDir, 'media', 'processed'),
    });
    assert.equal(result.ok, false);
    const row = database
      .prepare(
        `SELECT status, output_path AS outputPath, output_sha256 AS sha256,
                output_bytes AS byteLength, output_verified_at AS verifiedAt
         FROM media_jobs WHERE id = ?`,
      )
      .get(upload.upload.job.id);
    assert.deepEqual(
      { ...row },
      {
        status: 'failed',
        outputPath: null,
        sha256: null,
        byteLength: null,
        verifiedAt: null,
      },
    );
    assert.ok((await readFile(sourcePath)).length > 0);
  });
});

test('a stale clip worker cannot delete output published by a reclaimed worker', async () => {
  await withDatabase(async ({ database, config, dataDir }) => {
    const stagingDir = resolve(dataDir, 'media', 'staging');
    const sourcePath = resolve(stagingDir, 'integrity-overlapping-claims.mp4');
    await createSyntheticSource(sourcePath);
    recordClipMediaMetadata(database, {
      sourceUri: sourcePath,
      mimeType: 'video/mp4',
      byteLength: 10_000,
      durationSeconds: 2,
      width: 180,
      height: 320,
      hasAudio: true,
    });
    const upload = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      {
        idempotencyKey: 'integrity-overlapping-claims',
        sourceUri: sourcePath,
        mimeType: 'video/mp4',
        byteLength: 10_000,
        durationSeconds: 1,
        width: 180,
        height: 320,
        hasAudio: true,
        mode: 'soft-focus',
        trimStartSeconds: 0.5,
        trimEndSeconds: 1.5,
        sourceDurationSeconds: 2,
      },
      new Date('2026-09-10T12:00:00.000Z'),
    );
    assert.equal(upload.ok, true);
    if (!upload.ok) return;
    const jobId = upload.upload.job.id;
    const outputDir = resolve(dataDir, 'media', 'processed');
    const invocationCountPath = resolve(dataDir, 'ffmpeg-invocations.txt');
    const firstStartedPath = resolve(dataDir, 'first-ffmpeg-started');
    const releaseFirstPath = resolve(dataDir, 'release-first-ffmpeg');
    const { stdout: realFfmpeg } = await execFileAsync('which', ['ffmpeg']);
    const { stdout: realFfprobe } = await execFileAsync('which', ['ffprobe']);
    await symlink(realFfprobe.trim(), resolve(dataDir, 'ffprobe'));
    const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const shimPath = resolve(dataDir, 'ffmpeg-claim-race-shim');
    await writeFile(
      shimPath,
      `#!/bin/sh
count_file=${shellQuote(invocationCountPath)}
started_file=${shellQuote(firstStartedPath)}
release_file=${shellQuote(releaseFirstPath)}
count=0
if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
count=$((count + 1))
printf '%s' "$count" > "$count_file"
if [ "$count" -eq 1 ]; then
  : > "$started_file"
  while [ ! -f "$release_file" ]; do sleep 0.01; done
  exit 1
fi
exec ${shellQuote(realFfmpeg.trim())} "$@"
`,
    );
    await chmod(shimPath, 0o700);

    const workerOptions = {
      jobId,
      ffmpegBin: shimPath,
      stagingDir,
      outputDir,
    };
    const firstWorker = processClipJob(database, workerOptions);
    let secondResult;
    let secondError;
    try {
      let started = false;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        try {
          await readFile(firstStartedPath);
          started = true;
          break;
        } catch {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
      }
      assert.equal(started, true, 'first worker did not reach the controlled FFmpeg pause');
      database
        .prepare('UPDATE media_jobs SET processing_started_at = ? WHERE id = ?')
        .run(new Date(Date.now() - PROCESSING_CLAIM_LEASE_MS - 1000).toISOString(), jobId);
      secondResult = await processClipJob(database, workerOptions);
    } catch (error) {
      secondError = error;
    } finally {
      await writeFile(releaseFirstPath, 'release');
    }

    const firstResult = await firstWorker;
    if (secondError) throw secondError;
    assert.deepEqual(secondResult, { ok: true, jobId, status: 'ready' });
    assert.equal(firstResult.ok, false);
    const readyRow = database
      .prepare(
        `SELECT status, claim_generation AS claimGeneration, output_path AS outputPath,
                output_sha256 AS sha256, output_bytes AS byteLength
         FROM media_jobs WHERE id = ?`,
      )
      .get(jobId);
    assert.equal(readyRow.status, 'ready');
    assert.equal(readyRow.claimGeneration, 2);
    assert.ok(readyRow.outputPath);
    const outputBytes = await readFile(readyRow.outputPath);
    assert.equal(readyRow.byteLength, outputBytes.length);
    assert.equal(readyRow.sha256, createHash('sha256').update(outputBytes).digest('hex'));
  });
});

test('a row finalized before #157 is unverifiable and the migration backfills it', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-integrity-backfill-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_FFMPEG_BIN: 'ffmpeg',
  });
  try {
    let database = openDatabase(config);
    const jobId = await finalizeOneClip({ database, config, dataDir }, 'integrity-backfill-1');
    const row = storedIntegrity(database, jobId);
    const bytes = await readFile(row.outputPath);

    // Recreate the pre-#157 shape: no recorded digest and no receipt.
    database
      .prepare(
        `UPDATE media_jobs SET output_sha256 = NULL, output_bytes = NULL,
           output_verified_at = NULL WHERE id = ?`,
      )
      .run(jobId);
    const result = await verifyMediaIntegrity(database, jobId, row.outputPath);
    assert.equal(result.outcome, 'unverifiable');
    database.close();

    const raw = new DatabaseSync(config.databasePath);
    raw.exec("DELETE FROM schema_migration_markers WHERE migration_key = 'media-integrity-v1'");
    raw.exec('DELETE FROM schema_migrations WHERE version = 15');
    raw.close();

    database = openDatabase(config);
    try {
      await backfillMediaIntegrity(database, config.dataDir);
      const backfilled = storedIntegrity(database, jobId);
      assert.equal(backfilled.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(backfilled.byteLength, bytes.length);
      assert.ok(backfilled.verifiedAt);
      // Repairing twice is safe and leaves the same values.
      migrateDatabase(database);
      await backfillMediaIntegrity(database, config.dataDir);
      assert.deepEqual({ ...storedIntegrity(database, jobId) }, { ...backfilled });
    } finally {
      database.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('legacy backfill releases writer locks while hashing and resumes after restart', async () => {
  await withDatabase(async ({ database, config, dataDir }) => {
    const jobIds = [
      await finalizeOneClip({ database, config, dataDir }, 'integrity-resume-a'),
      await finalizeOneClip({ database, config, dataDir }, 'integrity-resume-b'),
    ].sort();
    const expected = new Map(
      await Promise.all(
        jobIds.map(async (jobId) => {
          const row = storedIntegrity(database, jobId);
          const bytes = await readFile(row.outputPath);
          return [jobId, createHash('sha256').update(bytes).digest('hex')];
        }),
      ),
    );
    database
      .prepare(
        `UPDATE media_jobs SET output_sha256 = NULL, output_bytes = NULL,
           output_verified_at = NULL WHERE id IN (?, ?)`,
      )
      .run(...jobIds);
    // Force the schema-only migration to replay, as after a crash between
    // adding columns and finishing the separate backfill phase.
    const raw = new DatabaseSync(config.databasePath);
    raw.exec("DELETE FROM schema_migration_markers WHERE migration_key = 'media-integrity-v1'");
    raw.exec('DELETE FROM schema_migrations WHERE version = 15');
    raw.close();
    migrateDatabase(database);

    const competingWriter = new DatabaseSync(config.databasePath);
    competingWriter.exec('PRAGMA busy_timeout = 100');
    let hashCalls = 0;
    await assert.rejects(
      backfillMediaIntegrity(database, dataDir, {
        hashOutput: async (path) => {
          hashCalls += 1;
          if (hashCalls === 1) {
            // Hold a competing writer lock during the media read. This fails
            // with SQLITE_BUSY if the migration already holds BEGIN IMMEDIATE.
            competingWriter.exec('BEGIN IMMEDIATE');
            try {
              competingWriter
                .prepare("UPDATE groups SET name = name WHERE id = 'demo-group'")
                .run();
              const integrity = await hashFileWithIdentity(path);
              competingWriter.exec('COMMIT');
              return integrity;
            } catch (error) {
              competingWriter.exec('ROLLBACK');
              throw error;
            }
          }
          throw new Error('simulated interruption after one committed receipt');
        },
      }),
      /simulated interruption/,
    );
    competingWriter.close();
    assert.equal(hashCalls, 2);
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM media_jobs
           WHERE id IN (?, ?) AND output_sha256 IS NOT NULL`,
        )
        .get(...jobIds).count,
      1,
      'the first short receipt transaction should survive the simulated interruption',
    );

    // Reopening reapplies only the idempotent schema and resumes the missing
    // row; the already-recorded receipt stays unchanged.
    const resumed = openDatabase(config);
    try {
      await backfillMediaIntegrity(resumed, dataDir);
      for (const jobId of jobIds) {
        assert.equal(storedIntegrity(resumed, jobId).sha256, expected.get(jobId));
      }
    } finally {
      resumed.close();
    }
  });
});

test('the integrity migration is idempotent, preserves audit rows, and widens the event guard', async () => {
  await withDatabase(async ({ config, database }) => {
    database
      .prepare(
        `INSERT INTO audit_events (id, event_type, actor_member_id, resource_id, occurred_at, result)
         VALUES ('legacy-audit', 'job.failed', 'demo-1', 'job:legacy-1', ?, 'failure')`,
      )
      .run(new Date().toISOString());
    migrateDatabase(database);

    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id = 'legacy-audit'").get()
        .count,
      1,
      'existing audit rows must survive the table rebuild',
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'media.integrity_failed'",
        )
        .get().count,
      0,
    );
    // The rebuilt table still indexes chronological and resource lookups.
    const indexes = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_events'")
      .all()
      .map((row) => row.name);
    assert.ok(indexes.includes('audit_events_occurred_at_idx'));
    assert.ok(indexes.includes('audit_events_resource_id_idx'));
  });
});

/** Insert one already-processed clip so a film can compile real retained
 * inputs. The recorded digest is computed from the bytes actually written. */
async function insertReadyClipWithIntegrity(database, { id, contributionId, cycleId, path }) {
  const bytes = await readFile(path);
  database
    .prepare(
      `INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
       VALUES (?, ?, 'demo-2', 1, '2026-09-10T01:00:00.000Z')`,
    )
    .run(contributionId, cycleId);
  database
    .prepare(
      `INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, output_path, created_at, source_path,
         output_sha256, output_bytes, output_verified_at)
       VALUES (?, 'demo-group', ?, 'clip', 'ready', ?, '2026-09-10T01:00:00.000Z', NULL, ?, ?, ?)`,
    )
    .run(
      id,
      contributionId,
      path,
      createHash('sha256').update(bytes).digest('hex'),
      bytes.length,
      '2026-09-10T01:00:30.000Z',
    );
}

test('film finalization persists a digest and verifies its retained clip inputs', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    const outputDir = resolve(dataDir, 'media', 'processed');
    const clipPath = resolve(outputDir, 'input-clip.mp4');
    await createSyntheticSource(clipPath);
    await insertReadyClipWithIntegrity(database, {
      id: 'integrity-input-clip',
      contributionId: 'integrity-input-contribution',
      cycleId: 'demo-cycle',
      path: clipPath,
    });
    database.prepare("UPDATE cycles SET status = 'revealing' WHERE id = 'demo-cycle'").run();
    const created = createCompilationJob(database, {
      groupId: 'demo-group',
      cycleId: 'demo-cycle',
      createdAt: '2026-09-11T00:00:00.000Z',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const result = await processCompilationJob(database, {
      jobId: created.job.id,
      ffmpegBin: config.ffmpegBin,
      outputDir,
    });
    assert.deepEqual(result, { ok: true, jobId: created.job.id, status: 'ready' });

    const row = storedIntegrity(database, created.job.id);
    const bytes = await readFile(row.outputPath);
    assert.equal(row.byteLength, bytes.length);
    assert.equal(row.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(getCompilationJob(database, created.job.id)?.status, 'ready');
  });
});

test('a tampered retained clip input blocks film compilation instead of minting a fresh digest', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    const outputDir = resolve(dataDir, 'media', 'processed');
    const clipPath = resolve(outputDir, 'tampered-input.mp4');
    await createSyntheticSource(clipPath);
    await insertReadyClipWithIntegrity(database, {
      id: 'integrity-tampered-clip',
      contributionId: 'integrity-tampered-contribution',
      cycleId: 'demo-cycle',
      path: clipPath,
    });
    // Same length, different bytes.
    const original = await readFile(clipPath);
    const tampered = Buffer.from(original);
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    await writeFile(clipPath, tampered);

    database.prepare("UPDATE cycles SET status = 'revealing' WHERE id = 'demo-cycle'").run();
    const created = createCompilationJob(database, {
      groupId: 'demo-group',
      cycleId: 'demo-cycle',
      createdAt: '2026-09-11T00:00:00.000Z',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await processCompilationJob(database, {
        jobId: created.job.id,
        ffmpegBin: config.ffmpegBin,
        outputDir,
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
    }
    // The film must not be published with a checksum of the tampered input.
    assert.equal(getCompilationJob(database, created.job.id)?.status, 'failed');
    assert.equal(storedIntegrity(database, created.job.id).sha256, null);
    assert.deepEqual(
      database
        .prepare(
          `SELECT event_type AS eventType, resource_id AS resourceId, result
           FROM audit_events WHERE event_type = 'media.integrity_failed'`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          eventType: 'media.integrity_failed',
          resourceId: 'clip:integrity-tampered-clip',
          result: 'denied',
        },
      ],
      'the damaged retained clip is audited once at compilation detection, without file details',
    );
  });
});

test('a stale failing film worker cannot remove a reclaimed generation output', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    const outputDir = resolve(dataDir, 'media', 'processed');
    const clipPath = resolve(outputDir, 'overlapping-film-input.mp4');
    await createSyntheticSource(clipPath);
    await insertReadyClipWithIntegrity(database, {
      id: 'integrity-overlapping-film-clip',
      contributionId: 'integrity-overlapping-film-contribution',
      cycleId: 'demo-cycle',
      path: clipPath,
    });
    database.prepare("UPDATE cycles SET status = 'revealing' WHERE id = 'demo-cycle'").run();
    const created = createCompilationJob(database, {
      groupId: 'demo-group',
      cycleId: 'demo-cycle',
      createdAt: '2026-09-11T00:00:00.000Z',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const jobId = created.job.id;

    const staleStartedPath = resolve(dataDir, 'stale-film-worker-started');
    const staleReleasePath = resolve(dataDir, 'stale-film-worker-release');
    const currentStartedPath = resolve(dataDir, 'current-film-worker-started');
    const currentReleasePath = resolve(dataDir, 'current-film-worker-release');
    const { stdout: realFfmpeg } = await execFileAsync('which', ['ffmpeg']);
    const { stdout: realFfprobe } = await execFileAsync('which', ['ffprobe']);
    await symlink(realFfprobe.trim(), resolve(dataDir, 'ffprobe'));
    const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const makeWrapper = (startedPath, releasePath, command) =>
      `#!/bin/sh\n: > ${shellQuote(startedPath)}\nwhile [ ! -f ${shellQuote(releasePath)} ]; do sleep 0.01; done\n${command}\n`;
    const staleFfmpeg = resolve(dataDir, 'ffmpeg-stale-film-worker');
    const currentFfmpeg = resolve(dataDir, 'ffmpeg-current-film-worker');
    await writeFile(staleFfmpeg, makeWrapper(staleStartedPath, staleReleasePath, 'exit 1'), {
      mode: 0o700,
    });
    await writeFile(
      currentFfmpeg,
      makeWrapper(
        currentStartedPath,
        currentReleasePath,
        `exec ${shellQuote(realFfmpeg.trim())} "$@"`,
      ),
      { mode: 0o700 },
    );

    let staleWorker;
    let currentWorker;
    try {
      staleWorker = processCompilationJob(database, {
        jobId,
        ffmpegBin: staleFfmpeg,
        outputDir,
      });
      let staleStarted = false;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        try {
          await readFile(staleStartedPath);
          staleStarted = true;
          break;
        } catch {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
      }
      assert.equal(staleStarted, true, 'stale worker did not reach the controlled FFmpeg pause');
      database
        .prepare('UPDATE media_jobs SET processing_started_at = ? WHERE id = ?')
        .run(new Date(Date.now() - PROCESSING_CLAIM_LEASE_MS - 1000).toISOString(), jobId);

      currentWorker = processCompilationJob(database, {
        jobId,
        ffmpegBin: currentFfmpeg,
        outputDir,
      });
      let currentStarted = false;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        try {
          await readFile(currentStartedPath);
          currentStarted = true;
          break;
        } catch {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
      }
      assert.equal(
        currentStarted,
        true,
        'reclaimed worker did not reach the controlled FFmpeg pause',
      );

      const currentGeneration = database
        .prepare('SELECT claim_generation AS generation FROM media_jobs WHERE id = ?')
        .get(jobId).generation;
      assert.equal(currentGeneration, 2);
      const suffix = createHash('sha256').update(jobId).digest('hex').slice(0, 24);
      const currentOutputPath = resolve(outputDir, `film-${suffix}-g2.mp4`);
      await writeFile(currentOutputPath, 'generation 2 output');

      // Let stale generation 1 fail while generation 2 is still processing
      // and its generation-specific final path already exists.
      await writeFile(staleReleasePath, 'fail stale worker');
      const staleResult = await staleWorker;
      assert.equal(staleResult.ok, false);
      const stillProcessing = database
        .prepare('SELECT status, claim_generation AS generation FROM media_jobs WHERE id = ?')
        .get(jobId);
      assert.equal(stillProcessing.status, 'processing');
      assert.equal(stillProcessing.generation, 2);
      assert.equal(await readFile(currentOutputPath, 'utf8'), 'generation 2 output');

      await writeFile(currentReleasePath, 'publish current worker');
      const currentResult = await currentWorker;
      assert.deepEqual(currentResult, { ok: true, jobId, status: 'ready' });
      const readyRow = database
        .prepare('SELECT status, output_path AS outputPath FROM media_jobs WHERE id = ?')
        .get(jobId);
      assert.equal(readyRow.status, 'ready');
      assert.equal(readyRow.outputPath, currentOutputPath);
      const integrity = storedIntegrity(database, jobId);
      const bytes = await readFile(readyRow.outputPath);
      assert.equal(integrity.byteLength, bytes.length);
      assert.equal(integrity.sha256, createHash('sha256').update(bytes).digest('hex'));
    } finally {
      await writeFile(staleReleasePath, 'unblock stale worker').catch(() => undefined);
      await writeFile(currentReleasePath, 'unblock current worker').catch(() => undefined);
      await Promise.all([
        staleWorker?.catch(() => undefined),
        currentWorker?.catch(() => undefined),
      ]);
    }
  });
});

test('media streaming retains a verified snapshot after its source pathname is replaced', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    const jobId = await finalizeOneClip({ database, config, dataDir }, 'integrity-stream-race');
    const row = storedIntegrity(database, jobId);
    const expectedBytes = await readFile(row.outputPath);
    const replacement = resolve(dataDir, 'replacement.mp4');
    const changedBytes = Buffer.from(expectedBytes);
    changedBytes[Math.floor(changedBytes.length / 2)] ^= 0xff;
    await writeFile(replacement, changedBytes);

    const opened = await openMediaWithIntegrity(database, jobId, row.outputPath);
    assert.equal(opened.result.outcome, 'verified');
    assert.ok(opened.handle);
    assert.equal(opened.byteLength, expectedBytes.length);
    try {
      // This is the exact interval between HTTP verification and beginning
      // the response stream. Atomic replacement of the published path must
      // not redirect the already verified response to a different inode.
      await rename(replacement, row.outputPath);
      const chunks = [];
      for await (const chunk of opened.handle.createReadStream({ autoClose: true })) {
        chunks.push(chunk);
      }
      assert.deepEqual(Buffer.concat(chunks), expectedBytes);
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  });
});

test('media streaming rejects a mixed snapshot after an in-place source mutation', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    const jobId = await finalizeOneClip(
      { database, config, dataDir },
      'integrity-stream-in-place-race',
    );
    const row = storedIntegrity(database, jobId);
    const expectedBytes = await readFile(row.outputPath);
    const replacement = Buffer.from(expectedBytes);
    replacement.fill(0x5a, Math.floor(replacement.length / 2));

    // Pause the source read after its first chunk. This reliably places the
    // mutation between snapshot chunks without relying on filesystem timing.
    const source = await open(row.outputPath, 'r+');
    const originalSourceRead = source.read.bind(source);
    let paused = false;
    let releaseRead;
    let continueRead;
    const readPaused = new Promise((resolve) => {
      releaseRead = resolve;
    });
    const resumeRead = new Promise((resolve) => {
      continueRead = resolve;
    });
    const readFromSource = async (...args) => {
      const result = await originalSourceRead(...args);
      if (!paused && result.bytesRead > 0) {
        paused = true;
        releaseRead();
        await resumeRead;
      }
      return result;
    };

    try {
      const opening = openMediaWithIntegrity(database, jobId, row.outputPath, {
        readSource: readFromSource,
      });
      await readPaused;
      await source.write(replacement, 0, replacement.length, 0);
      continueRead();
      const opened = await opening;
      assert.equal(opened.result.outcome, 'unavailable');
      assert.equal(opened.handle, null);
    } finally {
      continueRead();
      await source.close();
    }
  });
});

test('a published film whose bytes changed is reported delayed and never streamed', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    const processedDir = resolve(dataDir, 'media', 'processed');
    const filmPath = resolve(processedDir, 'demo-film.mp4');
    await createSyntheticSource(filmPath);
    const bytes = await readFile(filmPath);
    database
      .prepare(
        `UPDATE media_jobs
         SET status = 'ready', cycle_id = 'demo-cycle', output_path = ?,
             output_sha256 = ?, output_bytes = ?, output_verified_at = ?
         WHERE id = 'demo-film' AND kind = 'film'`,
      )
      .run(
        filmPath,
        createHash('sha256').update(bytes).digest('hex'),
        bytes.length,
        new Date().toISOString(),
      );
    database
      .prepare(
        `UPDATE cycles SET status = 'revealing', release_status = 'published',
           release_published_at = ? WHERE id = 'demo-cycle'`,
      )
      .run(new Date().toISOString());

    const server = createRuntimeServer(config, database);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: 'demo-1' }),
      });
      const session = await sessionResponse.json();
      const query = `groupId=demo-group&sessionId=${encodeURIComponent(session.session.id)}`;

      // Healthy bytes: the premiere is ready and the film streams.
      const ready = await fetch(`${baseUrl}/cycles/demo-cycle/premiere?${query}`);
      const readyBody = await ready.json();
      assert.equal(readyBody.premiere.state, 'ready');
      const playback = await fetch(`${baseUrl}${readyBody.premiere.playbackPath}`);
      assert.equal(playback.status, 200);

      // Tampered bytes: the same request must stop advertising playback.
      const tampered = Buffer.from(bytes);
      tampered[tampered.length - 1] ^= 0xff;
      await writeFile(filmPath, tampered);
      const broken = await fetch(`${baseUrl}/cycles/demo-cycle/premiere?${query}`);
      assert.deepEqual(await broken.json(), {
        premiere: { state: 'delayed', cycleId: 'demo-cycle' },
      });
      const brokenPlayback = await fetch(`${baseUrl}/films/demo-film/play?${query}`);
      assert.equal(brokenPlayback.status, 404);
      const audit = database
        .prepare(
          `SELECT resource_id AS resourceId FROM audit_events
           WHERE event_type = 'media.integrity_failed'`,
        )
        .all()
        .map((row) => ({ ...row }));
      assert.deepEqual(audit, [{ resourceId: 'film:demo-film' }]);
    } finally {
      await new Promise((close) => server.close(close));
    }
  });
});

test('hashFileSync and hashFile agree, and reject empty or absent files', async () => {
  await withDatabase(async ({ dataDir }) => {
    const path = resolve(dataDir, 'sample.bin');
    await writeFile(path, Buffer.from('deterministic-payload'));
    assert.deepEqual(hashFileSync(path), await hashFile(path));
    assert.equal(hashFileSync(resolve(dataDir, 'absent.bin')), null);
    const empty = resolve(dataDir, 'empty.bin');
    await writeFile(empty, Buffer.alloc(0));
    assert.equal(hashFileSync(empty), null);
    assert.equal(await hashFile(empty), null);
  });
});
