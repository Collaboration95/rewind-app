import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = (name) => import(join(root, 'server/dist', `${name}.js`));
export const PROTOCOL = Object.freeze({ runs: 3, clients: 5, warmupMs: 30_000, samples: 100 });
export const SOURCE_PROFILE = Object.freeze({
  width: 720,
  height: 1280,
  frameRates: [24, 30],
  seconds: 6,
});

// Nearest-rank percentiles: retain every observation, including failures.
export function summarize(samples) {
  assert.ok(samples.length > 0, 'No observations');
  assert.ok(samples.every((s) => Number.isFinite(s.ms) && s.ms >= 0));
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  return {
    count: samples.length,
    errors: samples.filter((s) => !s.ok).length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
  };
}

export function assertTargets(report) {
  assert.equal(report.api.length, PROTOCOL.runs);
  assert.equal(report.films.length, PROTOCOL.runs);
  for (const run of report.api) {
    assert.ok(run.warmupElapsedMs >= PROTOCOL.warmupMs);
    for (const operation of ['group', 'prompt', 'budget', 'chat']) {
      const stats = summarize(run.samples.filter((s) => s.operation === operation));
      assert.ok(stats.count >= PROTOCOL.samples, `${operation}: insufficient samples`);
      assert.equal(stats.errors, 0, `${operation}: request errors`);
      assert.ok(stats.p95Ms <= 2000, `${operation}: p95 exceeds 2s`);
    }
  }
  for (const film of report.films) {
    assert.equal(film.inputCount, 25);
    assert.equal(film.inputSeconds, 150);
    assert.equal(film.inputs.length, 25);
    for (const input of film.inputs) {
      assert.equal(input.width, SOURCE_PROFILE.width);
      assert.equal(input.height, SOURCE_PROFILE.height);
      assert.equal(input.frameRates.nominal, `${SOURCE_PROFILE.frameRates[input.index % 2]}/1`);
    }
    assert.equal(film.metadata.width, 180);
    assert.equal(film.metadata.height, 320);
    assert.ok(film.queueMs >= 0 && film.workerMs > 0);
    assert.ok(film.endToEndMs >= film.workerMs);
    assert.ok(film.endToEndMs <= 600_000, 'Boundary-to-ready exceeds ten minutes');
    assert.equal(film.completedCount, 25);
    assert.equal(film.playable, true);
    assert.equal(film.chronologicalFrames, 25);
    assert.ok(film.loudnessLufs >= -18 && film.loudnessLufs <= -14);
  }
}

async function ffmpeg(args, options = {}) {
  return exec('ffmpeg', ['-hide_banner', ...args], {
    timeout: 120_000,
    maxBuffer: 8_000_000,
    ...options,
  });
}

async function probeFrameRates(path) {
  const { stdout } = await exec(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=avg_frame_rate,r_frame_rate',
      '-of',
      'json',
      path,
    ],
    { timeout: 10_000 },
  );
  const stream = JSON.parse(stdout).streams[0];
  return { nominal: stream.r_frame_rate, average: stream.avg_frame_rate };
}

async function request(origin, actor, path, body, expected = 200) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `Unexpected HTTP status for ${path.split('?')[0]}`);
  return data;
}

async function fixture(directory, run) {
  const { parseConfig } = await build('config');
  const { openDatabase } = await build('db');
  const { createRuntimeServer } = await build('http');
  const { createRealAccount } = await build('auth/index');
  // Deliberately do not inherit REWIND_* settings, storage or providers.
  const config = parseConfig({
    REWIND_DATA_DIR: directory,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
  });
  const now = new Date();
  const database = openDatabase(config);
  const server = createRuntimeServer(config, database, { now: () => now });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const actors = [];
    for (let i = 0; i < 6; i += 1) {
      const username = `perf-member-${i}`;
      const password = 'owned synthetic measurement password';
      const account = await createRealAccount(database, username, username, password, now);
      assert.equal(account.ok, true);
      const auth = await request(origin, null, '/auth/login', {
        username,
        password,
        clientType: 'native',
      });
      actors.push({ token: auth.token, account: account.account });
    }
    const group = await request(
      origin,
      actors[0],
      '/real/groups',
      {
        name: 'Synthetic performance group',
        prompt: 'A synthetic moment',
        maxMembers: 5,
      },
      201,
    );
    for (const actor of actors.slice(1, 5)) {
      const invite = await request(
        origin,
        actors[0],
        `/real/groups/${group.group.id}/invites`,
        {},
        201,
      );
      await request(origin, actor, '/real/invites/accept', { code: invite.invite.code });
    }
    const members = database
      .prepare(
        'SELECT profile_id AS id, account_id AS accountId FROM real_group_memberships WHERE group_id = ? ORDER BY account_id',
      )
      .all(group.group.id);
    assert.equal(members.length, 5);
    for (let i = 0; i < 100; i += 1) {
      await request(
        origin,
        actors[i % 5],
        `/realtime/groups/${group.group.id}/messages`,
        { body: `Synthetic message ${i}` },
        201,
      );
    }
    return await run({ database, origin, actors, group, members, now });
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((done) => server.close(done));
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function measureApi(context) {
  const { origin, actors, group } = context;
  const id = group.group.id;
  const operations = [
    ['group', `/real/groups/${id}`],
    [
      'prompt',
      `/real/groups/${id}/settings`,
      { prompt: 'Measured synthetic prompt', timeZone: 'Asia/Singapore' },
    ],
    ['budget', `/contributions?groupId=${id}&limit=5`],
    ['chat', `/realtime/groups/${id}/messages?limit=100`],
  ];
  async function batch(index, samples) {
    await Promise.all(
      actors.slice(0, 5).map(async (actor, client) => {
        const [operation, path, body] = operations[(index * 5 + client) % operations.length];
        const start = performance.now();
        let ok = false;
        try {
          const data = await request(
            origin,
            operation === 'prompt' ? actors[0] : actor,
            path,
            body,
          );
          if (operation === 'budget')
            assert.ok(data.allowance, 'Budget response missing allowance');
          if (operation === 'budget') assert.equal(data.allowance.countUsed, 5);
          if (operation === 'chat') assert.equal(data.events.length, 100);
          ok = true;
        } finally {
          samples.push({ operation, ms: performance.now() - start, ok });
        }
      }),
    );
  }
  const warmup = [];
  const start = performance.now();
  let index = 0;
  while (performance.now() - start < PROTOCOL.warmupMs) {
    await batch(index++, warmup);
    await new Promise((done) => setTimeout(done, 100));
  }
  const warmupElapsedMs = performance.now() - start;
  const samples = [];
  for (let i = 0; i < 80; i += 1) await batch(i, samples);
  const stats = Object.fromEntries(
    operations.map(([operation]) => [
      operation,
      summarize(samples.filter((s) => s.operation === operation)),
    ]),
  );
  return { warmupElapsedMs, warmupRequests: warmup.length, samples, stats };
}

async function prepareFilm({ database, group, members, now }, directory) {
  const { probeClipWithFfmpeg } = await build('ffmpeg');
  const outputDir = join(directory, 'media', 'processed');
  await mkdir(outputDir, { recursive: true });
  const colors = ['red', 'green', 'blue'];
  // Reverse insertion order and misleading job dates test acceptance ordering.
  const hashes = [];
  for (let i = 24; i >= 0; i -= 1) {
    const path = join(outputDir, `new-${i}.mp4`);
    await ffmpeg([
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${colors[i % 3]}:size=${SOURCE_PROFILE.width}x${SOURCE_PROFILE.height}:rate=${SOURCE_PROFILE.frameRates[i % 2]}:duration=${SOURCE_PROFILE.seconds}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${440 + i * 20}:sample_rate=${i % 2 ? 48000 : 44100}:duration=6`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-af',
      `volume=${[0.08, 0.7, 0.2][i % 3]}`,
      '-shortest',
      path,
    ]);
    const metadata = await probeClipWithFfmpeg('ffmpeg', path);
    assert.ok(Math.abs(metadata.durationSeconds - 6) < 0.1 && metadata.hasAudio);
    assert.equal(metadata.width, SOURCE_PROFILE.width);
    assert.equal(metadata.height, SOURCE_PROFILE.height);
    const frameRates = await probeFrameRates(path);
    assert.equal(frameRates.nominal, `${SOURCE_PROFILE.frameRates[i % 2]}/1`);
    hashes.push({
      index: i,
      sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
      ...metadata,
      frameRates,
    });
    const accepted = new Date(now.getTime() + i * 1000).toISOString();
    database
      .prepare(
        'INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at) VALUES (?, ?, ?, 6, ?)',
      )
      .run(`perf-${i}`, group.cycle.id, members[i % 5].id, accepted);
    database
      .prepare(
        "INSERT INTO media_jobs (id, group_id, contribution_id, kind, status, output_path, created_at, source_path) VALUES (?, ?, ?, 'clip', 'ready', ?, ?, NULL)",
      )
      .run(
        `clip-${i}`,
        group.group.id,
        `perf-${i}`,
        path,
        new Date(now.getTime() + (24 - i) * 1000).toISOString(),
      );
  }
  const { contributionQuotaWindow } = await build('contributions/index');
  const window = contributionQuotaWindow(group.cycle, now);
  for (const member of members) {
    database
      .prepare(
        'INSERT INTO contribution_quota_windows (id, cycle_id, member_id, window_start_at, window_end_at, max_count, max_seconds, count_used, seconds_used) VALUES (?, ?, ?, ?, ?, 5, 30, 5, 30)',
      )
      .run(`quota-${member.id}`, group.cycle.id, member.id, window.startsAt, window.endsAt);
  }
  return { outputDir, hashes };
}

async function measureFilm({ database, group }, { outputDir, hashes }) {
  const { createCompilationJob, getCompilationJob, processCompilationJobForWorker } =
    await build('jobs/index');
  const { probeClipWithFfmpeg } = await build('ffmpeg');
  const boundary = performance.now();
  database.prepare("UPDATE cycles SET status = 'revealing' WHERE id = ?").run(group.cycle.id);
  const created = createCompilationJob(database, {
    groupId: group.group.id,
    cycleId: group.cycle.id,
    createdAt: new Date().toISOString(),
  });
  assert.equal(created.ok, true);
  assert.deepEqual(
    created.job.clipJobIds,
    Array.from({ length: 25 }, (_, i) => `clip-${i}`),
  );
  let claimed;
  let claimedAt;
  const result = await processCompilationJobForWorker(
    database,
    { jobId: created.job.id, ffmpegBin: 'ffmpeg', outputDir },
    () => {
      claimed = performance.now();
      claimedAt = getCompilationJob(database, created.job.id).processingStartedAt;
    },
  );
  const ready = performance.now();
  assert.equal(result.ok, true, 'Compilation did not succeed');
  const job = getCompilationJob(database, created.job.id);
  const durable = database
    .prepare('SELECT created_at, updated_at FROM media_jobs WHERE id = ?')
    .get(job.id);
  assert.equal(job.status, 'ready');
  const output = job.outputPath;
  const metadata = await probeClipWithFfmpeg('ffmpeg', output);
  assert.ok(Math.abs(metadata.durationSeconds - 150) < 1 && metadata.hasAudio);
  await ffmpeg([
    '-loglevel',
    'error',
    '-i',
    output,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-f',
    'null',
    '-',
  ]);
  for (let i = 0; i < 25; i += 1) {
    const { stdout } = await ffmpeg(
      [
        '-loglevel',
        'error',
        '-ss',
        String(i * 6 + 1),
        '-i',
        output,
        '-frames:v',
        '1',
        '-vf',
        'scale=1:1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        '-',
      ],
      { encoding: 'buffer' },
    );
    assert.equal(stdout.length, 3);
    const channel = i % 3;
    assert.ok(
      stdout[channel] > Math.max(...[...stdout].filter((_, c) => c !== channel)) * 1.5,
      `Chronology failed at clip ${i}`,
    );
  }
  const { stderr } = await ffmpeg([
    '-loglevel',
    'info',
    '-i',
    output,
    '-af',
    'ebur128=framelog=quiet',
    '-f',
    'null',
    '-',
  ]);
  const match = stderr.match(/Integrated loudness:\s+I:\s+(-?\d+(?:\.\d+)?) LUFS/);
  assert.ok(match, 'No loudness measurement');
  return {
    inputCount: 25,
    inputSeconds: 150,
    queueMs: claimed - boundary,
    workerMs: ready - claimed,
    endToEndMs: ready - boundary,
    durable: { enqueuedAt: durable.created_at, claimedAt, readyAt: durable.updated_at },
    completedCount: job.completedCount,
    attemptCount: job.attemptCount,
    playable: true,
    chronologicalFrames: 25,
    loudnessLufs: Number(match[1]),
    outputSha256: createHash('sha256')
      .update(await readFile(output))
      .digest('hex'),
    metadata: { ...metadata, frameRates: await probeFrameRates(output) },
    inputs: hashes,
  };
}

async function privacy({ origin, actors, group, members }) {
  const id = group.group.id;
  await request(origin, actors[5], `/real/groups/${id}`, undefined, 404);
  await request(origin, actors[5], `/contributions?groupId=${id}`, undefined, 403);
  await request(origin, actors[5], `/realtime/groups/${id}/messages`, undefined, 403);
  await request(
    origin,
    actors[5],
    `/real/groups/${id}/settings`,
    { prompt: 'forbidden', timeZone: 'Asia/Singapore' },
    403,
  );
  await request(
    origin,
    actors[1],
    `/real/groups/${id}/settings`,
    { prompt: 'forbidden', timeZone: 'Asia/Singapore' },
    403,
  );
  const clipOwner = actors.find((actor) => actor.account.id === members[0].accountId);
  assert.ok(clipOwner, 'Sealed clip owner must be a provisioned member');
  await request(origin, clipOwner, `/clips/clip-0/download?groupId=${id}`, undefined, 404);
  return {
    sealedClipDownload: 404,
    outsiderGroup: 404,
    outsiderBudget: 403,
    outsiderChat: 403,
    outsiderPrompt: 403,
    memberPrompt: 403,
  };
}

export async function main() {
  assert.equal(
    process.argv.length,
    2,
    'No arguments supported; this runner never accepts a hosted URL',
  );
  const directory = await mkdtemp(join(tmpdir(), 'rewind-perf-353-'));
  const report = {
    schema: 1,
    startedAt: new Date().toISOString(),
    protocol: PROTOCOL,
    sourceProfile: SOURCE_PROFILE,
    host: {
      platform: platform(),
      release: release(),
      arch: process.arch,
      cpu: cpus()[0].model,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
      loadAverage: (await import('node:os')).loadavg(),
      node: process.version,
    },
    config: {
      bind: '127.0.0.1',
      port: 'OS allocated per repetition',
      storage: 'owned temporary local disk',
      database: 'SQLite',
      auth: 'real password accounts/native bearer; insecure loopback only',
      clients: 5,
      members: 5,
      outsider: 1,
      chatMessages: 100,
      promptActor: 'owner',
      requestBoundary: 'fetch start through complete JSON response',
      apiAndServer: 'same Node process, no profiler',
      filmBoundary: 'cycle transition/job creation through ready return',
      queue: 'immediate local worker dispatch, no scheduled tick delay',
      compileConcurrency: 1,
      inheritedRewindEnvironment: false,
    },
    build: {
      head: (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
      dirty: (await exec('git', ['status', '--short'], { cwd: root })).stdout.trim(),
      lockSha256: createHash('sha256')
        .update(await readFile(join(root, 'package-lock.json')))
        .digest('hex'),
      runnerSha256: createHash('sha256')
        .update(await readFile(fileURLToPath(import.meta.url)))
        .digest('hex'),
      ffmpeg: (await exec('ffmpeg', ['-version'])).stdout.split('\n')[0],
    },
    api: [],
    films: [],
    privacy: [],
    gates: [
      'Existing film failure/retry/filler and private-media regression suites must be reported separately',
      'Hosted/device/provider acceptance',
      'Review, required Quality and integration into dev',
    ],
  };
  let failed = false;
  try {
    for (let run = 1; run <= PROTOCOL.runs; run += 1) {
      console.log(
        `Repetition ${run}: fresh five-member fixture, API warm-up/samples, 25-clip real compilation`,
      );
      const dataDir = join(directory, `run-${run}`);
      await fixture(dataDir, async (context) => {
        const prepared = await prepareFilm(context, dataDir);
        report.privacy.push(await privacy(context));
        report.api.push(await measureApi(context));
        report.films.push(await measureFilm(context, prepared));
      });
    }
    assertTargets(report);
    report.passed = true;
  } catch (error) {
    failed = true;
    // Do not persist raw HTTP bodies, bearer tokens or FFmpeg diagnostics.
    report.passed = false;
    report.failure = {
      name: error.name,
      message:
        error instanceof assert.AssertionError
          ? error.message
          : 'Runner failed; local diagnostics require inspection',
    };
    console.error(report.failure);
    console.error(
      error instanceof assert.AssertionError ? error.message : (error.code ?? error.name),
    );
  } finally {
    report.finishedAt = new Date().toISOString();
    const path = join(directory, 'report.json');
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(`Measurement report: ${path}`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
