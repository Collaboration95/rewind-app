import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const { parseConfig } = await import('../dist/config.js');
const { migrateDatabase, openDatabase, schemaReadiness } = await import('../dist/db.js');
const { applyConsistencyRepair, planConsistencyRepair } =
  await import('../dist/jobs/consistency.js');

async function fixture(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-consistency-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir });
  const processedDir = resolve(dataDir, 'media', 'processed');
  const stagingDir = resolve(dataDir, 'media', 'staging');
  await mkdir(processedDir, { recursive: true });
  await mkdir(stagingDir, { recursive: true });
  const database = openDatabase(config);
  try {
    return await run({ dataDir, processedDir, stagingDir, database });
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function addJob(
  database,
  {
    id,
    kind = 'clip',
    status = 'failed',
    outputPath = null,
    started = null,
    generation = 0,
    cycleId = null,
    contributionId = null,
  },
) {
  database
    .prepare(
      `INSERT INTO media_jobs (id, group_id, cycle_id, contribution_id, kind, status, output_path, created_at,
      processing_started_at, claim_generation, updated_at)
     VALUES (?, 'demo-group', ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, cycleId, contributionId, kind, status, outputPath, started, generation);
}

test('report detects each required inconsistency and does not mutate rows, files, or audits', async () => {
  await fixture(async ({ database, processedDir, stagingDir }) => {
    const missingId = 'job:missing-output';
    const staleId = 'job:stale-claim';
    const danglingFile = resolve(processedDir, 'unreferenced ?.mp4');
    const outsideFile = resolve(processedDir, '..', 'outside.mp4');
    await writeFile(danglingFile, 'orphan');
    await writeFile(outsideFile, 'outside');
    await symlink(outsideFile, resolve(processedDir, 'escape.mp4'));
    addJob(database, {
      id: missingId,
      kind: 'clip',
      status: 'ready',
      outputPath: resolve(processedDir, 'gone.mp4'),
    });
    addJob(database, {
      id: staleId,
      kind: 'film',
      status: 'processing',
      started: '2020-01-01T00:00:00.000Z',
      generation: 9,
    });
    const contribution = database.prepare('SELECT id FROM contributions LIMIT 1').get().id;
    addJob(database, { id: 'job:film', kind: 'clip' });
    addJob(database, { id: 'job:missing-clip', kind: 'film' });
    database
      .prepare(
        `INSERT INTO compilation_job_inputs (job_id, clip_job_id, contribution_id, position)
      VALUES ('job:film', 'job:missing-clip', ?, 0)`,
      )
      .run(contribution);
    database.prepare("UPDATE media_jobs SET kind = 'clip' WHERE id = 'job:film'").run();
    database
      .prepare(
        `INSERT INTO staged_sources
      (source_id, source_uri, idempotency_key_hash, group_id, member_id, source_path, status, created_at)
      SELECT 'source:missing', 'staged://${'a'.repeat(24)}', '${'b'.repeat(32)}', group_id, member_id,
        ?, 'staged', '2026-01-01T00:00:00.000Z' FROM memberships LIMIT 1`,
      )
      .run(resolve(stagingDir, 'gone.mp4'));
    database
      .prepare(
        `INSERT INTO staged_sources
       (source_id, source_uri, idempotency_key_hash, group_id, member_id, source_path, status, created_at, claim_expires_at)
       SELECT 'source:pending', 'staged://${'c'.repeat(24)}', '${'d'.repeat(32)}', group_id, member_id,
         NULL, 'pending', '2026-01-01T00:00:00.000Z', '2026-09-26T00:00:00.000Z' FROM memberships LIMIT 1`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO staged_sources
       (source_id, source_uri, idempotency_key_hash, group_id, member_id, source_path, status, created_at, claim_expires_at)
       SELECT 'source:pending-active', 'staged://${'e'.repeat(24)}', '${'f'.repeat(32)}', group_id, member_id,
         ?, 'pending', '2026-01-01T00:00:00.000Z', '2026-09-26T00:00:00.000Z' FROM memberships LIMIT 1`,
      )
      .run(resolve(stagingDir, 'pending-not-yet-written.mp4'));
    database
      .prepare(
        `INSERT INTO staged_sources
       (source_id, source_uri, idempotency_key_hash, group_id, member_id, source_path, status, created_at, claim_expires_at)
       SELECT 'source:pending-expired', 'staged://${'g'.repeat(24)}', '${'h'.repeat(32)}', group_id, member_id,
         ?, 'pending', '2026-01-01T00:00:00.000Z', '2026-09-24T00:00:00.000Z' FROM memberships LIMIT 1`,
      )
      .run(resolve(stagingDir, 'expired-missing.mp4'));

    const before = database
      .prepare(
        'SELECT id, status, processing_started_at, claim_generation FROM media_jobs ORDER BY id',
      )
      .all();
    const plan = planConsistencyRepair(database, processedDir, stagingDir, {
      now: new Date('2026-09-25T00:00:00.000Z'),
    });
    const kinds = new Set(plan.findings.map((item) => item.kind));
    for (const kind of [
      'missing_output',
      'unreferenced_processed_file',
      'staged_without_file',
      'invalid_compilation_reference',
      'stale_processing_claim',
    ])
      assert.ok(kinds.has(kind), kind);
    assert.ok(
      plan.findings.some(
        (item) => item.kind === 'missing_output' && item.id === 'job_missing-output',
      ),
    );
    assert.ok(
      plan.findings.some(
        (item) => item.kind === 'unreferenced_processed_file' && item.name === 'unreferenced__.mp4',
      ),
    );
    assert.equal(
      plan.findings.find(
        (item) => item.kind === 'unreferenced_processed_file' && item.name === 'unreferenced__.mp4',
      ).repairable,
      false,
    );
    assert.ok(
      plan.findings.some(
        (item) => item.kind === 'staged_without_file' && item.id === 'source_missing',
      ),
    );
    assert.ok(
      !plan.findings.some(
        (item) => item.kind === 'staged_without_file' && item.id === 'source_pending',
      ),
    );
    assert.ok(
      !plan.findings.some(
        (item) => item.kind === 'staged_without_file' && item.id === 'source_pending-active',
      ),
    );
    assert.ok(
      plan.findings.some(
        (item) => item.kind === 'staged_without_file' && item.id === 'source_pending-expired',
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(plan.findings),
      /\/private\/tmp|outside\.mp4|demo-group|secret/i,
    );
    assert.deepEqual(
      database
        .prepare(
          'SELECT id, status, processing_started_at, claim_generation FROM media_jobs ORDER BY id',
        )
        .all(),
      before,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 0);
    assert.equal(await readFile(danglingFile, 'utf8'), 'orphan');
  });
});

test('processed-file candidate checks find references beyond the limited job window', async () => {
  await fixture(async ({ database, processedDir, stagingDir }) => {
    const lateOutput = resolve(processedDir, 'live-output.mp4');
    await writeFile(lateOutput, 'still referenced');
    addJob(database, { id: 'job:a-before-window' });
    addJob(database, { id: 'job:b-before-window' });
    addJob(database, { id: 'job:z-live-reference', status: 'ready', outputPath: lateOutput });
    assert.ok(database.prepare('SELECT 1 FROM media_jobs WHERE output_path = ?').get(lateOutput));
    const plan = planConsistencyRepair(database, processedDir, stagingDir, { limit: 1 });
    assert.ok(
      !plan.findings.some((item) => item.kind === 'unreferenced_processed_file'),
      JSON.stringify(plan.findings),
    );
    assert.equal(plan.files.length, 0);
  });
});

test('compilation audit detects IDs bound to the wrong contribution', async () => {
  await fixture(async ({ database, processedDir, stagingDir }) => {
    const original = database
      .prepare('SELECT id, cycle_id, member_id, quota_window_start_at FROM contributions LIMIT 1')
      .get();
    const alternateContribution = 'contribution:alternate-binding';
    database
      .prepare(
        `INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at, quota_window_start_at)
       VALUES (?, ?, ?, 1, '2026-01-02T00:00:00.000Z', ?)`,
      )
      .run(
        alternateContribution,
        original.cycle_id,
        original.member_id,
        original.quota_window_start_at,
      );
    addJob(database, {
      id: 'job:binding-film',
      kind: 'film',
      status: 'pending',
      cycleId: original.cycle_id,
    });
    addJob(database, {
      id: 'job:binding-clip',
      kind: 'clip',
      status: 'ready',
      cycleId: original.cycle_id,
      contributionId: original.id,
    });
    database
      .prepare(
        `INSERT INTO compilation_job_inputs (job_id, clip_job_id, contribution_id, position)
       VALUES ('job:binding-film', 'job:binding-clip', ?, 0)`,
      )
      .run(alternateContribution);
    const plan = planConsistencyRepair(database, processedDir, stagingDir);
    assert.ok(
      plan.findings.some(
        (item) => item.kind === 'invalid_compilation_reference' && item.id === 'job_binding-film',
      ),
    );
  });
});

test('compilation audit detects a clip bound to another group cycle', async () => {
  await fixture(async ({ database, processedDir, stagingDir }) => {
    const owner = database.prepare('SELECT id, cycle_id FROM contributions LIMIT 1').get();
    const otherGroup = 'group:consistency-other';
    const otherCycle = 'cycle:consistency-other';
    database.prepare('INSERT INTO groups (id, name) VALUES (?, ?)').run(otherGroup, 'Other');
    database
      .prepare(
        `INSERT INTO cycles (id, group_id, prompt, starts_at, ends_at, status, lock_state, max_count, max_seconds)
       VALUES (?, ?, 'prompt', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'archived', 'locked', 5, 30)`,
      )
      .run(otherCycle, otherGroup);
    addJob(database, {
      id: 'job:cross-cycle-film',
      kind: 'film',
      status: 'pending',
      cycleId: owner.cycle_id,
    });
    addJob(database, {
      id: 'job:cross-cycle-clip',
      kind: 'clip',
      status: 'ready',
      cycleId: otherCycle,
      contributionId: owner.id,
    });
    database
      .prepare(
        `INSERT INTO compilation_job_inputs (job_id, clip_job_id, contribution_id, position)
       VALUES ('job:cross-cycle-film', 'job:cross-cycle-clip', ?, 0)`,
      )
      .run(owner.id);
    const plan = planConsistencyRepair(database, processedDir, stagingDir);
    assert.ok(
      plan.findings.some(
        (item) =>
          item.kind === 'invalid_compilation_reference' && item.id === 'job_cross-cycle-film',
      ),
    );
  });
});

test('compilation audit detects a film bound to a different cycle than its clip', async () => {
  await fixture(async ({ database, processedDir, stagingDir }) => {
    const owner = database.prepare('SELECT id, cycle_id FROM contributions LIMIT 1').get();
    const otherCycle = 'cycle:consistency-same-group';
    database
      .prepare(
        `INSERT INTO cycles (id, group_id, prompt, starts_at, ends_at, status, lock_state, max_count, max_seconds)
       VALUES (?, 'demo-group', 'prompt', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'archived', 'locked', 5, 30)`,
      )
      .run(otherCycle);
    addJob(database, {
      id: 'job:different-cycle-film',
      kind: 'film',
      status: 'pending',
      cycleId: otherCycle,
    });
    addJob(database, {
      id: 'job:different-cycle-clip',
      kind: 'clip',
      status: 'ready',
      cycleId: owner.cycle_id,
      contributionId: owner.id,
    });
    database
      .prepare(
        `INSERT INTO compilation_job_inputs (job_id, clip_job_id, contribution_id, position)
       VALUES ('job:different-cycle-film', 'job:different-cycle-clip', ?, 0)`,
      )
      .run(owner.id);
    const plan = planConsistencyRepair(database, processedDir, stagingDir);
    assert.ok(
      plan.findings.some(
        (item) =>
          item.kind === 'invalid_compilation_reference' && item.id === 'job_different-cycle-film',
      ),
    );
  });
});

test('migration 017 preserves audit history and permits consistency repair events', async () => {
  await fixture(async ({ database }) => {
    database
      .prepare(
        `INSERT INTO audit_events (id, event_type, actor_member_id, resource_id, occurred_at, result)
       VALUES ('audit-preserved-session', 'session.created', NULL, 'session:safe-id', '2026-09-25T00:00:00.000Z', 'success'),
              ('audit-preserved-integrity', 'media.integrity_failed', NULL, 'clip:safe-id', '2026-09-25T00:00:01.000Z', 'failure')`,
      )
      .run();
    database.exec(`
      DROP INDEX audit_events_occurred_at_idx;
      DROP INDEX audit_events_resource_id_idx;
      ALTER TABLE audit_events RENAME TO audit_events_old;
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'session.created', 'session.validated', 'session.rejected', 'session.expired',
          'session.invalidated', 'job.started', 'job.completed', 'job.failed', 'media.integrity_failed'
        )),
        actor_member_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
        resource_id TEXT,
        occurred_at TEXT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'denied'))
      );
      INSERT INTO audit_events SELECT * FROM audit_events_old;
      DROP TABLE audit_events_old;
    `);
    database.prepare('DELETE FROM schema_migrations WHERE version = 17').run();
    database
      .prepare('DELETE FROM schema_migration_markers WHERE migration_key = ?')
      .run('consistency-repair-audit-v1');
    migrateDatabase(database);
    assert.equal(schemaReadiness(database).ready, true);
    const rows = database.prepare('SELECT id, event_type FROM audit_events ORDER BY id').all();
    assert.deepEqual(
      rows.map((row) => ({ id: row.id, event_type: row.event_type })),
      [
        { id: 'audit-preserved-integrity', event_type: 'media.integrity_failed' },
        { id: 'audit-preserved-session', event_type: 'session.created' },
      ],
    );
    database
      .prepare(
        `INSERT INTO audit_events (id, event_type, actor_member_id, resource_id, occurred_at, result)
       VALUES ('audit-new-consistency', 'media.consistency_repaired', NULL, NULL, '2026-09-25T00:00:02.000Z', 'success')`,
      )
      .run();
  });
});

test('consistency CLI defaults to read-only JSON report mode', async () => {
  await fixture(async ({ dataDir, database, processedDir }) => {
    const file = resolve(processedDir, 'orphan.mp4');
    await writeFile(file, 'keep');
    const { stdout } = await execFileAsync(
      process.execPath,
      ['server/dist/cli.js', 'consistency', '--json'],
      {
        cwd: resolve(import.meta.dirname, '../..'),
        env: { ...process.env, REWIND_DATA_DIR: dataDir },
      },
    );
    const report = JSON.parse(stdout);
    assert.equal(report.mode, 'report');
    assert.ok(
      report.findings.some(
        (finding) =>
          finding.kind === 'unreferenced_processed_file' && finding.name === 'orphan.mp4',
      ),
    );
    assert.equal(await readFile(file, 'utf8'), 'keep');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 0);
  });
});

test('repair is bounded, audited, generation-fenced, path-contained, and idempotent', async () => {
  await fixture(async ({ database, processedDir, stagingDir }) => {
    const oldJob = 'job:repair-stale';
    const activeJob = 'job:reclaimed';
    const oldFile = resolve(processedDir, 'remove.mp4');
    const outsideFile = resolve(processedDir, '..', 'outside.mp4');
    await writeFile(oldFile, 'orphan');
    const staleTime = new Date('2026-09-20T00:00:00.000Z');
    await utimes(oldFile, staleTime, staleTime);
    await writeFile(outsideFile, 'outside');
    await symlink(outsideFile, resolve(processedDir, 'escape.mp4'));
    addJob(database, {
      id: oldJob,
      kind: 'film',
      status: 'processing',
      started: '2020-01-01T00:00:00.000Z',
      generation: 4,
    });
    addJob(database, {
      id: activeJob,
      kind: 'clip',
      status: 'processing',
      started: '2020-01-01T00:00:00.000Z',
      generation: 7,
    });
    database.prepare('UPDATE media_jobs SET attempt_count = 2 WHERE id = ?').run(oldJob);
    const plan = planConsistencyRepair(database, processedDir, stagingDir, {
      now: new Date('2026-09-25T00:00:00.000Z'),
      limit: 1,
    });
    assert.ok(plan.findings.length <= 1);
    const completePlan = planConsistencyRepair(database, processedDir, stagingDir, {
      now: new Date('2026-09-25T00:00:00.000Z'),
    });
    database
      .prepare(
        `UPDATE media_jobs SET claim_generation = 8, processing_started_at = '2026-09-24T23:59:59.000Z' WHERE id = ?`,
      )
      .run(activeJob);
    const result = applyConsistencyRepair(database, processedDir, completePlan);
    assert.ok(result.repaired.includes('job_repair-stale'));
    assert.ok(result.skipped.includes('job_reclaimed'));
    assert.equal(
      database.prepare('SELECT status FROM media_jobs WHERE id = ?').get(oldJob).status,
      'processing',
    );
    assert.equal(
      database
        .prepare('SELECT status, claim_generation FROM media_jobs WHERE id = ?')
        .get(activeJob).claim_generation,
      8,
    );
    assert.equal(
      database
        .prepare('SELECT claim_generation, attempt_count FROM media_jobs WHERE id = ?')
        .get(oldJob).claim_generation,
      5,
    );
    assert.equal(
      database.prepare('SELECT attempt_count FROM media_jobs WHERE id = ?').get(oldJob)
        .attempt_count,
      2,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'media.consistency_repaired'",
        )
        .get().count,
      2,
      JSON.stringify(database.prepare('SELECT event_type, resource_id FROM audit_events').all()),
    );
    assert.ok(
      database
        .prepare(
          "SELECT 1 FROM audit_events WHERE event_type = 'media.consistency_repaired' AND resource_id LIKE 'file:%:consistency'",
        )
        .get(),
    );
    await assert.rejects(readFile(oldFile));
    assert.equal(await readFile(outsideFile, 'utf8'), 'outside');
    const second = applyConsistencyRepair(database, processedDir, completePlan);
    assert.equal(second.repaired.length, 0);
    const afterRepair = planConsistencyRepair(database, processedDir, stagingDir, {
      now: new Date('2026-09-25T00:00:00.000Z'),
    });
    assert.ok(
      !afterRepair.findings.some(
        (item) => item.id === 'job_reclaimed' || item.id === 'job_repair-stale',
      ),
    );
  });
});

test('a failed database commit restores quarantined files and rolls back their audit rows', async () => {
  await fixture(async ({ database, processedDir, stagingDir }) => {
    const orphan = resolve(processedDir, 'rollback-orphan.mp4');
    await writeFile(orphan, 'restore me');
    const staleTime = new Date('2026-09-20T00:00:00.000Z');
    await utimes(orphan, staleTime, staleTime);
    const plan = planConsistencyRepair(database, processedDir, stagingDir, {
      now: new Date('2026-09-25T00:00:00.000Z'),
    });
    database.exec(`
      CREATE TABLE consistency_commit_failure (
        id TEXT PRIMARY KEY,
        member_id TEXT REFERENCES profiles(id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE TRIGGER fail_consistency_commit AFTER INSERT ON audit_events
      WHEN NEW.resource_id LIKE 'file:%:consistency'
      BEGIN
        INSERT INTO consistency_commit_failure (id, member_id)
        VALUES ('deferred-invalid-owner', 'missing-member');
      END;
    `);

    assert.throws(() => applyConsistencyRepair(database, processedDir, plan), /FOREIGN KEY/i);
    assert.equal(await readFile(orphan, 'utf8'), 'restore me');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 0);
  });
});
