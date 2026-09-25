import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { fixtureSummary, openDatabase, resetDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { createGroup } = await import('../dist/groups/index.js');

async function withRuntime(run, options = {}) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-runtime-test-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_FFMPEG_BIN: 'ffmpeg',
  });
  const { seedNow, ...serverOptions } = options;
  const database = openDatabase(config, seedNow === undefined ? undefined : { seedNow });
  const server = createRuntimeServer(config, database, serverOptions);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run({ baseUrl, config, database });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function demoContributionQuery(baseUrl, memberId = 'demo-1') {
  const response = await fetch(`${baseUrl}/sessions/demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId }),
  });
  assert.equal(response.status, 201);
  const { session } = await response.json();
  return `groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`;
}

async function assertNoSyntheticStagingLeak(database, config, expectedJobCount) {
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM staged_sources').get().count, 0);
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM media_metadata WHERE source_uri LIKE 'staged://%'")
      .get().count,
    0,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM media_jobs WHERE kind = 'clip'").get().count,
    expectedJobCount,
  );
  const entries = await readdir(resolve(config.dataDir, 'media', 'staging')).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  assert.deepEqual(
    entries.filter((entry) => entry.endsWith('.mp4') || entry.includes('.part-')),
    [],
  );
}

test('configuration rejects an unsafe bind address with an actionable hint', async () => {
  assert.throws(
    () => parseConfig({ REWIND_HOST: 'public.example.com' }),
    /local or LAN-safe bind address.*127\.0\.0\.1.*0\.0\.0\.0/,
  );
});

test('fresh migration, restart, and reset preserve or restore deterministic state', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-db-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  try {
    let database = openDatabase(config);
    const seeded = fixtureSummary(database);
    assert.deepEqual(seeded, {
      profiles: 5,
      groups: 1,
      memberships: 5,
      invites: 1,
      cycles: 1,
      sessions: 1,
      contributions: 1,
      media_jobs: 3,
      messages: 1,
      reactions: 1,
    });
    database
      .prepare('UPDATE memberships SET role = ? WHERE group_id = ? AND member_id = ?')
      .run('owner', 'demo-group', 'demo-1');
    database.close();

    database = openDatabase(config);
    assert.deepEqual(fixtureSummary(database), seeded);
    assert.equal(
      database
        .prepare('SELECT role FROM memberships WHERE group_id = ? AND member_id = ?')
        .get('demo-group', 'demo-1').role,
      'owner',
    );
    database.close();

    resetDatabase(config);
    database = openDatabase(config);
    assert.deepEqual(fixtureSummary(database), seeded);
    assert.equal(
      database
        .prepare('SELECT role FROM memberships WHERE group_id = ? AND member_id = ?')
        .get('demo-group', 'demo-1').role,
      'owner',
    );
    database.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a fresh runtime seeds a current Demo window while retaining fixed-clock test control', async () => {
  const seedNow = new Date('2030-01-15T12:00:00.000Z');
  await withRuntime(
    async ({ database }) => {
      const cycle = database
        .prepare('SELECT starts_at AS startsAt, ends_at AS endsAt FROM cycles WHERE id = ?')
        .get('demo-cycle');
      assert.equal(cycle.startsAt, seedNow.toISOString());
      assert.equal(Date.parse(cycle.endsAt) - Date.parse(cycle.startsAt), 11 * 24 * 60 * 60 * 1000);
    },
    { seedNow },
  );
});

test('health and typed fixture endpoints are reachable over the local service', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.service, 'rewind-local-runtime');
    assert.equal(health.ready, true);
    assert.equal(health.checks.schema.ready, true);
    assert.equal(health.checks.schema.expectedMigrationVersion, 16);

    const profiles = await fetch(`${baseUrl}/profiles`).then((response) => response.json());
    assert.equal(profiles.profiles.length, 5);

    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-1' }),
    });
    const { session } = await sessionResponse.json();
    const sessionQuery = `sessionId=${encodeURIComponent(session.id)}`;
    const group = await fetch(`${baseUrl}/groups/current?${sessionQuery}`).then((response) =>
      response.json(),
    );
    assert.equal(group.group.id, 'demo-group');
    const cycle = await fetch(`${baseUrl}/cycles/current?groupId=demo-group&${sessionQuery}`).then(
      (response) => response.json(),
    );
    assert.equal(cycle.cycle.id, 'demo-cycle');

    database
      .prepare('DELETE FROM schema_migration_markers WHERE migration_key = ?')
      .run('chat-replies-reactions-v1');
    const staleHealth = await fetch(`${baseUrl}/health`);
    assert.equal(staleHealth.status, 503);
    const staleBody = await staleHealth.json();
    assert.equal(staleBody.ready, false);
    assert.deepEqual(staleBody.checks.schema.missingMigrationKeys, ['chat-replies-reactions-v1']);
  });
});

test('every protected endpoint category requires a session and ignores caller identity values', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const paths = [
      '/groups/demo-group',
      '/cycles/current?groupId=demo-group',
      '/cycles/history?groupId=demo-group',
      '/messages/demo-message?groupId=demo-group',
      '/contributions/demo-contribution?groupId=demo-group',
      '/clips/demo-clip?groupId=demo-group',
      '/films/demo-film?groupId=demo-group',
      '/downloads/demo-download?groupId=demo-group',
    ];
    const responses = await Promise.all(
      paths.map(async (path) => {
        const response = await fetch(`${baseUrl}${path}&memberId=demo-outsider`);
        return { status: response.status, body: await response.json() };
      }),
    );
    for (const result of responses) {
      assert.equal(result.status, 401);
      assert.deepEqual(result.body, {
        error: 'session_required',
        message: 'Choose Demo access before changing local Demo data.',
      });
    }

    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-1' }),
    });
    const { session } = await sessionResponse.json();
    const allowed = await fetch(
      `${baseUrl}/films/demo-film?groupId=demo-group&memberId=demo-outsider&sessionId=${encodeURIComponent(session.id)}`,
    );
    assert.equal(allowed.status, 200);
  });
});

test('released archive downloads are session-bound, owner-scoped, release-gated, and never expose paths', async () => {
  await withRuntime(async ({ baseUrl, config, database }) => {
    database
      .prepare(
        `INSERT INTO cycles
          (id, group_id, prompt, starts_at, ends_at, status, lock_state, max_count,
           max_seconds, count_used, seconds_used, release_status, release_published_at)
         VALUES (?, 'demo-group', ?, ?, ?, ?, 'locked', 5, 30, 0, 0, ?, ?)`,
      )
      .run(
        'revealing-cycle',
        'A revealing prompt',
        '2026-08-20T00:00:00.000Z',
        '2026-08-27T00:00:00.000Z',
        'revealing',
        'unpublished',
        null,
      );
    database
      .prepare(
        `INSERT INTO cycles
          (id, group_id, prompt, starts_at, ends_at, status, lock_state, max_count,
           max_seconds, count_used, seconds_used, release_status, release_published_at)
         VALUES (?, 'demo-group', ?, ?, ?, 'archived', 'locked', 5, 30, 0, 0, 'published', ?)`,
      )
      .run(
        'archived-cycle',
        'An archived prompt',
        '2026-08-01T00:00:00.000Z',
        '2026-08-08T00:00:00.000Z',
        '2026-08-09T00:00:00.000Z',
      );
    database
      .prepare(
        `INSERT INTO cycles
          (id, group_id, prompt, starts_at, ends_at, status, lock_state, max_count,
           max_seconds, count_used, seconds_used, release_status, release_published_at)
         VALUES (?, 'demo-group', ?, ?, ?, 'archived', 'locked', 5, 30, 0, 0, 'unpublished', NULL)`,
      )
      .run(
        'locked-archived-cycle',
        'A locked archived prompt',
        '2026-08-10T00:00:00.000Z',
        '2026-08-17T00:00:00.000Z',
      );
    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-1' }),
    });
    const { session } = await sessionResponse.json();
    const query = `groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`;

    const historyNoSession = await fetch(`${baseUrl}/cycles/history?groupId=demo-group`);
    assert.equal(historyNoSession.status, 401);
    const historyResponse = await fetch(`${baseUrl}/cycles/history?${query}`);
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json();
    assert.deepEqual(history.cycles, [
      {
        id: 'demo-cycle',
        prompt: 'What made you pause and smile?',
        startsAt: '2026-09-01T00:00:00.000Z',
        endsAt: '2026-09-12T00:00:00.000Z',
        status: 'collecting',
        releaseStatus: 'unpublished',
      },
      {
        id: 'revealing-cycle',
        prompt: 'A revealing prompt',
        startsAt: '2026-08-20T00:00:00.000Z',
        endsAt: '2026-08-27T00:00:00.000Z',
        status: 'revealing',
        releaseStatus: 'unpublished',
      },
      {
        id: 'locked-archived-cycle',
        prompt: 'A locked archived prompt',
        startsAt: '2026-08-10T00:00:00.000Z',
        endsAt: '2026-08-17T00:00:00.000Z',
        status: 'archived',
        releaseStatus: 'unpublished',
      },
      {
        id: 'archived-cycle',
        prompt: 'An archived prompt',
        startsAt: '2026-08-01T00:00:00.000Z',
        endsAt: '2026-08-08T00:00:00.000Z',
        status: 'archived',
        releaseStatus: 'published',
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(history),
      /uri|thumbnail|playback|download|share|outputPath/i,
    );

    const locked = await fetch(`${baseUrl}/cycles/demo-cycle/premiere?${query}`);
    assert.equal(locked.status, 200);
    assert.deepEqual(await locked.json(), {
      premiere: { state: 'locked', cycleId: 'demo-cycle' },
    });
    const noSession = await fetch(`${baseUrl}/cycles/demo-cycle/premiere?groupId=demo-group`);
    assert.equal(noSession.status, 401);
    const noArchiveSession = await fetch(`${baseUrl}/archive?groupId=demo-group`);
    assert.equal(noArchiveSession.status, 401);
    const noDownloadSession = await fetch(`${baseUrl}/films/demo-film/download?groupId=demo-group`);
    assert.equal(noDownloadSession.status, 401);

    database
      .prepare(
        `UPDATE media_jobs SET status = 'failed', attempt_count = 3, output_path = NULL,
           cycle_id = ? WHERE id = 'demo-film' AND kind = 'film'`,
      )
      .run('demo-cycle');
    database.prepare("UPDATE cycles SET status = 'revealing' WHERE id = 'demo-cycle'").run();
    const delayed = await fetch(`${baseUrl}/cycles/demo-cycle/premiere?${query}`);
    assert.deepEqual(await delayed.json(), {
      premiere: { state: 'delayed', cycleId: 'demo-cycle' },
    });

    const processedDir = resolve(config.dataDir, 'media', 'processed');
    const outputPath = resolve(processedDir, 'demo-film.mp4');
    const clipOutputPath = resolve(processedDir, 'demo-clip.mp4');
    await mkdir(processedDir, { recursive: true });
    await writeFile(outputPath, Buffer.from('synthetic playable bytes'));
    await writeFile(clipOutputPath, Buffer.from('synthetic clip bytes'));
    database
      .prepare(
        `UPDATE media_jobs SET status = 'ready', cycle_id = ?, output_path = ?
         WHERE id = 'demo-film' AND kind = 'film'`,
      )
      .run('demo-cycle', outputPath);
    database
      .prepare(`UPDATE media_jobs SET status = 'ready', output_path = ? WHERE id = 'demo-clip'`)
      .run(clipOutputPath);
    database
      .prepare(
        `UPDATE cycles SET status = 'revealing', release_status = 'published',
           release_published_at = ? WHERE id = 'demo-cycle'`,
      )
      .run(new Date().toISOString());

    const ready = await fetch(`${baseUrl}/cycles/demo-cycle/premiere?${query}`);
    assert.equal(ready.status, 200);
    const readyBody = await ready.json();
    assert.equal(readyBody.premiere.state, 'ready');
    assert.equal(readyBody.premiere.filmId, 'demo-film');
    assert.match(readyBody.premiere.playbackPath, /^\/films\/demo-film\/play\?/);
    assert.doesNotMatch(
      JSON.stringify(readyBody),
      new RegExp(config.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );

    const archiveResponse = await fetch(`${baseUrl}/archive?${query}`);
    assert.equal(archiveResponse.status, 200);
    const archive = await archiveResponse.json();
    assert.equal(archive.archive.films.length, 1);
    assert.equal(archive.archive.clips.length, 1);
    const releasedHistoryResponse = await fetch(`${baseUrl}/cycles/history?${query}`);
    const releasedHistory = await releasedHistoryResponse.json();
    assert.equal(releasedHistory.cycles[0].status, 'revealing');
    assert.equal(releasedHistory.cycles[0].releaseStatus, 'published');
    assert.equal(archive.archive.films[0].cycleId, releasedHistory.cycles[0].id);
    assert.equal(archive.archive.clips[0].cycleId, releasedHistory.cycles[0].id);
    assert.match(archive.archive.films[0].downloadPath, /^\/films\/demo-film\/download\?/);
    assert.match(archive.archive.clips[0].downloadPath, /^\/clips\/demo-clip\/download\?/);
    assert.doesNotMatch(
      JSON.stringify(archive),
      new RegExp(config.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );

    const filmDownload = await fetch(`${baseUrl}${archive.archive.films[0].downloadPath}`);
    assert.equal(filmDownload.status, 200);
    assert.equal(
      filmDownload.headers.get('content-disposition'),
      'attachment; filename="rewind-group-film.mp4"',
    );
    assert.deepEqual(
      Buffer.from(await filmDownload.arrayBuffer()),
      Buffer.from('synthetic playable bytes'),
    );
    const clipDownload = await fetch(`${baseUrl}${archive.archive.clips[0].downloadPath}`);
    assert.equal(clipDownload.status, 200);
    assert.equal(
      clipDownload.headers.get('content-disposition'),
      'attachment; filename="rewind-my-clip.mp4"',
    );
    assert.deepEqual(
      Buffer.from(await clipDownload.arrayBuffer()),
      Buffer.from('synthetic clip bytes'),
    );

    const otherMemberResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-2', groupId: 'demo-group' }),
    });
    const { session: otherMemberSession } = await otherMemberResponse.json();
    const otherMemberArchive = await fetch(
      `${baseUrl}/archive?groupId=demo-group&sessionId=${encodeURIComponent(otherMemberSession.id)}`,
    ).then((response) => response.json());
    assert.equal(otherMemberArchive.archive.films.length, 1);
    assert.equal(otherMemberArchive.archive.clips.length, 0);
    const otherMemberClip = await fetch(
      `${baseUrl}/clips/demo-clip/download?groupId=demo-group&sessionId=${encodeURIComponent(otherMemberSession.id)}`,
    );
    assert.equal(otherMemberClip.status, 404);

    const playback = await fetch(`${baseUrl}${readyBody.premiere.playbackPath}`);
    assert.equal(playback.status, 200);
    assert.equal(playback.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(
      Buffer.from(await playback.arrayBuffer()),
      Buffer.from('synthetic playable bytes'),
    );
    const rangedPlayback = await fetch(`${baseUrl}${readyBody.premiere.playbackPath}`, {
      headers: { Range: 'bytes=10-18' },
    });
    assert.equal(rangedPlayback.status, 206);
    assert.equal(rangedPlayback.headers.get('content-range'), 'bytes 10-18/24');
    assert.deepEqual(Buffer.from(await rangedPlayback.arrayBuffer()), Buffer.from('playable '));

    database
      .prepare(
        "UPDATE cycles SET release_status = 'unpublished', release_published_at = NULL WHERE id = ?",
      )
      .run('demo-cycle');
    const afterUnpublish = await fetch(`${baseUrl}${readyBody.premiere.playbackPath}`);
    assert.equal(afterUnpublish.status, 404);
    const archiveAfterUnpublish = await fetch(`${baseUrl}/archive?${query}`).then((response) =>
      response.json(),
    );
    assert.deepEqual(archiveAfterUnpublish.archive, { films: [], clips: [] });
    const revokedDownload = await fetch(`${baseUrl}${archive.archive.films[0].downloadPath}`);
    assert.equal(revokedDownload.status, 404);
  });
});

test('a session-authorized synthetic Demo clip enters the ordinary sealed processing path', async () => {
  await withRuntime(
    async ({ baseUrl, config }) => {
      const denied = await fetch(`${baseUrl}/demo/synthetic-clip?groupId=demo-group`, {
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
      const created = await fetch(`${baseUrl}/demo/synthetic-clip?${query}`, { method: 'POST' });
      const body = await created.json();
      assert.equal(created.status, 201, JSON.stringify(body));
      assert.equal(body.synthetic, true);
      assert.equal(body.upload.job.status, 'pending');
      assert.doesNotMatch(
        JSON.stringify(body),
        new RegExp(config.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      const processed = await fetch(
        `${baseUrl}/contributions/jobs/${encodeURIComponent(body.upload.job.id)}/process?${query}`,
        { method: 'POST' },
      );
      assert.equal(processed.status, 200);
      assert.equal((await processed.json()).job.status, 'ready');

      const memberSessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: 'demo-2' }),
      });
      const { session: memberSession } = await memberSessionResponse.json();
      const memberCreated = await fetch(
        `${baseUrl}/demo/synthetic-clip?groupId=demo-group&sessionId=${encodeURIComponent(memberSession.id)}`,
        { method: 'POST' },
      );
      assert.equal(memberCreated.status, 201);
      assert.equal((await memberCreated.json()).synthetic, true);
    },
    { now: () => new Date('2026-09-10T12:00:00.000Z') },
  );
});

test('synthetic quota rejection removes its staged capability and permits an immediate retry', async () => {
  const fixedNow = new Date('2026-09-10T12:00:00.000Z');
  await withRuntime(
    async ({ baseUrl, config, database }) => {
      const query = await demoContributionQuery(baseUrl);
      database
        .prepare('DELETE FROM contribution_quota_windows WHERE cycle_id = ? AND member_id = ?')
        .run('demo-cycle', 'demo-1');
      database
        .prepare(
          `INSERT INTO contribution_quota_windows
           (id, cycle_id, member_id, window_start_at, window_end_at,
            max_count, max_seconds, count_used, seconds_used)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'synthetic-quota-test',
          'demo-cycle',
          'demo-1',
          fixedNow.toISOString(),
          '2026-09-17T12:00:00.000Z',
          1,
          30,
          1,
          2,
        );
      const jobsBefore = database
        .prepare("SELECT COUNT(*) AS count FROM media_jobs WHERE kind = 'clip'")
        .get().count;

      const rejected = await fetch(`${baseUrl}/demo/synthetic-clip?${query}`, { method: 'POST' });
      assert.equal(rejected.status, 409);
      assert.deepEqual(await rejected.json(), {
        error: 'contribution_quota_exceeded',
        message: 'This member has reached the current cycle contribution limit.',
      });
      await assertNoSyntheticStagingLeak(database, config, jobsBefore);

      database
        .prepare(
          `UPDATE contribution_quota_windows
           SET count_used = 0, seconds_used = 0
           WHERE id = ?`,
        )
        .run('synthetic-quota-test');
      const retry = await fetch(`${baseUrl}/demo/synthetic-clip?${query}`, { method: 'POST' });
      assert.equal(retry.status, 201, JSON.stringify(await retry.clone().json()));
      assert.equal((await retry.json()).synthetic, true);
    },
    { now: () => fixedNow, seedNow: fixedNow },
  );
});

test('synthetic closed-window rejection removes its staged capability and permits an immediate retry', async () => {
  const fixedNow = new Date('2026-09-10T12:00:00.000Z');
  await withRuntime(
    async ({ baseUrl, config, database }) => {
      const query = await demoContributionQuery(baseUrl);
      database
        .prepare('UPDATE cycles SET ends_at = ? WHERE id = ?')
        .run(fixedNow.toISOString(), 'demo-cycle');
      const jobsBefore = database
        .prepare("SELECT COUNT(*) AS count FROM media_jobs WHERE kind = 'clip'")
        .get().count;

      const rejected = await fetch(`${baseUrl}/demo/synthetic-clip?${query}`, { method: 'POST' });
      assert.equal(rejected.status, 409);
      assert.deepEqual(await rejected.json(), {
        error: 'contribution_window_closed',
        message: 'The current cycle is not accepting contributions.',
      });
      await assertNoSyntheticStagingLeak(database, config, jobsBefore);

      database
        .prepare('UPDATE cycles SET ends_at = ? WHERE id = ?')
        .run('2026-09-21T12:00:00.000Z', 'demo-cycle');
      const retry = await fetch(`${baseUrl}/demo/synthetic-clip?${query}`, { method: 'POST' });
      assert.equal(retry.status, 201, JSON.stringify(await retry.clone().json()));
      assert.equal((await retry.json()).synthetic, true);
    },
    { now: () => fixedNow, seedNow: fixedNow },
  );
});

test('synthetic post-ready exception removes its exact staged capability with a redacted retryable error', async () => {
  const fixedNow = new Date('2026-09-10T12:00:00.000Z');
  await withRuntime(
    async ({ baseUrl, config, database }) => {
      const query = await demoContributionQuery(baseUrl);
      const jobsBefore = database
        .prepare("SELECT COUNT(*) AS count FROM media_jobs WHERE kind = 'clip'")
        .get().count;
      database.exec(
        `CREATE TRIGGER fail_synthetic_clip_job
         BEFORE INSERT ON media_jobs
         WHEN NEW.kind = 'clip'
         BEGIN
           SELECT RAISE(ABORT, 'forced post-ready failure');
         END`,
      );

      const rejected = await fetch(`${baseUrl}/demo/synthetic-clip?${query}`, { method: 'POST' });
      assert.equal(rejected.status, 503);
      const rejectedBody = await rejected.json();
      assert.deepEqual(rejectedBody, {
        error: 'synthetic_clip_failed',
        message: 'The synthetic Demo clip could not be prepared. Try again.',
      });
      const serialized = JSON.stringify(rejectedBody);
      assert.doesNotMatch(serialized, /forced post-ready failure|media_jobs/i);
      assert.doesNotMatch(
        serialized,
        new RegExp(config.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      await assertNoSyntheticStagingLeak(database, config, jobsBefore);

      database.exec('DROP TRIGGER fail_synthetic_clip_job');
      const retry = await fetch(`${baseUrl}/demo/synthetic-clip?${query}`, { method: 'POST' });
      assert.equal(retry.status, 201, JSON.stringify(await retry.clone().json()));
      assert.equal((await retry.json()).synthetic, true);
    },
    { now: () => fixedNow, seedNow: fixedNow },
  );
});

test('the owner reveal control reports collecting while the cycle is still open', async () => {
  await withRuntime(
    async ({ baseUrl }) => {
      const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: 'demo-1' }),
      });
      const { session } = await sessionResponse.json();
      const query = `groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`;

      const collecting = await fetch(`${baseUrl}/demo/reveal?${query}`, { method: 'POST' });
      assert.equal(collecting.status, 200);
      assert.deepEqual(await collecting.json(), {
        reveal: { state: 'collecting', cycleId: 'demo-cycle' },
      });
    },
    { now: () => new Date('2026-09-10T12:00:00.000Z') },
  );
});

test('the owner reveal control reports a durable compile failure as delayed without a player', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-1' }),
    });
    const { session } = await sessionResponse.json();
    const query = `groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`;

    const compiling = await fetch(`${baseUrl}/demo/reveal?${query}`, { method: 'POST' });
    assert.equal(compiling.status, 200);
    assert.equal((await compiling.json()).reveal.state, 'compiling');
    const delayed = await fetch(`${baseUrl}/demo/reveal?${query}`, { method: 'POST' });
    assert.equal(delayed.status, 200);
    const delayedBody = await delayed.json();
    assert.equal(delayedBody.reveal.state, 'delayed');
    const premiere = await fetch(`${baseUrl}/cycles/demo-cycle/premiere?${query}`);
    assert.equal(premiere.status, 200);
    assert.deepEqual((await premiere.json()).premiere, {
      state: 'processing',
      cycleId: 'demo-cycle',
    });
  });
});

test('a non-owner Demo member cannot operate the reveal control', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-2' }),
    });
    const { session } = await sessionResponse.json();
    const response = await fetch(
      `${baseUrl}/demo/reveal?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`,
      { method: 'POST' },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      allowed: false,
      status: 403,
      error: 'forbidden',
      message: 'You do not have access to this resource.',
    });
  });
});

test('malformed percent-encoded path segments return a client error for every route family', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const malformed = '%E0%A4%A';
    const paths = [
      `/sessions/${malformed}`,
      `/groups/${malformed}?memberId=demo-1`,
      `/messages/${malformed}?groupId=demo-group&memberId=demo-1`,
      `/contributions/${malformed}?groupId=demo-group&memberId=demo-1`,
      `/clips/${malformed}?groupId=demo-group&memberId=demo-1`,
      `/films/${malformed}?groupId=demo-group&memberId=demo-1`,
      `/downloads/${malformed}?groupId=demo-group&memberId=demo-1`,
    ];
    for (const path of paths) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), {
        error: 'invalid_request',
        message: 'The request contains a malformed path segment.',
      });
    }

    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-1' }),
    });
    const { session } = await sessionResponse.json();
    const encodedValid = await fetch(
      `${baseUrl}/groups/%64emo-group?memberId=demo-outsider&sessionId=${encodeURIComponent(session.id)}`,
    );
    assert.equal(encodedValid.status, 200);
    assert.equal((await encodedValid.json()).group.id, 'demo-group');
  });
});

test('invitation routes require a session and expose an owner-generated code state', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const missingSession = await fetch(`${baseUrl}/invites?groupId=demo-group`, {
      method: 'POST',
    });
    assert.equal(missingSession.status, 401);

    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-1' }),
    });
    const { session } = await sessionResponse.json();
    const generated = await fetch(
      `${baseUrl}/invites?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInSeconds: 600 }),
      },
    );
    assert.equal(generated.status, 201);
    const { invite } = await generated.json();
    assert.match(invite.code, /^[A-Z0-9]{8}$/);
    assert.equal(invite.groupId, 'demo-group');
    assert.equal(invite.status, 'active');

    const malformed = await fetch(
      `${baseUrl}/invites/accept?sessionId=${encodeURIComponent(session.id)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'bad' }),
      },
    );
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error, 'invite_malformed');
  });
});

test('local group creation validates before writing and creates an owner one-day cycle atomically', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-group-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  try {
    const baseline = fixtureSummary(database);
    const invalid = createGroup(database, 'demo-1', {
      name: '   ',
      prompt: 'A valid prompt',
      now: new Date('2026-09-10T12:00:00.000Z'),
    });
    assert.deepEqual(invalid, { ok: false, field: 'name', reason: 'required' });
    assert.deepEqual(fixtureSummary(database), baseline);

    const tooLong = createGroup(database, 'demo-1', {
      name: 'A valid group',
      prompt: 'x'.repeat(161),
      now: new Date('2026-09-10T12:00:00.000Z'),
    });
    assert.deepEqual(tooLong, { ok: false, field: 'prompt', reason: 'too_long' });
    assert.deepEqual(fixtureSummary(database), baseline);

    const created = createGroup(database, 'demo-1', {
      name: '  Saturday table  ',
      prompt: '  What is worth keeping?  ',
      now: new Date('2026-09-10T12:00:00.000Z'),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.group.name, 'Saturday table');
    assert.equal(created.group.actingMemberRole, 'owner');
    assert.equal(created.cycle.prompt, 'What is worth keeping?');
    assert.equal(created.cycle.status, 'collecting');
    assert.equal(created.cycle.lockState, 'locked');
    assert.equal(
      Date.parse(created.cycle.endsAt) - Date.parse(created.cycle.startsAt),
      24 * 60 * 60 * 1000,
    );
    assert.equal(
      database
        .prepare('SELECT role FROM memberships WHERE group_id = ? AND member_id = ?')
        .get(created.group.id, 'demo-1').role,
      'owner',
    );
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Demo session and group HTTP mutations preserve the selected group context', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-2' }),
    });
    assert.equal(sessionResponse.status, 201);
    const { session } = await sessionResponse.json();

    const groupResponse = await fetch(
      `${baseUrl}/groups?sessionId=${encodeURIComponent(session.id)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Walk home', prompt: 'What did you notice?' }),
      },
    );
    assert.equal(groupResponse.status, 201);
    const created = await groupResponse.json();
    assert.equal(created.group.actingMemberRole, 'owner');
    assert.equal(
      Date.parse(created.cycle.endsAt) - Date.parse(created.cycle.startsAt),
      24 * 60 * 60 * 1000,
    );

    const current = await fetch(
      `${baseUrl}/groups/current?sessionId=${encodeURIComponent(session.id)}`,
    );
    assert.equal(current.status, 200);
    assert.equal((await current.json()).group.id, created.group.id);
  });
});

test('local Demo reset endpoint restores the deterministic fixture and removes created groups', async () => {
  await withRuntime(async ({ baseUrl, config, database }) => {
    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-1' }),
    });
    const { session } = await sessionResponse.json();
    const groupResponse = await fetch(
      `${baseUrl}/groups?sessionId=${encodeURIComponent(session.id)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Temporary group', prompt: 'Temporary prompt' }),
      },
    );
    assert.equal(groupResponse.status, 201);
    assert.equal(fixtureSummary(database).groups, 2);
    const stagedFile = resolve(config.dataDir, 'media', 'staging', 'partial.mp4');
    const outputFile = resolve(config.dataDir, 'media', 'processed', 'film.mp4');
    await mkdir(resolve(config.dataDir, 'media', 'staging'), { recursive: true });
    await mkdir(resolve(config.dataDir, 'media', 'processed'), { recursive: true });
    await writeFile(stagedFile, 'staged', { encoding: 'utf8', flag: 'w' });
    await writeFile(outputFile, 'processed', { encoding: 'utf8', flag: 'w' });

    const reset = await fetch(`${baseUrl}/demo/reset?sessionId=${encodeURIComponent(session.id)}`, {
      method: 'POST',
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(fixtureSummary(database), {
      profiles: 5,
      groups: 1,
      memberships: 5,
      invites: 1,
      cycles: 1,
      sessions: 1,
      contributions: 1,
      media_jobs: 3,
      messages: 1,
      reactions: 1,
    });
    assert.equal(existsSync(stagedFile), false);
    assert.equal(existsSync(outputFile), false);
  });
});

test('local Demo reset endpoint refuses a valid non-owner session', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-2' }),
    });
    const { session } = await sessionResponse.json();
    const reset = await fetch(`${baseUrl}/demo/reset?sessionId=${encodeURIComponent(session.id)}`, {
      method: 'POST',
    });
    assert.equal(reset.status, 403);
    assert.deepEqual(await reset.json(), {
      allowed: false,
      status: 403,
      error: 'forbidden',
      message: 'You do not have access to this resource.',
    });
    assert.equal(fixtureSummary(database).groups, 1);
  });
});
