import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createCompilationJob, getCompilationJob, MAX_COMPILATION_ATTEMPTS, processCompilationJob } =
  await import('../dist/jobs/index.js');
const { compileFilmWithFfmpeg, generateSyntheticDemoClip, probeClipWithFfmpeg } =
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

const LABEL_FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
};

function labelledPpm(label) {
  const width = 180;
  const height = 320;
  const pixels = Buffer.alloc(width * height * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    pixels[offset] = 128;
    pixels[offset + 1] = 0;
    pixels[offset + 2] = 128;
  }
  const lines = label.toUpperCase().split(' ');
  const scale = 2;
  const charAdvance = 12;
  const lineHeight = 18;
  const maxLineWidth = Math.max(...lines.map((line) => line.length * charAdvance));
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const yOffset = 3 + lineIndex * lineHeight;
    for (let y = 0; y < 11; y += 1) {
      for (let x = 2; x < maxLineWidth + 4; x += 1) {
        const pixel = (yOffset + y) * width + x;
        pixels[pixel * 3] = 0;
        pixels[pixel * 3 + 1] = 0;
        pixels[pixel * 3 + 2] = 0;
      }
    }
    for (let characterIndex = 0; characterIndex < line.length; characterIndex += 1) {
      const glyph = LABEL_FONT[line[characterIndex]];
      if (!glyph) continue;
      for (let glyphY = 0; glyphY < glyph.length; glyphY += 1) {
        for (let glyphX = 0; glyphX < glyph[glyphY].length; glyphX += 1) {
          if (glyph[glyphY][glyphX] !== '1') continue;
          for (let scaledY = 0; scaledY < scale; scaledY += 1) {
            for (let scaledX = 0; scaledX < scale; scaledX += 1) {
              const x = 4 + characterIndex * charAdvance + glyphX * scale + scaledX;
              const y = yOffset + glyphY * scale + scaledY;
              const pixel = y * width + x;
              pixels[pixel * 3] = 255;
              pixels[pixel * 3 + 1] = 255;
              pixels[pixel * 3 + 2] = 255;
            }
          }
        }
      }
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

async function createProcessedClip(
  path,
  { color, frequency, volume = 1, label = null, duration = 1 },
) {
  let labelFramePath = null;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (label) {
    labelFramePath = `${path}.label.ppm`;
    await writeFile(labelFramePath, labelledPpm(label));
    args.push('-loop', '1', '-i', labelFramePath);
  } else {
    args.push('-f', 'lavfi', '-i', `color=c=${color}:size=180x320:rate=12:duration=${duration}`);
  }
  args.push(
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
  );
  try {
    await execFileAsync('ffmpeg', args);
  } finally {
    if (labelFramePath) await rm(labelFramePath, { force: true });
  }
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
  { id, contributionId, acceptedAt, jobCreatedAt = acceptedAt, outputPath },
) {
  database
    .prepare(
      `INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
       VALUES (?, 'demo-cycle', 'demo-2', 1, ?)`,
    )
    .run(contributionId, acceptedAt);
  database
    .prepare(
      `INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, output_path, created_at, source_path)
       VALUES (?, 'demo-group', ?, 'clip', 'ready', ?, ?, NULL)`,
    )
    .run(id, contributionId, outputPath, jobCreatedAt);
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

test('compiled archive-filler output retains its visible From the archive label', async () => {
  await withDatabase(async ({ config, dataDir }) => {
    const outputDir = `${dataDir}/media/processed`;
    await mkdir(outputDir, { recursive: true });
    const plainClip = `${outputDir}/plain-reference.mp4`;
    const fillerClip = `${outputDir}/archive-filler.mp4`;
    const plainFilm = `${outputDir}/plain-reference-film.mp4`;
    const fillerFilm = `${outputDir}/archive-filler-film.mp4`;
    const fixture = { color: 'purple', frequency: 550, volume: 0.4 };
    await createProcessedClip(plainClip, fixture);
    await createProcessedClip(fillerClip, { ...fixture, label: 'From the archive' });
    await compileFilmWithFfmpeg(config.ffmpegBin, {
      inputPaths: [plainClip],
      outputPath: plainFilm,
    });
    await compileFilmWithFfmpeg(config.ffmpegBin, {
      inputPaths: [fillerClip],
      outputPath: fillerFilm,
    });

    const plainLabelRegion = await frameCrop(plainFilm, 0.25, 'crop=172:48:4:4');
    const fillerLabelRegion = await frameCrop(fillerFilm, 0.25, 'crop=172:48:4:4');
    assert.ok(
      changedPixelFraction(plainLabelRegion, fillerLabelRegion) > 0.08,
      'the rendered archive label did not survive film compilation',
    );
    await assertPlayableWithFfmpeg(fillerFilm);
    const metadata = await probeClipWithFfmpeg(config.ffmpegBin, fillerFilm);
    assert.equal(metadata.hasAudio, true);
  });
});

test('a missing retained input exhausts bounded retries and never publishes a partial film', async () => {
  await withDatabase(async ({ config, database, dataDir }) => {
    const outputDir = `${dataDir}/media/processed`;
    await mkdir(outputDir, { recursive: true });
    insertReadyClip(database, {
      id: 'missing-clip',
      contributionId: 'missing-contribution',
      acceptedAt: '2026-09-10T01:00:00.000Z',
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

    const outputNames = await readdir(outputDir);
    assert.deepEqual(
      outputNames,
      [],
      'failed compilation must leave no final or temporary film artifact behind',
    );

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
