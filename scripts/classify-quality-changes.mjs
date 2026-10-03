import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isDocumentation(path, mode) {
  if (mode !== '100644' || !path.endsWith('.md')) return false;
  return (
    !path.includes('/') || /^(?:docs|doc|skills)\//.test(path) || /^\.github\/[^/]+\.md$/.test(path)
  );
}

export function classifyChanges({ base, head, cwd = process.cwd() }) {
  const fallback = { docsOnly: false, reason: 'comparison-unavailable' };
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? '') && !/^0+$/.test(sha)))
    return fallback;
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    // Do not detect renames: both the old and new path must be classified.
    const paths = git('diff', '--no-renames', '--name-only', '-z', base, head, '--')
      .split('\0')
      .filter(Boolean);
    if (!paths.length) return { docsOnly: false, reason: 'empty-comparison' };
    for (const path of paths) {
      let found = false;
      for (const sha of [base, head]) {
        const entry = git('ls-tree', '-z', sha, '--', path);
        if (!entry) continue;
        found = true;
        const mode = entry.match(/^([0-9]+) /)?.[1];
        if (!isDocumentation(path, mode)) return { docsOnly: false, reason: 'runnable-change' };
      }
      if (!found) return fallback;
    }
    return { docsOnly: true, reason: 'documentation-only' };
  } catch {
    return fallback;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = classifyChanges({
    base: process.env.REWIND_CHANGE_BASE,
    head: process.env.REWIND_CHANGE_HEAD,
  });
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${result.docsOnly}\n`);
  console.log(JSON.stringify(result));
}
