import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { clearFixtureMedia, openFixtureDatabase } from './helpers/fixture-group.mjs';
import { REAL_AUTH_ENV, signInAs } from './helpers/real-http.mjs';

const { parseConfig } = await import('../dist/config.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { openMediaWithIntegrity } = await import('../dist/media/integrity.js');
const { MediaServingBudget, releaseBudgetWhenSnapshotCloses } =
  await import('../dist/media/serving-budget.js');

test('archive films and clips keyset-page independently and drop resized media', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-paging-performance-test-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    ...REAL_AUTH_ENV,
  });
  const database = openFixtureDatabase(config);
  clearFixtureMedia(database);
  const processedDir = `${dataDir}/media/processed`;
  await mkdir(processedDir, { recursive: true });
  const mediaPath = `${processedDir}/archive-fixture.mp4`;
  const mediaBytes = Buffer.from('verified archive fixture');
  await writeFile(mediaPath, mediaBytes);
  const digest = createHash('sha256').update(mediaBytes).digest('hex');
  const timestamp = '2026-09-26T00:00:00.000Z';

  database
    .prepare(
      `UPDATE cycles SET status = 'archived', release_status = 'published',
         release_published_at = ? WHERE id = 'demo-cycle'`,
    )
    .run(timestamp);
  const insertCycle = database.prepare(
    `INSERT INTO cycles
       (id, group_id, prompt, starts_at, ends_at, status, lock_state, max_count, max_seconds,
        release_status, release_published_at)
     VALUES (?, 'demo-group', ?, ?, ?, 'archived', 'unlocked', 5, 30, 'published', ?)`,
  );
  for (let index = 0; index < 55; index += 1) {
    const start = new Date(Date.parse(timestamp) - index * 86_400_000).toISOString();
    insertCycle.run(`page-cycle-${index}`, `Prompt ${index}`, start, timestamp, timestamp);
  }

  const insertFilm = database.prepare(
    `INSERT INTO media_jobs
       (id, group_id, cycle_id, kind, status, output_path, created_at, output_sha256, output_bytes,
        output_verified_at)
     VALUES (?, 'demo-group', ?, 'film', 'ready', ?, ?, ?, ?, ?)`,
  );
  for (let index = 0; index < 51; index += 1) {
    const createdAt = new Date(Date.parse(timestamp) - index * 1_000).toISOString();
    insertFilm.run(
      `page-film-${index}`,
      `page-cycle-${index}`,
      mediaPath,
      createdAt,
      digest,
      mediaBytes.length,
      timestamp,
    );
  }
  database
    .prepare(
      `INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
       VALUES ('page-contribution', 'demo-cycle', 'demo-1', 3, ?)`,
    )
    .run(timestamp);
  database
    .prepare(
      `INSERT INTO media_jobs
         (id, group_id, cycle_id, contribution_id, kind, status, output_path, created_at,
          output_sha256, output_bytes, output_verified_at)
       VALUES ('page-clip', 'demo-group', 'demo-cycle', 'page-contribution', 'clip',
         'ready', ?, ?, ?, ?, ?)`,
    )
    .run(mediaPath, timestamp, digest, mediaBytes.length, timestamp);

  const server = createRuntimeServer(config, database);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const { headers } = await signInAs(database, 'demo-1');
    const query = 'groupId=demo-group';

    const firstArchiveResponse = await fetch(`${baseUrl}/archive?${query}&limit=50`, { headers });
    assert.equal(firstArchiveResponse.status, 200);
    const firstArchive = await firstArchiveResponse.json();
    assert.equal(firstArchive.archive.films.length, 50);
    assert.deepEqual(
      firstArchive.archive.clips.map(({ id }) => id),
      ['page-clip'],
    );
    assert.equal(firstArchive.pagination.hasMoreFilms, true);
    assert.equal(firstArchive.pagination.hasMoreClips, false);

    const finalFilmPageResponse = await fetch(
      `${baseUrl}/archive?${query}&limit=50&filmCursor=${encodeURIComponent(firstArchive.pagination.filmCursor)}&includeClips=false`,
      { headers },
    );
    const finalFilmPage = await finalFilmPageResponse.json();
    assert.deepEqual(
      finalFilmPage.archive.films.map(({ id }) => id),
      ['page-film-50'],
    );
    assert.deepEqual(finalFilmPage.archive.clips, []);
    assert.equal(finalFilmPage.pagination.hasMoreFilms, false);
    assert.equal(finalFilmPage.pagination.hasMoreClips, false);

    const invalidArchiveCursor = await fetch(`${baseUrl}/archive?${query}&filmCursor=invalid`, {
      headers,
    });
    assert.equal(invalidArchiveCursor.status, 400);

    // Same-size tampering stays listed (listing checks size, not content)
    // and is refused when playback hashes the bytes (#475).
    await writeFile(mediaPath, Buffer.from('tampered archive fixture'));
    const tamperedPageResponse = await fetch(
      `${baseUrl}/archive?${query}&filmCursor=${encodeURIComponent(firstArchive.pagination.filmCursor)}&includeClips=false`,
      { headers },
    );
    const tamperedPage = await tamperedPageResponse.json();
    assert.deepEqual(
      tamperedPage.archive.films.map((film) => film.id),
      ['page-film-50'],
    );
    const playback = await fetch(`${baseUrl}/films/page-film-50/play?${query}`, { headers });
    assert.equal(playback.status, 404);
    // A resized object no longer matches its record and leaves the listing.
    await writeFile(mediaPath, Buffer.from('truncated'));
    const resizedPage = await (
      await fetch(
        `${baseUrl}/archive?${query}&filmCursor=${encodeURIComponent(firstArchive.pagination.filmCursor)}&includeClips=false`,
        { headers },
      )
    ).json();
    assert.deepEqual(resizedPage.archive.films, []);
    const download = await fetch(`${baseUrl}/films/page-film-50/download?${query}`, { headers });
    assert.equal(download.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('media serving budget rejects excess concurrency/bytes and releases capacity once', () => {
  const budget = new MediaServingBudget(2, 10);
  const first = budget.tryAcquire(6);
  assert.ok(first);
  assert.equal(budget.tryAcquire(5), null);
  const second = budget.tryAcquire(4);
  assert.ok(second);
  assert.deepEqual(budget.snapshot(), { active: 2, reservedBytes: 10 });
  first.release();
  first.release();
  assert.deepEqual(budget.snapshot(), { active: 1, reservedBytes: 4 });
  const afterAbort = budget.tryAcquire(6);
  assert.ok(afterAbort);
  second.release();
  afterAbort.release();
  assert.deepEqual(budget.snapshot(), { active: 0, reservedBytes: 0 });
});

test('default media snapshot budget leaves tmpfs headroom and rejects an oversized file', () => {
  const budget = new MediaServingBudget();
  assert.equal(budget.maxConcurrent, 3);
  assert.equal(budget.maxSnapshotBytes, 96 * 1024 * 1024);
  assert.equal(budget.maxSnapshotBytes + 32 * 1024 * 1024, 128 * 1024 * 1024);
  assert.equal(budget.tryAcquire(budget.maxSnapshotBytes + 1), null);
});

test('aborted media response retains its lease until the snapshot stream closes', async () => {
  const budget = new MediaServingBudget(1, 16);
  const lease = budget.tryAcquire(16);
  assert.ok(lease);
  const stream = new PassThrough();
  const response = new EventEmitter();
  releaseBudgetWhenSnapshotCloses(lease, stream, response);
  response.emit('close');
  await once(stream, 'close');
  assert.deepEqual(budget.snapshot(), { active: 0, reservedBytes: 0 });
});

test('integrity snapshot refuses a source larger than its reserved temporary-byte budget', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-snapshot-budget-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openFixtureDatabase(config);
  clearFixtureMedia(database);
  const processedDir = `${dataDir}/media/processed`;
  await mkdir(processedDir, { recursive: true });
  const mediaPath = `${processedDir}/oversized.mp4`;
  await writeFile(mediaPath, Buffer.alloc(32));
  database
    .prepare(
      `INSERT INTO media_jobs (id, group_id, kind, status, output_path, created_at)
       VALUES ('oversized-serving-test', 'demo-group', 'download', 'ready', ?, ?)`,
    )
    .run(mediaPath, new Date().toISOString());
  try {
    const opened = await openMediaWithIntegrity(database, 'oversized-serving-test', mediaPath, {
      maxSnapshotBytes: 16,
    });
    assert.equal(opened.capacityExceeded, true);
    assert.equal(opened.handle, null);
    assert.deepEqual(await readdir(processedDir), ['oversized.mp4']);
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
