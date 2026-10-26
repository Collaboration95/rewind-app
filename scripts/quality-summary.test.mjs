import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('./quality-summary.py', import.meta.url).pathname;

test('Quality summaries count failed/skipped tests and do not assign frontend coverage to root', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rewind-quality-summary-'));
  try {
    await mkdir(join(cwd, 'coverage'));
    await writeFile(
      join(cwd, 'coverage', 'test-results-root.xml'),
      '<testsuites><testsuite><testcase/><testcase><failure/></testcase><testcase><skipped/></testcase></testsuite></testsuites>',
    );
    await writeFile(
      join(cwd, 'coverage', 'coverage-summary.json'),
      JSON.stringify({ total: { statements: { pct: 99 } } }),
    );
    const summary = join(cwd, 'summary.md');
    const result = spawnSync('python3', [script, 'root'], {
      cwd,
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(summary, 'utf8'), /\| root \| 1 \| 1 \| 1 \| n\/a \|/);
    await writeFile(
      join(cwd, 'coverage', 'npm-audit.json'),
      JSON.stringify({ metadata: { vulnerabilities: { high: 1, critical: 0 } } }),
    );
    const audit = spawnSync('python3', [script, 'audit'], {
      cwd,
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
      encoding: 'utf8',
    });
    assert.equal(audit.status, 0, audit.stderr);
    assert.match(await readFile(summary, 'utf8'), /FAIL \(HIGH\+ gate\).*high: 1/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
