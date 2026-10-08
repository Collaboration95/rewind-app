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
  // `test` builds the server once and runs root, server and Jest concurrently; its
  // Jest invocation is covered by scripts/run-fast-tests.test.mjs.
  assert.equal(packageJson.scripts.test, 'node scripts/run-fast-tests.mjs');
  assert.equal(packageJson.scripts['test:fast'], 'npm test');
  assert.equal(packageJson.scripts['test:coverage:frontend'], 'jest --coverage');
  assert.doesNotMatch(JSON.stringify(packageJson.scripts), /--runInBand/);
  assert.match(packageJson.scripts.check, /format:check/);
  assert.match(packageJson.scripts.check, /lint/);
  assert.match(packageJson.scripts.check, /architecture:check/);
  assert.match(packageJson.scripts.check, /typecheck/);
  assert.match(packageJson.scripts.check, /test/);
});

test('quality workflow validates main and dev pushes and PRs against any stacked base', () => {
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /name: Format, lint, typecheck, and test/);
  // The cheap checks run as one parallel matrix; each leg runs `npm run "$CHECK"`.
  assert.match(workflow, /check: \[format:check, lint, architecture:check, typecheck\]/);
  assert.match(workflow, /run: npm run "\$CHECK"/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
  assert.match(workflow, /npx jest --coverage/);
  assert.doesNotMatch(workflow, /--runInBand/);
  assert.match(workflow, /bash tests\/deploy\/recovery-smoke\.test\.sh/);
  assert.equal((workflow.match(/npm run build:web/g) ?? []).length, 1);
  assert.match(
    workflow,
    /needs: \[changes, checks, audit, static, server, server-postgres, frontend, browser, fixtures\]/,
  );
  // The gate requires every job, and lets each one skip on documentation-only changes.
  const gateJobs = ['checks', 'audit', 'static', 'server', 'server-postgres', 'frontend'];
  for (const job of [...gateJobs, 'fixtures'])
    assert.match(workflow, new RegExp(`test '\\$\\{\\{ needs\\.${job}\\.result \\}\\}' = success`));
  for (const job of [...gateJobs, 'browser', 'fixtures'])
    assert.match(workflow, new RegExp(`test '\\$\\{\\{ needs\\.${job}\\.result \\}\\}' = skipped`));
  // Classifying compares two trees, so a shallow checkout plus the base commit is enough.
  const classifierJob = workflow.split('\n  checks:')[0];
  assert.doesNotMatch(classifierJob, /fetch-depth/);
  assert.match(classifierJob, /git fetch --no-tags --depth=1 .*"\$REWIND_CHANGE_BASE"/);
  // The server suite also runs against PostgreSQL, the hosted engine (#261).
  assert.match(workflow, /npm run server:test:postgres/);
  assert.match(workflow, /test '\$\{\{ needs\.server-postgres\.result \}\}' = success/);
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
  assert.doesNotMatch(classifier, /fetch-depth/);
  assert.match(classifier, /git fetch --no-tags --depth=1 .*"\$REWIND_CHANGE_BASE"/);
  assert.match(classifier, /REWIND_CHANGE_HEAD: \$\{\{ github\.sha \}\}/);
  assert.match(codeql, /schedule:\n    - cron: '23 3 \* \* 1'/);
  assert.doesNotMatch(codeql, /paths-ignore:/);
  assert.match(codeql, /analyze:\n    needs: changes/);
});
