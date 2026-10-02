import { realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const suitePatterns = {
  frontend: /^tests\/[^/]+\.test\.(?:ts|tsx)$/,
  server: /^server\/tests\/[^/]+\.test\.mjs$/,
  root: /^tests\/(?:[^/]+\.test\.mjs|deploy\/[^/]+\.test\.(?:mjs|sh)|terraform\/[^/]+\.test\.mjs)$/,
};

export function selectCommands(args, cwd = process.cwd()) {
  if (args.length !== 2) {
    throw new Error('Expected exactly one suite and one test file.');
  }

  const [suite, candidate] = args;
  const pattern = suitePatterns[suite];
  if (!pattern) {
    throw new Error(`Unknown suite "${suite}". Choose frontend, server, or root.`);
  }
  if (typeof candidate !== 'string' || !pattern.test(candidate)) {
    throw new Error(`Unsupported ${suite} test path: ${String(candidate)}`);
  }

  const absoluteCandidate = path.resolve(cwd, candidate);
  let actualPath;
  try {
    actualPath = realpathSync(absoluteCandidate);
    if (!statSync(actualPath).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`Test file does not exist: ${candidate}`);
  }
  if (actualPath !== absoluteCandidate) {
    throw new Error(`Test path must not resolve through a symlink: ${candidate}`);
  }

  if (suite === 'frontend') {
    return [
      {
        command: process.execPath,
        args: ['node_modules/jest/bin/jest.js', '--runInBand', candidate],
      },
    ];
  }
  if (suite === 'server') {
    return [
      { command: 'npm', args: ['run', 'server:build'] },
      { command: process.execPath, args: ['--test', candidate] },
    ];
  }
  if (candidate.endsWith('.sh')) {
    return [{ command: 'bash', args: [candidate] }];
  }
  return [{ command: process.execPath, args: ['--test', candidate] }];
}

function signalExitCode(signal) {
  const signalNumber = signal ? os.constants.signals[signal] : undefined;
  return signalNumber ? 128 + signalNumber : 1;
}

export function runFocused(args, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const spawn = options.spawn ?? spawnSync;
  const stderr = options.stderr ?? process.stderr;
  const stdout = options.stdout ?? process.stdout;
  let commands;
  try {
    commands = selectCommands(args, cwd);
  } catch (error) {
    stderr.write(
      `${error.message}\nUsage: npm run test:focused -- <frontend|server|root> <test-file>\n`,
    );
    return 2;
  }

  stdout.write(`Focused ${args[0]} test: ${args[1]}\n`);
  for (const { command, args: childArgs } of commands) {
    const result = spawn(command, childArgs, { cwd, stdio: 'inherit' });
    if (result.error) {
      stderr.write(`Could not start ${command}: ${result.error.message}\n`);
      return 1;
    }
    if (result.status !== 0) {
      return result.status ?? signalExitCode(result.signal);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = runFocused(process.argv.slice(2));
}
