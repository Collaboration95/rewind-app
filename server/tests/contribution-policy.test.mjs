import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase, openDatabaseAt, restoreFixture, seedDatabase } =
  await import('../dist/db.js');
const { contributionQuotaWindow, MAX_CONTRIBUTION_COUNT, MAX_CONTRIBUTION_SECONDS } =
  await import('../dist/contributions/index.js');
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

async function withDatabase(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-contribution-policy-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  try {
    return await run({ config, database });
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

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

test('upgrading a v005 database backfills the cycle-start quota ledger', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-contribution-upgrade-`);
  const databasePath = `${dataDir}/rewind.sqlite`;
  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec('PRAGMA foreign_keys = ON;');
    for (const [index, name] of [
      '001-initial.sql',
      '002-session-audit.sql',
      '003-cycle-controls.sql',
      '004-invites.sql',
      '005-media-idempotency.sql',
    ].entries()) {
      legacy.exec(await readFile(`server/migrations/${name}`, 'utf8'));
      legacy
        .prepare(
          'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
        )
        .run();
      legacy
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(index + 1, new Date().toISOString());
    }
    seedDatabase(legacy);
    legacy
      .prepare(
        `INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
         VALUES ('legacy-contribution', 'demo-cycle', 'demo-1', 7, '2026-09-02T00:00:00.000Z')`,
      )
      .run();
    legacy
      .prepare('UPDATE cycles SET count_used = 1, seconds_used = 7 WHERE id = ?')
      .run('demo-cycle');
    legacy.close();

    const upgraded = openDatabaseAt(databasePath);
    try {
      assert.deepEqual(
        upgraded
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all()
          .map((row) => row.version),
        [1, 2, 3, 4, 5, 6, 7],
      );
      const rows = upgraded
        .prepare(
          `SELECT window_start_at AS startsAt, window_end_at AS endsAt,
              count_used AS countUsed, seconds_used AS secondsUsed
           FROM contribution_quota_windows
           WHERE cycle_id = 'demo-cycle' AND member_id = 'demo-1'`,
        )
        .all();
      assert.deepEqual(
        rows.map((row) => ({ ...row })),
        [
          {
            startsAt: '2026-09-01T00:00:00.000Z',
            endsAt: '2026-09-08T00:00:00.000Z',
            countUsed: 2,
            secondsUsed: 10,
          },
        ],
      );
      assert.equal(
        upgraded
          .prepare('SELECT quota_window_start_at AS windowStart FROM contributions WHERE id = ?')
          .get('legacy-contribution').windowStart,
        '2026-09-01T00:00:00.000Z',
      );
    } finally {
      upgraded.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a legacy media-only v6 is repaired without losing its media schema', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-contribution-media-v6-`);
  const databasePath = `${dataDir}/rewind.sqlite`;
  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec('PRAGMA foreign_keys = ON;');
    for (const [index, name] of [
      '001-initial.sql',
      '002-session-audit.sql',
      '003-cycle-controls.sql',
      '004-invites.sql',
      '005-media-idempotency.sql',
    ].entries()) {
      legacy.exec(await readFile(`server/migrations/${name}`, 'utf8'));
      legacy
        .prepare(
          'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
        )
        .run();
      legacy
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(index + 1, new Date().toISOString());
    }
    legacy.exec(
      `ALTER TABLE media_jobs ADD COLUMN source_path TEXT;
       ALTER TABLE media_jobs ADD COLUMN trim_start_seconds REAL;
       ALTER TABLE media_jobs ADD COLUMN trim_end_seconds REAL;
       ALTER TABLE media_jobs ADD COLUMN mode TEXT;
       ALTER TABLE media_jobs ADD COLUMN error_code TEXT;`,
    );
    legacy
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)')
      .run(new Date().toISOString());
    seedDatabase(legacy);
    legacy.close();

    const upgraded = openDatabaseAt(databasePath);
    try {
      assert.equal(
        upgraded
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contribution_quota_windows'",
          )
          .get()?.['1'],
        1,
      );
      assert.equal(
        upgraded.prepare('SELECT source_path FROM media_jobs LIMIT 1').get().source_path,
        null,
      );
      assert.deepEqual(
        upgraded
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all()
          .map((row) => row.version),
        [1, 2, 3, 4, 5, 6, 7],
      );
    } finally {
      upgraded.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
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
        'SELECT count_used AS countUsed, seconds_used AS secondsUsed FROM contribution_quota_windows',
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

test('idempotent retries consume one allowance and persisted state survives reopen', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-contribution-retry-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  let database = openDatabase(config);
  try {
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
    database = openDatabase(config);
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

test('demo reset clears quota and verified metadata so stale sources cannot be reused', async () => {
  await withDatabase(async ({ database }) => {
    registerMetadata(database);
    const result = createClipUpload(
      database,
      'demo-group',
      'demo-1',
      { ...validInput, idempotencyKey: 'quota-reset-stale' },
      new Date('2026-09-09T00:00:00.000Z'),
    );
    assert.equal(result.ok, true);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM media_metadata').get().count, 1);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM contribution_quota_windows').get().count,
      1,
    );
    restoreFixture(database);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM media_metadata').get().count, 0);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM contribution_quota_windows').get().count,
      0,
    );
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
  const database = openDatabase(config);
  const input = { ...validInput, idempotencyKey: 'quota-busy-retry' };
  registerMetadata(database);
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     const { DatabaseSync } = require('node:sqlite');
     const db = new DatabaseSync(workerData.databasePath);
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
       const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(workerData.databasePath);
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
