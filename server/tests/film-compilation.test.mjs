import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { createCompilationJob, getCompilationJob, MAX_COMPILATION_ATTEMPTS, processCompilationJob } =
  await import('../dist/jobs/index.js');
const { ARCHIVE_FILLER_LABEL, generateSyntheticDemoClip, probeClipWithFfmpeg } =
  await import('../dist/ffmpeg.js');

async function withDatabase(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-film-compilation-test-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_FFMPEG_BIN: 'ffmpeg',
  });
  const database = openDatabase(config);
  try {
    return await run({ config, database, dataDir });
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function createProcessedClip(path, { color, frequency, volume = 1, duration = 1 }) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:size=180x320:rate=12:duration=${duration}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:sample_rate=44100:duration=${duration}`,
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
    '-af',
    `volume=${volume}`,
    '-shortest',
    path,
  ];
  await execFileAsync('ffmpeg', args);
}

test('creates a deterministic portrait synthetic clip with audio for the local Demo', async () => {
  await withDatabase(async ({ config, dataDir }) => {
    const outputDir = `${dataDir}/media/staging`;
    await mkdir(outputDir, { recursive: true });
    const media = await generateSyntheticDemoClip(config.ffmpegBin, `${outputDir}/synthetic.mp4`);
    assert.equal(media.mimeType, 'video/mp4');
    assert.equal(media.width, 180);
    assert.equal(media.height, 320);
    assert.equal(media.hasAudio, true);
    assert.ok(media.durationSeconds > 1.5 && media.durationSeconds < 2.5);
  });
});

async function frameAverage(path, seconds) {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(seconds),
      '-i',
      path,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 2_000_000 },
  );
  const channels = [0, 0, 0];
  for (let offset = 0; offset + 2 < stdout.length; offset += 3) {
    channels[0] += stdout[offset];
    channels[1] += stdout[offset + 1];
    channels[2] += stdout[offset + 2];
  }
  return channels.map((channel) => channel / (stdout.length / 3));
}

function insertReadyClip(
  database,
  {
    id,
    contributionId,
    acceptedAt,
    jobCreatedAt = acceptedAt,
    outputPath,
    groupId = 'demo-group',
    cycleId = 'demo-cycle',
    memberId = 'demo-2',
  },
) {
  database
    .prepare(
      `INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    )
    .run(contributionId, cycleId, memberId, acceptedAt);
  database
    .prepare(
      `INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, output_path, created_at, source_path)
       VALUES (?, ?, ?, 'clip', 'ready', ?, ?, NULL)`,
    )
    .run(id, groupId, contributionId, outputPath, jobCreatedAt);
}

async function assertPlayableWithFfmpeg(path) {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    path,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-f',
    'null',
    '-',
  ]);
}

async function integratedLoudness(path) {
  const { stderr } = await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'info',
      '-i',
      path,
      '-af',
      'ebur128=framelog=quiet',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8', maxBuffer: 2_000_000 },
  );
  const match = stderr.match(/Integrated loudness:\s+I:\s+(-?\d+(?:\.\d+)?) LUFS/);
  assert.ok(match, 'FFmpeg did not report integrated loudness');
  return Number(match[1]);
}

async function frameCrop(path, seconds, crop) {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(seconds),
      '-i',
      path,
      '-frames:v',
      '1',
      '-vf',
      `${crop},format=gray`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 2_000_000 },
  );
  return stdout;
}

function changedPixelFraction(left, right) {
  assert.equal(left.length, right.length);
  let changed = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (Math.abs(left[index] - right[index]) > 20) changed += 1;
  }
  return changed / left.length;
}

function pixelFractionAbove(frame, threshold) {
  let matching = 0;
  for (const pixel of frame) {
    if (pixel > threshold) matching += 1;
  }
  return matching / frame.length;
}

function insertArchivedCycle(database, { id, groupId, publishedAt }) {
  database
    .prepare(
      `INSERT INTO cycles
        (id, group_id, prompt, starts_at, ends_at, status, lock_state,
         max_count, max_seconds, count_used, seconds_used, release_status, release_published_at)
       VALUES (?, ?, 'An earlier prompt', '2026-09-01T00:00:00.000Z',
         '2026-09-02T00:00:00.000Z', 'archived', 'locked', 5, 30, 1, 1, 'published', ?)`,
    )
    .run(id, groupId, publishedAt);
}

async function createFilmJob(database) {
  database.prepare("UPDATE cycles SET status = 'revealing' WHERE id = 'demo-cycle'").run();
  const created = createCompilationJob(database, {
    groupId: 'demo-group',
    cycleId: 'demo-cycle',
    createdAt: '2026-09-11T00:00:00.000Z',
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error('film job was not created');
  return created.job.id;
}

test('compiles chronological retained clips into a playable normalized-audio film', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    const outputDir = `${dataDir}/media/processed`;
    await mkdir(outputDir, { recursive: true });
    const redClip = `${outputDir}/red.mp4`;
    const greenClip = `${outputDir}/green.mp4`;
    const blueClip = `${outputDir}/blue.mp4`;
    await createProcessedClip(redClip, { color: 'red', frequency: 440, volume: 0.08 });
    await createProcessedClip(greenClip, { color: 'green', frequency: 660, volume: 0.7 });
    await createProcessedClip(blueClip, { color: 'blue', frequency: 880, volume: 0.2 });
    // Insert in reverse acceptance order and give the jobs deliberately
    // misleading creation times. The only valid ordering signal is the
    // contribution's accepted timestamp.
    insertReadyClip(database, {
      id: 'accepted-late-blue',
      contributionId: 'contribution-blue',
      acceptedAt: '2026-09-10T03:00:00.000Z',
      jobCreatedAt: '2026-09-10T00:30:00.000Z',
      outputPath: blueClip,
    });
    insertReadyClip(database, {
      id: 'accepted-first-red',
      contributionId: 'contribution-red',
      acceptedAt: '2026-09-10T01:00:00.000Z',
      jobCreatedAt: '2026-09-10T01:30:00.000Z',
      outputPath: redClip,
    });
    insertReadyClip(database, {
      id: 'accepted-middle-green',
      contributionId: 'contribution-green',
      acceptedAt: '2026-09-10T02:00:00.000Z',
      jobCreatedAt: '2026-09-10T00:45:00.000Z',
      outputPath: greenClip,
    });
    const jobId = await createFilmJob(database);

    const result = await processCompilationJob(database, {
      jobId,
      ffmpegBin: config.ffmpegBin,
      outputDir,
    });
    assert.deepEqual(result, { ok: true, jobId, status: 'ready' });
    const job = getCompilationJob(database, jobId);
    assert.equal(job?.status, 'ready');
    assert.equal(job?.progress, 100);
    assert.equal(job?.completedCount, 3);
    assert.ok(job?.outputPath);
    await access(job.outputPath);
    const metadata = await probeClipWithFfmpeg(config.ffmpegBin, job.outputPath);
    assert.equal(metadata.hasAudio, true);
    assert.ok(metadata.durationSeconds > 2.7 && metadata.durationSeconds < 3.4);
    await assertPlayableWithFfmpeg(job.outputPath);
    const loudness = await integratedLoudness(job.outputPath);
    assert.ok(
      loudness >= -18 && loudness <= -14,
      `compiled film loudness ${loudness} LUFS was outside the deterministic -18..-14 LUFS bound`,
    );
    const [firstRed, , firstBlue] = await frameAverage(job.outputPath, 0.25);
    const [middleRed, middleGreen, middleBlue] = await frameAverage(job.outputPath, 1.25);
    const [lastRed, , lastBlue] = await frameAverage(job.outputPath, 2.25);
    assert.ok(firstRed > firstBlue * 1.5, 'first accepted clip was not first in the film');
    assert.ok(
      middleGreen > middleRed * 1.5 && middleGreen > middleBlue * 1.5,
      'middle accepted clip was not second in the film',
    );
    assert.ok(lastBlue > lastRed * 1.5, 'last accepted clip was not last in the film');
  });
});

test('production selection appends and visibly labels same-group archive filler', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    const outputDir = `${dataDir}/media/processed`;
    await mkdir(outputDir, { recursive: true });
    const currentClip = `${outputDir}/current-red.mp4`;
    const archiveClip = `${outputDir}/same-group-archive-purple.mp4`;
    const foreignClip = `${outputDir}/foreign-archive-orange.mp4`;
    await createProcessedClip(currentClip, { color: 'red', frequency: 440, volume: 0.4 });
    await createProcessedClip(archiveClip, { color: 'purple', frequency: 550, volume: 0.4 });
    await createProcessedClip(foreignClip, { color: 'orange', frequency: 660, volume: 0.4 });

    insertArchivedCycle(database, {
      id: 'same-group-archive-cycle',
      groupId: 'demo-group',
      publishedAt: '2026-09-08T00:00:00.000Z',
    });
    database
      .prepare(
        "INSERT INTO groups (id, name, current_cycle_id) VALUES ('foreign-group', 'Foreign', NULL)",
      )
      .run();
    insertArchivedCycle(database, {
      id: 'foreign-archive-cycle',
      groupId: 'foreign-group',
      // This is deliberately newer; group scoping must still exclude it.
      publishedAt: '2026-09-09T00:00:00.000Z',
    });
    insertReadyClip(database, {
      id: 'same-group-archive-clip',
      contributionId: 'same-group-archive-contribution',
      acceptedAt: '2026-09-02T00:00:00.000Z',
      outputPath: archiveClip,
      cycleId: 'same-group-archive-cycle',
    });
    insertReadyClip(database, {
      id: 'foreign-archive-clip',
      contributionId: 'foreign-archive-contribution',
      acceptedAt: '2026-09-02T01:00:00.000Z',
      outputPath: foreignClip,
      groupId: 'foreign-group',
      cycleId: 'foreign-archive-cycle',
    });
    insertReadyClip(database, {
      id: 'current-cycle-clip',
      contributionId: 'current-cycle-contribution',
      acceptedAt: '2026-09-10T01:00:00.000Z',
      outputPath: currentClip,
    });

    const jobId = await createFilmJob(database);
    assert.deepEqual(getCompilationJob(database, jobId)?.clipJobIds, [
      'current-cycle-clip',
      'same-group-archive-clip',
    ]);
    const result = await processCompilationJob(database, {
      jobId,
      ffmpegBin: config.ffmpegBin,
      outputDir,
    });
    assert.deepEqual(result, { ok: true, jobId, status: 'ready' });
    const film = getCompilationJob(database, jobId);
    assert.ok(film?.outputPath);

    const [firstRed, , firstBlue] = await frameAverage(film.outputPath, 0.25);
    const [archiveRed, archiveGreen, archiveBlue] = await frameAverage(film.outputPath, 1.25);
    assert.ok(firstRed > firstBlue * 1.5, 'current-cycle clip was not first');
    assert.ok(
      archiveRed > archiveGreen * 1.5 &&
        archiveBlue > archiveGreen * 1.5 &&
        archiveRed / archiveBlue > 0.7 &&
        archiveRed / archiveBlue < 1.4,
      'selected archive filler was not the same-group purple fixture',
    );

    const plainLabelRegion = await frameCrop(archiveClip, 0.25, 'crop=172:48:4:4');
    const fillerLabelRegion = await frameCrop(film.outputPath, 1.25, 'crop=172:48:4:4');
    assert.equal(ARCHIVE_FILLER_LABEL, 'From the archive');
    assert.ok(
      changedPixelFraction(plainLabelRegion, fillerLabelRegion) > 0.08,
      'production compilation did not render the archive label region',
    );
    assert.ok(
      pixelFractionAbove(fillerLabelRegion, 220) > 0.04,
      'the visible white From the archive lettering was not present',
    );
    await assertPlayableWithFfmpeg(film.outputPath);
    const metadata = await probeClipWithFfmpeg(config.ffmpegBin, film.outputPath);
    assert.equal(metadata.hasAudio, true);
    assert.ok(metadata.durationSeconds > 1.8 && metadata.durationSeconds < 2.4);
  });
});

test('a write-then-fail FFmpeg run removes partial output and keeps playback unavailable', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    const outputDir = `${dataDir}/media/processed`;
    await mkdir(outputDir, { recursive: true });
    const sourceClip = `${outputDir}/failure-source.mp4`;
    await createProcessedClip(sourceClip, { color: 'blue', frequency: 880, volume: 0.4 });
    insertReadyClip(database, {
      id: 'failure-source-clip',
      contributionId: 'failure-source-contribution',
      acceptedAt: '2026-09-10T01:00:00.000Z',
      outputPath: sourceClip,
    });
    const jobId = await createFilmJob(database);
    const markerPath = `${dataDir}/ffmpeg-wrote-output.marker`;
    const failingFfmpeg = `${dataDir}/write-then-fail.cjs`;
    await writeFile(
      failingFfmpeg,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { existsSync, statSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const outputPath = args.at(-1);
const result = spawnSync(${JSON.stringify(config.ffmpegBin)}, args, { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 90);
if (!outputPath || !existsSync(outputPath) || statSync(outputPath).size === 0) process.exit(92);
writeFileSync(${JSON.stringify(markerPath)}, outputPath);
process.exit(91);
`,
    );
    await chmod(failingFfmpeg, 0o755);

    for (let attempt = 1; attempt <= MAX_COMPILATION_ATTEMPTS; attempt += 1) {
      const result = await processCompilationJob(database, {
        jobId,
        ffmpegBin: failingFfmpeg,
        outputDir,
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.equal(
        result.reason,
        attempt === MAX_COMPILATION_ATTEMPTS ? 'retry_exhausted' : 'processing_failed',
      );
      await access(markerPath);
      assert.deepEqual(
        await readdir(outputDir),
        ['failure-source.mp4'],
        'failed compilation must remove its written temp and any final film artifact',
      );
    }
    const job = getCompilationJob(database, jobId);
    assert.equal(job?.status, 'failed');
    assert.equal(job?.outputPath, null);
    assert.equal(job?.attemptCount, MAX_COMPILATION_ATTEMPTS);
    assert.equal(job?.failureCategory, 'process_failed');
    assert.equal(job?.retryable, false);
    assert.equal(job?.delayed, true);

    const exhausted = await processCompilationJob(database, {
      jobId,
      ffmpegBin: failingFfmpeg,
      outputDir,
    });
    assert.deepEqual(exhausted, {
      ok: false,
      jobId,
      status: 'failed',
      reason: 'retry_exhausted',
      message: 'The film is delayed after the maximum number of compile attempts.',
    });
    assert.equal(getCompilationJob(database, jobId)?.attemptCount, MAX_COMPILATION_ATTEMPTS);

    const server = createRuntimeServer(config, database);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: 'demo-1' }),
      });
      assert.equal(sessionResponse.status, 201);
      const session = await sessionResponse.json();
      const query = `groupId=demo-group&sessionId=${encodeURIComponent(session.session.id)}`;
      const expectedNotFound = {
        error: 'not_found',
        message: 'The requested resource was not found.',
      };
      const playback = await fetch(`${baseUrl}/films/${encodeURIComponent(jobId)}/play?${query}`);
      assert.equal(playback.status, 404);
      assert.deepEqual(await playback.json(), expectedNotFound);
      const download = await fetch(
        `${baseUrl}/films/${encodeURIComponent(jobId)}/download?${query}`,
      );
      assert.equal(download.status, 404);
      assert.deepEqual(await download.json(), expectedNotFound);
    } finally {
      await new Promise((close) => server.close(close));
    }
  });
});
