import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { once } from 'node:events';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { migrateDatabase, openDatabase } = await import('../dist/db.js');
const { copyFile, utimes } = await import('node:fs/promises');
const { createClipUpload, stagedSourcePath } = await import('../dist/media/index.js');
const { cleanupOrphanedStagedSources, processClipJob } = await import('../dist/jobs/index.js');
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

async function createSyntheticSource(path) {
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
      assert.equal(invalidUploadResponse.status, 400);
      await assert.rejects(access(stagedSourcePath(invalidSource.uri, stagingDir)));
      const uploadResponse = await fetch(`${baseUrl}/contributions/upload?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: 'http-staged-job-key',
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
          idempotencyKey: 'cancel-job-key',
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
  await withDatabase(async ({ database }) => {
    const versions = database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => Number(row.version));
    assert.deepEqual(versions, [1, 2, 3, 4, 5, 7]);

    // Databases created by the first #45 implementation recorded media as
    // version 6. Existing columns are enough to promote that record safely.
    database.prepare('DELETE FROM schema_migrations WHERE version = 7').run();
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)')
      .run(new Date().toISOString());
    assert.throws(() => migrateDatabase(database), /legacy media-v6 database.*#44 quota migration/);
  });
});

test('staged orphan cleanup is bounded and leaves active job sources untouched', async () => {
  await withDatabase(async ({ database, dataDir }) => {
    const stagingDir = `${dataDir}/media/staging`;
    await mkdir(stagingDir, { recursive: true });
    const orphanSource = `${stagingDir}/source-${'a'.repeat(32)}.mp4`;
    const activeSource = `${stagingDir}/source-${'b'.repeat(32)}.mp4`;
    const fixtureSource = `${dataDir}/fixture.mp4`;
    await createSyntheticSource(fixtureSource);
    await copyFile(fixtureSource, orphanSource);
    await copyFile(fixtureSource, activeSource);
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(orphanSource, staleAt, staleAt);
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
    assert.equal(await cleanupOrphanedStagedSources(database, stagingDir, 25), 0);
  });
});

test('staged source tokens cannot be enqueued across owner or group boundaries', async () => {
  await withDatabase(async ({ database, dataDir }) => {
    const stagingDir = `${dataDir}/media/staging`;
    const sourceUri = `staged://${'c'.repeat(32)}`;
    const sourcePath = `${stagingDir}/source-${'c'.repeat(32)}.mp4`;
    database
      .prepare(
        `INSERT INTO media_metadata
          (source_uri, mime_type, byte_length, duration_seconds, width, height, has_audio, verified_at)
         VALUES (?, 'video/mp4', 1000, 1, 180, 320, 1, ?)`,
      )
      .run(sourceUri, new Date().toISOString());
    database
      .prepare(
        `INSERT INTO staged_media_sources
          (source_uri, group_id, member_id, source_path, created_at)
          VALUES (?, 'demo-group', 'demo-2', ?, ?)`,
      )
      .run(sourceUri, sourcePath, new Date().toISOString());
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
