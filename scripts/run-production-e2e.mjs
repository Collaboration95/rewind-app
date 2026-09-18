import { spawn } from 'node:child_process';
import { join } from 'node:path';

const projectRoot = process.cwd();
const playwrightCli = join(projectRoot, 'node_modules/@playwright/test/cli.js');

function localOnlyEnv(runId) {
  const env = { ...process.env, REWIND_E2E_RUN: runId };
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

function run(runId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [playwrightCli, 'test', '--config=playwright.e2e.config.ts'],
      { cwd: projectRoot, env: localOnlyEnv(runId), stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const results = [];
for (const runId of ['1', '2']) results.push(await run(runId));
if (results.some((code) => code !== 0)) process.exitCode = 1;
