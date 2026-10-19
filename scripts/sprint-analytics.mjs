#!/usr/bin/env node
// Build doc/analytics/sprint-analytics.html from live GitHub issues and PRs.
// Usage: node scripts/sprint-analytics.mjs   (needs an authenticated `gh`)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const gh = (args) =>
  JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20 }));

const issues = gh([
  'issue',
  'list',
  '--state',
  'all',
  '--limit',
  '2000',
  '--json',
  'number,title,state,createdAt,closedAt,labels,milestone,author,stateReason',
]).map((i) => ({
  n: i.number,
  t: i.title,
  s: i.state === 'OPEN' ? 'open' : 'closed',
  r: i.stateReason || '',
  c: i.createdAt,
  x: i.closedAt,
  l: i.labels.map((l) => l.name),
  m: i.milestone?.title || '',
  a: i.author?.login || '',
}));

// `gh issue list` returns sub-issues as plain issues; GraphQL adds the parent link.
const parents = {};
const [owner, repo] = execFileSync(
  'gh',
  ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
  {
    encoding: 'utf8',
  },
)
  .trim()
  .split('/');
for (let after = null, more = true; more;) {
  const q = `{repository(owner:"${owner}",name:"${repo}"){issues(first:100${after ? `,after:"${after}"` : ''}){pageInfo{hasNextPage endCursor}nodes{number parent{number}}}}}`;
  const page = gh(['api', 'graphql', '-f', `query=${q}`]).data.repository.issues;
  for (const n of page.nodes) if (n.parent) parents[n.number] = n.parent.number;
  ({ hasNextPage: more, endCursor: after } = page.pageInfo);
}
for (const i of issues) if (parents[i.n]) i.p = parents[i.n];

const issueNumbers = new Set(issues.map((i) => i.n));

const prs = gh([
  'pr',
  'list',
  '--state',
  'all',
  '--limit',
  '2000',
  '--json',
  'number,title,state,createdAt,mergedAt,additions,deletions,changedFiles,body,author,baseRefName',
]).map((p) => ({
  n: p.number,
  t: p.title,
  s: p.state.toLowerCase(),
  c: p.createdAt,
  mg: p.mergedAt,
  ad: p.additions,
  dl: p.deletions,
  f: p.changedFiles,
  b: p.baseRefName,
  a: p.author?.login || '',
  // Issues referenced anywhere in the body ("Refs #12", "#12", links), PR numbers excluded.
  i: [
    ...new Set([...(p.body || '').matchAll(/(?:#|\/issues\/)(\d+)\b/g)].map((m) => +m[1])),
  ].filter((n) => issueNumbers.has(n) && n !== p.number),
}));

// Two-week Sprints per AGENTS.md (Sprint 0 = foundation, up to 12 Sep 2026).
const sprints = [
  { name: 'Sprint 0', start: '', end: '2026-09-12' },
  { name: 'Sprint 1', start: '2026-09-13', end: '2026-09-26' },
  { name: 'Sprint 2', start: '2026-09-27', end: '2026-10-10' },
  { name: 'Sprint 3', start: '2026-10-11', end: '2026-10-24' },
];
const firstDay = [...issues, ...prs]
  .map((x) => x.c)
  .sort()[0]
  .slice(0, 10);
sprints[0].start = firstDay;
// Keep adding two-week Sprints so later activity never lands in a finished one.
const iso = (t) => new Date(t).toISOString().slice(0, 10);
while (sprints.at(-1).end < iso(Date.now())) {
  const last = Date.parse(sprints.at(-1).end);
  sprints.push({
    name: `Sprint ${sprints.length}`,
    start: iso(last + 864e5),
    end: iso(last + 14 * 864e5),
  });
}

const data = { generatedAt: new Date().toISOString(), sprints, issues, prs };
const template = readFileSync(new URL('./sprint-analytics.template.html', import.meta.url), 'utf8');
const out = new URL('../doc/analytics/sprint-analytics.html', import.meta.url);
mkdirSync(new URL('.', out), { recursive: true });
// Escape "<" so issue titles cannot close the inline <script>.
writeFileSync(
  out,
  template.replace(/\/\*DATA\*\/ ?null/, () => JSON.stringify(data).replace(/</g, '\\u003c')),
);
console.log(`Wrote ${out.pathname}: ${issues.length} issues, ${prs.length} PRs`);
