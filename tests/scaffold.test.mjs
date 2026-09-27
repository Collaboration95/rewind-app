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
  assert.equal(packageJson.scripts['architecture:check'], 'node scripts/check-architecture.mjs');
  assert.equal(packageJson.engines.node, '>=22.13.0');
  assert.match(packageJson.scripts['server:preflight'], /server\/dist\/cli\.js preflight/);
  assert.match(packageJson.scripts['build:web'], /expo export --(?:clear )?--platform web/);
  assert.match(packageJson.scripts['web:smoke-server'], /scripts\/web-smoke-server\.mjs/);
  assert.match(packageJson.scripts['test:web-smoke'], /playwright test/);
  assert.match(packageJson.scripts.test, /jest --runInBand/);
  assert.match(packageJson.scripts.check, /format:check/);
  assert.match(packageJson.scripts.check, /lint/);
  assert.match(packageJson.scripts.check, /architecture:check/);
  assert.match(packageJson.scripts.check, /typecheck/);
  assert.match(packageJson.scripts.check, /test/);
});

test('quality workflow validates main pushes and PRs against any stacked base', () => {
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /name: Format, lint, typecheck, and test/);
  assert.match(workflow, /npm run format:check/);
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npx jest --runInBand --coverage/);
  assert.match(workflow, /bash tests\/deploy\/recovery-smoke\.test\.sh/);
  assert.equal((workflow.match(/npm run build:web/g) ?? []).length, 1);
  assert.match(workflow, /needs: \[static, server, frontend, browser, fixtures\]/);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/);
  assert.match(workflow, /push:\n    branches: \[main\]/);
  const pullRequestBlock = workflow.match(/  pull_request:\n((?:    .*\n)*)/)?.[1] ?? '';
  assert.match(pullRequestBlock, /types: \[opened, synchronize, reopened, ready_for_review\]/);
  assert.doesNotMatch(pullRequestBlock, /branches:/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /cancel-in-progress: true/);
});
