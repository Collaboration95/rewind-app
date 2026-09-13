import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { once } from 'node:events';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { migrateDatabase, openDatabase } = await import('../dist/db.js');
const { copyFile, utimes } = await import('node:fs/promises');
const {
  claimStagedSource,
  cancelClipUpload,
  createClipUpload,
  markStagedSourceReady,
  reclaimStagedSource,
  recordClipMediaMetadata,
  resetStagedSourceClaim,
  setStagedSourcePath,
  stagedSourceId,
  stagedSourcePath,
} = await import('../dist/media/index.js');
const { cleanupOrphanedStagedSources, processClipJob, PROCESSING_CLAIM_LEASE_MS } =
  await import('../dist/jobs/index.js');
const { probeClipWithFfmpeg } = await import('../dist/ffmpeg.js');
const { createRuntimeServer } = await import('../dist/http.js');

async function withDatabase(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-media-processing-test-`);
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

async function createSyntheticSource(path, firstColor = 'red') {
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
      `color=c=${firstColor}:size=180x320:rate=12:duration=1`,
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
    ],
    { maxBuffer: 2_000_000 },
  );
}

async function enqueue(
  database,
  sourcePath,
  mode,
  idempotencyKey,
  trimStartSeconds = 1,
  trimEndSeconds = 1.5,
) {
  const upload = createClipUpload(
    database,
    'demo-group',
    'demo-1',
    {
      idempotencyKey,
      sourceUri: sourcePath,
      mimeType: 'video/mp4',
      byteLength: 10_000,
      durationSeconds: trimEndSeconds - trimStartSeconds,
      width: 180,
      height: 320,
      hasAudio: true,
      mode,
      trimStartSeconds,
      trimEndSeconds,
      sourceDurationSeconds: 2,
    },
    new Date('2026-09-10T12:00:00.000Z'),
  );
  assert.equal(upload.ok, true);
  if (!upload.ok) throw new Error('synthetic upload was rejected');
  return upload.upload.job.id;
}

async function firstFrameAverage(path) {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 2_000_000 },
  );
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let offset = 0; offset + 2 < stdout.length; offset += 3) {
    red += stdout[offset];
    green += stdout[offset + 1];
    blue += stdout[offset + 2];
  }
  const pixels = stdout.length / 3;
  return { red: red / pixels, green: green / pixels, blue: blue / pixels };
}

for (const mode of ['soft-focus', 'high-contrast']) {
  test(`FFmpeg produces a playable ${mode} clip with bounded trim and raw cleanup`, async () => {
    await withDatabase(async ({ database, config, dataDir }) => {
      const stagingDir = `${dataDir}/media/staging`;
      const stagedSourcePath = `${stagingDir}/${mode}.mp4`;
      await mkdir(stagingDir, { recursive: true });
      await createSyntheticSource(stagedSourcePath);
      const jobId = await enqueue(
        database,
        stagedSourcePath,
        mode,
        `mode-${mode.replace('-', '')}-key`,
      );
      const result = await processClipJob(database, {
        jobId,
        ffmpegBin: config.ffmpegBin,
        stagingDir,
        outputDir: `${dataDir}/processed`,
      });
      assert.deepEqual(result, { ok: true, jobId, status: 'ready' });
      await assert.rejects(access(stagedSourcePath));
      const row = database
        .prepare(
          'SELECT status, output_path AS outputPath, source_path AS sourcePath FROM media_jobs WHERE id = ?',
        )
        .get(jobId);
      assert.equal(row.status, 'ready');
      assert.equal(row.sourcePath, null);
      await access(row.outputPath);
      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        row.outputPath,
      ]);
      const duration = Number(stdout.trim());
      assert.ok(Math.abs(duration - 0.5) <= 0.15, `unexpected output duration ${duration}`);
      const average = await firstFrameAverage(row.outputPath);
      assert.ok(
        average.blue > average.red * 1.5,
        `trim did not select the blue scene: ${JSON.stringify(average)}`,
      );
      const { stdout: streams } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-count_frames',
        '-show_entries',
        'stream=codec_type,nb_read_frames',
        '-of',
        'csv=p=0',
        row.outputPath,
      ]);
      assert.match(streams, /video/);
      assert.match(streams, /audio/);
      const { stdout: firstTimestamp } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-read_intervals',
        '%+#1',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'csv=p=0',
        row.outputPath,
      ]);
      assert.ok(
        Number.parseFloat(firstTimestamp.trim()) <= 0.1,
        `unexpected first frame timestamp ${firstTimestamp}`,
      );
    });
  });
}

test('the shared probe accepts only playable portrait MP4 sources with audio', async () => {
  await withDatabase(async ({ config, dataDir }) => {
    const mp4Path = `${dataDir}/probe.mp4`;
    await createSyntheticSource(mp4Path);
    const metadata = await probeClipWithFfmpeg(config.ffmpegBin, mp4Path);
    const fileUrlMetadata = await probeClipWithFfmpeg(
      config.ffmpegBin,
      pathToFileURL(mp4Path).href,
    );
    assert.equal(metadata.mimeType, 'video/mp4');
    assert.equal(metadata.hasAudio, true);
    assert.equal(metadata.width, 180);
    assert.equal(metadata.height, 320);
    assert.ok(metadata.durationSeconds > 0);
    assert.deepEqual(fileUrlMetadata, metadata);

    const webmPath = `${dataDir}/probe.webm`;
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=180x320:rate=12:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100:duration=1',
      '-c:v',
      'libvpx-vp9',
      '-c:a',
      'libopus',
      '-shortest',
      webmPath,
    ]);
    await assert.rejects(probeClipWithFfmpeg(config.ffmpegBin, webmPath));
  });
});

async function* delayedBody(buffer) {
  for (let offset = 0; offset < buffer.byteLength; offset += 1024) {
    yield buffer.subarray(offset, Math.min(offset + 1024, buffer.byteLength));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('same-key staging claims one pending source and rejects a concurrent distinct payload', async () => {
  await withDatabase(async ({ database, config, dataDir }) => {
    const firstPath = `${dataDir}/first.mp4`;
    const secondPath = `${dataDir}/second.mp4`;
    await createSyntheticSource(firstPath, 'red');
    await createSyntheticSource(secondPath, 'green');
    database
      .prepare('UPDATE cycles SET ends_at = ? WHERE id = ?')
      .run(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), 'demo-cycle');
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
      const { session } = await sessionResponse.json();
      const query = `sessionId=${encodeURIComponent(session.id)}&groupId=demo-group&idempotencyKey=concurrent-stage-key`;
      const [firstBody, secondBody] = await Promise.all([
        readFile(firstPath),
        readFile(secondPath),
      ]);
      const responses = await Promise.all(
        [firstBody, secondBody].map((body) =>
          fetch(`${baseUrl}/contributions/upload/source?${query}`, {
            method: 'POST',
            headers: { 'Content-Type': 'video/mp4' },
            body: delayedBody(body),
            duplex: 'half',
          }),
        ),
      );
      assert.deepEqual(
        responses.map((response) => response.status).sort((a, b) => a - b),
        [201, 409],
      );
      const sourceUri = `staged://${stagedSourceId('concurrent-stage-key')}`;
      const sourcePath = stagedSourcePath(sourceUri, `${dataDir}/media/staging`);
      assert.ok(sourcePath);
      const stored = await readFile(sourcePath);
      assert.equal(
        [firstBody, secondBody].some((body) => Buffer.compare(stored, body) === 0),
        true,
      );
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM staged_sources').get().count, 1);
      assert.equal(database.prepare('SELECT status FROM staged_sources').get().status, 'staged');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('stale intake callbacks cannot complete or reset a reclaimed generation', async () => {
  await withDatabase(async ({ database, dataDir }) => {
    const stagingDir = `${dataDir}/media/staging`;
    const key = 'generation-fence-key';
    const sourceUri = `staged://${stagedSourceId(key)}`;
    const firstPath = stagedSourcePath(sourceUri, stagingDir, 1);
    const secondPath = stagedSourcePath(sourceUri, stagingDir, 2);
    assert.ok(firstPath);
    assert.ok(secondPath);
    const first = claimStagedSource(
      database,
      'demo-group',
      'demo-1',
      key,
      new Date('2026-09-10T12:00:00.000Z'),
      firstPath,
    );
    assert.equal(first.ok, true);
    assert.equal(first.source.claimGeneration, 1);
    assert.equal(resetStagedSourceClaim(database, sourceUri, firstPath, 1), true);
    const second = claimStagedSource(
      database,
      'demo-group',
      'demo-1',
      key,
      new Date('2026-09-10T12:01:00.000Z'),
      secondPath,
    );
    assert.equal(second.ok, true);
    assert.equal(second.source.claimGeneration, 2);
    assert.equal(markStagedSourceReady(database, sourceUri, 1000, firstPath, 1), false);
    assert.equal(resetStagedSourceClaim(database, sourceUri, firstPath, 1), false);
    assert.equal(markStagedSourceReady(database, sourceUri, 1000, secondPath, 2), true);
    const current = database
      .prepare(
        'SELECT status, source_path AS sourcePath, claim_generation AS claimGeneration FROM staged_sources WHERE source_uri = ?',
      )
      .get(sourceUri);
    assert.deepEqual(
      { ...current },
      {
        status: 'staged',
        sourcePath: secondPath,
        claimGeneration: 2,
      },
    );
  });
});

test('expired pending intake claims can be reclaimed to a new generation', async () => {
  await withDatabase(async ({ database, dataDir }) => {
    const stagingDir = `${dataDir}/media/staging`;
    const key = 'expired-pending-reclaim-key';
    const sourceUri = `staged://${stagedSourceId(key)}`;
    const firstPath = stagedSourcePath(sourceUri, stagingDir, 1);
    const secondPath = stagedSourcePath(sourceUri, stagingDir, 2);
    assert.ok(firstPath);
    assert.ok(secondPath);
    const claimed = claimStagedSource(
      database,
      'demo-group',
      'demo-1',
      key,
      new Date('2026-09-10T12:00:00.000Z'),
      firstPath,
    );
    assert.equal(claimed.ok, true);
    const reclaimed = reclaimStagedSource(
      database,
      'demo-group',
      'demo-1',
      key,
      secondPath,
      new Date('2026-09-10T15:00:00.000Z'),
    );
    assert.equal(reclaimed.ok, true);
    if (!reclaimed.ok) return;
    assert.equal(reclaimed.source.status, 'pending');
    assert.equal(reclaimed.source.sourcePath, secondPath);
    assert.equal(reclaimed.source.claimGeneration, 2);
  });
});

test('enqueue retries rebind a pending job to the recovered staged generation', async () => {
  await withDatabase(async ({ database, dataDir }) => {
    const stagingDir = `${dataDir}/media/staging`;
    const key = 'enqueue-recovery-key';
    const sourceUri = `staged://${stagedSourceId(key)}`;
    const firstPath = stagedSourcePath(sourceUri, stagingDir, 1);
    const secondPath = stagedSourcePath(sourceUri, stagingDir, 2);
    assert.ok(firstPath);
    assert.ok(secondPath);
    const first = claimStagedSource(
      database,
      'demo-group',
      'demo-1',
      key,
      new Date('2026-09-10T12:00:00.000Z'),
      firstPath,
    );
    assert.equal(first.ok, true);
    assert.equal(markStagedSourceReady(database, sourceUri, 1000, firstPath, 1), true);
    recordClipMediaMetadata(database, {
      sourceUri,
      mimeType: 'video/mp4',
      byteLength: 1000,
      durationSeconds: 2,
      width: 180,
      height: 320,
      hasAudio: true,
    });
    const input = {
      idempotencyKey: key,
      sourceUri,
      mimeType: 'video/mp4',
      byteLength: 1000,
      durationSeconds: 1,
      width: 180,
      height: 320,
      hasAudio: true,
      mode: 'soft-focus',
      trimStartSeconds: 0.25,
      trimEndSeconds: 1.25,
    };
    const upload = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      input,
      new Date('2026-09-10T12:00:00.000Z'),
      { stagingDir, requireVerifiedMetadata: true },
    );
    assert.equal(upload.ok, true);
    if (!upload.ok) return;
    await rm(firstPath, { force: true });
    assert.equal(
      reclaimStagedSource(
        database,
        'demo-group',
        'demo-1',
        key,
        secondPath,
        new Date('2026-09-10T12:01:00.000Z'),
      ).ok,
      true,
    );
    assert.equal(markStagedSourceReady(database, sourceUri, 1000, secondPath, 2), true);
    recordClipMediaMetadata(database, {
      sourceUri,
      mimeType: 'video/mp4',
      byteLength: 1000,
      durationSeconds: 2,
      width: 180,
      height: 320,
      hasAudio: true,
    });
    const retry = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      input,
      new Date('2026-09-10T12:02:00.000Z'),
      { stagingDir, requireVerifiedMetadata: true },
    );
    assert.equal(retry.ok, true);
    assert.equal(retry.ok && retry.upload.existing, true);
    const job = database
      .prepare(
        'SELECT source_uri AS sourceUri, source_generation AS sourceGeneration, source_path AS sourcePath FROM media_jobs WHERE id = ?',
      )
      .get(upload.upload.job.id);
    assert.deepEqual(
      { ...job },
      {
        sourceUri,
        sourceGeneration: 2,
        sourcePath: secondPath,
      },
    );
  });
});

test('a worker restart finalizes a durable output marker after raw deletion', async () => {
  await withDatabase(async ({ database, config, dataDir }) => {
    const stagingDir = `${dataDir}/media/staging`;
    const outputDir = `${dataDir}/processed`;
    const sourceUri = `staged://${stagedSourceId('finalize-marker-key')}`;
    const sourcePath = stagedSourcePath(sourceUri, stagingDir, 1);
    assert.ok(sourcePath);
    await mkdir(stagingDir, { recursive: true });
    const fixture = `${dataDir}/finalize-fixture.mp4`;
    await createSyntheticSource(fixture);
    await copyFile(fixture, sourcePath);
    assert.equal(
      claimStagedSource(
        database,
        'demo-group',
        'demo-1',
        'finalize-marker-key',
        new Date('2026-09-10T12:00:00.000Z'),
        sourcePath,
      ).ok,
      true,
    );
    assert.equal(markStagedSourceReady(database, sourceUri, 1000, sourcePath, 1), true);
    recordClipMediaMetadata(database, {
      sourceUri,
      mimeType: 'video/mp4',
      byteLength: 1000,
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
        idempotencyKey: 'finalize-marker-key',
        sourceUri,
        mimeType: 'video/mp4',
        byteLength: 1000,
        durationSeconds: 1,
        width: 180,
        height: 320,
        hasAudio: true,
        mode: 'soft-focus',
        trimStartSeconds: 0.25,
        trimEndSeconds: 1.25,
      },
      new Date('2026-09-10T12:00:00.000Z'),
      { stagingDir, requireVerifiedMetadata: true },
    );
    assert.equal(upload.ok, true);
    if (!upload.ok) return;
    const outputPath = `${outputDir}/durable-output.mp4`;
    await mkdir(outputDir, { recursive: true });
    await copyFile(fixture, outputPath);
    await rm(sourcePath, { force: true });
    database
      .prepare(
        `UPDATE media_jobs SET status = 'processing', output_path = ?,
           processing_started_at = ?, source_path = ?
         WHERE id = ?`,
      )
      .run(
        outputPath,
        new Date(Date.now() - PROCESSING_CLAIM_LEASE_MS - 1_000).toISOString(),
        sourcePath,
        upload.upload.job.id,
      );
    const result = await processClipJob(database, {
      jobId: upload.upload.job.id,
      ffmpegBin: config.ffmpegBin,
      stagingDir,
      outputDir,
    });
    assert.deepEqual(result, { ok: true, jobId: upload.upload.job.id, status: 'ready' });
    assert.equal(
      database.prepare('SELECT status FROM media_jobs WHERE id = ?').get(upload.upload.job.id)
        .status,
      'ready',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM staged_sources').get().count, 0);
    await access(outputPath);
    await assert.rejects(access(sourcePath));
  });
});

test('cleanup preserves a live leased intake claim even when its file is old', async () => {
  await withDatabase(async ({ database, dataDir }) => {
    const stagingDir = `${dataDir}/media/staging`;
    const key = 'leased-cleanup-key';
    const sourceUri = `staged://${stagedSourceId(key)}`;
    const sourcePath = stagedSourcePath(sourceUri, stagingDir, 1);
    assert.ok(sourcePath);
    await mkdir(stagingDir, { recursive: true });
    await copyFile(`${dataDir}/fixture.mp4`, sourcePath).catch(async () => {
      const fixture = `${dataDir}/fixture.mp4`;
      await createSyntheticSource(fixture);
      await copyFile(fixture, sourcePath);
    });
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(sourcePath, staleAt, staleAt);
    const claim = claimStagedSource(database, 'demo-group', 'demo-1', key, new Date(), sourcePath);
    assert.equal(claim.ok, true);
    assert.equal(await cleanupOrphanedStagedSources(database, stagingDir, 25, 0), 0);
    await access(sourcePath);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM staged_sources').get().count, 1);
  });
});

test('processing failure is recoverable and never discloses media paths', async () => {
  await withDatabase(async ({ database, config, dataDir }) => {
    const sourcePath = `${dataDir}/external-source.mp4`;
    await createSyntheticSource(sourcePath);
    const jobId = await enqueue(database, sourcePath, 'soft-focus', 'failure-source-key');
    const result = await processClipJob(database, {
      jobId,
      ffmpegBin: config.ffmpegBin,
      stagingDir: `${dataDir}/media/staging`,
      outputDir: `${dataDir}/processed`,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /retry/i);
    assert.doesNotMatch(result.message, /external-source|rewind-media-processing-test/);
    const row = database
      .prepare(
        'SELECT status, output_path AS outputPath, error_code AS errorCode FROM media_jobs WHERE id = ?',
      )
      .get(jobId);
    assert.equal(row.status, 'failed');
    assert.equal(row.outputPath, null);
    assert.equal(row.errorCode, 'source_unavailable');
    const events = database.prepare('SELECT resource_id AS resourceId FROM audit_events').all();
    assert.equal(
      events.every((event) => !String(event.resourceId).includes('missing-source')),
      true,
    );
    await access(sourcePath);

    // The failed job retains enough private metadata to retry after the
    // transient source problem is repaired.
    await mkdir(`${dataDir}/media/staging`, { recursive: true });
    const stagedSourcePath = `${dataDir}/media/staging/repaired-source.mp4`;
    await createSyntheticSource(stagedSourcePath);
    database
      .prepare('UPDATE media_jobs SET source_path = ? WHERE id = ?')
      .run(stagedSourcePath, jobId);
    const retry = await processClipJob(database, {
      jobId,
      ffmpegBin: config.ffmpegBin,
      stagingDir: `${dataDir}/media/staging`,
      outputDir: `${dataDir}/processed`,
    });
    assert.deepEqual(retry, { ok: true, jobId, status: 'ready' });
    await assert.rejects(access(stagedSourcePath));
  });
});

test('a stale processing claim is recoverable after a worker restart', async () => {
  await withDatabase(async ({ database, config, dataDir }) => {
    const stagingDir = `${dataDir}/media/staging`;
    const sourcePath = `${stagingDir}/stale-claim.mp4`;
    await mkdir(stagingDir, { recursive: true });
    await createSyntheticSource(sourcePath);
    const jobId = await enqueue(database, sourcePath, 'soft-focus', 'stale-claim-key');
    database
      .prepare(
        `UPDATE media_jobs
         SET status = 'processing', processing_started_at = ?
         WHERE id = ?`,
      )
      .run(new Date(Date.now() - PROCESSING_CLAIM_LEASE_MS - 1_000).toISOString(), jobId);
    const result = await processClipJob(database, {
      jobId,
      ffmpegBin: config.ffmpegBin,
      stagingDir,
      outputDir: `${dataDir}/processed`,
    });
    assert.deepEqual(result, { ok: true, jobId, status: 'ready' });
    assert.equal(
      database
        .prepare('SELECT processing_started_at AS startedAt FROM media_jobs WHERE id = ?')
        .get(jobId).startedAt,
      null,
    );
    await assert.rejects(access(sourcePath));
  });
});

test('cancellation rechecks the job state after a concurrent processor claim', async () => {
  await withDatabase(async ({ database, config, dataDir }) => {
    const sourcePath = `${dataDir}/cancel-race.mp4`;
    const jobId = await enqueue(database, sourcePath, 'soft-focus', 'cancel-race-key');
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(workerData.databasePath);
       db.exec('BEGIN IMMEDIATE');
       db.prepare("UPDATE media_jobs SET status = 'processing' WHERE id = ?").run(workerData.jobId);
       parentPort.postMessage('claimed');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
       db.exec('COMMIT');
       db.close();`,
      { eval: true, workerData: { databasePath: config.databasePath, jobId } },
    );
    try {
      await new Promise((resolve, reject) => {
        worker.once('message', (message) => (message === 'claimed' ? resolve() : undefined));
        worker.once('error', reject);
      });
      assert.deepEqual(cancelClipUpload(database, 'demo-group', 'demo-1', jobId), {
        ok: false,
        reason: 'not_found',
      });
      assert.equal(
        database.prepare('SELECT status FROM media_jobs WHERE id = ?').get(jobId).status,
        'processing',
      );
    } finally {
      await worker.terminate();
    }
  });
});

test('cancellation fences a capability that is concurrently recovered to a new path', async () => {
  await withDatabase(async ({ database, dataDir }) => {
    const stagingDir = `${dataDir}/media/staging`;
    const fixture = `${dataDir}/cancel-recovery-fixture.mp4`;
    await createSyntheticSource(fixture);
    const key = 'cancel-recovery-key';
    const sourceUri = `staged://${stagedSourceId(key)}`;
    const firstPath = stagedSourcePath(sourceUri, stagingDir, 1);
    const recoveredPath = stagedSourcePath(sourceUri, stagingDir, 2);
    assert.ok(firstPath);
    assert.ok(recoveredPath);
    await mkdir(stagingDir, { recursive: true });
    await copyFile(fixture, firstPath);
    const claim = claimStagedSource(
      database,
      'demo-group',
      'demo-1',
      key,
      new Date('2026-09-10T12:00:00.000Z'),
      firstPath,
    );
    assert.equal(claim.ok, true);
    assert.equal(markStagedSourceReady(database, sourceUri, 1000, firstPath, 1), true);
    recordClipMediaMetadata(database, {
      sourceUri,
      mimeType: 'video/mp4',
      byteLength: 1000,
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
        sourceUri,
        mimeType: 'video/mp4',
        byteLength: 1000,
        durationSeconds: 1,
        width: 180,
        height: 320,
        hasAudio: true,
        mode: 'soft-focus',
        trimStartSeconds: 0.25,
        trimEndSeconds: 1.25,
      },
      new Date('2026-09-10T12:00:00.000Z'),
      { stagingDir, requireVerifiedMetadata: true },
    );
    assert.equal(upload.ok, true);
    await rm(firstPath, { force: true });
    const recovered = reclaimStagedSource(
      database,
      'demo-group',
      'demo-1',
      key,
      recoveredPath,
      new Date('2026-09-10T12:01:00.000Z'),
    );
    assert.equal(recovered.ok, true);
    await copyFile(fixture, recoveredPath);
    assert.equal(
      cancelClipUpload(database, 'demo-group', 'demo-1', upload.upload.job.id, { stagingDir }).ok,
      true,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM staged_sources').get().count, 0);
    await assert.rejects(access(firstPath));
    await assert.rejects(access(recoveredPath));
  });
});

test('session-authorized HTTP processing completes a staged capture workflow', async () => {
  await withDatabase(async ({ database, config, dataDir }) => {
    const stagingDir = `${dataDir}/media/staging`;
    const sourcePath = `${dataDir}/http-capture-original.mp4`;
    await createSyntheticSource(sourcePath);
    const server = createRuntimeServer(config, database, {
      now: () => new Date('2026-09-10T12:00:00.000Z'),
    });
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
      const { session } = await sessionResponse.json();
      const query = `sessionId=${encodeURIComponent(session.id)}&groupId=demo-group`;
      const stagedResponse = await fetch(
        `${baseUrl}/contributions/upload/source?${query}&idempotencyKey=http-staged-key`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'video/mp4' },
          body: await readFile(sourcePath),
        },
      );
      assert.equal(stagedResponse.status, 201);
      const { source } = await stagedResponse.json();
      const stagedRetry = await fetch(
        `${baseUrl}/contributions/upload/source?${query}&idempotencyKey=http-staged-key`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'video/mp4' },
          body: await readFile(sourcePath),
        },
      );
      assert.equal(stagedRetry.status, 200);
      assert.deepEqual((await stagedRetry.json()).source, source);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM staged_sources').get().count, 1);
      const invalidStagedResponse = await fetch(
        `${baseUrl}/contributions/upload/source?${query}&idempotencyKey=invalid-stage-key`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'video/mp4' },
          body: await readFile(sourcePath),
        },
      );
      const { source: invalidSource } = await invalidStagedResponse.json();
      const invalidUploadResponse = await fetch(`${baseUrl}/contributions/upload?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: 'invalid-enqueue-key',
          sourceUri: invalidSource.uri,
          mimeType: 'video/mp4',
          byteLength: 10_000,
          durationSeconds: 1.25,
          width: 180,
          height: 320,
          hasAudio: true,
          mode: 'unsupported-mode',
          trimStartSeconds: 0.25,
          trimEndSeconds: 1.5,
          sourceDurationSeconds: 2,
        }),
      });
      // The staged token is bound to the staging idempotency key. A submit
      // with a different key is intentionally indistinguishable from a
      // missing resource and must not delete the owner's source.
      assert.equal(invalidUploadResponse.status, 404);
      await access(stagedSourcePath(invalidSource.uri, stagingDir));
      const malformedKeyResponse = await fetch(`${baseUrl}/contributions/upload?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: 'bad',
          sourceUri: invalidSource.uri,
          mimeType: 'video/mp4',
          byteLength: 10_000,
          durationSeconds: 1.25,
          width: 180,
          height: 320,
          hasAudio: true,
          mode: 'soft-focus',
          trimStartSeconds: 0.25,
          trimEndSeconds: 1.5,
        }),
      });
      assert.equal(malformedKeyResponse.status, 400);
      await access(stagedSourcePath(invalidSource.uri, stagingDir));
      const uploadResponse = await fetch(`${baseUrl}/contributions/upload?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: 'http-staged-key',
          sourceUri: source.uri,
          mimeType: 'video/mp4',
          byteLength: 10_000,
          durationSeconds: 1.25,
          width: 180,
          height: 320,
          hasAudio: true,
          mode: 'high-contrast',
          trimStartSeconds: 0.25,
          trimEndSeconds: 1.5,
          sourceDurationSeconds: 2,
        }),
      });
      if (uploadResponse.status !== 201) assert.equal(uploadResponse.status, 201);
      const { upload } = await uploadResponse.json();
      const processResponse = await fetch(
        `${baseUrl}/contributions/jobs/${encodeURIComponent(upload.job.id)}/process?${query}`,
        { method: 'POST' },
      );
      assert.equal(processResponse.status, 200);
      assert.deepEqual(await processResponse.json(), {
        job: { id: upload.job.id, status: 'ready' },
      });
      // The server-owned staged copy is removed, while the client-side
      // original remains available until the workflow reports success.
      await access(sourcePath);
      await assert.rejects(access(stagedSourcePath(source.uri, stagingDir)));

      const cancelStagedResponse = await fetch(
        `${baseUrl}/contributions/upload/source?${query}&idempotencyKey=cancel-source-key`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'video/mp4' },
          body: await readFile(sourcePath),
        },
      );
      const { source: cancelSource } = await cancelStagedResponse.json();
      const cancelUploadResponse = await fetch(`${baseUrl}/contributions/upload?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: 'cancel-source-key',
          sourceUri: cancelSource.uri,
          mimeType: 'video/mp4',
          byteLength: 10_000,
          durationSeconds: 1.25,
          width: 180,
          height: 320,
          hasAudio: true,
          mode: 'soft-focus',
          trimStartSeconds: 0.25,
          trimEndSeconds: 1.5,
          sourceDurationSeconds: 2,
        }),
      });
      const { upload: cancelUpload } = await cancelUploadResponse.json();
      const cancelledResponse = await fetch(
        `${baseUrl}/contributions/upload/${encodeURIComponent(cancelUpload.job.id)}?${query}`,
        { method: 'DELETE' },
      );
      assert.equal(cancelledResponse.status, 200);
      await assert.rejects(access(stagedSourcePath(cancelSource.uri, stagingDir)));
      const clipResponse = await fetch(
        `${baseUrl}/clips/${encodeURIComponent(upload.job.id)}?${query}`,
      );
      assert.equal(clipResponse.status, 200);
      assert.deepEqual((await clipResponse.json()).clip, {
        id: upload.job.id,
        groupId: 'demo-group',
        kind: 'clip',
        status: 'ready',
        createdAt: upload.job.createdAt,
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('migration versions are explicit and guard legacy media-v6 promotion until quota is installed', async () => {
  await withDatabase(async ({ database, dataDir }) => {
    const versions = database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => Number(row.version));
    assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Databases created by the first #45 implementation recorded media as
    // version 6. Existing columns are enough to promote that record safely.
    database.prepare('DELETE FROM schema_migrations WHERE version IN (6, 7)').run();
    database
      .prepare('DELETE FROM schema_migration_markers WHERE migration_key IN (?, ?)')
      .run('contribution-quota-v1', 'media-processing-v1');
    const originalKey = 'legacy-original-key';
    const legacySourceUri = `staged://${'f'.repeat(32)}`;
    const legacySourcePath = `${dataDir}/legacy-source.mp4`;
    database
      .prepare('UPDATE media_jobs SET source_path = ?, idempotency_key = ? WHERE id = ?')
      .run(
        legacySourcePath,
        createHash('sha256').update(originalKey).digest('hex').slice(0, 32),
        'demo-clip',
      );
    database.exec(
      `CREATE TABLE staged_media_sources (
         source_uri TEXT PRIMARY KEY, group_id TEXT NOT NULL, member_id TEXT NOT NULL,
         source_path TEXT NOT NULL, created_at TEXT NOT NULL
       );`,
    );
    database
      .prepare(
        `INSERT INTO media_metadata
          (source_uri, mime_type, byte_length, duration_seconds, width, height, has_audio, verified_at)
         VALUES (?, 'video/mp4', 1000, 1, 180, 320, 1, ?)`,
      )
      .run(legacySourceUri, new Date().toISOString());
    database
      .prepare(
        `INSERT INTO staged_media_sources
          (source_uri, group_id, member_id, source_path, created_at)
         VALUES (?, 'demo-group', 'demo-1', ?, ?)`,
      )
      .run(legacySourceUri, legacySourcePath, new Date().toISOString());
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)')
      .run(new Date().toISOString());
    migrateDatabase(database);
    assert.deepEqual(
      database
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((row) => Number(row.version)),
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
    assert.equal(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'staged_media_sources'",
        )
        .get(),
      undefined,
    );
    const migrated = database
      .prepare(
        'SELECT idempotency_key_hash AS idempotencyKeyHash FROM staged_sources WHERE source_uri = ?',
      )
      .get(legacySourceUri);
    assert.equal(
      migrated.idempotencyKeyHash,
      createHash('sha256').update(originalKey).digest('hex').slice(0, 32),
    );
    const retry = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      {
        idempotencyKey: originalKey,
        sourceUri: legacySourceUri,
        mimeType: 'video/mp4',
        byteLength: 1000,
        durationSeconds: 1,
        width: 180,
        height: 320,
        hasAudio: true,
        mode: 'soft-focus',
      },
      new Date('2026-09-10T12:00:00.000Z'),
      { stagingDir: `${dataDir}/media/staging`, requireVerifiedMetadata: true },
    );
    assert.equal(retry.ok, true);
    assert.equal(retry.ok && retry.upload.existing, true);
  });
});

test('staged orphan cleanup is bounded and leaves active job sources untouched', async () => {
  await withDatabase(async ({ database, dataDir }) => {
    const stagingDir = `${dataDir}/media/staging`;
    await mkdir(stagingDir, { recursive: true });
    const orphanSource = `${stagingDir}/source-${'a'.repeat(32)}.mp4`;
    const orphanPart = `${stagingDir}/source-${'d'.repeat(24)}.mp4.${'e'.repeat(8)}.part`;
    const activeSource = `${stagingDir}/source-${'b'.repeat(32)}.mp4`;
    const fixtureSource = `${dataDir}/fixture.mp4`;
    await createSyntheticSource(fixtureSource);
    await copyFile(fixtureSource, orphanSource);
    await copyFile(fixtureSource, orphanPart);
    await copyFile(fixtureSource, activeSource);
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(orphanSource, staleAt, staleAt);
    await utimes(orphanPart, staleAt, staleAt);
    database
      .prepare(
        `INSERT INTO media_jobs
          (id, group_id, contribution_id, kind, status, output_path, created_at, source_path)
         VALUES ('orphan-active-job', 'demo-group', NULL, 'clip', 'pending', NULL, ?, ?)`,
      )
      .run(new Date().toISOString(), activeSource);
    assert.equal(await cleanupOrphanedStagedSources(database, stagingDir, 1), 1);
    await assert.rejects(access(orphanSource));
    await access(activeSource);
    assert.equal(await cleanupOrphanedStagedSources(database, stagingDir, 25), 1);
    await assert.rejects(access(orphanPart));
  });
});

test('staged source tokens cannot be enqueued across owner or group boundaries', async () => {
  await withDatabase(async ({ database, dataDir }) => {
    const stagingDir = `${dataDir}/media/staging`;
    const key = 'cross-group-stage-key';
    const sourceUri = `staged://${stagedSourceId(key)}`;
    const sourcePath = stagedSourcePath(sourceUri, stagingDir);
    const claimed = claimStagedSource(database, 'demo-group', 'demo-2', key);
    assert.equal(claimed.ok, true);
    setStagedSourcePath(database, sourceUri, sourcePath);
    markStagedSourceReady(database, sourceUri, 1000, sourcePath);
    database
      .prepare(
        `INSERT INTO media_metadata
          (source_uri, mime_type, byte_length, duration_seconds, width, height, has_audio, verified_at)
         VALUES (?, 'video/mp4', 1000, 1, 180, 320, 1, ?)`,
      )
      .run(sourceUri, new Date().toISOString());
    const result = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      {
        idempotencyKey: 'cross-group-stage-key',
        sourceUri,
        mimeType: 'video/mp4',
        byteLength: 1000,
        durationSeconds: 1,
        width: 180,
        height: 320,
        hasAudio: true,
        mode: 'soft-focus',
      },
      new Date('2026-09-10T12:00:00.000Z'),
      { stagingDir, requireVerifiedMetadata: true },
    );
    assert.deepEqual(result, { ok: false, reason: 'not_found' });
  });
});

test('production enqueue rejects arbitrary local paths without verified staged metadata', async () => {
  await withDatabase(async ({ database, dataDir }) => {
    const result = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      {
        idempotencyKey: 'arbitrary-path-key',
        sourceUri: pathToFileURL(`${dataDir}/caller-owned.mp4`).href,
        mimeType: 'video/mp4',
        byteLength: 1000,
        durationSeconds: 1,
        width: 180,
        height: 320,
        hasAudio: true,
        mode: 'soft-focus',
      },
      new Date('2026-09-10T12:00:00.000Z'),
      { stagingDir: `${dataDir}/media/staging`, requireVerifiedMetadata: true },
    );
    assert.deepEqual(result, { ok: false, reason: 'invalid_media' });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM media_jobs').get().count, 3);
  });
});
