import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Native build fixtures remain behind test:native-build. Every other root or
// script test is discovered automatically, including the existing nested suites.
const files = globSync([
  'tests/*.test.mjs',
  'scripts/*.test.mjs',
  'tests/deploy/*.test.mjs',
  'tests/terraform/*.test.mjs',
  'tests/e2e-real-account/*.test.mjs',
])
  .filter((file) => file !== 'tests/native-build.test.mjs')
  .sort();
if (files.length === 0) throw new Error('No root tests discovered.');
// scripts/run-fast-tests.mjs caps this while other suites share the CPUs; by default
// node --test uses all of them.
const cap = process.env.REWIND_TEST_CONCURRENCY;
const concurrency = /^[1-9]\d*$/.test(cap ?? '') ? [`--test-concurrency=${cap}`] : [];
const result = spawnSync(process.execPath, ['--test', ...concurrency, ...files], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
