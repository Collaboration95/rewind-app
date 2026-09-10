import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('one-command preflight passes service, SQLite, LAN, and FFmpeg gates', async () => {
  const dataDir = `${process.cwd()}/.local-data/test-preflight`;
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['server/dist/cli.js', 'preflight', '--json'],
      {
        env: { ...process.env, REWIND_DATA_DIR: dataDir },
        maxBuffer: 2_000_000,
      },
    );
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.service.ok, true);
    assert.equal(report.sqlite.ok, true);
    assert.equal(report.ffmpeg.transformSucceeded, true);
    assert.equal(report.ffmpeg.deliberateFailureDetected, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
