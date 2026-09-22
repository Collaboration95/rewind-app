import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { generateSyntheticDemoClip } = await import('../dist/ffmpeg.js');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const serialTest = (name, fn) => test(name, { concurrency: false }, fn);

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
  const server = createRuntimeServer(config, database);
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

async function* delayedBody(chunks, delayMs) {
  for (const [index, chunk] of chunks.entries()) {
    yield chunk;
    if (index < chunks.length - 1) await sleep(delayMs);
  }
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
      const response = await fetch(`${baseUrl}/sessions/demo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: delayedBody([Buffer.from('{"memberId":"demo-1"'), Buffer.from('}')], 100),
        duplex: 'half',
      });
      assert.equal(response.status, 408);
      assert.deepEqual(await response.json(), {
        error: 'request_timeout',
        message: 'The request body did not arrive within the configured idle timeout.',
      });
    },
    { idleTimeoutMs: 30 },
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
  await withRuntime(async ({ baseUrl, database, dataDir }) => {
    const session = await createSession(baseUrl);
    const query = `groupId=demo-group&sessionId=${encodeURIComponent(session.id)}&idempotencyKey=abort-key`;
    const request = httpRequest(`${baseUrl}/contributions/upload/source?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': '1000' },
    });
    const resultPromise = readRawResponse(request);
    request.write(Buffer.from('partial'));
    await sleep(20);
    request.destroy();
    await resultPromise;
    await sleep(100);

    const source = database
      .prepare(
        'SELECT status, source_path AS sourcePath, byte_length AS byteLength FROM staged_sources',
      )
      .get();
    assert.equal(source.status, 'pending');
    assert.equal(source.sourcePath, null);
    assert.equal(source.byteLength, null);
    const stagingEntries = await readdir(`${dataDir}/media/staging`).catch(() => []);
    assert.equal(
      stagingEntries.some((entry) => entry.endsWith('.part')),
      false,
    );
  });
});

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
