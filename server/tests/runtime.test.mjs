import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';
import { signInAs } from './helpers/real-http.mjs';

const { parseConfig } = await import('../dist/config.js');
const { getCurrentCycle, resetDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { revokeRealSession } = await import('../dist/auth/index.js');
const { planConsistencyRepair } = await import('../dist/jobs/consistency.js');
const { runWorkerTick } = await import('../dist/jobs/worker.js');
const { probeClipWithFfmpeg } = await import('../dist/ffmpeg.js');
const { claimStagedSource, markStagedSourceReady, recordClipMediaMetadata, stagedSourceId } =
  await import('../dist/media/index.js');

function fixtureSummary(database) {
  return Object.fromEntries(
    [
      'profiles',
      'groups',
      'memberships',
      'invites',
      'cycles',
      'contributions',
      'media_jobs',
      'messages',
      'reactions',
    ].map((table) => [
      table,
      database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    ]),
  );
}

async function withRuntime(run, options = {}) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-runtime-test-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_FFMPEG_BIN: 'ffmpeg',
    REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
  });
  const { seedNow, ...serverOptions } = options;
  const database = openFixtureDatabase(config, seedNow === undefined ? undefined : { seedNow });
  const server = createRuntimeServer(config, database, serverOptions);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run({ baseUrl, config, database, server });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function postBodyAfter(body, path, baseUrl, headers, afterPartial) {
  const url = new URL(path, baseUrl);
  const responsePromise = new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' } },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }),
        );
      },
    );
    request.on('error', reject);
    const serialized = JSON.stringify(body);
    const split = Math.max(1, Math.floor(serialized.length / 2));
    request.write(serialized.slice(0, split));
    setTimeout(() => {
      try {
        afterPartial();
        request.end(serialized.slice(split));
      } catch (error) {
        request.destroy(error);
      }
    }, 20);
  });
  return responsePromise;
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
    let database = openFixtureDatabase(config);
    const seeded = fixtureSummary(database);
    assert.deepEqual(seeded, {
      profiles: 5,
      groups: 1,
      memberships: 5,
      invites: 0,
      cycles: 1,
      contributions: 1,
      media_jobs: 3,
      messages: 1,
      reactions: 1,
    });
    database
      .prepare('UPDATE memberships SET role = ? WHERE group_id = ? AND member_id = ?')
      .run('owner', 'demo-group', 'demo-1');
    database.close();

    database = openFixtureDatabase(config);
    assert.deepEqual(fixtureSummary(database), seeded);
    assert.equal(
      database
        .prepare('SELECT role FROM memberships WHERE group_id = ? AND member_id = ?')
        .get('demo-group', 'demo-1').role,
      'owner',
    );
    database.close();

    resetDatabase(config);
    database = openFixtureDatabase(config);
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

test('fixture media stays consistent and restart preserves genuine missing-output failures', async () => {
  await withRuntime(async ({ config, database }) => {
    const processedDir = resolve(config.dataDir, 'media', 'processed');
    const stagingDir = resolve(config.dataDir, 'media', 'staging');
    const assertFixture = async () => {
      const seededCycle = getCurrentCycle(database, 'demo-group', 'demo-1');
      assert.deepEqual(
        getCurrentCycle(database, 'demo-group', 'demo-1', new Date(seededCycle.startsAt))
          .contributionUsage,
        {
          countUsed: 1,
          secondsUsed: 3,
        },
      );
      const jobs = database
        .prepare(
          "SELECT id, status, output_path AS outputPath, output_sha256 AS sha256, output_bytes AS bytes FROM media_jobs WHERE kind IN ('clip', 'film') ORDER BY id",
        )
        .all();
      assert.deepEqual(
        jobs.map(({ id, status }) => ({ id, status })),
        [
          { id: 'demo-clip', status: 'ready' },
          { id: 'demo-film', status: 'ready' },
        ],
      );
      for (const job of jobs) {
        const bytes = await readFile(job.outputPath);
        assert.equal(job.bytes, bytes.byteLength);
        assert.equal(job.sha256, createHash('sha256').update(bytes).digest('hex'));
        const metadata = await probeClipWithFfmpeg(config.ffmpegBin, job.outputPath, processedDir);
        assert.equal(metadata.durationSeconds, 3);
        assert.equal(metadata.hasAudio, true);
        assert.ok(metadata.width < metadata.height);
      }
      assert.deepEqual(planConsistencyRepair(database, processedDir, stagingDir).findings, []);
      assert.deepEqual(
        await runWorkerTick(database, {
          ffmpegBin: config.ffmpegBin,
          stagingDir,
          outputDir: processedDir,
        }),
        { claimed: false, reason: 'idle' },
      );
    };
    await assertFixture();
    // Restart preserves genuine missing-output failures. There are no special
    // fixture exclusions.
    const paths = database
      .prepare("SELECT output_path AS path FROM media_jobs WHERE kind IN ('clip', 'film')")
      .all();
    for (const { path } of paths) await rm(path);
    const reopened = openFixtureDatabase(config);
    try {
      assert.equal(
        planConsistencyRepair(reopened, processedDir, stagingDir).findings.filter(
          (item) => item.kind === 'missing_output',
        ).length,
        2,
      );
    } finally {
      reopened.close();
    }
  });
});

test('health reports schema readiness over the local service', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.service, 'rewind-local-runtime');
    assert.equal(health.ready, true);
    assert.equal(health.checks.schema.ready, true);
    assert.equal(health.checks.schema.expectedMigrationVersion, 31);

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

test('every protected endpoint category requires a real session and ignores caller identity values', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const paths = [
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
        message: 'A valid sign-in is required.',
      });
    }

    const member = await signInAs(database, 'demo-1');
    const allowed = await fetch(
      `${baseUrl}/clips/demo-clip?groupId=demo-group&memberId=demo-outsider`,
      { headers: member.headers },
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
    const owner = await signInAs(database, 'demo-1');
    const asOwner = { headers: owner.headers };
    const query = 'groupId=demo-group';

    const locked = await fetch(`${baseUrl}/cycles/demo-cycle/premiere?${query}`, asOwner);
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
    const delayed = await fetch(`${baseUrl}/cycles/demo-cycle/premiere?${query}`, asOwner);
    assert.deepEqual(await delayed.json(), {
      premiere: { state: 'delayed', cycleId: 'demo-cycle' },
    });

    const processedDir = resolve(config.dataDir, 'media', 'processed');
    const outputPath = resolve(processedDir, 'demo-film.mp4');
    const clipOutputPath = resolve(processedDir, 'demo-clip.mp4');
    await mkdir(processedDir, { recursive: true });
    const filmBytes = Buffer.from('synthetic playable bytes');
    const clipBytes = Buffer.from('synthetic clip bytes');
    await writeFile(outputPath, filmBytes);
    await writeFile(clipOutputPath, clipBytes);
    database
      .prepare(
        `UPDATE media_jobs SET status = 'ready', cycle_id = ?, output_path = ?,
           output_sha256 = ?, output_bytes = ?, output_verified_at = ?
         WHERE id = 'demo-film' AND kind = 'film'`,
      )
      .run(
        'demo-cycle',
        outputPath,
        createHash('sha256').update(filmBytes).digest('hex'),
        filmBytes.byteLength,
        new Date().toISOString(),
      );
    database
      .prepare(
        `UPDATE media_jobs SET status = 'ready', output_path = ?, output_sha256 = ?, output_bytes = ?, output_verified_at = ? WHERE id = 'demo-clip'`,
      )
      .run(
        clipOutputPath,
        createHash('sha256').update(clipBytes).digest('hex'),
        clipBytes.byteLength,
        new Date().toISOString(),
      );
    database
      .prepare(
        `UPDATE cycles SET status = 'revealing', release_status = 'published',
           release_published_at = ? WHERE id = 'demo-cycle'`,
      )
      .run(new Date().toISOString());

    const ready = await fetch(`${baseUrl}/cycles/demo-cycle/premiere?${query}`, asOwner);
    assert.equal(ready.status, 200);
    const readyBody = await ready.json();
    assert.equal(readyBody.premiere.state, 'ready');
    assert.equal(readyBody.premiere.filmId, 'demo-film');
    assert.match(readyBody.premiere.playbackPath, /^\/media\/access\/[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(
      JSON.stringify(readyBody),
      new RegExp(config.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );

    const archiveResponse = await fetch(`${baseUrl}/archive?${query}`, asOwner);
    assert.equal(archiveResponse.status, 200);
    const archive = await archiveResponse.json();
    assert.equal(archive.archive.films.length, 1);
    assert.equal(archive.archive.clips.length, 1);
    assert.equal(archive.archive.films[0].cycleId, 'demo-cycle');
    assert.equal(archive.archive.clips[0].cycleId, 'demo-cycle');
    assert.match(archive.archive.films[0].downloadPath, /^\/media\/access\/[A-Za-z0-9_-]{43}$/);
    assert.match(archive.archive.clips[0].downloadPath, /^\/media\/access\/[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(
      JSON.stringify(archive),
      new RegExp(config.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );

    const filmDownload = await fetch(`${baseUrl}${archive.archive.films[0].downloadPath}`, asOwner);
    assert.equal(filmDownload.status, 200);
    assert.equal(
      filmDownload.headers.get('content-disposition'),
      'attachment; filename="rewind-group-film.mp4"',
    );
    assert.deepEqual(
      Buffer.from(await filmDownload.arrayBuffer()),
      Buffer.from('synthetic playable bytes'),
    );
    const clipDownload = await fetch(`${baseUrl}${archive.archive.clips[0].downloadPath}`, asOwner);
    assert.equal(clipDownload.status, 200);
    assert.equal(
      clipDownload.headers.get('content-disposition'),
      'attachment; filename="rewind-my-clip.mp4"',
    );
    assert.deepEqual(
      Buffer.from(await clipDownload.arrayBuffer()),
      Buffer.from('synthetic clip bytes'),
    );

    const otherMember = await signInAs(database, 'demo-2');
    const otherMemberArchive = await fetch(`${baseUrl}/archive?groupId=demo-group`, {
      headers: otherMember.headers,
    }).then((response) => response.json());
    assert.equal(otherMemberArchive.archive.films.length, 1);
    assert.equal(otherMemberArchive.archive.clips.length, 0);
    const otherMemberClip = await fetch(`${baseUrl}/clips/demo-clip/download?groupId=demo-group`, {
      headers: otherMember.headers,
    });
    assert.equal(otherMemberClip.status, 404);

    const playback = await fetch(`${baseUrl}${readyBody.premiere.playbackPath}`, asOwner);
    assert.equal(playback.status, 200);
    assert.equal(playback.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(
      Buffer.from(await playback.arrayBuffer()),
      Buffer.from('synthetic playable bytes'),
    );
    const rangedPlayback = await fetch(`${baseUrl}${readyBody.premiere.playbackPath}`, {
      headers: { ...owner.headers, Range: 'bytes=10-18' },
    });
    assert.equal(rangedPlayback.status, 206);
    assert.equal(rangedPlayback.headers.get('content-range'), 'bytes 10-18/24');
    assert.deepEqual(Buffer.from(await rangedPlayback.arrayBuffer()), Buffer.from('playable '));

    database
      .prepare(
        "UPDATE cycles SET release_status = 'unpublished', release_published_at = NULL WHERE id = ?",
      )
      .run('demo-cycle');
    const afterUnpublish = await fetch(`${baseUrl}${readyBody.premiere.playbackPath}`, asOwner);
    assert.equal(afterUnpublish.status, 404);
    const archiveAfterUnpublish = await fetch(`${baseUrl}/archive?${query}`, asOwner).then(
      (response) => response.json(),
    );
    assert.deepEqual(archiveAfterUnpublish.archive, { films: [], clips: [] });
    const revokedDownload = await fetch(
      `${baseUrl}${archive.archive.films[0].downloadPath}`,
      asOwner,
    );
    assert.equal(revokedDownload.status, 404);
  });
});

test('malformed percent-encoded path segments return a client error for every route family', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const malformed = '%E0%A4%A';
    const paths = [
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

    const member = await signInAs(database, 'demo-1');
    const encodedValid = await fetch(
      `${baseUrl}/clips/%64emo-clip?groupId=demo-group&memberId=demo-outsider`,
      { headers: member.headers },
    );
    assert.equal(encodedValid.status, 200);
    assert.equal((await encodedValid.json()).clip.id, 'demo-clip');
  });
});

test('a delayed contribution body cannot commit after real session revocation', async () => {
  await withRuntime(async ({ baseUrl, config, database }) => {
    database
      .prepare('UPDATE cycles SET ends_at = ? WHERE id = ?')
      .run('2030-01-01T00:00:00.000Z', 'demo-cycle');
    const uploadKey = 'revoked-upload-key';
    const sourceUri = `staged://${stagedSourceId(uploadKey)}`;
    const sourcePath = resolve(config.dataDir, 'media', 'staging', 'revoked-source.mp4');
    const claim = claimStagedSource(
      database,
      'demo-group',
      'demo-1',
      uploadKey,
      new Date(),
      sourcePath,
    );
    assert.equal(claim.ok, true);
    recordClipMediaMetadata(database, {
      sourceUri,
      mimeType: 'video/mp4',
      byteLength: 1024,
      durationSeconds: 3,
      width: 720,
      height: 1280,
      hasAudio: true,
    });
    assert.equal(markStagedSourceReady(database, sourceUri, 1024, sourcePath, 1), true);
    const uploadMember = await signInAs(database, 'demo-1');
    const contributionCount = database
      .prepare('SELECT COUNT(*) AS count FROM contributions')
      .get().count;
    const uploadResult = await postBodyAfter(
      {
        idempotencyKey: uploadKey,
        sourceUri,
        mimeType: 'video/mp4',
        byteLength: 1024,
        durationSeconds: 3,
        width: 720,
        height: 1280,
        hasAudio: true,
      },
      '/contributions/upload?groupId=demo-group',
      baseUrl,
      uploadMember.headers,
      () => revokeRealSession(database, uploadMember.token),
    );
    assert.equal(uploadResult.status, 401);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM contributions').get().count,
      contributionCount,
    );
  });
});
