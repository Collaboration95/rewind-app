import { spawn } from 'node:child_process';
import { constants as osConstants, tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = process.cwd();
export function localOnlyEnv(runId, artifactCacheDir, source = process.env) {
  const env = {
    ...source,
    REWIND_E2E_RUN: runId,
    REWIND_E2E_ARTIFACT_CACHE_DIR: artifactCacheDir,
  };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('AWS_') ||
      key === 'AWS_PROFILE' ||
      key === 'AWS_DEFAULT_PROFILE' ||
      key === 'AWS_CONFIG_FILE' ||
      key === 'AWS_SHARED_CREDENTIALS_FILE' ||
      key.startsWith('CLOUDSDK_')
    ) {
      delete env[key];
    }
  }
  return env;
}

export function runOwnedCommand(command, args, { cwd = projectRoot, env = process.env } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const signalNumber = signal ? osConstants.signals[signal] : undefined;
      resolveRun(code ?? (signalNumber ? 128 + signalNumber : 1));
    });
  });
}

export async function runProductionE2ePair({
  root = projectRoot,
  sourceEnv = process.env,
  execute = runOwnedCommand,
  makeCacheRoot = () => mkdtemp(join(tmpdir(), 'rewind-production-e2e-build-')),
  removeCacheRoot = (path) => rm(path, { recursive: true, force: true }),
  log = console.log,
} = {}) {
  const startedAt = performance.now();
  const artifactCacheDir = await makeCacheRoot();
  let exitCode = 0;
  try {
    const buildStartedAt = performance.now();
    const npmCommand = sourceEnv.npm_execpath ? process.execPath : 'npm';
    const npmArgs = sourceEnv.npm_execpath
      ? [sourceEnv.npm_execpath, 'run', 'server:build']
      : ['run', 'server:build'];
    const buildCode = await execute(npmCommand, npmArgs, {
      cwd: root,
      env: localOnlyEnv('build', artifactCacheDir, sourceEnv),
    });
    log(
      `Production E2E server build exited ${buildCode} in ${(
        (performance.now() - buildStartedAt) /
        1000
      ).toFixed(2)}s.`,
    );
    if (buildCode !== 0) {
      exitCode = buildCode;
    } else {
      const playwrightCliPath = join(root, 'node_modules/@playwright/test/cli.js');
      for (const runId of ['1', '2']) {
        const code = await execute(
          process.execPath,
          [playwrightCliPath, 'test', '--config=playwright.e2e.config.ts'],
          { cwd: root, env: localOnlyEnv(runId, artifactCacheDir, sourceEnv) },
        );
        if (exitCode === 0 && code !== 0) exitCode = code;
      }
    }
  } catch (error) {
    log(error instanceof Error ? error.message : 'Production E2E process failed.');
    exitCode = 1;
  } finally {
    try {
      await removeCacheRoot(artifactCacheDir);
    } catch (error) {
      log(error instanceof Error ? error.message : 'Production E2E artifact cleanup failed.');
      if (exitCode === 0) exitCode = 1;
    }
    log(
      `Production E2E pair finished with exit ${exitCode} in ${(
        (performance.now() - startedAt) /
        1000
      ).toFixed(2)}s.`,
    );
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runProductionE2ePair();
}
