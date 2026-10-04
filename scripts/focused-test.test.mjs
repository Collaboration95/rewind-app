import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runFocused, selectCommands } from './focused-test.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('frontend selector runs only the named Jest file', () => {
  assert.deepEqual(
    selectCommands(['frontend', 'tests/VideoCaptureScreen.test.tsx'], repositoryRoot),
    [
      {
        command: process.execPath,
        args: ['node_modules/jest/bin/jest.js', '--runInBand', 'tests/VideoCaptureScreen.test.tsx'],
      },
    ],
  );
});

test('server selector builds then runs only the named Node test', () => {
  assert.deepEqual(selectCommands(['server', 'server/tests/cycles.test.mjs'], repositoryRoot), [
    { command: 'npm', args: ['run', 'server:build'] },
    { command: process.execPath, args: ['--test', 'server/tests/cycles.test.mjs'] },
  ]);
});

test('root selector maps Node and shell files to their existing runners', () => {
  assert.deepEqual(selectCommands(['root', 'tests/architecture.test.mjs'], repositoryRoot), [
    { command: process.execPath, args: ['--test', 'tests/architecture.test.mjs'] },
  ]);
  assert.deepEqual(
    selectCommands(['root', 'tests/deploy/ownership-contract.test.sh'], repositoryRoot),
    [{ command: 'bash', args: ['tests/deploy/ownership-contract.test.sh'] }],
  );
});

test('unknown suites, unsupported paths, and missing files are rejected', () => {
  assert.throws(
    () => selectCommands(['unknown', 'tests/architecture.test.mjs'], repositoryRoot),
    /Unknown suite/,
  );
  assert.throws(
    () => selectCommands(['root', '../outside.test.mjs'], repositoryRoot),
    /Unsupported root test path/,
  );
  assert.throws(
    () => selectCommands(['server', 'server/tests/missing.test.mjs'], repositoryRoot),
    /does not exist/,
  );
  assert.throws(() => selectCommands(['root'], repositoryRoot), /exactly one suite/);
});

test('a selected test failure is returned unchanged after a successful server build', () => {
  const results = [
    { status: 0, signal: null },
    { status: 23, signal: null },
  ];
  const calls = [];
  const errors = [];
  const exitCode = runFocused(['server', 'server/tests/cycles.test.mjs'], {
    cwd: repositoryRoot,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return results.shift();
    },
    stderr: { write: (message) => errors.push(message) },
    stdout: { write: () => {} },
  });

  assert.equal(exitCode, 23);
  assert.equal(calls.length, 2);
  assert.deepEqual(errors, []);
});
