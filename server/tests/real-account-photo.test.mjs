import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { uploadFixture } from './helpers/fixture-upload.mjs';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { createRealAccount } = await import('../dist/auth/index.js');

async function withRuntime(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-real-photo-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_FFMPEG_BIN: 'ffmpeg',
    REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
  });
  const database = openFixtureDatabase(config);
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

async function account(baseUrl, database, username) {
  const created = await createRealAccount(
    database,
    username,
    username,
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
  return { authorization: `Bearer ${body.token}` };
}

async function createGroup(baseUrl, authorization) {
  const response = await fetch(`${baseUrl}/real/groups`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Photo group',
      prompt: 'What should we remember?',
      maxMembers: 3,
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('real photo upload is idempotent, private, and processed as a three-second silent portrait MP4', async () => {
  await withRuntime(async ({ baseUrl, config, database, dataDir, server }) => {
    const owner = await account(baseUrl, database, 'photo-owner');
    const outsider = await account(baseUrl, database, 'photo-outsider');
    const group = await createGroup(baseUrl, owner.authorization);
    const otherGroup = await createGroup(baseUrl, outsider.authorization);
    const imagePath = `${dataDir}/source.png`;
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x240',
      '-frames:v',
      '1',
      imagePath,
    ]);
    const bytes = await readFile(imagePath);
    const groupId = group.group.id;
    const key = 'real-photo-upload-248';
    const scoped = (path, id = groupId) => `${baseUrl}${path}?groupId=${encodeURIComponent(id)}`;
    const stagedResponse = await uploadFixture(
      server,
      `${scoped('/contributions/upload/source')}&idempotencyKey=${key}`,
      {
        authorization: owner.authorization,
        mimeType: 'image/png',
        bytes,
      },
    );
    assert.equal(stagedResponse.status, 201);
    const staged = (await stagedResponse.json()).source;
    const stagedPath = database
      .prepare('SELECT source_path AS path FROM staged_sources WHERE source_uri = ?')
      .get(staged.uri).path;
    const input = {
      mediaType: 'photo',
      idempotencyKey: key,
      sourceUri: staged.uri,
      mimeType: 'image/png',
      byteLength: staged.byteLength,
      durationSeconds: 3,
      width: 320,
      height: 240,
      hasAudio: true,
      mode: 'soft-focus',
      trimStartSeconds: 0,
      trimEndSeconds: 3,
    };
    const uploadResponse = await fetch(scoped('/contributions/upload'), {
      method: 'POST',
      headers: { Authorization: owner.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(uploadResponse.status, 201);
    const upload = (await uploadResponse.json()).upload;
    assert.equal(upload.contribution.durationSeconds, 3);
    const pendingStatus = await fetch(scoped(`/clips/${upload.job.id}`), {
      headers: { Authorization: owner.authorization },
    });
    assert.equal(pendingStatus.status, 200);
    assert.equal((await pendingStatus.json()).clip.status, 'pending');
    const duplicateResponse = await fetch(scoped('/contributions/upload'), {
      method: 'POST',
      headers: { Authorization: owner.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(duplicateResponse.status, 200);
    assert.equal((await duplicateResponse.json()).upload.contribution.id, upload.contribution.id);
    const count = database
      .prepare('SELECT COUNT(*) AS count FROM contributions WHERE id = ?')
      .get(upload.contribution.id);
    assert.equal(count.count, 1);
    const processResponse = await fetch(scoped(`/contributions/jobs/${upload.job.id}/process`), {
      method: 'POST',
      headers: { Authorization: owner.authorization },
    });
    assert.equal(processResponse.status, 200);
    assert.equal((await processResponse.json()).job.status, 'ready');
    const readyStatus = await fetch(scoped(`/clips/${upload.job.id}`), {
      headers: { Authorization: owner.authorization },
    });
    assert.equal(readyStatus.status, 200);
    assert.equal((await readyStatus.json()).clip.status, 'ready');
    assert.equal(
      database.prepare('SELECT 1 FROM staged_sources WHERE source_uri = ?').get(staged.uri),
      undefined,
    );
    await assert.rejects(access(stagedPath));
    const outputPath = database
      .prepare('SELECT output_path AS path FROM media_jobs WHERE id = ?')
      .get(upload.job.id).path;
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,width,height',
      '-of',
      'json',
      outputPath,
    ]);
    const output = JSON.parse(stdout);
    assert.equal(output.streams.find((stream) => stream.codec_type === 'video').width, 720);
    assert.equal(output.streams.find((stream) => stream.codec_type === 'video').height, 1280);
    assert.ok(output.streams.some((stream) => stream.codec_type === 'audio'));
    assert.ok(Math.abs(Number(output.format.duration) - 3) < 0.1);
    const forbidden = await fetch(
      scoped(`/contributions/jobs/${upload.job.id}/process`, otherGroup.group.id),
      { method: 'POST', headers: { Authorization: outsider.authorization } },
    );
    assert.equal(forbidden.status, 404);
    const hiddenSegment = await fetch(scoped(`/clips/${upload.job.id}/download`, groupId), {
      headers: { Authorization: outsider.authorization },
    });
    assert.equal(hiddenSegment.status, 403);
    const ledger = await fetch(scoped('/contributions'), {
      headers: { Authorization: owner.authorization },
    });
    assert.equal(ledger.status, 200);
    assert.ok(
      (await ledger.json()).entries.some(
        (entry) => entry.contributionId === upload.contribution.id && entry.state === 'sealed',
      ),
    );
  });
});
