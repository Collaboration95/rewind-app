import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';

const { parseConfig } = await import('../dist/config.js');
const { getCurrentCycle } = await import('../dist/db.js');
const { createRealAccount } = await import('../dist/auth/index.js');
const { createRealGroup, getCurrentRealGroup } = await import('../dist/groups/real.js');
const { createClipUpload } = await import('../dist/media/index.js');
const { probeClipWithFfmpeg } = await import('../dist/ffmpeg.js');
const { runCycleSchedulerTick, startCycleSchedulerLoop } =
  await import('../dist/cycles/scheduler.js');

async function fixture(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-real-scheduler-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
  });
  const database = openFixtureDatabase(config);
  let now = new Date('2026-09-01T00:00:00.000Z');
  const account = await createRealAccount(
    database,
    'scheduler-owner',
    'Scheduler Owner',
    'synthetic scheduler test password',
    now,
  );
  assert.equal(account.ok, true);
  const group = createRealGroup(
    database,
    account.account,
    { name: 'Automatic private film', prompt: 'A memory', maxMembers: 2 },
    now,
  );
  const options = {
    ffmpegBin: 'ffmpeg',
    stagingDir: resolve(dataDir, 'media/staging'),
    outputDir: resolve(dataDir, 'media/processed'),
    now: () => now,
  };
  try {
    await run({
      config,
      database,
      group,
      account: account.account,
      options,
      setNow: (value) => {
        now = new Date(value);
      },
    });
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function readyClip(database, group, dataDir, now) {
  const bytes = await readFile('server/fixtures/sample-clip.mp4');
  const path = resolve(dataDir, 'media/processed/real-scheduler-input.mp4');
  await writeFile(path, bytes);
  const uploaded = createClipUpload(
    database,
    group.group.id,
    group.memberId,
    {
      idempotencyKey: 'real-scheduler-clip-01',
      sourceUri: 'synthetic-scheduler-source',
      mimeType: 'video/mp4',
      byteLength: bytes.length,
      durationSeconds: 3,
      width: 720,
      height: 1280,
      hasAudio: true,
    },
    now,
  );
  assert.equal(uploaded.ok, true);
  database
    .prepare(
      `UPDATE media_jobs SET status = 'ready', source_path = NULL, output_path = ?,
    output_sha256 = ?, output_bytes = ?, output_verified_at = ? WHERE id = ?`,
    )
    .run(
      path,
      createHash('sha256').update(bytes).digest('hex'),
      bytes.length,
      now.toISOString(),
      uploaded.upload.job.id,
    );
  return uploaded.upload;
}

test('real persisted scheduler closes, compiles with audio, publishes once and archives after 24h with every client absent', async () => {
  await fixture(async ({ database, group, account, config, options, setNow }) => {
    await readyClip(database, group, config.dataDir, new Date(group.cycle.startsAt));
    setNow(group.cycle.endsAt);
    const first = await runCycleSchedulerTick(database, options);
    assert.equal(first.transitions[0].action, 'revealing');
    assert.equal(first.worker.claimed, true);
    assert.equal(first.worker.record.status, 'ready');
    const next = getCurrentCycle(database, group.group.id);
    assert.notEqual(next.id, group.cycle.id);
    assert.equal(next.startsAt, group.cycle.endsAt);
    const second = await runCycleSchedulerTick(database, options);
    assert.equal(second.transitions[0].action, 'published');
    assert.equal(getCurrentRealGroup(database, account.id).releases[0].state, 'premiere');
    const film = database
      .prepare("SELECT output_path AS path FROM media_jobs WHERE cycle_id = ? AND kind = 'film'")
      .get(group.cycle.id);
    const metadata = await probeClipWithFfmpeg('ffmpeg', film.path);
    assert.equal(metadata.hasAudio, true);
    assert.ok(metadata.durationSeconds >= 3);
    setNow(new Date(Date.parse(group.cycle.endsAt) + 24 * 60 * 60 * 1000 - 1));
    assert.equal(
      (await runCycleSchedulerTick(database, options)).transitions[0].action,
      'premiere',
    );
    setNow(new Date(Date.parse(group.cycle.endsAt) + 24 * 60 * 60 * 1000));
    assert.equal(
      (await runCycleSchedulerTick(database, options)).transitions[0].action,
      'archived',
    );
    assert.equal((await runCycleSchedulerTick(database, options)).transitions.length, 0);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS n FROM media_jobs WHERE cycle_id = ? AND kind = 'film'")
        .get(group.cycle.id).n,
      1,
    );
    assert.equal(getCurrentCycle(database, group.group.id).id, next.id);
    assert.equal((await readFile(film.path)).length > 0, true);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM cycle_lifecycle_events WHERE group_id = ? AND transition = 'revealing_to_archived'",
        )
        .get(group.group.id).n,
      1,
    );
  });
});

test('scheduler does not publish a missing or corrupted ready film and stop cancels idle scans', async () => {
  await fixture(async ({ database, group, config, options, setNow }) => {
    await readyClip(database, group, config.dataDir, new Date(group.cycle.startsAt));
    setNow(group.cycle.endsAt);
    await runCycleSchedulerTick(database, options);
    const film = database
      .prepare("SELECT output_path AS path FROM media_jobs WHERE cycle_id = ? AND kind = 'film'")
      .get(group.cycle.id);
    await writeFile(film.path, 'corrupted synthetic output');
    assert.equal(
      (await runCycleSchedulerTick(database, options)).transitions[0].action,
      'waiting_for_release',
    );
    await rm(film.path);
    assert.equal(
      (await runCycleSchedulerTick(database, options)).transitions[0].action,
      'waiting_for_release',
    );
    assert.equal(
      database
        .prepare('SELECT release_status AS status FROM cycles WHERE id = ?')
        .get(group.cycle.id).status,
      'unpublished',
    );
    let ticks = 0;
    const handle = startCycleSchedulerLoop(database, {
      ...options,
      intervalMs: 50,
      onTick: () => {
        ticks += 1;
      },
    });
    await handle.stop();
    await handle.done;
    const stoppedAt = ticks;
    await new Promise((resolveWait) => setTimeout(resolveWait, 60));
    assert.equal(ticks, stoppedAt);
  });
});

test('bounded scans advance their cursor and invalid limits fail clearly', async () => {
  await fixture(async ({ database, group, account, options, setNow }) => {
    const other = createRealGroup(
      database,
      account,
      { name: 'Second real group', prompt: 'Next memory', maxMembers: 2 },
      new Date(group.cycle.startsAt),
    );
    setNow(group.cycle.endsAt);
    for (const limit of [0, 101, 1.5])
      await assert.rejects(runCycleSchedulerTick(database, { ...options, limit }), RangeError);
    const first = await runCycleSchedulerTick(database, { ...options, limit: 1 });
    assert.equal(first.transitions.length, 1);
    const second = await runCycleSchedulerTick(database, {
      ...options,
      limit: 1,
      cursor: first.cursor,
    });
    assert.equal(second.transitions.length, 1);
    assert.notEqual(first.transitions[0].cycleId, second.transitions[0].cycleId);
    for (const id of [group.group.id, other.group.id])
      assert.equal(
        database.prepare('SELECT COUNT(*) AS n FROM cycles WHERE group_id = ?').get(id).n,
        2,
      );
  });
});

test('ordinary runtime starts automatic real lifecycle without an HTTP request and shuts down its owned loop', async () => {
  await fixture(async ({ database, group, config }) => {
    const now = new Date();
    const start = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
    const end = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    database
      .prepare('UPDATE cycles SET starts_at = ?, ends_at = ? WHERE id = ?')
      .run(start.toISOString(), end.toISOString(), group.cycle.id);
    await readyClip(database, group, config.dataDir, start);
    const child = spawn(process.execPath, ['server/dist/cli.js', 'start'], {
      env: {
        ...process.env,
        REWIND_DATA_DIR: config.dataDir,
        REWIND_HOST: '127.0.0.1',
        REWIND_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    child.stdout.on('data', (bytes) => {
      diagnostics += bytes.toString();
    });
    child.stderr.on('data', (bytes) => {
      diagnostics += bytes.toString();
    });
    const exit = once(child, 'exit');
    try {
      const deadline = Date.now() + 10_000;
      let published = false;
      while (Date.now() < deadline) {
        published =
          database
            .prepare('SELECT release_status AS status FROM cycles WHERE id = ?')
            .get(group.cycle.id).status === 'published';
        if (published || child.exitCode !== null) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      assert.equal(
        published,
        true,
        `automatic runtime did not publish: ${diagnostics.replace(config.dataDir, '[owned-data]')}`,
      );
      assert.notEqual(getCurrentCycle(database, group.group.id).id, group.cycle.id);
    } finally {
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try {
        const [code, signal] = await exit;
        assert.equal(code, 0);
        assert.equal(signal, null);
      } finally {
        clearTimeout(timeout);
      }
    }
  });
});
