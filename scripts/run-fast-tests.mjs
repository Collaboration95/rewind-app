// `npm test` / `npm run test:fast`: build the server once, then run the root, server
// and Jest suites concurrently. Each suite's output is buffered and printed when it
// finishes (passing suites show only their summary, failing ones in full) so the
// three never interleave. The exit status is non-zero when any suite fails, and the
// last line names the failures. The suite commands mirror `test:root`, `server:test`
// and `test:coverage:frontend` in package.json (scripts/run-fast-tests.test.mjs
// checks they have not drifted); those scripts still work standalone.
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SUMMARY_LINES = 12;
const KILL_GRACE_MS = 5000;
// A suite normally takes well under a minute; this only stops a hung one blocking forever.
const SUITE_TIMEOUT_MS = 10 * 60 * 1000;

// The suites share the CPUs, so each gets a small cap instead of the default of
// every core (which oversubscribes them and slows the slowest suite, Jest). Jest is
// bound by its slowest file (~26 s), which two workers already reach; node --test
// finishes well before that with a third of the cores each.
export function jestWorkers(cpus = os.availableParallelism()) {
  return Math.max(2, Math.floor(cpus / 4));
}

export function testConcurrency(cpus = os.availableParallelism()) {
  return Math.max(2, Math.floor(cpus / 3));
}

export function fastSuites(cpus = os.availableParallelism()) {
  return [
    {
      name: 'root',
      command: process.execPath,
      args: ['scripts/run-root-tests.mjs'],
      // run-root-tests.mjs builds the node --test command itself; this caps it.
      env: { REWIND_TEST_CONCURRENCY: String(testConcurrency(cpus)) },
    },
    {
      name: 'server',
      command: process.execPath,
      args: ['--test', `--test-concurrency=${testConcurrency(cpus)}`, 'server/tests/*.test.mjs'],
    },
    {
      name: 'frontend',
      command: process.execPath,
      args: ['node_modules/jest/bin/jest.js', `--maxWorkers=${jestWorkers(cpus)}`],
    },
  ];
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

// The closing totals of node --test (spec or TAP) or Jest; otherwise the last lines.
function passSummary(text) {
  const marks = [...text.matchAll(/^(?:ℹ tests |# tests |Test Suites:)/gm)];
  const start = marks.length ? marks.at(-1).index : 0;
  return text.slice(start).trimEnd().split('\n').slice(-SUMMARY_LINES).join('\n');
}

export function describeResult(result) {
  const how = result.error
    ? `could not start (${result.error.message})`
    : result.timedOut
      ? `timed out, killed by ${result.signal}`
      : result.signal
        ? `killed by ${result.signal}`
        : `exit ${result.code}`;
  return result.ok
    ? `--- ${result.name}: passed in ${seconds(result.ms)}\n${passSummary(result.output)}\n`
    : `--- ${result.name}: FAILED (${how}) after ${seconds(result.ms)}\n${result.output.trimEnd()}\n`;
}

export function summarize(results, extra = '') {
  const width = Math.max(...results.map((result) => result.name.length));
  const lines = results.map(
    (result) =>
      `  ${result.name.padEnd(width)}  ${result.ok ? 'passed' : 'FAILED'}  ${seconds(result.ms)}`,
  );
  const failed = results.filter((result) => !result.ok).map((result) => result.name);
  return {
    failed,
    text:
      `Suites${extra}:\n${lines.join('\n')}\n` +
      (failed.length ? `FAILED: ${failed.join(', ')}\n` : 'All suites passed.\n'),
  };
}

// Each suite runs in its own process group so an interrupt or timeout can stop its
// whole tree (node --test leaves grandchildren behind a plain child.kill).
export function runSuites(
  suites,
  { cwd = process.cwd(), env = process.env, report, timeoutMs = SUITE_TIMEOUT_MS } = {},
) {
  const running = new Set();
  let interrupted;
  const stopGroup = (child, signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  };
  const stop = (child, signal) => {
    stopGroup(child, signal);
    setTimeout(() => stopGroup(child, 'SIGKILL'), KILL_GRACE_MS).unref();
  };
  const onSignal = (signal) => {
    if (interrupted) return;
    interrupted = signal;
    for (const child of running) stop(child, signal);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, onSignal);

  const runs = suites.map(
    (suite) =>
      new Promise((resolve) => {
        const started = performance.now();
        const chunks = [];
        let done = false;
        let timedOut = false;
        const finish = (fields) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          running.delete(child);
          const result = {
            name: suite.name,
            ms: performance.now() - started,
            output: Buffer.concat(chunks).toString('utf8'),
            timedOut,
            ...fields,
          };
          if (!interrupted) report?.(result);
          resolve(result);
        };
        const child = spawn(suite.command, suite.args, {
          cwd,
          env: { ...env, ...suite.env },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        running.add(child);
        const timer = setTimeout(() => {
          timedOut = true;
          stop(child, 'SIGTERM');
        }, timeoutMs);
        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.stderr.on('data', (chunk) => chunks.push(chunk));
        child.once('error', (error) => finish({ ok: false, error, code: null, signal: null }));
        child.once('close', (code, signal) => finish({ ok: code === 0 && !signal, code, signal }));
      }),
  );
  return Promise.all(runs)
    .finally(() => {
      for (const signal of signals) process.off(signal, onSignal);
    })
    .then((results) => ({ results, interrupted }));
}

export async function main({ cwd = process.cwd(), stdout = process.stdout } = {}) {
  const started = performance.now();
  const build = spawnSync('npm', ['run', 'server:build'], { cwd, stdio: 'inherit' });
  if (build.error || build.status !== 0) {
    stdout.write('FAILED: server build\n');
    return build.status ?? 1;
  }
  const built = performance.now() - started;
  const suites = fastSuites();
  stdout.write(
    `Server built in ${seconds(built)}; running ${suites.map((s) => s.name).join(', ')} ` +
      `concurrently (Jest workers: ${jestWorkers()}, node --test concurrency: ${testConcurrency()}).\n`,
  );
  const { results, interrupted } = await runSuites(suites, {
    cwd,
    report: (result) => stdout.write(describeResult(result)),
  });
  if (interrupted) {
    stdout.write(`Interrupted by ${interrupted}.\n`);
    return 128 + (os.constants.signals[interrupted] ?? 0);
  }
  const { failed, text } = summarize(
    results,
    ` (${seconds(performance.now() - started)} total, server build ${seconds(built)})`,
  );
  stdout.write(text);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
