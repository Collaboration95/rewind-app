import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

const { parseConfig } = await import('../dist/config.js');
const { fixtureSummary, openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { createClipUpload, recordClipMediaMetadata } = await import('../dist/media/index.js');

const validInput = {
  idempotencyKey: 'clip-retry-1',
  sourceUri: 'file:///tmp/clip-retry-1.mp4',
  mimeType: 'video/mp4',
  byteLength: 1024,
  durationSeconds: 8,
  width: 720,
  height: 1280,
  hasAudio: true,
};

function registerMetadata(database, input = validInput) {
  recordClipMediaMetadata(database, {
    sourceUri: input.sourceUri,
    mimeType: 'video/mp4',
    byteLength: input.byteLength,
    durationSeconds: input.durationSeconds,
    width: input.width,
    height: input.height,
    hasAudio: true,
  });
}

async function withDatabase(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-media-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  try {
    return await run({ config, database });
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('clip upload validates media before creating a job and retries idempotently', async () => {
  await withDatabase(async ({ database }) => {
    registerMetadata(database);
    const baseline = fixtureSummary(database);
    assert.deepEqual(
      createClipUpload(database, 'demo-group', 'demo-1', {
        ...validInput,
        mimeType: 'video/quicktime',
      }),
      { ok: false, reason: 'invalid_media' },
    );
    assert.deepEqual(fixtureSummary(database), baseline);

    const created = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      validInput,
      new Date('2026-09-10T12:00:00.000Z'),
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.upload.existing, false);
    assert.equal(created.upload.job.status, 'pending');
    const retried = createClipUpload(database, 'demo-group', 'demo-1', {
      ...validInput,
      durationSeconds: 10,
    });
    assert.equal(retried.ok, true);
    if (!retried.ok) return;
    assert.equal(retried.upload.existing, true);
    assert.equal(retried.upload.contribution.id, created.upload.contribution.id);
    assert.equal(
      database
        .prepare(
          'SELECT count_used AS countUsed, seconds_used AS secondsUsed FROM cycles WHERE id = ?',
        )
        .get('demo-cycle').secondsUsed,
      8,
    );
  });
});

test('clip upload rejects ended cycles and malformed dimensions before writing', async () => {
  await withDatabase(async ({ database }) => {
    registerMetadata(database);
    const ended = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      { ...validInput, idempotencyKey: 'ended-cycle-1' },
      new Date('2026-09-12T00:00:01.000Z'),
    );
    assert.deepEqual(ended, { ok: false, reason: 'not_found' });

    for (const [width, height, idempotencyKey] of [
      [0, 1, 'zero-dimension'],
      [1.5, 2, 'fraction-dimension'],
    ]) {
      assert.deepEqual(
        createClipUpload(
          database,
          'demo-group',
          'demo-1',
          { ...validInput, width, height, idempotencyKey },
          new Date('2026-09-11T12:00:00.000Z'),
        ),
        { ok: false, reason: 'invalid_media' },
      );
    }
  });
});

test('HTTP clip upload requires a session and cancellation releases quota for retry', async () => {
  await withDatabase(async ({ config, database }) => {
    const sourceUri = `${config.dataDir}/media/staging/http-clip.mp4`;
    await mkdir(`${config.dataDir}/media/staging`, { recursive: true });
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=180x320:rate=12:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=44100:duration=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      sourceUri,
    ]);
    const server = createRuntimeServer(config, database, {
      now: () => new Date('2026-09-10T12:00:00.000Z'),
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const denied = await fetch(`${baseUrl}/contributions/upload?groupId=demo-group`, {
        method: 'POST',
      });
      assert.equal(denied.status, 401);

      const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: 'demo-1' }),
      });
      const { session } = await sessionResponse.json();
      const query = `groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`;
      const staged = await fetch(
        `${baseUrl}/contributions/upload/source?${query}&idempotencyKey=clip-retry-1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'video/mp4' },
          body: await readFile(sourceUri),
        },
      );
      assert.equal(staged.status, 201);
      const { source } = await staged.json();
      const httpInput = { ...validInput, sourceUri: source.uri, byteLength: source.byteLength };
      const created = await fetch(`${baseUrl}/contributions/upload?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(httpInput),
      });
      assert.equal(created.status, 201);
      const first = await created.json();
      const retried = await fetch(`${baseUrl}/contributions/upload?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(httpInput),
      });
      assert.equal(retried.status, 200);
      assert.equal((await retried.json()).upload.existing, true);

      const cancelled = await fetch(
        `${baseUrl}/contributions/upload/${first.upload.job.id}?${query}`,
        { method: 'DELETE' },
      );
      assert.equal(cancelled.status, 200);
      assert.equal(
        database.prepare('SELECT count_used FROM cycles WHERE id = ?').get('demo-cycle').count_used,
        0,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
