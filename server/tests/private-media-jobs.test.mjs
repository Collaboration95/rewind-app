import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import { parseConfig } from '../dist/config.js';
import { openDatabase, openDatabaseAt } from '../dist/db.js';
import { createClipUpload } from '../dist/media/index.js';
import { decodeMediaRef, encodeMediaRef } from '../dist/media/store.js';
import {
  createCompilationJob,
  processClipJob,
  processCompilationJob,
  verifyReadyJobOutput,
} from '../dist/jobs/index.js';
import { runWorkerTick } from '../dist/jobs/worker.js';
import { clearDemoMedia } from './helpers/demo-media.mjs';
import { s3Double, s3Store } from './helpers/private-media-store.mjs';
const scope = { environment: 'test', groupId: 'demo-group' };
async function scenario(run) {
  const root = await mkdtemp(`${tmpdir()}/rewind-private-jobs-`);
  const config = parseConfig({ REWIND_DATA_DIR: root });
  const database = openDatabase(config);
  clearDemoMedia(database);
  const double = s3Double();
  const store = s3Store(double);
  const options = {
    ffmpegBin: 'ffmpeg',
    stagingDir: root + '/staging',
    outputDir: root + '/processed',
    mediaStore: store,
    mediaEnvironment: 'test',
  };
  const context = { database, double, store, root, options, databasePath: config.databasePath };
  try {
    await run(context);
  } finally {
    context.database.close();
    await rm(root, { recursive: true, force: true });
  }
}
function job(database, id) {
  return database
    .prepare(
      'SELECT id, status, output_path AS outputPath, source_path AS sourcePath, output_sha256 AS sha256, output_bytes AS byteLength, output_verified_at AS verifiedAt, attempt_count AS attempts, error_code AS errorCode FROM media_jobs WHERE id = ?',
    )
    .get(id);
}
async function enqueue(context, key = 'private-job') {
  const bytes = await readFile(new URL('../fixtures/demo-media.mp4', import.meta.url));
  const ref = await context.store.put(scope, {
    prefix: 'incoming',
    name: key,
    body: Readable.from([bytes]),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
    contentType: 'video/mp4',
    expiresAt: '2026-10-03T12:00:00Z',
  });
  const upload = createClipUpload(
    context.database,
    'demo-group',
    'demo-1',
    {
      idempotencyKey: key,
      sourceUri: '/unused-private-source.mp4',
      mimeType: 'video/mp4',
      byteLength: bytes.length,
      durationSeconds: 0.5,
      width: 180,
      height: 320,
      hasAudio: true,
      mode: 'soft-focus',
      trimStartSeconds: 0,
      trimEndSeconds: 0.5,
      sourceDurationSeconds: 2,
    },
    new Date('2026-09-10T12:00:00Z'),
  );
  assert.equal(upload.ok, true);
  const id = upload.upload.job.id;
  context.database
    .prepare('UPDATE media_jobs SET source_path = ?, source_uri = NULL WHERE id = ?')
    .run(encodeMediaRef(ref), id);
  return { id, ref };
}

test('worker pins original version, stores verified private clip and film, leaves no raw scratch bytes', async () =>
  scenario(async (context) => {
    const { id, ref } = await enqueue(context);
    const replacement = Buffer.from('invalid-overwrite');
    await context.store.put(scope, {
      prefix: 'incoming',
      name: 'private-job',
      body: Readable.from([replacement]),
      sha256: createHash('sha256').update(replacement).digest('hex'),
      byteLength: replacement.length,
      contentType: 'video/mp4',
      expiresAt: ref.expiresAt,
    });
    const tick = await runWorkerTick(context.database, context.options);
    assert.equal(tick.claimed, true);
    assert.equal(tick.record.status, 'ready');
    const ready = job(context.database, id);
    assert.equal(ready.sourcePath, null);
    assert.equal(decodeMediaRef(ready.outputPath).prefix, 'processed');
    await assert.rejects(context.store.head(scope, ref), { code: 'missing' });
    assert.equal(await verifyReadyJobOutput(context.database, id, context.options), true);
    assert.deepEqual(await readdir(context.options.outputDir), []);
    context.database
      .prepare("UPDATE cycles SET status = 'revealing' WHERE id = 'demo-cycle'")
      .run();
    const film = createCompilationJob(context.database, {
      groupId: 'demo-group',
      cycleId: 'demo-cycle',
    });
    assert.equal(film.ok, true);
    const result = await processCompilationJob(context.database, {
      ...context.options,
      jobId: film.job.id,
    });
    assert.equal(result.ok, true);
    const output = job(context.database, film.job.id);
    assert.equal(decodeMediaRef(output.outputPath).prefix, 'films');
    assert.equal(await verifyReadyJobOutput(context.database, film.job.id, context.options), true);
    context.database
      .prepare('UPDATE media_jobs SET output_verified_at = NULL WHERE id = ?')
      .run(film.job.id);
    assert.equal(await verifyReadyJobOutput(context.database, film.job.id, context.options), false);
    assert.deepEqual(await readdir(context.options.outputDir), []);
  }));

test('cleanup failure retains prepared identity; restart finalizes without raw reads or FFmpeg and bounds attempts', async () =>
  scenario(async (context) => {
    const { id, ref } = await enqueue(context);
    const remove = context.double.transport.deleteObject;
    context.double.transport.deleteObject = async () => {
      throw new Error('simulated cleanup failure');
    };
    const first = await processClipJob(context.database, { ...context.options, jobId: id });
    assert.equal(first.ok, false);
    const failed = job(context.database, id);
    assert.equal(failed.errorCode, 'cleanup_failed');
    assert.ok(failed.outputPath);
    assert.equal(failed.attempts, 1);
    await context.store.head(scope, ref);
    context.double.transport.deleteObject = remove;
    const resumed = await processClipJob(context.database, {
      ...context.options,
      ffmpegBin: '/does-not-exist',
      jobId: id,
      workerAttemptCap: 3,
    });
    assert.equal(resumed.ok, true);
    assert.equal(job(context.database, id).outputPath, failed.outputPath);
    assert.equal(await verifyReadyJobOutput(context.database, id, context.options), true);
    assert.deepEqual(await readdir(context.options.outputDir), []);
  }));

test('crash after deleting input recovers durable prepared output; no missing-source reprocess', async () =>
  scenario(async (context) => {
    const { id, ref } = await enqueue(context);
    const remove = context.double.transport.deleteObject;
    context.double.transport.deleteObject = async (request) => {
      await remove(request);
      throw new Error('lost delete response');
    };
    assert.equal(
      (await processClipJob(context.database, { ...context.options, jobId: id })).ok,
      false,
    );
    const marker = job(context.database, id).outputPath;
    await assert.rejects(context.store.head(scope, ref), { code: 'missing' });
    context.database
      .prepare(
        "UPDATE media_jobs SET status = 'processing', processing_started_at = '2026-01-01T00:00:00Z' WHERE id = ?",
      )
      .run(id);
    context.double.transport.deleteObject = remove;
    assert.equal(
      (
        await processClipJob(context.database, {
          ...context.options,
          ffmpegBin: '/missing',
          jobId: id,
        })
      ).ok,
      true,
    );
    assert.equal(job(context.database, id).outputPath, marker);
  }));

for (const mutation of ['missing', 'mismatch', 'wrong_group', 'expired', 'cleanup_exhaustion']) {
  test(`private source ${mutation} fails closed with bounded automatic retries`, async () =>
    scenario(async (context) => {
      const { id, ref } = await enqueue(context);
      if (mutation === 'missing') await context.store.delete(scope, ref);
      if (mutation === 'mismatch')
        context.double.versions.get(`${ref.key}:${ref.versionId}`).bytes.fill(0);
      if (mutation === 'wrong_group')
        context.database.prepare('UPDATE media_jobs SET source_path = ? WHERE id = ?').run(
          encodeMediaRef({
            ...ref,
            groupId: 'outsider',
            key: ref.key.replace('/demo-group/', '/outsider/'),
          }),
          id,
        );
      if (mutation === 'expired')
        context.database
          .prepare('UPDATE media_jobs SET source_path = ? WHERE id = ?')
          .run(encodeMediaRef({ ...ref, expiresAt: '2026-01-01T00:00:00Z' }), id);
      if (mutation === 'cleanup_exhaustion')
        context.double.transport.deleteObject = async () => {
          throw new Error('cleanup failed');
        };
      for (let index = 0; index < 3; index++) {
        const tick = await runWorkerTick(context.database, context.options);
        assert.equal(tick.claimed, true);
        assert.equal(tick.record.status, 'failed');
      }
      assert.equal((await runWorkerTick(context.database, context.options)).claimed, false);
      assert.equal(job(context.database, id).attempts, 3);
      assert.equal(await verifyReadyJobOutput(context.database, id, context.options), false);
    }));
}

test('corrupt prepared output cannot trigger original deletion or become ready', async () =>
  scenario(async (context) => {
    const { id, ref } = await enqueue(context);
    const remove = context.double.transport.deleteObject;
    context.double.transport.deleteObject = async () => {
      throw new Error('cleanup failed');
    };
    await processClipJob(context.database, { ...context.options, jobId: id });
    const output = decodeMediaRef(job(context.database, id).outputPath);
    context.double.versions.get(`${output.key}:${output.versionId}`).bytes.fill(0);
    context.double.transport.deleteObject = remove;
    assert.equal(
      (await processClipJob(context.database, { ...context.options, jobId: id })).ok,
      false,
    );
    await context.store.head(scope, ref);
    assert.equal(job(context.database, id).status, 'failed');
  }));

test('stale clip generation cannot prepare/publish output or delete accepted input', async () =>
  scenario(async (context) => {
    const { id, ref } = await enqueue(context);
    const put = context.double.transport.putObject;
    context.double.transport.putObject = async (request) => {
      const result = await put(request);
      if (request.Metadata['media-ref'].includes('processed'))
        context.database
          .prepare('UPDATE media_jobs SET claim_generation = claim_generation + 1 WHERE id = ?')
          .run(id);
      return result;
    };
    assert.equal(
      (await processClipJob(context.database, { ...context.options, jobId: id })).ok,
      false,
    );
    const row = job(context.database, id);
    assert.equal(row.status, 'processing');
    assert.equal(row.outputPath, null);
    await context.store.head(scope, ref);
    assert.equal(context.double.versions.size, 1);
  }));

test('remote input without adapter fails closed; local adapter processes independently of S3', async () =>
  scenario(async (context) => {
    const { id, ref } = await enqueue(context);
    assert.equal(
      (
        await processClipJob(context.database, {
          ...context.options,
          mediaStore: undefined,
          jobId: id,
        })
      ).ok,
      false,
    );
    await context.store.head(scope, ref);
    const { LocalMediaStore } = await import('../dist/media/local-store.js');
    const local = new LocalMediaStore(
      context.root + '/local',
      () => new Date('2026-10-02T12:00:00Z'),
    );
    const bytes = await readFile(new URL('../fixtures/demo-media.mp4', import.meta.url));
    const localRef = await local.put(scope, {
      prefix: 'incoming',
      name: 'local-clip',
      body: Readable.from([bytes]),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      contentType: 'video/mp4',
      expiresAt: '2026-10-03T12:00:00Z',
    });
    context.database
      .prepare('UPDATE media_jobs SET source_path = ? WHERE id = ?')
      .run(encodeMediaRef(localRef), id);
    const options = { ...context.options, mediaStore: local, jobId: id };
    assert.equal((await processClipJob(context.database, options)).ok, true);
    assert.equal(await verifyReadyJobOutput(context.database, id, options), true);
    await assert.rejects(local.head(scope, localRef), { code: 'missing' });
  }));

test('film waits across restart without attempts, freezes all settled accepted clips once', async () =>
  scenario(async (context) => {
    const first = await enqueue(context, 'settled-first');
    const second = await enqueue(context, 'pending-at-close');
    assert.equal(
      (await processClipJob(context.database, { ...context.options, jobId: first.id })).ok,
      true,
    );
    context.database
      .prepare("UPDATE cycles SET status = 'revealing' WHERE id = 'demo-cycle'")
      .run();
    const film = createCompilationJob(context.database, {
      groupId: 'demo-group',
      cycleId: 'demo-cycle',
    });
    assert.equal(film.job.inputCount, 1);
    for (let repeat = 0; repeat < 2; repeat++) {
      context.database.close();
      context.database = openDatabaseAt(context.databasePath);
      const waiting = await processCompilationJob(context.database, {
        ...context.options,
        jobId: film.job.id,
      });
      assert.equal(waiting.reason, 'waiting_for_inputs');
      assert.equal(job(context.database, film.job.id).attempts, 0);
      assert.equal(job(context.database, film.job.id).status, 'pending');
    }
    assert.equal(
      (await processClipJob(context.database, { ...context.options, jobId: second.id })).ok,
      true,
    );
    assert.equal(
      (await processCompilationJob(context.database, { ...context.options, jobId: film.job.id }))
        .ok,
      true,
    );
    assert.deepEqual(
      context.database
        .prepare(
          'SELECT clip_job_id AS id FROM compilation_job_inputs WHERE job_id = ? ORDER BY position',
        )
        .all(film.job.id)
        .map((row) => row.id),
      [first.id, second.id],
    );
    assert.equal(job(context.database, film.job.id).attempts, 1);
  }));

for (const state of ['missing', 'exhausted', 'corrupt']) {
  test(`film cannot silently omit ${state} accepted contribution`, async () =>
    scenario(async (context) => {
      const first = await enqueue(context, 'film-first');
      const second = await enqueue(context, 'film-second');
      assert.equal(
        (await processClipJob(context.database, { ...context.options, jobId: first.id })).ok,
        true,
      );
      if (state === 'missing')
        context.database.prepare('DELETE FROM media_jobs WHERE id = ?').run(second.id);
      if (state === 'exhausted')
        context.database
          .prepare("UPDATE media_jobs SET status = 'failed', attempt_count = 3 WHERE id = ?")
          .run(second.id);
      if (state === 'corrupt') {
        assert.equal(
          (await processClipJob(context.database, { ...context.options, jobId: second.id })).ok,
          true,
        );
        const ref = decodeMediaRef(job(context.database, second.id).outputPath);
        context.double.versions.get(`${ref.key}:${ref.versionId}`).bytes.fill(0);
      }
      context.database
        .prepare("UPDATE cycles SET status = 'revealing' WHERE id = 'demo-cycle'")
        .run();
      const film = createCompilationJob(context.database, {
        groupId: 'demo-group',
        cycleId: 'demo-cycle',
      });
      for (let index = 0; index < 3; index++)
        assert.equal(
          (
            await processCompilationJob(context.database, {
              ...context.options,
              jobId: film.job.id,
            })
          ).ok,
          false,
        );
      assert.equal(job(context.database, film.job.id).status, 'failed');
      assert.equal(job(context.database, film.job.id).attempts, 3);
      assert.equal(job(context.database, film.job.id).outputPath, null);
      assert.equal(
        (await processCompilationJob(context.database, { ...context.options, jobId: film.job.id }))
          .reason,
        'retry_exhausted',
      );
    }));
}
