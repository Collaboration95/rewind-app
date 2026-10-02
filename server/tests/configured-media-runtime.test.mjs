import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { parseConfig } from '../dist/config.js';
import { configureRuntimeMedia } from '../dist/media/configured-runtime.js';
import { openDatabase } from '../dist/db.js';
import { createClipUpload } from '../dist/media/index.js';
import { decodeMediaRef, encodeMediaRef, verifyStoredMedia } from '../dist/media/store.js';
import { clearDemoMedia } from './helpers/demo-media.mjs';

const execFileAsync = promisify(execFile);
const s3 = {
  REWIND_MEDIA_BACKEND: 's3',
  REWIND_MEDIA_ENVIRONMENT: 'test',
  REWIND_MEDIA_S3_BUCKET: 'private-test-bucket',
  REWIND_MEDIA_S3_OWNER: '123456789012',
  REWIND_MEDIA_S3_REGION: 'ap-southeast-1',
};

test('disk rollback creates no adapter and local store requires an explicit namespace', async () => {
  let created = 0;
  const config = parseConfig({});
  assert.equal(config.media, null);
  const runtime = await configureRuntimeMedia(config, async () => {
    created++;
    throw new Error('disk must not load the SDK');
  });
  assert.deepEqual(runtime.options, {});
  runtime.close();
  assert.equal(created, 0);
  assert.throws(() => parseConfig({ REWIND_MEDIA_BACKEND: 'local' }), /ENVIRONMENT/);
  const local = parseConfig({ REWIND_MEDIA_BACKEND: 'local', REWIND_MEDIA_ENVIRONMENT: 'test' });
  assert.equal(local.media.root, resolve(local.dataDir, 'media', 'objects'));
});

test('explicit S3 config fails closed without exposing values or accepting aliases', () => {
  for (const [key, value] of [
    ['REWIND_MEDIA_BACKEND', 'public'],
    ['REWIND_MEDIA_ENVIRONMENT', '../other'],
    ['REWIND_MEDIA_S3_BUCKET', 'sensitive.invalid/bucket'],
    ['REWIND_MEDIA_S3_OWNER', 'sensitive-owner'],
    ['REWIND_MEDIA_S3_REGION', 'https://sensitive.invalid'],
    ['REWIND_MEDIA_S3_KMS_KEY_ARN', 'alias/sensitive'],
  ]) {
    assert.throws(
      () => parseConfig({ ...s3, [key]: value }),
      (error) => error.message.includes(key) && !error.message.includes(value),
    );
  }
  for (const key of ['REWIND_MEDIA_S3_BUCKET', 'REWIND_MEDIA_S3_OWNER', 'REWIND_MEDIA_S3_REGION']) {
    assert.throws(() => parseConfig({ ...s3, [key]: '' }), new RegExp(key));
  }
  assert.equal(parseConfig(s3).media.backend, 's3');
  const arn = 'arn:aws:kms:ap-southeast-1:123456789012:key/test-key';
  assert.equal(parseConfig({ ...s3, REWIND_MEDIA_S3_KMS_KEY_ARN: arn }).media.kmsKeyId, arn);
});

test('one configured adapter binds HTTP, lifecycle, worker and upload intents to the same scope', async () => {
  const config = parseConfig({ ...s3, REWIND_DATA_DIR: resolve(tmpdir(), 'configured-test') });
  const store = {};
  const transport = {};
  let created = 0;
  let closed = 0;
  const runtime = await configureRuntimeMedia(config, async (input) => {
    created++;
    assert.deepEqual(input, config.media);
    return { store, uploadTransport: transport, close: () => closed++ };
  });
  assert.equal(created, 1);
  assert.equal(runtime.options.mediaStore, store);
  assert.equal(runtime.options.mediaEnvironment, 'test');
  assert.equal(runtime.options.uploadIntents.store, store);
  assert.equal(runtime.options.uploadIntents.transport, transport);
  assert.equal(runtime.options.uploadIntents.environment, 'test');
  assert.equal(
    runtime.options.uploadIntents.scratchDir,
    resolve(config.dataDir, 'media/intent-scratch'),
  );
  assert.equal(runtime.options.uploadIntents.ffmpegBin, config.ffmpegBin);
  runtime.close();
  assert.equal(closed, 1);
  await assert.rejects(
    configureRuntimeMedia(config, async () => {
      throw new Error('adapter unavailable');
    }),
    /adapter unavailable/,
  );
});

test('installed SDK constructs the configured private runtime offline and closes idempotently', async () => {
  // No object operation or presigning is invoked: this proves the packaged
  // runtime can load its real SDK, not any live provider semantics.
  const runtime = await configureRuntimeMedia(parseConfig(s3));
  assert.equal(runtime.options.mediaEnvironment, 'test');
  assert.equal(runtime.options.uploadIntents.transport.backend, 's3');
  assert.equal(typeof runtime.options.mediaStore.read, 'function');
  runtime.close();
  runtime.close();
});

test('worker CLI uses opt-in local store for pinned input, verified output and input cleanup', async () => {
  const root = await mkdtemp(`${tmpdir()}/rewind-configured-worker-`);
  const env = {
    ...process.env,
    REWIND_DATA_DIR: root,
    REWIND_MEDIA_BACKEND: 'local',
    REWIND_MEDIA_ENVIRONMENT: 'test',
  };
  const config = parseConfig(env);
  let database = openDatabase(config);
  const runtime = await configureRuntimeMedia(config);
  const scope = { environment: 'test', groupId: 'demo-group' };
  try {
    assert.equal(runtime.options.uploadIntents, undefined);
    clearDemoMedia(database);
    const bytes = await readFile(new URL('../fixtures/demo-media.mp4', import.meta.url));
    const source = await runtime.options.mediaStore.put(scope, {
      prefix: 'incoming',
      name: 'configured-input',
      body: Readable.from([bytes]),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      contentType: 'video/mp4',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const upload = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      {
        idempotencyKey: 'configured-worker',
        sourceUri: 'synthetic-source',
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
    database
      .prepare('UPDATE media_jobs SET source_path = ? WHERE id = ?')
      .run(encodeMediaRef(source), upload.upload.job.id);
    database.close();
    database = null;
    const { stdout } = await execFileAsync(
      process.execPath,
      ['server/dist/cli.js', 'worker', '--once', '--json', '--max-jobs', '1'],
      { env },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.drained, 1);
    assert.equal(result.jobs[0].status, 'ready');
    database = openDatabase(config);
    const job = database
      .prepare(
        'SELECT output_path, output_sha256, output_bytes, source_path FROM media_jobs WHERE id = ?',
      )
      .get(upload.upload.job.id);
    const output = decodeMediaRef(job.output_path);
    assert.equal(output.backend, 'local');
    assert.equal(output.prefix, 'processed');
    assert.equal(output.sha256, job.output_sha256);
    assert.equal(output.byteLength, job.output_bytes);
    assert.equal(job.source_path, null);
    await verifyStoredMedia(runtime.options.mediaStore, scope, output, {
      sha256: job.output_sha256,
      byteLength: job.output_bytes,
    });
    await assert.rejects(runtime.options.mediaStore.head(scope, source), { code: 'missing' });
  } finally {
    database?.close();
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
