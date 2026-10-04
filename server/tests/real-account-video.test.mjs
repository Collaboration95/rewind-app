import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { uploadFixture } from './helpers/fixture-upload.mjs';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { createRealAccount } = await import('../dist/auth/index.js');
const { generateSyntheticDemoClip } = await import('../dist/ffmpeg.js');

async function withRuntime(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-real-video-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_FFMPEG_BIN: 'ffmpeg',
    REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
  });
  const database = openDatabase(config);
  const server = createRuntimeServer(config, database, {
    now: () => new Date('2026-09-29T00:00:00.000Z'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ baseUrl, config, database, dataDir, server });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function account(baseUrl, database, username, displayName) {
  const created = await createRealAccount(
    database,
    username,
    displayName,
    'a sufficiently long pilot password',
    new Date('2026-09-29T00:00:00.000Z'),
  );
  assert.equal(created.ok, true);
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'a sufficiently long pilot password',
      clientType: 'native',
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  return { account: created.account, authorization: `Bearer ${body.token}` };
}

async function createGroup(baseUrl, authorization, name) {
  const response = await fetch(`${baseUrl}/real/groups`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, prompt: 'What should we remember?', maxMembers: 3 }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

function delayedUploadRequest(baseUrl, authorization, groupId, input) {
  const url = new URL(`${baseUrl}/contributions/upload?groupId=${encodeURIComponent(groupId)}`);
  let resolveResponse;
  let rejectResponse;
  let resolveStarted;
  const responsePromise = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const startedPromise = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const body = JSON.stringify(input);
  const request = httpRequest(
    {
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Expect: '100-continue',
        'Transfer-Encoding': 'chunked',
      },
    },
    (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (responseBody += chunk));
      response.on('end', () =>
        resolveResponse({ status: response.statusCode, body: responseBody }),
      );
    },
  );
  request.on('error', rejectResponse);
  request.on('continue', () => {
    request.write(body.slice(0, Math.max(1, Math.floor(body.length / 2))));
    resolveStarted();
  });
  request.flushHeaders();
  return {
    request,
    responsePromise,
    startedPromise,
    remaining: body.slice(Math.floor(body.length / 2)),
  };
}

test('real account can upload and process a clip only in its selected group', async () => {
  await withRuntime(async ({ baseUrl, config, database, dataDir, server }) => {
    const owner = await account(baseUrl, database, 'video-owner', 'Video Owner');
    const ownerGroup = await createGroup(baseUrl, owner.authorization, 'Owner group');
    const other = await account(baseUrl, database, 'video-other', 'Other member');
    const otherGroup = await createGroup(baseUrl, other.authorization, 'Other group');
    const sourcePath = `${dataDir}/phone-source.mp4`;
    const metadata = await generateSyntheticDemoClip(config.ffmpegBin, sourcePath);
    const bytes = await readFile(sourcePath);
    const groupId = ownerGroup.group.id;
    const idempotencyKey = 'real-video-upload-247';
    const scoped = (path, id = groupId) => `${baseUrl}${path}?groupId=${encodeURIComponent(id)}`;

    const stagedResponse = await uploadFixture(
      server,
      scoped(`/contributions/upload/source`) +
        `&idempotencyKey=${encodeURIComponent(idempotencyKey)}`,
      {
        authorization: owner.authorization,
        mimeType: 'video/mp4',
        bytes,
      },
    );
    assert.equal(stagedResponse.status, 201);
    const staged = (await stagedResponse.json()).source;
    assert.equal(staged.byteLength, bytes.byteLength);

    const input = {
      idempotencyKey,
      sourceUri: staged.uri,
      mimeType: 'video/mp4',
      byteLength: metadata.byteLength,
      durationSeconds: metadata.durationSeconds,
      width: metadata.width,
      height: metadata.height,
      hasAudio: metadata.hasAudio,
      mode: 'soft-focus',
      trimStartSeconds: 0,
      trimEndSeconds: Math.min(2, metadata.durationSeconds),
      sourceDurationSeconds: metadata.durationSeconds,
    };
    const uploadedResponse = await fetch(scoped('/contributions/upload'), {
      method: 'POST',
      headers: { Authorization: owner.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(uploadedResponse.status, 201);
    const uploaded = (await uploadedResponse.json()).upload;
    assert.equal(uploaded.job.status, 'pending');

    const processedResponse = await fetch(
      scoped(`/contributions/jobs/${encodeURIComponent(uploaded.job.id)}/process`),
      { method: 'POST', headers: { Authorization: owner.authorization } },
    );
    assert.equal(processedResponse.status, 200);
    assert.equal((await processedResponse.json()).job.status, 'ready');

    const statusPath = `/clips/${encodeURIComponent(uploaded.job.id)}`;
    const ownerStatus = await fetch(scoped(statusPath), {
      headers: { Authorization: owner.authorization },
    });
    assert.equal(ownerStatus.status, 200);
    assert.equal((await ownerStatus.json()).clip.status, 'ready');

    const crossGroupStatus = await fetch(scoped(statusPath), {
      headers: { Authorization: other.authorization },
    });
    assert.equal(crossGroupStatus.status, 403);
    const crossGroupStaging = await uploadFixture(
      server,
      `${scoped('/contributions/upload/source')}&idempotencyKey=other-video-key-247`,
      {
        authorization: other.authorization,
        mimeType: 'video/mp4',
        bytes,
      },
    );
    assert.equal(crossGroupStaging.status, 403);
    assert.notEqual(otherGroup.group.id, groupId);

    const mixedDemoAuthority = await fetch(`${scoped(statusPath)}&sessionId=demo-session-owner`, {
      headers: { Authorization: owner.authorization },
    });
    assert.equal(mixedDemoAuthority.status, 403);

    const ledger = await fetch(scoped('/contributions'), {
      headers: { Authorization: owner.authorization },
    });
    assert.equal(ledger.status, 200);
    const entries = await ledger.json();
    assert.equal(entries.entries[0]?.state, 'sealed');
    assert.equal(JSON.stringify(entries).includes(sourcePath), false);
    assert.equal(JSON.stringify(entries).includes(staged.uri), false);

    const deletionPath = `/contributions/${encodeURIComponent(uploaded.contribution.id)}`;
    const crossGroupDelete = await fetch(scoped(deletionPath, otherGroup.group.id), {
      method: 'DELETE',
      headers: { Authorization: other.authorization },
    });
    assert.equal(crossGroupDelete.status, 404);
    const deleted = await fetch(scoped(deletionPath), {
      method: 'DELETE',
      headers: { Authorization: owner.authorization },
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual((await deleted.json()).restored, { count: 1, seconds: 2 });
    const deletedLedger = await fetch(scoped('/contributions'), {
      headers: { Authorization: owner.authorization },
    });
    assert.equal((await deletedLedger.json()).entries[0]?.state, 'deleted');

    const contributionCount = database
      .prepare('SELECT COUNT(*) AS count FROM contributions')
      .get().count;
    const delayed = delayedUploadRequest(baseUrl, owner.authorization, groupId, {
      ...input,
      idempotencyKey: 'changed-group-upload-247',
    });
    await delayed.startedPromise;
    database
      .prepare('DELETE FROM real_account_group_selections WHERE account_id = ?')
      .run(owner.account.id);
    delayed.request.end(delayed.remaining);
    const delayedResult = await delayed.responsePromise;
    assert.equal(delayedResult.status, 401);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM contributions').get().count,
      contributionCount,
    );
  });
});
