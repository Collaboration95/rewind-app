import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createCompilationJob, getCompilationJob, MAX_COMPILATION_ATTEMPTS, processCompilationJob } =
  await import('../dist/jobs/index.js');
const { generateSyntheticDemoClip, probeClipWithFfmpeg } = await import('../dist/ffmpeg.js');

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

async function createProcessedClip(path, color, frequency) {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:size=180x320:rate=12:duration=1`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:sample_rate=44100:duration=1`,
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

function insertReadyClip(database, { id, contributionId, createdAt, outputPath }) {
  database
    .prepare(
      `INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
       VALUES (?, 'demo-cycle', 'demo-2', 1, ?)`,
    )
    .run(contributionId, createdAt);
  database
    .prepare(
      `INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, output_path, created_at, source_path)
       VALUES (?, 'demo-group', ?, 'clip', 'ready', ?, ?, NULL)`,
    )
    .run(id, contributionId, outputPath, createdAt);
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
    const blueClip = `${outputDir}/blue.mp4`;
    await createProcessedClip(redClip, 'red', 440);
    await createProcessedClip(blueClip, 'blue', 880);
    insertReadyClip(database, {
      id: 'chronological-red',
      contributionId: 'contribution-red',
      createdAt: '2026-09-10T01:00:00.000Z',
      outputPath: redClip,
    });
    insertReadyClip(database, {
      id: 'chronological-blue',
      contributionId: 'contribution-blue',
      createdAt: '2026-09-10T02:00:00.000Z',
      outputPath: blueClip,
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
    assert.equal(job?.completedCount, 2);
    assert.ok(job?.outputPath);
    await access(job.outputPath);
    const metadata = await probeClipWithFfmpeg(config.ffmpegBin, job.outputPath);
    assert.equal(metadata.hasAudio, true);
    assert.ok(metadata.durationSeconds > 1.75 && metadata.durationSeconds < 2.3);
    const [firstRed, , firstBlue] = await frameAverage(job.outputPath, 0.25);
    const [secondRed, , secondBlue] = await frameAverage(job.outputPath, 1.25);
    assert.ok(firstRed > firstBlue * 1.5, 'first accepted clip was not first in the film');
    assert.ok(secondBlue > secondRed * 1.5, 'second accepted clip was not second in the film');
  });
});

test('a missing retained input exhausts bounded retries and never publishes a partial film', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    const outputDir = `${dataDir}/media/processed`;
    await mkdir(outputDir, { recursive: true });
    insertReadyClip(database, {
      id: 'missing-clip',
      contributionId: 'missing-contribution',
      createdAt: '2026-09-10T01:00:00.000Z',
      outputPath: `${outputDir}/gone.mp4`,
    });
    const jobId = await createFilmJob(database);

    for (let attempt = 1; attempt <= MAX_COMPILATION_ATTEMPTS; attempt += 1) {
      const result = await processCompilationJob(database, {
        jobId,
        ffmpegBin: config.ffmpegBin,
        outputDir,
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.equal(
        result.reason,
        attempt === MAX_COMPILATION_ATTEMPTS ? 'retry_exhausted' : 'processing_failed',
      );
    }
    const job = getCompilationJob(database, jobId);
    assert.equal(job?.status, 'failed');
    assert.equal(job?.outputPath, null);
    assert.equal(job?.attemptCount, MAX_COMPILATION_ATTEMPTS);
    assert.equal(job?.failureCategory, 'source_unavailable');
    assert.equal(job?.retryable, false);
    assert.equal(job?.delayed, true);

    const exhausted = await processCompilationJob(database, {
      jobId,
      ffmpegBin: config.ffmpegBin,
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
  });
});
