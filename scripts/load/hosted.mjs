// Dependency-free, bounded closed-loop HTTP load test. No credentials in results.
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const target = new URL(process.env.TARGET_URL || 'https://d2m6kz76y4kuvm.cloudfront.net');
if (
  !['https:', 'http:'].includes(target.protocol) ||
  target.username ||
  target.password ||
  target.search ||
  target.hash
)
  throw new Error('Use an HTTP(S) origin without credentials or query');
const maxVus = Number(process.env.MAX_VUS || 100);
const steadySeconds = Number(process.env.STEADY_SECONDS || 180);
const rampSeconds = Number(process.env.RAMP_SECONDS || 15);
if (!Number.isInteger(maxVus) || maxVus < 1 || maxVus > 100)
  throw new Error('MAX_VUS must be 1..100');
if (
  !Number.isFinite(steadySeconds) ||
  steadySeconds < 1 ||
  steadySeconds > 180 ||
  !Number.isFinite(rampSeconds) ||
  rampSeconds < 0 ||
  rampSeconds > 30
)
  throw new Error('Invalid stage duration');
const output = resolve(process.env.OUTPUT || 'load-results/results.json');
const privateFixture = process.env.FIXTURE_FILE;
const confirmationOnly = process.env.CONFIRMATION_ONLY === 'true';
if (confirmationOnly && !privateFixture) throw new Error('Confirmation needs an existing fixture');
const samples = [];
const setup = [];
let interrupted = false;
process.on('SIGTERM', () => {
  interrupted = true;
});
process.on('SIGINT', () => {
  interrupted = true;
});
let current = null;
let originChecks = {};
const startedAt = new Date().toISOString();
const runId = `load-${Date.now()}`;

async function request(
  operation,
  path,
  actor,
  body,
  expected = [200],
  bucket = samples,
  contentType = 'application/json',
) {
  const start = performance.now();
  let status = 0,
    bytes = 0,
    data = null,
    valid = false,
    cache = null;
  try {
    const response = await fetch(new URL(path, target), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': contentType } : {}),
      },
      body:
        body === undefined
          ? undefined
          : contentType === 'application/json'
            ? JSON.stringify(body)
            : body,
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    status = response.status;
    cache = response.headers.get('x-cache');
    const text = await response.text();
    bytes = Buffer.byteLength(text);
    try {
      data = JSON.parse(text);
    } catch {
      /* Non-JSON responses fail below. */
    }
    valid = expected.includes(status) && data !== null && !data.error;
  } catch {
    /* Persist bounded status only, never response bodies or credentials. */
  }
  const sample = {
    operation,
    ms: performance.now() - start,
    status,
    ok: valid,
    bytes,
    cache,
    stage: current?.vus ?? 0,
    phase: current?.phase ?? 'setup',
    at: new Date().toISOString(),
  };
  bucket.push(sample);
  return { ok: valid, status, data };
}
async function must(...args) {
  const result = await request(...args);
  if (!result.ok) throw new Error(`Setup failed: ${args[0]} HTTP ${result.status}`);
  return result.data;
}
function summarize(rows, seconds) {
  const times = rows.map((r) => r.ms).sort((a, b) => a - b);
  const percentile = (q) => (times.length ? times[Math.ceil(q * times.length) - 1] : null);
  const errors = rows.filter((r) => !r.ok).length;
  return {
    requests: rows.length,
    errors,
    errorRate: rows.length ? errors / rows.length : null,
    throughputRps: rows.length / seconds,
    meanMs: rows.length ? times.reduce((a, b) => a + b, 0) / rows.length : null,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: times.at(-1) ?? null,
  };
}
let fixture;
const stages = [];
try {
  originChecks = await must('health', '/api/health', null, undefined, [200], setup);
  if (privateFixture) {
    fixture = JSON.parse(await readFile(privateFixture, 'utf8'));
    if (fixture.target !== target.origin) throw new Error('Fixture origin mismatch');
  } else {
    const actors = [];
    for (let i = 0; i < 3; i++) {
      const username = `${runId}-${i}`;
      const password = randomBytes(24).toString('base64url');
      await must('register', '/api/auth/register', null, { username, password }, [201], setup);
      const login = await must(
        'login',
        '/api/auth/login',
        null,
        { username, password, clientType: 'native' },
        [200],
        setup,
      );
      if (!login.token) throw new Error('Login did not return native session');
      actors.push({ token: login.token });
    }
    const group = await must(
      'create-group',
      '/api/real/groups',
      actors[0],
      {
        name: `Scripted performance ${runId}`,
        prompt: 'Synthetic load-test moment',
        maxMembers: 5,
      },
      [201],
      setup,
    );
    const groupId = group.group.id;
    for (const actor of actors.slice(1)) {
      const invitation = await must(
        'invite',
        `/api/real/groups/${groupId}/invites`,
        actors[0],
        {},
        [201],
        setup,
      );
      await must(
        'join',
        '/api/real/invites/accept',
        actor,
        { code: invitation.invite.code },
        [200],
        setup,
      );
    }
    fixture = { target: target.origin, actors, groupId, cycle: group.cycle };
    if (process.env.SAVE_FIXTURE)
      await writeFile(process.env.SAVE_FIXTURE, JSON.stringify(fixture), { mode: 0o600 });
  }
  const { actors, groupId } = fixture;
  // Upload at most three tiny PNGs across the run, one per account. The PNG is
  // embedded so CI needs neither ffmpeg nor an external media fixture.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  let uploads = 0,
    capabilities = 0,
    capabilityEmpty = 0;
  async function upload(actor) {
    const key = randomUUID();
    const staged = await request(
      'upload-source',
      `/api/contributions/upload/source?groupId=${groupId}&idempotencyKey=${key}`,
      actor,
      png,
      [201],
      samples,
      'image/png',
    );
    if (!staged.ok) return;
    const created = await request(
      'upload-contribution',
      `/api/contributions/upload?groupId=${groupId}`,
      actor,
      {
        mediaType: 'photo',
        idempotencyKey: key,
        sourceUri: staged.data.source.uri,
        mimeType: 'image/png',
        byteLength: png.length,
        durationSeconds: 3,
        width: 1,
        height: 1,
        hasAudio: true,
      },
      [200, 201],
    );
    if (created.ok) {
      const jobId = created.data.upload.jobId;
      if (jobId)
        await request(
          'process-contribution',
          `/api/contributions/jobs/${jobId}/process?groupId=${groupId}`,
          actor,
          {},
          [200],
        );
    }
  }
  const mix = [
    'home',
    'chat',
    'groups',
    'chat',
    'home',
    'archive',
    'budget',
    'chat',
    'groups',
    'capability',
    'home',
    'chat',
    'archive',
    'groups',
    'budget',
    'chat',
    'home',
    'archive',
    'chat',
    'send',
  ];
  async function operation(vu, index) {
    const actor = actors[vu % actors.length];
    let kind = mix[(index + vu) % mix.length];
    if (confirmationOnly && kind === 'send') kind = 'chat';
    const groupPath = `/api/real/groups/${groupId}`;
    if (kind === 'home') await request('home', groupPath, actor);
    if (kind === 'groups') await request('groups', '/api/real/groups', actor);
    if (kind === 'chat')
      await request('chat-read', `/api/realtime/groups/${groupId}/messages?limit=30`, actor);
    if (kind === 'budget')
      await request('contributions', `/api/contributions?groupId=${groupId}&limit=5`, actor);
    if (kind === 'send')
      await request(
        'chat-send',
        `/api/realtime/groups/${groupId}/messages`,
        actor,
        { body: `Synthetic performance ${runId}`, messageId: randomUUID() },
        [201],
      );
    if (kind === 'archive' || kind === 'capability') {
      const r = await request(
        kind === 'archive' ? 'archive' : 'media-capability',
        `/api/archive?groupId=${groupId}&limit=5`,
        actor,
      );
      if (kind === 'capability' && r.ok) {
        const entries = [...(r.data.archive?.films || []), ...(r.data.archive?.clips || [])];
        const path = entries[0]?.downloadPath;
        if (path) capabilities++;
        else capabilityEmpty++;
      }
    }
  }
  const levels = confirmationOnly
    ? [maxVus]
    : [...new Set([1, 10, 25, 50, maxVus].filter((n) => n <= maxVus))];
  let active = 0,
    end = 0,
    stopping = false;
  async function vuLoop(vu) {
    let index = 0;
    while (!stopping) {
      if (vu < active && performance.now() < end) {
        await operation(vu, index++);
        // Deterministic staggered user think time, mean five seconds.
        await sleep(3000 + ((vu * 7919 + index * 1543) % 4001));
      } else await sleep(100);
    }
  }
  const workers = Array.from({ length: maxVus }, (_, i) => vuLoop(i));
  for (const vus of levels) {
    for (const [phase, seconds] of [
      ['ramp', rampSeconds],
      ['steady', steadySeconds],
    ]) {
      current = { vus, phase };
      const start = performance.now();
      end = start + seconds * 1000;
      const previous = active;
      if (phase === 'steady') active = vus;
      while (performance.now() < end && !interrupted) {
        if (phase === 'ramp')
          active = Math.max(
            1,
            Math.ceil(
              previous + ((vus - previous) * (performance.now() - start)) / (seconds * 1000),
            ),
          );
        if (!confirmationOnly && phase === 'steady' && uploads < actors.length) {
          const actor = actors[uploads++];
          await upload(actor);
        }
        await sleep(100);
      }
      const elapsedSeconds = (performance.now() - start) / 1000;
      stages.push({ vus, phase, elapsedSeconds });
      console.log(
        JSON.stringify({
          vus,
          phase,
          ...summarize(
            samples.filter((r) => r.stage === vus && r.phase === phase),
            elapsedSeconds,
          ),
        }),
      );
      if (interrupted) break;
    }
    if (interrupted) break;
  }
  stopping = true;
  if (interrupted) process.exitCode = 1;
  await Promise.all(workers);
  fixture = { ...fixture, actors: undefined };
  fixture.media = { uploadAttempts: uploads, capabilitiesIssued: capabilities, capabilityEmpty };
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  const summaries = stages.map((stage) => ({
    ...stage,
    ...summarize(
      samples.filter((s) => s.stage === stage.vus && s.phase === stage.phase),
      stage.elapsedSeconds,
    ),
  }));
  const steady = samples.filter((s) => s.phase === 'steady');
  const aggregate = summarize(
    steady,
    stages.filter((s) => s.phase === 'steady').reduce((n, s) => n + s.elapsedSeconds, 0) || 1,
  );
  const expectedStageCount = confirmationOnly
    ? 1
    : new Set([1, 10, 25, 50, maxVus].filter((n) => n <= maxVus)).size;
  const passed =
    summaries.filter((s) => s.phase === 'steady').length === expectedStageCount &&
    summaries
      .filter((s) => s.phase === 'steady')
      .every((s) => s.requests > 0 && s.p95Ms < 2000 && s.errorRate < 0.01) &&
    !process.exitCode;
  const report = {
    schemaVersion: 1,
    runId,
    target: target.origin,
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    hostCpu: 'unobserved',
    originChecks,
    profile: {
      confirmationOnly,
      maxVus,
      steadySeconds,
      rampSeconds,
      thinkTimeMs: [3000, 7000],
      timeoutMs: 15000,
    },
    fixture: fixture
      ? { groupId: fixture.groupId, cycle: fixture.cycle, media: fixture.media }
      : null,
    setup,
    stages: summaries,
    operations: Object.fromEntries(
      [...new Set(steady.map((s) => s.operation))].map((op) => [
        op,
        summarize(
          steady.filter((s) => s.operation === op),
          stages.filter((s) => s.phase === 'steady').reduce((n, s) => n + s.elapsedSeconds, 0) || 1,
        ),
      ]),
    ),
    aggregate,
    passed,
    samples,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  const summary =
    `# Hosted load test\n\nTarget: ${target.origin}\n\nResult: ${passed ? 'PASS' : 'FAIL'} (p95 < 2000 ms, errors < 1%, every steady stage)\n\n| VUs | Phase | Requests | p50 ms | p95 ms | p99 ms | req/s | Errors % |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n` +
    summaries
      .map(
        (s) =>
          `| ${s.vus} | ${s.phase} | ${s.requests} | ${s.p50Ms?.toFixed(1)} | ${s.p95Ms?.toFixed(1)} | ${s.p99Ms?.toFixed(1)} | ${s.throughputRps.toFixed(2)} | ${(s.errorRate * 100).toFixed(2)} |`,
      )
      .join('\n') +
    '\n';
  await writeFile(resolve(dirname(output), 'SUMMARY.md'), summary);
  if (!passed) process.exitCode = 1;
}
