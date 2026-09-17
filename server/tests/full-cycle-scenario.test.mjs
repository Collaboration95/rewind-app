import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { advanceCycleLifecycle, publishCycleRelease } = await import('../dist/cycles/index.js');
const { processCompilationJob } = await import('../dist/jobs/index.js');

const START = new Date('2026-09-10T12:00:00.000Z');
const REVEAL = new Date('2026-09-11T12:00:01.000Z');

async function expectJson(stage, response, expectedStatus) {
  assert.equal(response.status, expectedStatus, `${stage}: unexpected HTTP status`);
  return response.json();
}

async function postJson(stage, baseUrl, path, body, expectedStatus) {
  return expectJson(
    stage,
    await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    expectedStatus,
  );
}

async function createSyntheticMp4(path) {
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
  ]);
}

test('full-cycle: reset → join → sealed clip → reveal → authorized archive', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-full-cycle-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_FFMPEG_BIN: 'ffmpeg',
  });
  const database = openDatabase(config);
  const server = createRuntimeServer(config, database, { now: () => START });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const owner = await postJson(
      'owner demo access',
      baseUrl,
      '/sessions/demo',
      { memberId: 'demo-1' },
      201,
    );
    const ownerSessionId = owner.session.id;
    const groupCreated = await postJson(
      'owner creates group',
      baseUrl,
      `/groups?sessionId=${encodeURIComponent(ownerSessionId)}`,
      { name: 'Full-cycle friends', prompt: 'Show a small delight.' },
      201,
    );
    const { group, cycle } = groupCreated;
    const ownerQuery = `groupId=${encodeURIComponent(group.id)}&sessionId=${encodeURIComponent(ownerSessionId)}`;

    const invite = await postJson(
      'owner creates invite',
      baseUrl,
      `/invites?${ownerQuery}`,
      {},
      201,
    );
    const guest = await postJson(
      'guest demo access',
      baseUrl,
      '/sessions/demo',
      { memberId: 'demo-2' },
      201,
    );
    const guestSessionId = guest.session.id;
    await postJson(
      'guest joins invite',
      baseUrl,
      `/invites/accept?sessionId=${encodeURIComponent(guestSessionId)}`,
      { code: invite.invite.code, groupId: group.id },
      200,
    );
    const guestQuery = `groupId=${encodeURIComponent(group.id)}&sessionId=${encodeURIComponent(guestSessionId)}`;

    const sourcePath = resolve(dataDir, 'generated-input.mp4');
    await createSyntheticMp4(sourcePath);
    const bytes = await readFile(sourcePath);
    const staged = await expectJson(
      'stage generated clip',
      await fetch(
        `${baseUrl}/contributions/upload/source?${guestQuery}&idempotencyKey=full-cycle-clip-1`,
        { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: bytes },
      ),
      201,
    );
    const uploaded = await postJson(
      'queue generated clip',
      baseUrl,
      `/contributions/upload?${guestQuery}`,
      {
        idempotencyKey: 'full-cycle-clip-1',
        sourceUri: staged.source.uri,
        mimeType: 'video/mp4',
        byteLength: staged.source.byteLength,
        durationSeconds: 2,
        width: 180,
        height: 320,
        hasAudio: true,
        mode: 'soft-focus',
      },
      201,
    );
    await expectJson(
      'process generated clip',
      await fetch(
        `${baseUrl}/contributions/jobs/${encodeURIComponent(uploaded.upload.job.id)}/process?${guestQuery}`,
        { method: 'POST' },
      ),
      200,
    );
    await postJson(
      'post group message',
      baseUrl,
      `/realtime/groups/${encodeURIComponent(group.id)}/messages?sessionId=${encodeURIComponent(guestSessionId)}`,
      { body: 'A sealed moment is ready.', messageId: 'full-cycle-message-1' },
      201,
    );

    const sealed = await expectJson(
      'assert sealed before reveal',
      await fetch(`${baseUrl}/cycles/${encodeURIComponent(cycle.id)}/premiere?${ownerQuery}`),
      200,
    );
    assert.deepEqual(sealed.premiere, { state: 'locked', cycleId: cycle.id });

    const revealing = advanceCycleLifecycle(database, {
      groupId: group.id,
      cycleId: cycle.id,
      clock: () => REVEAL,
    });
    assert.deepEqual(revealing.ok && revealing.action, 'revealing', 'transition to reveal');
    const film = database
      .prepare("SELECT id FROM media_jobs WHERE group_id = ? AND cycle_id = ? AND kind = 'film'")
      .get(group.id, cycle.id);
    assert.ok(film?.id, 'reveal stage did not create a film job');
    const compiled = await processCompilationJob(database, {
      jobId: film.id,
      ffmpegBin: config.ffmpegBin,
      outputDir: resolve(dataDir, 'media', 'processed'),
    });
    assert.deepEqual(compiled, { ok: true, jobId: film.id, status: 'ready' }, 'compile film');
    const published = publishCycleRelease(database, {
      groupId: group.id,
      cycleId: cycle.id,
      publishedAt: REVEAL,
    });
    assert.deepEqual(published.ok && published.action, 'published', 'publish release');

    const premiere = await expectJson(
      'load authorized premiere',
      await fetch(`${baseUrl}/cycles/${encodeURIComponent(cycle.id)}/premiere?${ownerQuery}`),
      200,
    );
    assert.equal(premiere.premiere.state, 'ready');
    const playback = await fetch(`${baseUrl}${premiere.premiere.playbackPath}`);
    assert.equal(playback.status, 200, 'authorized playback');
    assert.ok((await playback.arrayBuffer()).byteLength > 0, 'authorized playback was empty');

    const archive = await expectJson(
      'load released archive',
      await fetch(`${baseUrl}/archive?${guestQuery}`),
      200,
    );
    assert.equal(archive.archive.films.length, 1, 'released film missing from archive');
    assert.equal(archive.archive.clips.length, 1, 'owned released clip missing from archive');
  } finally {
    await new Promise((close) => server.close(close));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
