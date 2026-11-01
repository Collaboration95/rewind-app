import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';
import { withDatabase as withSharedDatabase } from './helpers/runtime.mjs';

const { parseConfig } = await import('../dist/config.js');
const {
  contributionQuotaWindow,
  deleteContribution,
  MAX_CONTRIBUTION_COUNT,
  MAX_CONTRIBUTION_SECONDS,
} = await import('../dist/contributions/index.js');
const {
  cancelClipUpload,
  claimStagedSource,
  createClipUpload,
  findStagedSource,
  markStagedSourceReady,
  recordClipMediaMetadata,
  stagedSourceId,
} = await import('../dist/media/index.js');

const validInput = {
  sourceUri: 'file:///tmp/clip.mp4',
  mimeType: 'video/mp4',
  byteLength: 1024,
  durationSeconds: 6,
  width: 720,
  height: 1280,
  hasAudio: true,
};

const withDatabase = (run) =>
  withSharedDatabase(
    {
      prefix: 'rewind-contribution-policy-',
      setup: (database) =>
        database.exec(
          "DELETE FROM contribution_quota_windows; DELETE FROM contributions WHERE id = 'demo-contribution';",
        ),
    },
    run,
  );

function registerMetadata(database, input = validInput) {
  recordClipMediaMetadata(database, {
    sourceUri: input.sourceUri,
    mimeType: 'video/mp4',
    byteLength: input.byteLength,
    durationSeconds: input.durationSeconds,
    width: input.width,
    height: input.height,
    hasAudio: true,
  });
}

test('weekly allowance is anchored to the cycle start and resets at seven days', () => {
  const cycle = {
    startsAt: '2026-09-01T12:00:00.000Z',
    endsAt: '2026-09-20T12:00:00.000Z',
  };
  assert.deepEqual(contributionQuotaWindow(cycle, '2026-09-08T11:59:59.999Z'), {
    startsAt: '2026-09-01T12:00:00.000Z',
    endsAt: '2026-09-08T12:00:00.000Z',
  });
  assert.deepEqual(contributionQuotaWindow(cycle, '2026-09-08T12:00:00.000Z'), {
    startsAt: '2026-09-08T12:00:00.000Z',
    endsAt: '2026-09-15T12:00:00.000Z',
  });
});

test('clip submissions enforce five clips and thirty seconds per member window', async () => {
  await withDatabase(async ({ database }) => {
    registerMetadata(database);
    const now = new Date('2026-09-08T00:00:00.000Z');
    for (let index = 0; index < MAX_CONTRIBUTION_COUNT; index += 1) {
      const result = createClipUpload(
        database,
        'demo-group',
        'demo-1',
        { ...validInput, idempotencyKey: `quota-clip-${index}`, durationSeconds: 6 },
        now,
      );
      assert.equal(result.ok, true);
    }
    assert.deepEqual(
      createClipUpload(
        database,
        'demo-group',
        'demo-1',
        { ...validInput, idempotencyKey: 'quota-clip-sixth', durationSeconds: 1 },
        now,
      ),
      { ok: false, reason: 'quota_exceeded' },
    );
    const ledger = database
      .prepare(
        `SELECT count_used AS countUsed, seconds_used AS secondsUsed
         FROM contribution_quota_windows WHERE window_start_at = '2026-09-08T00:00:00.000Z'`,
      )
      .get();
    assert.deepEqual({ ...ledger }, { countUsed: 5, secondsUsed: MAX_CONTRIBUTION_SECONDS - 0 });

    // A different member has an independent server-side allowance.
    const otherMember = createClipUpload(
      database,
      'demo-group',
      'demo-2',
      { ...validInput, idempotencyKey: 'quota-other-member', durationSeconds: 15 },
      now,
    );
    assert.equal(otherMember.ok, true);
  });
});

test('one current-week deletion tombstones media, restores exact allowance, and permits replacement', async () => {
  await withDatabase(async ({ database, dataDir }) => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const sourceUri = 'file:///tmp/delete-me.mp4';
    registerMetadata(database, { ...validInput, sourceUri, durationSeconds: 7 });
    const upload = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      { ...validInput, sourceUri, durationSeconds: 7, idempotencyKey: 'delete-policy-key' },
      now,
    );
    assert.equal(upload.ok, true);
    if (!upload.ok) return;
    const outputDir = `${dataDir}/media/processed`;
    const outputPath = `${outputDir}/deleted-output.mp4`;
    await writeFile(outputPath, 'private processed bytes').catch(async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(outputDir, { recursive: true });
      await writeFile(outputPath, 'private processed bytes');
    });
    database
      .prepare("UPDATE media_jobs SET status = 'ready', output_path = ? WHERE id = ?")
      .run(outputPath, upload.upload.job.id);

    assert.deepEqual(
      deleteContribution(database, 'demo-group', 'demo-1', upload.upload.contribution.id, now, {
        outputDir,
      }),
      {
        ok: true,
        contributionId: upload.upload.contribution.id,
        jobId: upload.upload.job.id,
        restored: { count: 1, seconds: 7 },
      },
    );
    assert.equal(
      database
        .prepare('SELECT deleted_at AS deletedAt FROM contributions WHERE id = ?')
        .get(upload.upload.contribution.id).deletedAt !== null,
      true,
    );
    assert.equal(
      database.prepare('SELECT status FROM media_jobs WHERE id = ?').get(upload.upload.job.id)
        .status,
      'deleted',
    );
    assert.equal(
      database.prepare('SELECT count_used FROM cycles WHERE id = ?').get('demo-cycle').count_used,
      0,
    );
    assert.equal(
      database
        .prepare('SELECT seconds_used, deletions_used FROM contribution_quota_windows LIMIT 1')
        .get().seconds_used,
      0,
    );

    const replacement = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      {
        ...validInput,
        sourceUri: 'file:///tmp/replacement.mp4',
        idempotencyKey: 'replacement-key',
      },
      now,
    );
    assert.equal(replacement.ok, true);
    assert.equal(
      database.prepare('SELECT deletions_used FROM contribution_quota_windows LIMIT 1').get()
        .deletions_used,
      1,
    );
    assert.equal(
      await import('node:fs/promises').then(({ access }) =>
        access(outputPath).then(
          () => true,
          () => false,
        ),
      ),
      false,
    );
  });
});

test('second deletion in the same weekly window and post-reveal deletion are denied', async () => {
  await withDatabase(async ({ database }) => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const first = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      { ...validInput, idempotencyKey: 'delete-first-key' },
      now,
    );
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(
      deleteContribution(database, 'demo-group', 'demo-1', first.upload.contribution.id, now).ok,
      true,
    );
    const second = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      {
        ...validInput,
        sourceUri: 'file:///tmp/delete-second.mp4',
        idempotencyKey: 'delete-second-key',
      },
      now,
    );
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.deepEqual(
      deleteContribution(database, 'demo-group', 'demo-1', second.upload.contribution.id, now),
      { ok: false, reason: 'deletion_used' },
    );
    database.prepare("UPDATE cycles SET status = 'revealing' WHERE id = 'demo-cycle'").run();
    assert.deepEqual(
      deleteContribution(database, 'demo-group', 'demo-1', second.upload.contribution.id, now),
      { ok: false, reason: 'not_eligible' },
    );
  });
});

test('processing contributions cannot be deleted while a worker owns the job', async () => {
  await withDatabase(async ({ database }) => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const upload = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      { ...validInput, idempotencyKey: 'delete-processing-key' },
      now,
    );
    assert.equal(upload.ok, true);
    if (!upload.ok) return;
    database
      .prepare("UPDATE media_jobs SET status = 'processing' WHERE id = ?")
      .run(upload.upload.job.id);
    assert.deepEqual(
      deleteContribution(database, 'demo-group', 'demo-1', upload.upload.contribution.id, now),
      { ok: false, reason: 'processing' },
    );
    assert.equal(
      database
        .prepare('SELECT deleted_at FROM contributions WHERE id = ?')
        .get(upload.upload.contribution.id).deleted_at,
      null,
    );
  });
});

test('idempotent retries consume one allowance and persisted state survives reopen', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-contribution-retry-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  let database = openFixtureDatabase(config);
  try {
    database.exec(
      "DELETE FROM contribution_quota_windows; DELETE FROM contributions WHERE id = 'demo-contribution';",
    );
    registerMetadata(database, { ...validInput, durationSeconds: 8 });
    const first = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      { ...validInput, idempotencyKey: 'quota-retry-1', durationSeconds: 8 },
      new Date('2026-09-09T00:00:00.000Z'),
    );
    assert.equal(first.ok, true);
    const retry = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      { ...validInput, idempotencyKey: 'quota-retry-1', durationSeconds: 15 },
      new Date('2026-09-09T00:00:01.000Z'),
    );
    assert.equal(retry.ok, true);
    if (!retry.ok) return;
    assert.equal(retry.upload.existing, true);
    database.close();
    database = openFixtureDatabase(config);
    const ledger = database
      .prepare(
        'SELECT count_used AS countUsed, seconds_used AS secondsUsed FROM contribution_quota_windows',
      )
      .get();
    assert.deepEqual({ ...ledger }, { countUsed: 1, secondsUsed: 8 });
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the thirty-second limit is independent from the five-clip limit', async () => {
  await withDatabase(async ({ database }) => {
    registerMetadata(database, { ...validInput, durationSeconds: 15 });
    const now = new Date('2026-09-09T00:00:00.000Z');
    for (const [index, durationSeconds] of [1, 15].entries()) {
      assert.equal(
        createClipUpload(
          database,
          'demo-group',
          'demo-1',
          { ...validInput, idempotencyKey: `quota-seconds-${index}`, durationSeconds },
          now,
        ).ok,
        true,
      );
    }
    assert.deepEqual(
      createClipUpload(
        database,
        'demo-group',
        'demo-1',
        { ...validInput, idempotencyKey: 'quota-seconds-over', durationSeconds: 1 },
        now,
      ),
      { ok: false, reason: 'quota_exceeded' },
    );
  });
});

test('duration above fifteen seconds is rejected before policy state is written', async () => {
  await withDatabase(async ({ database }) => {
    registerMetadata(database);
    const result = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      { ...validInput, idempotencyKey: 'quota-too-long', durationSeconds: 15.01 },
      new Date('2026-09-09T00:00:00.000Z'),
    );
    assert.deepEqual(result, { ok: false, reason: 'invalid_media' });
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM contribution_quota_windows').get().count,
      0,
    );
  });
});

test('quota uses verified server metadata when a client submits a shorter duration hint', async () => {
  await withDatabase(async ({ database }) => {
    registerMetadata(database, { ...validInput, durationSeconds: 14 });
    const result = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      { ...validInput, idempotencyKey: 'quota-duration-bypass', durationSeconds: 1 },
      new Date('2026-09-09T00:00:00.000Z'),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.upload.contribution.durationSeconds, 14);
    assert.equal(
      database.prepare('SELECT seconds_used AS secondsUsed FROM contribution_quota_windows').get()
        .secondsUsed,
      14,
    );
  });
});

test('trim bounds use verified FFprobe duration rather than a client source-duration hint', async () => {
  await withDatabase(async ({ database }) => {
    const key = 'verified-trim-bound';
    const sourceUri = `staged://${stagedSourceId(key)}`;
    const claimed = claimStagedSource(database, 'demo-group', 'demo-1', key);
    assert.equal(claimed.ok, true);
    markStagedSourceReady(database, sourceUri, 1000, '/tmp/verified-trim-bound.mp4');
    recordClipMediaMetadata(database, {
      sourceUri,
      mimeType: 'video/mp4',
      byteLength: 1000,
      durationSeconds: 2,
      width: 180,
      height: 320,
      hasAudio: true,
    });
    const accepted = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      {
        ...validInput,
        idempotencyKey: key,
        sourceUri,
        byteLength: 1000,
        durationSeconds: 1.25,
        width: 180,
        height: 320,
        trimStartSeconds: 0.25,
        trimEndSeconds: 1.5,
        sourceDurationSeconds: 1,
      },
      new Date('2026-09-09T00:00:00.000Z'),
      { stagingDir: '/tmp', requireVerifiedMetadata: true },
    );
    assert.equal(accepted.ok, true);
    const longKey = 'verified-trim-bound-too-long';
    const longSourceUri = `staged://${stagedSourceId(longKey)}`;
    assert.equal(claimStagedSource(database, 'demo-group', 'demo-1', longKey).ok, true);
    markStagedSourceReady(database, longSourceUri, 1000, '/tmp/verified-trim-bound-too-long.mp4');
    recordClipMediaMetadata(database, {
      sourceUri: longSourceUri,
      mimeType: 'video/mp4',
      byteLength: 1000,
      durationSeconds: 2,
      width: 180,
      height: 320,
      hasAudio: true,
    });
    const rejected = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      {
        ...validInput,
        idempotencyKey: 'verified-trim-bound-too-long',
        sourceUri: longSourceUri,
        byteLength: 1000,
        durationSeconds: 2.25,
        width: 180,
        height: 320,
        trimStartSeconds: 0.25,
        trimEndSeconds: 2.5,
        sourceDurationSeconds: 99,
      },
      new Date('2026-09-09T00:00:00.000Z'),
      { stagingDir: '/tmp', requireVerifiedMetadata: true },
    );
    assert.deepEqual(rejected, { ok: false, reason: 'invalid_media' });
  });
});

test('staged source capabilities are owner-bound and cannot be replaced', async () => {
  await withDatabase(async ({ database }) => {
    const first = claimStagedSource(database, 'demo-group', 'demo-1', 'source-owner-key');
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.existing, false);
    const retry = claimStagedSource(database, 'demo-group', 'demo-1', 'source-owner-key');
    assert.equal(retry.ok, true);
    if (!retry.ok) return;
    assert.equal(retry.existing, true);
    assert.deepEqual(claimStagedSource(database, 'demo-group', 'demo-2', 'source-owner-key'), {
      ok: false,
      reason: 'conflict',
    });
    markStagedSourceReady(database, first.source.sourceUri, 1234);
    const stable = findStagedSource(database, first.source.sourceUri);
    assert.equal(stable?.byteLength, 1234);
    assert.equal(stable?.memberId, 'demo-1');
    assert.equal(stable?.sourceId, stagedSourceId('source-owner-key'));
    recordClipMediaMetadata(database, {
      sourceUri: first.source.sourceUri,
      mimeType: 'video/mp4',
      byteLength: 1234,
      durationSeconds: 6,
      width: 720,
      height: 1280,
      hasAudio: true,
    });
    assert.deepEqual(
      createClipUpload(
        database,
        'demo-group',
        'demo-2',
        { ...validInput, sourceUri: first.source.sourceUri, idempotencyKey: 'source-owner-key' },
        new Date('2026-09-09T00:00:00.000Z'),
      ),
      { ok: false, reason: 'not_found' },
    );
  });
});

test('a transient SQLite writer lock retries and same-key submissions remain idempotent', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-contribution-busy-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openFixtureDatabase(config);
  const input = { ...validInput, idempotencyKey: 'quota-busy-retry' };
  registerMetadata(database);
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     const { openDatabaseAt } = require(require('node:path').resolve('server/dist/db.js'));
     const db = openDatabaseAt(workerData.databasePath);
     db.exec('BEGIN IMMEDIATE');
     parentPort.postMessage('locked');
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
     db.exec('COMMIT');
     const { createClipUpload } = require(workerData.mediaModule);
     const result = createClipUpload(db, 'demo-group', 'demo-1', workerData.input,
       new Date('2026-09-09T00:00:00.000Z'));
     parentPort.postMessage({ result });
     db.close();`,
    {
      eval: true,
      workerData: {
        databasePath: config.databasePath,
        mediaModule: `${process.cwd()}/server/dist/media/index.js`,
        input,
      },
    },
  );
  try {
    await new Promise((resolve, reject) => {
      worker.once('message', (message) => (message === 'locked' ? resolve() : undefined));
      worker.once('error', reject);
    });
    const mainResult = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      input,
      new Date('2026-09-09T00:00:00.000Z'),
    );
    const workerResult = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    assert.equal(mainResult.ok, true);
    assert.equal(workerResult.result.ok, true);
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM contributions WHERE id LIKE ?')
        .get('contribution-%').count,
      1,
    );
    assert.equal(
      mainResult.ok &&
        workerResult.result.ok &&
        mainResult.upload.existing !== workerResult.result.upload.existing,
      true,
    );
    const job = database
      .prepare("SELECT id FROM media_jobs WHERE kind = 'clip' AND status = 'pending'")
      .get();
    const cancelLock = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       const { openDatabaseAt } = require(require('node:path').resolve('server/dist/db.js'));
       const db = openDatabaseAt(workerData.databasePath);
       db.exec('BEGIN IMMEDIATE');
       parentPort.postMessage('locked');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
       db.exec('COMMIT');
       db.close();`,
      { eval: true, workerData: { databasePath: config.databasePath } },
    );
    await new Promise((resolve, reject) => {
      cancelLock.once('message', (message) => (message === 'locked' ? resolve() : undefined));
      cancelLock.once('error', reject);
    });
    const cancellation = cancelClipUpload(database, 'demo-group', 'demo-1', job.id);
    assert.equal(cancellation.ok, true);
    await cancelLock.terminate();
  } finally {
    await worker.terminate();
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
