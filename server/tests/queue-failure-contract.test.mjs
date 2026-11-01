import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { listQueueJobs, QueueQueryError } from '../dist/jobs/queue.js';
import { withBoundaryRuntime } from './helpers/boundary-runtime.mjs';

const execFileAsync = promisify(execFile);

async function withQueue(run) {
  await withBoundaryRuntime(async (c) => {
    const owner = await c.account('queue-contract-owner');
    const group = await c.group(owner);
    const other = await c.group(owner, { name: 'Other queue' });
    const insert = c.database.prepare(`INSERT INTO media_jobs
      (id, group_id, kind, status, created_at, updated_at, error_code, attempt_count, progress, output_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [id, kind, status, code, attempts] of [
      ['a-invalid', 'clip', 'failed', 'invalid_metadata', 1],
      ['b-source', 'clip', 'failed', 'source_unavailable', 3],
      ['c-process', 'film', 'failed', 'process_failed', 2],
      ['d-cleanup', 'film', 'failed', 'cleanup_failed', 3],
      ['e-unknown', 'film', 'failed', 'private error /secret/input.mp4', 3],
      ['f-processing', 'film', 'processing', null, 1],
      ['g-pending', 'clip', 'pending', null, 0],
      ['h-ready', 'clip', 'ready', null, 1],
      ['i-download', 'download', 'pending', null, 0],
    ])
      insert.run(
        id,
        group.group.id,
        kind,
        status,
        c.now().toISOString(),
        c.now().toISOString(),
        code,
        attempts,
        40,
        '/secret/output.mp4',
      );
    insert.run(
      'foreign-failure',
      other.group.id,
      'clip',
      'failed',
      c.now().toISOString(),
      c.now().toISOString(),
      'source_unavailable',
      1,
      0,
      '/secret/foreign.mp4',
    );
    const query = (options = {}) =>
      listQueueJobs(c.database, { groupId: group.group.id, ...options });
    const cli = (...args) =>
      execFileAsync(process.execPath, ['server/dist/cli.js', ...args], {
        env: { ...process.env, REWIND_DATA_DIR: c.dataDir },
        timeout: 20000,
      });
    await run({ ...c, group, other, query, cli });
  });
}

test('queue failures expose safe categories and distinguish manual clip retries from exhausted films', async () => {
  await withQueue(async (c) => {
    const failed = c.query({ status: 'failed' });
    assert.deepEqual(
      failed.jobs.map(({ id, failureCategory, retryable }) => ({ id, failureCategory, retryable })),
      [
        { id: 'a-invalid', failureCategory: 'invalid_metadata', retryable: true },
        { id: 'b-source', failureCategory: 'source_unavailable', retryable: true },
        { id: 'c-process', failureCategory: 'processing_failed', retryable: true },
        { id: 'd-cleanup', failureCategory: 'processing_failed', retryable: false },
        { id: 'e-unknown', failureCategory: 'unknown', retryable: false },
      ],
    );
    assert.doesNotMatch(JSON.stringify(failed), /secret|output_path|error_code|foreign-failure/);
    const active = c.query();
    assert.equal(active.jobs.length, 7);
    assert.equal(active.jobs.find(({ id }) => id === 'f-processing').retryable, false);
    assert.equal(active.jobs.find(({ id }) => id === 'g-pending').retryable, true);
    assert.equal(active.jobs.find(({ id }) => id === 'f-processing').failureCategory, null);
    assert.deepEqual(c.query({ kind: 'film', status: 'pending' }).jobs, []);
  });
});

test('queue cursors cannot be reused across groups or filters, and equal timestamps page without gaps', async () => {
  await withQueue(async (c) => {
    const first = c.query({ kind: 'clip', status: 'failed', limit: 1 });
    assert.equal(first.jobs[0].id, 'a-invalid');
    assert.equal(first.pagination.hasMore, true);
    const cursor = first.pagination.nextCursor;
    const last = c.query({ kind: 'clip', status: 'failed', limit: 1, cursor });
    assert.deepEqual(
      last.jobs.map(({ id }) => id),
      ['b-source'],
    );
    assert.equal(last.pagination.hasMore, false);
    assert.equal(last.pagination.nextCursor, null);
    for (const options of [
      { groupId: c.other.group.id, kind: 'clip', status: 'failed', cursor },
      { kind: 'film', status: 'failed', cursor },
      { kind: 'clip', status: 'processing', cursor },
      { cursor: 'x'.repeat(513) },
      { cursor: Buffer.from(JSON.stringify({ version: 2 })).toString('base64url') },
      { groupId: '' },
    ])
      assert.throws(() => c.query(options), QueueQueryError);
    const { stdout } = await c.cli(
      'queue',
      '--group',
      c.group.group.id,
      '--kind',
      'clip',
      '--status',
      'failed',
      '--limit',
      '1',
      '--cursor',
      cursor,
      '--json',
    );
    assert.deepEqual(JSON.parse(stdout).jobs, last.jobs);
    assert.doesNotMatch(stdout, /secret|foreign-failure/);
  });
});

test('queue CLI refuses invalid kinds, statuses and unbounded pages with a nonzero exit', async () => {
  await withQueue(async (c) => {
    for (const [args, message] of [
      [[], /requires a group/],
      [['--kind', 'download'], /kind must be clip or film/],
      [['--status', 'ready'], /status must be pending, processing, or failed/],
      [['--limit', '0'], /limit must be an integer from 1 to 100/],
      [['--limit', '101'], /limit must be an integer from 1 to 100/],
      [['--limit', '1.5'], /limit must be an integer from 1 to 100/],
      [['--cursor', 'not-json'], /cursor is invalid/],
    ]) {
      const command = args.length ? ['jobs', '--group', c.group.group.id, ...args] : ['jobs'];
      await assert.rejects(c.cli(...command, '--json'), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, message);
        assert.equal(error.stdout, '');
        assert.doesNotMatch(error.stderr, /secret\/input|secret\/output/);
        return true;
      });
    }
    assert.equal(c.query().jobs.length, 7);
    const { stdout } = await c.cli(
      'jobs',
      '--group-id',
      c.group.group.id,
      '--status',
      'failed',
      '--limit',
      '1',
    );
    assert.match(stdout, /clip failed id=a-invalid attempts=1 progress=40% retryable=true/);
    assert.match(stdout, /More jobs are available/);
    assert.doesNotMatch(stdout, /secret/);
  });
});
