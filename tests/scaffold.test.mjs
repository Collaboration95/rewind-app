import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const appJson = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
const workflow = await readFile(
  new URL('../.github/workflows/quality.yml', import.meta.url),
  'utf8',
);

test('scaffold identifies the Rewind app and exposes baseline quality commands', () => {
  assert.equal(packageJson.name, 'rewind-app');
  assert.equal(appJson.expo.name, 'Rewind');
  assert.equal(packageJson.scripts.lint, 'eslint .');
  assert.equal(packageJson.scripts.typecheck, 'tsc --noEmit');
  assert.equal(packageJson.engines.node, '>=22.13.0');
  assert.match(packageJson.scripts['server:preflight'], /server\/dist\/cli\.js preflight/);
  assert.match(packageJson.scripts.test, /jest --runInBand/);
  assert.match(packageJson.scripts.check, /format:check/);
  assert.match(packageJson.scripts.check, /lint/);
  assert.match(packageJson.scripts.check, /typecheck/);
  assert.match(packageJson.scripts.check, /test/);
});

test('quality workflow runs the same baseline check as local development', () => {
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /pull_request:\n    branches: \[main\]/);
});
