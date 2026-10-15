import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import {
  describeResult,
  fastSuites,
  jestWorkers,
  runSuites,
  summarize,
  testConcurrency,
} from './run-fast-tests.mjs';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const node = (code) => ({ command: process.execPath, args: ['-e', code] });

test('the concurrent suites run the same commands as the standalone scripts', () => {
  const [root, server, frontend] = fastSuites(8);
  assert.deepEqual([root.name, server.name, frontend.name], ['root', 'server', 'frontend']);
  // test:root and server:test add their own server build in front of these; only the
  // concurrency caps (--test-concurrency, REWIND_TEST_CONCURRENCY) are specific to here.
  const uncapped = server.args.filter((arg) => !arg.startsWith('--test-concurrency='));
  assert.ok(packageJson.scripts['test:root'].endsWith(`node ${root.args.join(' ')}`));
  assert.ok(packageJson.scripts['server:test'].endsWith(`node ${uncapped.join(' ')}`));
  assert.equal(server.args.length, uncapped.length + 1);
  assert.match(root.env.REWIND_TEST_CONCURRENCY, /^[1-9]\d*$/);
  // test:coverage:frontend is the same Jest run plus --coverage.
  assert.equal(packageJson.scripts['test:coverage:frontend'], 'jest --coverage');
  assert.equal(frontend.args[0], 'node_modules/jest/bin/jest.js');
  assert.ok(existsSync(frontend.args[0]));
  assert.match(frontend.args[1], /^--maxWorkers=\d+$/);
  assert.equal(frontend.args.includes('--runInBand'), false);
});

test('the suites share the CPUs instead of each taking all of them', () => {
  assert.equal(jestWorkers(1), 2);
  assert.equal(jestWorkers(4), 2);
  assert.equal(jestWorkers(10), 2);
  assert.equal(jestWorkers(16), 4);
  assert.equal(testConcurrency(1), 2);
  assert.equal(testConcurrency(10), 3);
  for (const cpus of [8, 10, 12, 16, 32])
    assert.ok(jestWorkers(cpus) + 2 * testConcurrency(cpus) <= cpus, `${cpus} CPUs`);
  const [root, server, frontend] = fastSuites(10);
  assert.equal(root.env.REWIND_TEST_CONCURRENCY, '3');
  assert.ok(server.args.includes('--test-concurrency=3'));
  assert.ok(frontend.args.includes('--maxWorkers=2'));
});

test('suites run concurrently with separate buffered output and a named failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rewind-fast-runner-'));
  try {
    // Each side waits for the other's marker, so this only finishes if both run
    // at the same time (a sequential runner would hit the deadline and exit 2).
    const meet = (name, other) => `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(join(dir, name))}, '');
      const deadline = Date.now() + 20000;
      (function wait() {
        if (fs.existsSync(${JSON.stringify(join(dir, other))})) return console.log('${name} met ${other}');
        if (Date.now() > deadline) process.exit(2);
        setTimeout(wait, 10);
      })();`;
    const reported = [];
    const { results, interrupted } = await runSuites(
      [
        { name: 'a', ...node(meet('a', 'b')) },
        { name: 'b', ...node(meet('b', 'a')) },
        { name: 'bad', ...node("console.log('before'); console.error('boom'); process.exit(3)") },
        { name: 'killed', ...node("process.kill(process.pid, 'SIGKILL')") },
        { name: 'missing', command: join(dir, 'no-such-command'), args: [] },
      ],
      { report: (result) => reported.push(result.name) },
    );
    assert.equal(interrupted, undefined);
    assert.deepEqual(reported.sort(), ['a', 'b', 'bad', 'killed', 'missing']);
    const byName = Object.fromEntries(results.map((result) => [result.name, result]));
    assert.equal(byName.a.ok, true);
    assert.equal(byName.a.output, 'a met b\n');
    assert.equal(byName.b.output, 'b met a\n');
    assert.equal(byName.bad.ok, false);
    assert.equal(byName.bad.code, 3);
    assert.match(byName.bad.output, /before/);
    assert.match(byName.bad.output, /boom/);
    assert.equal(byName.killed.signal, 'SIGKILL');
    assert.equal(byName.missing.ok, false);
    assert.equal(byName.missing.error.code, 'ENOENT');

    const failed = describeResult(byName.bad);
    assert.match(failed, /^--- bad: FAILED \(exit 3\)/);
    assert.match(failed, /before\nboom|boom\nbefore/);
    assert.match(describeResult(byName.killed), /FAILED \(killed by SIGKILL\)/);
    assert.match(describeResult(byName.missing), /FAILED \(could not start/);
    const { failed: names, text } = summarize(results);
    assert.deepEqual(names, ['bad', 'killed', 'missing']);
    assert.match(text, /^FAILED: bad, killed, missing$/m);
    assert.match(text, /^ {2}a +passed +\d/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a passing suite shows only its totals, a failing one its full output', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `✔ test ${index}`);
  const output = `${lines.join('\n')}\nℹ tests 40\nℹ pass 40\nℹ fail 0\n`;
  const passed = describeResult({ name: 'server', ok: true, ms: 1500, output });
  assert.equal(passed, '--- server: passed in 1.5 s\nℹ tests 40\nℹ pass 40\nℹ fail 0\n');
  const failed = describeResult({ name: 'server', ok: false, code: 1, ms: 1500, output });
  assert.ok(failed.includes('✔ test 0\n'));
  assert.deepEqual(summarize([{ name: 'server', ok: true, ms: 1 }]).failed, []);
});

test('an interrupt stops every suite, including grandchildren, and is reported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rewind-fast-runner-'));
  try {
    const marker = join(dir, 'started');
    // The suite starts a grandchild that would outlive a plain child.kill.
    const sleeper = node(`
      const fs = require('node:fs');
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)']);
      fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));
      setTimeout(() => {}, 60000);`);
    const reported = [];
    const running = runSuites([{ name: 'slow', ...sleeper }], {
      report: (result) => reported.push(result.name),
    });
    let grandchild = NaN;
    for (let waited = 0; Number.isNaN(grandchild) && waited < 20000; waited += 20) {
      await sleep(20);
      grandchild = existsSync(marker) ? Number.parseInt(await readFile(marker, 'utf8'), 10) : NaN;
    }
    assert.ok(grandchild > 0, 'the suite never started');
    process.kill(process.pid, 'SIGTERM');
    const { results, interrupted } = await running;
    assert.equal(interrupted, 'SIGTERM');
    assert.deepEqual(reported, [], 'an interrupted suite is not reported as a test failure');
    assert.equal(results[0].ok, false);
    assert.equal(results[0].signal, 'SIGTERM');
    for (let waited = 0; waited < 5000; waited += 20) {
      try {
        process.kill(grandchild, 0);
      } catch {
        return;
      }
      await sleep(20);
    }
    assert.fail('the grandchild outlived the interrupt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a hung suite is killed after the timeout and reported as such', async () => {
  const { results } = await runSuites([{ name: 'hung', ...node('setTimeout(() => {}, 60000)') }], {
    timeoutMs: 200,
  });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].timedOut, true);
  assert.equal(results[0].signal, 'SIGTERM');
  assert.match(describeResult(results[0]), /FAILED \(timed out, killed by SIGTERM\)/);
});
