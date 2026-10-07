import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { parseConfig } from '../dist/config.js';
import {
  capacityFromStatfs,
  filesystemCapacity,
} from '../dist/observability/filesystem-capacity.js';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';
import { sqliteOnly } from './helpers/dialect.mjs';

const execFileAsync = promisify(execFile);
const unknown = { state: 'unavailable', totalBytes: null, availableBytes: null };

test('capacity uses unprivileged available blocks and retains measured zero availability', () => {
  const stats = { bsize: 4096n, blocks: 100n, bfree: 40n, bavail: 25n };
  assert.deepEqual(capacityFromStatfs(stats), {
    state: 'available',
    totalBytes: 409600,
    availableBytes: 102400,
  });
  assert.deepEqual(capacityFromStatfs({ ...stats, bavail: 0n }), {
    state: 'available',
    totalBytes: 409600,
    availableBytes: 0,
  });
  assert.deepEqual(
    capacityFromStatfs({ bsize: 1n, blocks: BigInt(Number.MAX_SAFE_INTEGER), bavail: 1n }),
    {
      state: 'available',
      totalBytes: Number.MAX_SAFE_INTEGER,
      availableBytes: 1,
    },
  );
});

test('invalid metadata and unsafe byte arithmetic remain unavailable instead of rounding or clamping', () => {
  const valid = { bsize: 4096n, blocks: 100n, bavail: 25n };
  for (const invalid of [
    null,
    {},
    'secret-path',
    { ...valid, bsize: 4096 },
    { ...valid, bsize: 0n },
    { ...valid, bsize: -1n },
    { ...valid, blocks: -1n },
    { ...valid, blocks: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, bavail: NaN },
    { ...valid, bavail: 1.5 },
    { ...valid, bavail: -1n },
    { ...valid, bavail: 101n },
    { bsize: 1n, blocks: BigInt(Number.MAX_SAFE_INTEGER) + 1n, bavail: 0n },
    { bsize: 4096n, blocks: BigInt(Number.MAX_SAFE_INTEGER), bavail: 1n },
  ])
    assert.deepEqual(capacityFromStatfs(invalid), unknown);
});

test('filesystem probe failures and invalid results omit paths, exceptions and raw metadata', async () => {
  const secret = '/private/media-secret?token=never-log';
  assert.deepEqual(
    await filesystemCapacity(secret, async () => {
      throw new Error(`EACCES ${secret} raw-stack-secret`);
    }),
    unknown,
  );
  assert.deepEqual(
    await filesystemCapacity(secret, async () => ({
      bsize: 0n,
      blocks: 10n,
      bavail: 1n,
      path: secret,
      error: 'raw-error-secret',
    })),
    unknown,
  );
});

test(
  'actual local statfs CLI preserves database-only output and read-only store bytes',
  { skip: sqliteOnly },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewind-capacity-'));
    const config = parseConfig({ REWIND_DATA_DIR: root });
    const database = openFixtureDatabase(config);
    try {
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const before = await readFile(config.databasePath);
      const runCli = (...args) =>
        execFileAsync(
          process.execPath,
          ['scripts/server-operational-metrics.mjs', config.databasePath, ...args],
          { env: { ...process.env, NODE_NO_WARNINGS: '1' } },
        );
      const legacy = JSON.parse((await runCli()).stdout);
      assert.equal(legacy.schemaVersion, 1);
      assert.equal(Object.hasOwn(legacy, 'filesystem'), false);
      const stats = await statfs(root, { bigint: true });
      const { stdout, stderr } = await runCli('--filesystem', root);
      const snapshot = JSON.parse(stdout);
      assert.equal(stderr, '');
      assert.equal(snapshot.filesystem.state, 'available');
      assert.equal(snapshot.filesystem.totalBytes, Number(stats.bsize * stats.blocks));
      assert.ok(Number.isSafeInteger(snapshot.filesystem.availableBytes));
      assert.ok(snapshot.filesystem.availableBytes >= 0);
      assert.ok(snapshot.filesystem.availableBytes <= snapshot.filesystem.totalBytes);
      assert.equal(snapshot.filesystem.availableBytes % Number(stats.bsize), 0);
      assert.deepEqual(Object.keys(snapshot.filesystem).sort(), [
        'availableBytes',
        'state',
        'totalBytes',
      ]);
      const { filesystem, observedAt, ...numericSnapshot } = snapshot;
      const { observedAt: legacyTime, ...legacyNumeric } = legacy;
      assert.deepEqual(numericSnapshot, legacyNumeric);
      assert.doesNotMatch(stdout, /rewind-capacity|bavail|bfree|mount|stack|errno/);
      assert.deepEqual(await readFile(config.databasePath), before);

      const missingPath = join(root, 'secret-media-path-that-does-not-exist');
      await assert.rejects(runCli('--filesystem', missingPath), (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stderr, '');
        assert.deepEqual(JSON.parse(error.stdout).filesystem, unknown);
        assert.doesNotMatch(error.stdout, /secret-media|ENOENT|stack|path/);
        return true;
      });
      for (const args of [
        ['--filesystem'],
        ['--unknown', missingPath],
        ['--filesystem', root, missingPath],
      ]) {
        await assert.rejects(runCli(...args), (error) => {
          assert.equal(error.code, 1);
          assert.equal(error.stdout, '');
          assert.deepEqual(JSON.parse(error.stderr), { event: 'operational.snapshot_unavailable' });
          return true;
        });
      }
      assert.deepEqual(await readFile(config.databasePath), before);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
