import { globSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

// Every root and script test is discovered automatically, including the
// nested suites. test:native-build also runs the native build fixtures alone.
const files = globSync([
  'tests/*.test.mjs',
  'scripts/*.test.mjs',
  'tests/deploy/*.test.mjs',
  'tests/terraform/*.test.mjs',
  'tests/e2e-real-account/*.test.mjs',
]).sort();
if (files.length === 0) throw new Error('No root tests discovered.');
// scripts/run-fast-tests.mjs caps this while other suites share the CPUs; by default
// node --test uses all of them.
const cap = process.env.REWIND_TEST_CONCURRENCY;
const concurrency = /^[1-9]\d*$/.test(cap ?? '') ? [`--test-concurrency=${cap}`] : [];
const junit = process.env.REWIND_TEST_JUNIT;
if (junit) mkdirSync(dirname(junit), { recursive: true });
const reporters = junit
  ? [
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=junit',
      `--test-reporter-destination=${junit}`,
    ]
  : [];
const result = spawnSync(process.execPath, ['--test', ...reporters, ...concurrency, ...files], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
