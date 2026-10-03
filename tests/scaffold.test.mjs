import assert from 'node:assert/strict';
import './quality-classification.test.mjs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
// The static Quality job runs this root entry point explicitly.
import './node-forge-security.test.mjs';
import './braces-security.test.mjs';
import './native-build.test.mjs';

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

test('quality workflow validates main and dev pushes and PRs against any stacked base', () => {
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /name: Format, lint, typecheck, and test/);
  assert.match(workflow, /npm run format:check/);
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npx jest --runInBand --coverage/);
  assert.match(workflow, /bash tests\/deploy\/recovery-smoke\.test\.sh/);
  assert.equal((workflow.match(/npm run build:web/g) ?? []).length, 1);
  assert.match(workflow, /needs: \[changes, static, server, frontend, browser, fixtures\]/);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/);
  assert.match(workflow, /push:\n    branches: \[main, dev\]/);
  const pullRequestBlock = workflow.match(/  pull_request:\n((?:    .*\n)*)/)?.[1] ?? '';
  assert.match(pullRequestBlock, /types: \[opened, synchronize, reopened, ready_for_review\]/);
  assert.doesNotMatch(pullRequestBlock, /branches:/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.doesNotMatch(workflow, /paths-ignore:/);
  assert.match(workflow, /test '\$\{\{ needs\.changes\.result \}\}' = success/);
  assert.match(workflow, /No application tests ran/);
});

test('documentation classification gates deployment before AWS and preserves scheduled CodeQL', async () => {
  const [deploy, codeql] = await Promise.all([
    readFile(new URL('../.github/workflows/deploy-dev.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/codeql.yml', import.meta.url), 'utf8'),
  ]);
  assert.match(
    deploy,
    /deploy:\n    needs: changes\n    if: \$\{\{ needs\.changes\.outputs\.docs_only != 'true' \}\}/,
  );
  const classifier = deploy.split('  deploy:')[0];
  assert.doesNotMatch(classifier, /aws sts|AWS_ACCESS_KEY_ID|assume-role/);
  assert.match(classifier, /REWIND_CHANGE_HEAD: \$\{\{ github\.sha \}\}/);
  assert.match(codeql, /schedule:\n    - cron: '23 3 \* \* 1'/);
  assert.doesNotMatch(codeql, /paths-ignore:/);
  assert.match(codeql, /analyze:\n    needs: changes/);
});
