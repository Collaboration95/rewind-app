import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { probeClipWithFfmpeg } = await import('../dist/ffmpeg.js');
const START = new Date('2026-09-10T12:00:00.000Z');
const REVEAL = new Date('2026-09-11T12:00:01.000Z');
const SAFE_DENIAL = {
  allowed: false,
  status: 403,
  error: 'forbidden',
  message: 'You do not have access to this resource.',
};

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

function seedCrossGroupDownloadFixture(database) {
  database.exec(`
    INSERT INTO profiles (id, display_name, avatar_label, is_synthetic)
      VALUES ('demo-6', 'Fable', 'Fable, second-group member', 1);
    INSERT INTO groups (id, name, current_cycle_id)
      VALUES ('other-group', 'Other People', 'other-cycle');
    INSERT INTO cycles
      (id, group_id, prompt, starts_at, ends_at, status, lock_state,
       max_count, max_seconds, count_used, seconds_used)
      VALUES
      ('other-cycle', 'other-group', 'A second private prompt',
       '2026-09-10T12:00:00.000Z', '2026-09-11T12:00:01.000Z',
       'collecting', 'locked', 5, 30, 0, 0);
    INSERT INTO memberships (group_id, member_id, role, accepted_at)
      VALUES ('other-group', 'demo-6', 'owner', '2026-09-10T12:00:00.000Z');
  `);
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
  seedCrossGroupDownloadFixture(database);
  let clock = START;
  const server = createRuntimeServer(config, database, { now: () => clock });
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
    let ownerQuery = `groupId=${encodeURIComponent(group.id)}&sessionId=${encodeURIComponent(ownerSessionId)}`;

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
    let guestQuery = `groupId=${encodeURIComponent(group.id)}&sessionId=${encodeURIComponent(guestSessionId)}`;

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

    clock = REVEAL;
    const revealOwner = await postJson(
      'owner re-enters Demo access for reveal',
      baseUrl,
      '/sessions/demo',
      { memberId: 'demo-1', groupId: group.id },
      201,
    );
    ownerQuery = `groupId=${encodeURIComponent(group.id)}&sessionId=${encodeURIComponent(revealOwner.session.id)}`;
    const compiling = await expectJson(
      'owner starts the supported reveal control',
      await fetch(`${baseUrl}/demo/reveal?${ownerQuery}`, { method: 'POST' }),
      200,
    );
    assert.equal(compiling.reveal.state, 'compiling');
    assert.equal(compiling.reveal.cycleId, cycle.id);
    const filmId = compiling.reveal.jobId;
    assert.equal(typeof filmId, 'string');
    const preReleaseDownload = await fetch(
      `${baseUrl}/films/${encodeURIComponent(filmId)}/download?${ownerQuery}`,
    );
    assert.equal(preReleaseDownload.status, 404, 'pre-release film download must stay unavailable');
    assert.deepEqual(await preReleaseDownload.json(), {
      error: 'not_found',
      message: 'The requested resource was not found.',
    });
    const beforeRelease = await expectJson(
      'assert no player before release',
      await fetch(`${baseUrl}/cycles/${encodeURIComponent(cycle.id)}/premiere?${ownerQuery}`),
      200,
    );
    assert.deepEqual(beforeRelease.premiere, { state: 'processing', cycleId: cycle.id });
    const released = await expectJson(
      'owner completes the supported reveal control',
      await fetch(`${baseUrl}/demo/reveal?${ownerQuery}`, { method: 'POST' }),
      200,
    );
    assert.deepEqual(released.reveal, { state: 'released', cycleId: cycle.id });

    const premiere = await expectJson(
      'load authorized premiere',
      await fetch(`${baseUrl}/cycles/${encodeURIComponent(cycle.id)}/premiere?${ownerQuery}`),
      200,
    );
    assert.equal(premiere.premiere.state, 'ready');
    assert.equal(premiere.premiere.filmId, filmId);
    const playback = await fetch(`${baseUrl}${premiere.premiere.playbackPath}`);
    assert.equal(playback.status, 200, 'authorized playback');
    assert.ok((await playback.arrayBuffer()).byteLength > 0, 'authorized playback was empty');
    const filmDownload = await fetch(
      `${baseUrl}/films/${encodeURIComponent(filmId)}/download?${ownerQuery}`,
    );
    assert.equal(filmDownload.status, 200, 'authorized film download');
    assert.equal(filmDownload.headers.get('content-type'), 'video/mp4');
    assert.match(
      filmDownload.headers.get('content-disposition') ?? '',
      /attachment; filename="rewind-group-film\.mp4"/,
    );
    const downloadedFilmPath = resolve(dataDir, 'downloaded-film.mp4');
    await writeFile(downloadedFilmPath, Buffer.from(await filmDownload.arrayBuffer()));
    const downloadedFilmMetadata = await probeClipWithFfmpeg(config.ffmpegBin, downloadedFilmPath);
    assert.equal(downloadedFilmMetadata.hasAudio, true);
    assert.ok(downloadedFilmMetadata.durationSeconds > 1.5);

    const revealGuest = await postJson(
      'guest re-enters Demo access for released archive',
      baseUrl,
      '/sessions/demo',
      { memberId: 'demo-2', groupId: group.id },
      201,
    );
    guestQuery = `groupId=${encodeURIComponent(group.id)}&sessionId=${encodeURIComponent(revealGuest.session.id)}`;
    const archive = await expectJson(
      'load released archive',
      await fetch(`${baseUrl}/archive?${guestQuery}`),
      200,
    );
    assert.equal(archive.archive.films.length, 1, 'released film missing from archive');
    assert.equal(archive.archive.clips.length, 1, 'owned released clip missing from archive');

    const otherGroupSession = await postJson(
      'second-group member access',
      baseUrl,
      '/sessions/demo',
      { memberId: 'demo-6', groupId: 'other-group' },
      201,
    );
    const crossGroupDownload = await fetch(
      `${baseUrl}/films/${encodeURIComponent(filmId)}/download?groupId=${encodeURIComponent(group.id)}&sessionId=${encodeURIComponent(otherGroupSession.session.id)}`,
    );
    assert.equal(crossGroupDownload.status, SAFE_DENIAL.status);
    assert.deepEqual(await crossGroupDownload.json(), SAFE_DENIAL);
  } finally {
    await new Promise((close) => server.close(close));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
