import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createDemoSession, invalidateDemoSession, getDemoSession, validateDemoSession } =
  await import('../dist/session/index.js');
const { listAuditEvents, recordAuditEvent } = await import('../dist/audit/index.js');
const { runAuditedJob } = await import('../dist/jobs/index.js');

async function withDatabase(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-session-audit-test-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
  });
  const database = openDatabase(config);
  try {
    return await run({ config, database });
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('demo sessions persist a stable synthetic actor and enforce a bounded lifecycle', async () => {
  await withDatabase(async ({ database }) => {
    const startedAt = new Date('2026-09-10T12:00:00.000Z');
    const created = createDemoSession(database, {
      memberId: 'demo-1',
      groupId: 'demo-group',
      now: startedAt,
      sessionId: 'demo-session-contract',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.deepEqual(created.session.actor, {
      memberId: 'demo-1',
      displayName: 'Amber',
      isSynthetic: true,
    });
    assert.equal(created.session.accessKind, 'demo');
    assert.equal(created.session.expiresAt, '2026-09-10T20:00:00.000Z');
    assert.deepEqual(getDemoSession(database, created.session.id), created.session);

    const valid = validateDemoSession(
      database,
      created.session.id,
      new Date('2026-09-10T19:59:59.999Z'),
    );
    assert.equal(valid.status, 'valid');
    const expired = validateDemoSession(
      database,
      created.session.id,
      new Date('2026-09-10T20:00:00.000Z'),
    );
    assert.equal(expired.status, 'expired');
    assert.equal(expired.reason, 'expired');

    assert.deepEqual(createDemoSession(database, { memberId: 'demo-outsider' }), {
      ok: false,
      reason: 'unknown_member',
    });
  });
});

test('demo session invalidation is persisted and terminal', async () => {
  await withDatabase(async ({ database }) => {
    const created = createDemoSession(database, {
      memberId: 'demo-2',
      now: new Date('2026-09-10T12:00:00.000Z'),
      sessionId: 'demo-session-invalidate',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const invalidated = invalidateDemoSession(
      database,
      created.session.id,
      new Date('2026-09-10T12:01:00.000Z'),
    );
    assert.equal(invalidated.ok, true);
    if (!invalidated.ok) return;
    assert.equal(invalidated.session.invalidatedAt, '2026-09-10T12:01:00.000Z');
    assert.equal(validateDemoSession(database, created.session.id).status, 'invalidated');
    const again = invalidateDemoSession(database, created.session.id);
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'already_invalidated');
  });
});

test('audit events structurally redact arbitrary text and correlate failed jobs safely', async () => {
  await withDatabase(async ({ config, database }) => {
    recordAuditEvent(database, {
      eventType: 'job.failed',
      actorMemberId: 'demo-1',
      resourceId: 'job:demo-job-7',
      timestamp: '2026-09-10T12:00:00.000Z',
      result: 'failure',
    });
    recordAuditEvent(database, {
      eventType: 'job.failed',
      actorMemberId: 'private actor',
      resourceId: '/private/media/invite-code-secret.mp4',
      timestamp: '2026-09-10T12:01:00.000Z',
      result: 'failure',
    });

    await assert.rejects(
      runAuditedJob(database, {
        jobId: 'render-7',
        actorMemberId: 'demo-1',
        run: () => {
          throw new Error('private media path /private/media/clip.mp4 invite-code-secret');
        },
      }),
    );

    const events = listAuditEvents(database);
    const failedJobEvents = events.filter((event) => event.resourceId === 'job:render-7');
    assert.deepEqual(failedJobEvents.map((event) => event.eventType).sort(), [
      'job.failed',
      'job.started',
    ]);
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, /private media|invite-code-secret|\.mp4/);
    assert.equal(
      events.find((event) => event.resourceId === 'job:demo-job-7').actorMemberId,
      'demo-1',
    );
    assert.equal(
      events.find((event) => event.timestamp === '2026-09-10T12:01:00.000Z').resourceId,
      null,
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      ['server/dist/cli.js', 'diagnostics', '--json', '--limit', '2'],
      {
        cwd: process.cwd(),
        env: { ...process.env, REWIND_DATA_DIR: config.dataDir },
      },
    );
    const report = JSON.parse(stdout);
    assert.equal(report.events.length, 2);
    assert.equal(
      report.events.every((event) => !('details' in event)),
      true,
    );
  });
});
