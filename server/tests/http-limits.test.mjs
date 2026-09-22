import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { generateSyntheticDemoClip } = await import('../dist/ffmpeg.js');

const serialTest = (name, fn) => test(name, { concurrency: false }, fn);

async function waitForCondition(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function controlledBody(firstChunk, finalChunk = Buffer.alloc(0)) {
  let release;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    body: (async function* () {
      yield firstChunk;
      markStarted();
      await held;
      if (finalChunk.byteLength > 0) yield finalChunk;
    })(),
  };
}

async function withRuntime(run, overrides = {}) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-http-limits-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_FFMPEG_BIN: 'ffmpeg',
    REWIND_HTTP_IDLE_TIMEOUT_MS: String(overrides.idleTimeoutMs ?? 250),
    REWIND_HTTP_UPLOAD_TIMEOUT_MS: String(overrides.uploadTimeoutMs ?? 2_000),
    REWIND_HTTP_MAX_CONCURRENT_INTAKES: String(overrides.maxConcurrentIntakes ?? 2),
    REWIND_HTTP_MAX_CONCURRENT_PROCESSING: String(overrides.maxConcurrentProcessing ?? 1),
  });
  const database = openDatabase(config);
  const server = createRuntimeServer(config, database, {
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run({ baseUrl, config, database, dataDir });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function createSession(baseUrl) {
  const response = await fetch(`${baseUrl}/sessions/demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId: 'demo-1' }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).session;
}

function readRawResponse(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('response', (response) => {
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    request.on('error', (error) => {
      if (error.code === 'ECONNRESET') resolve(null);
      else reject(error);
    });
  });
}

serialTest('HTTP policy configuration is bounded and has documented defaults', () => {
  const defaults = parseConfig({ REWIND_HOST: '127.0.0.1' });
  assert.deepEqual(
    {
      idle: defaults.httpIdleTimeoutMs,
      upload: defaults.uploadTimeoutMs,
      intake: defaults.maxConcurrentIntakes,
      processing: defaults.maxConcurrentProcessing,
    },
    { idle: 30_000, upload: 120_000, intake: 2, processing: 1 },
  );

  assert.throws(
    () =>
      parseConfig({
        REWIND_HTTP_IDLE_TIMEOUT_MS: '0',
      }),
    /REWIND_HTTP_IDLE_TIMEOUT_MS must be an integer from 1/,
  );
  assert.throws(
    () =>
      parseConfig({
        REWIND_HTTP_MAX_CONCURRENT_INTAKES: '65',
      }),
    /REWIND_HTTP_MAX_CONCURRENT_INTAKES must be an integer from 1 to 64/,
  );
});

serialTest('slow JSON bodies return a stable 408 contract', async () => {
  await withRuntime(
    async ({ baseUrl }) => {
      const controlled = controlledBody(Buffer.from('{"memberId":"demo-1"'), Buffer.from('}'));
      try {
        const responsePromise = fetch(`${baseUrl}/sessions/demo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: controlled.body,
          duplex: 'half',
        });
        await controlled.started;
        const response = await responsePromise;
        assert.equal(response.status, 408);
        assert.deepEqual(await response.json(), {
          error: 'request_timeout',
          message: 'The request body did not arrive within the configured idle timeout.',
        });
      } finally {
        controlled.release();
      }
    },
    { idleTimeoutMs: 30 },
  );
});

serialTest('an upload that exceeds its total deadline returns a stable 408 contract', async () => {
  await withRuntime(
    async ({ baseUrl }) => {
      const session = await createSession(baseUrl);
      const controlled = controlledBody(Buffer.from('partial'), Buffer.from('tail'));
      try {
        const responsePromise = fetch(
          `${baseUrl}/contributions/upload/source?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}&idempotencyKey=total-deadline`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'video/mp4' },
            body: controlled.body,
            duplex: 'half',
          },
        );
        await controlled.started;
        const response = await responsePromise;
        assert.equal(response.status, 408);
        assert.deepEqual(await response.json(), {
          error: 'request_timeout',
          message: 'The upload did not complete within the configured timeout.',
        });
      } finally {
        controlled.release();
      }
    },
    { idleTimeoutMs: 1_000, uploadTimeoutMs: 30 },
  );
});

serialTest('JSON bodies above the existing 64 KiB cap return a stable 413 contract', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-1', filler: 'x'.repeat(70 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {
      error: 'payload_too_large',
      message: 'The JSON request body must be 64 KiB or smaller.',
    });
  });
});

serialTest('media bodies above the existing 50 MiB cap return a stable 413 contract', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const session = await createSession(baseUrl);
    const request = httpRequest(
      `${baseUrl}/contributions/upload/source?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}&idempotencyKey=oversize-media`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(50 * 1024 * 1024 + 1),
        },
      },
    );
    const responsePromise = readRawResponse(request);
    request.end();
    const response = await responsePromise;
    assert.equal(response.status, 413);
    assert.deepEqual(JSON.parse(response.body), {
      error: 'payload_too_large',
      message: 'The clip source must be 50 MiB or smaller.',
    });
  });
});

serialTest('a second media intake receives a stable 429 while the first is active', async () => {
  await withRuntime(
    async ({ baseUrl }) => {
      const session = await createSession(baseUrl);
      const query = `groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`;
      let releaseFirst;
      let signalFirstChunk;
      const firstChunk = new Promise((resolve) => {
        signalFirstChunk = resolve;
      });
      const firstRelease = new Promise((resolve) => {
        releaseFirst = resolve;
      });
      const firstRequest = fetch(
        `${baseUrl}/contributions/upload/source?${query}&idempotencyKey=limit-first`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'video/mp4' },
          body: (async function* () {
            yield Buffer.from('partial');
            signalFirstChunk();
            await firstRelease;
            yield Buffer.from('tail');
          })(),
          duplex: 'half',
        },
      );
      await firstChunk;
      const second = await fetch(
        `${baseUrl}/contributions/upload/source?${query}&idempotencyKey=limit-second`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'video/mp4' },
          body: Buffer.from('second'),
        },
      );
      assert.equal(second.status, 429);
      assert.deepEqual(await second.json(), {
        error: 'concurrency_limit',
        message: 'The server is at its configured concurrency limit. Retry the request.',
      });
      releaseFirst();
      const first = await firstRequest;
      assert.equal(first.status, 400);
    },
    { maxConcurrentIntakes: 1, idleTimeoutMs: 1_000 },
  );
});

serialTest('aborted media intake returns to a retryable staged state', async () => {
  await withRuntime(async ({ baseUrl, config, database, dataDir }) => {
    const session = await createSession(baseUrl);
    const query = `groupId=demo-group&sessionId=${encodeURIComponent(session.id)}&idempotencyKey=abort-key`;
    const retrySourcePath = join(dataDir, 'abort-retry.mp4');
    await generateSyntheticDemoClip(config.ffmpegBin, retrySourcePath);
    const retryBody = await readFile(retrySourcePath);
    const request = httpRequest(`${baseUrl}/contributions/upload/source?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': '1000' },
    });
    const resultPromise = readRawResponse(request);
    request.write(Buffer.from('partial'));
    await waitForCondition(() => {
      const source = database.prepare('SELECT source_path AS sourcePath FROM staged_sources').get();
      return typeof source?.sourcePath === 'string';
    }, 'aborted upload never established its staged-source claim');
    request.destroy();
    await resultPromise;
    await waitForCondition(() => {
      const source = database
        .prepare('SELECT status, source_path AS sourcePath FROM staged_sources')
        .get();
      return source?.status === 'pending' && source.sourcePath === null;
    }, 'aborted upload claim was not cleaned up');

    const retry = await fetch(`${baseUrl}/contributions/upload/source?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: retryBody,
    });
    assert.equal(retry.status, 201);
    assert.equal((await retry.json()).source.byteLength, retryBody.byteLength);
    const stagingEntries = await readdir(`${dataDir}/media/staging`).catch(() => []);
    assert.equal(
      stagingEntries.some((entry) => entry.endsWith('.part')),
      false,
    );
  });
});

serialTest(
  'processing concurrency returns stable 429 and releases capacity for retry',
  async () => {
    await withRuntime(
      async ({ baseUrl, config, dataDir }) => {
        const session = await createSession(baseUrl);
        const query = `groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`;
        const sourcePath = join(dataDir, 'processing-limit-source.mp4');
        const metadata = await generateSyntheticDemoClip(config.ffmpegBin, sourcePath);
        const stagedResponse = await fetch(
          `${baseUrl}/contributions/upload/source?${query}&idempotencyKey=processing-limit-source`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'video/mp4' },
            body: await readFile(sourcePath),
          },
        );
        assert.equal(stagedResponse.status, 201);
        const { source } = await stagedResponse.json();
        const uploadResponse = await fetch(`${baseUrl}/contributions/upload?${query}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idempotencyKey: 'processing-limit-source',
            sourceUri: source.uri,
            ...metadata,
            mode: 'soft-focus',
            trimStartSeconds: 0,
            trimEndSeconds: metadata.durationSeconds,
            sourceDurationSeconds: metadata.durationSeconds,
          }),
        });
        const uploadBody = await uploadResponse.json();
        assert.equal(uploadResponse.status, 201, JSON.stringify(uploadBody));
        const { upload } = uploadBody;

        const startedPath = join(dataDir, 'processing-started');
        const releasePath = join(dataDir, 'processing-release');
        const blockedFfmpeg = join(dataDir, 'blocked-media-bin');
        await writeFile(
          blockedFfmpeg,
          `#!/usr/bin/env node
const { existsSync, watch, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const { spawnSync } = require('node:child_process');
const startedPath = ${JSON.stringify(startedPath)};
const releasePath = ${JSON.stringify(releasePath)};
function waitForRelease() {
  if (existsSync(releasePath)) return Promise.resolve();
  return new Promise((resolve) => {
    const watcher = watch(dirname(releasePath), () => {
      if (!existsSync(releasePath)) return;
      watcher.close();
      resolve();
    });
    if (existsSync(releasePath)) {
      watcher.close();
      resolve();
    }
  });
}
async function main() {
  writeFileSync(startedPath, 'started');
  await waitForRelease();
  const result = spawnSync('ffmpeg', process.argv.slice(2), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
void main();
`,
          { mode: 0o755 },
        );
        await chmod(blockedFfmpeg, 0o755);
        config.ffmpegBin = blockedFfmpeg;
        const processUrl = `${baseUrl}/contributions/jobs/${encodeURIComponent(upload.job.id)}/process?${query}`;
        const firstPromise = fetch(processUrl, { method: 'POST' });
        await waitForCondition(
          () => existsSync(startedPath),
          'processing request never reached the controlled FFmpeg boundary',
          5_000,
        );

        const saturated = await fetch(processUrl, { method: 'POST' });
        assert.equal(saturated.status, 429);
        assert.deepEqual(await saturated.json(), {
          error: 'concurrency_limit',
          message: 'The server is at its configured concurrency limit. Retry the request.',
        });

        await writeFile(releasePath, 'release');
        const first = await firstPromise;
        assert.equal(first.status, 200);
        assert.deepEqual(await first.json(), {
          job: { id: upload.job.id, status: 'ready' },
        });
        const retry = await fetch(processUrl, { method: 'POST' });
        assert.equal(retry.status, 200);
        assert.deepEqual(await retry.json(), {
          job: { id: upload.job.id, status: 'ready' },
        });
      },
      { maxConcurrentProcessing: 1 },
    );
  },
);

serialTest('a normal bounded media upload remains successful', async () => {
  await withRuntime(async ({ baseUrl, config, dataDir }) => {
    const session = await createSession(baseUrl);
    await mkdir(`${dataDir}/media/staging`, { recursive: true });
    const sourcePath = `${dataDir}/media/staging/bounded.mp4`;
    await generateSyntheticDemoClip(config.ffmpegBin, sourcePath);
    const response = await fetch(
      `${baseUrl}/contributions/upload/source?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}&idempotencyKey=bounded-upload`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'video/mp4' },
        body: await readFile(sourcePath),
      },
    );
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.source.uri.startsWith('staged://'), true);
    assert.ok(body.source.byteLength > 0);
  });
});
