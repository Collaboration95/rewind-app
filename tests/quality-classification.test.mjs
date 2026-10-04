import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { classifyChanges } from '../scripts/classify-quality-changes.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'rewind-quality-scope-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Synthetic fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  const write = async (path, content = 'fixture\n') => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  };
  const commit = () => {
    git('add', '-A');
    git('commit', '-qm', 'test: change fixture');
    return git('rev-parse', 'HEAD');
  };
  await write('README.md');
  const base = commit();
  return {
    cwd,
    git,
    write,
    commit,
    base,
    classify: (head) => classifyChanges({ cwd, base, head }),
  };
}

for (const paths of [
  [
    'README.md',
    'docs/guide.md',
    'doc/planning/note.md',
    'skills/helper/SKILL.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
  ],
  ['docs/guide.md', 'App.tsx'],
  ['skills/helper/run.mjs'],
  ['docs/script.sh'],
  ['.github/workflows/quality.yml'],
  ['deploy/README.md'],
  ['infra/terraform/README.md'],
]) {
  test(`actual Git changes classify ${paths.join(', ')}`, async (t) => {
    const f = await fixture(t);
    for (const path of paths) await f.write(path, 'changed\n');
    const expected = paths[0] === 'README.md';
    assert.equal(f.classify(f.commit()).docsOnly, expected);
  });
}

test('executable and symlink Markdown require checks, including removal of an executable bit', async (t) => {
  const f = await fixture(t);
  await chmod(join(f.cwd, 'README.md'), 0o755);
  const executable = f.commit();
  assert.equal(f.classify(executable).docsOnly, false);
  await chmod(join(f.cwd, 'README.md'), 0o644);
  const ordinary = f.commit();
  assert.equal(classifyChanges({ cwd: f.cwd, base: executable, head: ordinary }).docsOnly, false);
  await symlink('README.md', join(f.cwd, 'linked.md'));
  assert.equal(f.classify(f.commit()).docsOnly, false);
});

test('code renamed into documentation still requires checks; documentation deletion can stay cheap', async (t) => {
  const f = await fixture(t);
  await f.write('old.mjs');
  const code = f.commit();
  await rename(join(f.cwd, 'old.mjs'), join(f.cwd, 'new.md'));
  const renamed = f.commit();
  assert.equal(classifyChanges({ cwd: f.cwd, base: code, head: renamed }).docsOnly, false);
  await rm(join(f.cwd, 'new.md'));
  assert.equal(classifyChanges({ cwd: f.cwd, base: renamed, head: f.commit() }).docsOnly, true);
});

test('unavailable, invalid, initial-push and empty comparisons conservatively require checks', async (t) => {
  const f = await fixture(t);
  for (const base of [undefined, '', '0'.repeat(40), 'f'.repeat(40), 'HEAD; false', f.base])
    assert.equal(classifyChanges({ cwd: f.cwd, base, head: f.base }).docsOnly, false);
});

test('deployment stays on its classified commit when dev advances to a documentation-only commit', async (t) => {
  const f = await fixture(t);
  await f.write('App.tsx', 'code change\n');
  const eventCommit = f.commit();
  assert.equal(f.classify(eventCommit).docsOnly, false);
  await f.write('README.md', 'later documentation change\n');
  const branchTip = f.commit();
  f.git('branch', 'dev', branchTip);
  assert.equal(classifyChanges({ cwd: f.cwd, base: eventCommit, head: branchTip }).docsOnly, true);
  const workflow = await readFile(
    new URL('../.github/workflows/deploy-dev.yml', import.meta.url),
    'utf8',
  );
  const deployRef = workflow
    .split('  deploy:')[1]
    .match(/ref: ([^\n]+)/)?.[1]
    .trim();
  // Resolve the checkout input as Actions would after the later push advanced dev.
  const selectedRef = deployRef === '${{ github.sha }}' ? eventCommit : deployRef;
  f.git('checkout', '-q', '--detach', selectedRef);
  assert.equal(f.git('rev-parse', 'HEAD'), eventCommit);
  assert.notEqual(f.git('rev-parse', 'HEAD'), f.git('rev-parse', 'dev'));
});
