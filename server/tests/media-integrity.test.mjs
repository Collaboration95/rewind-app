import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { migrateDatabase, openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { createClipUpload, recordClipMediaMetadata } = await import('../dist/media/index.js');
const { hashFile, hashFileSync, verifyMediaIntegrity } = await import('../dist/media/integrity.js');
const { processClipJob } = await import('../dist/jobs/index.js');
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
      const backfilled = storedIntegrity(database, jobId);
      assert.equal(backfilled.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(backfilled.byteLength, bytes.length);
      assert.ok(backfilled.verifiedAt);
      // Repairing twice is safe and leaves the same values.
      migrateDatabase(database, { mediaRoot: config.dataDir });
      assert.deepEqual({ ...storedIntegrity(database, jobId) }, { ...backfilled });
    } finally {
      database.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the integrity migration is idempotent, preserves audit rows, and widens the event guard', async () => {
  await withDatabase(async ({ config, database }) => {
    database
      .prepare(
        `INSERT INTO audit_events (id, event_type, actor_member_id, resource_id, occurred_at, result)
         VALUES ('legacy-audit', 'job.failed', 'demo-1', 'job:legacy-1', ?, 'failure')`,
      )
      .run(new Date().toISOString());
    migrateDatabase(database, { mediaRoot: config.dataDir });

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

    const result = await processCompilationJob(database, {
      jobId: created.job.id,
      ffmpegBin: config.ffmpegBin,
      outputDir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    // The film must not be published with a checksum of the tampered input.
    assert.equal(getCompilationJob(database, created.job.id)?.status, 'failed');
    assert.equal(storedIntegrity(database, created.job.id).sha256, null);
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
