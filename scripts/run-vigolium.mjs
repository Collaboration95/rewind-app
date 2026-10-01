import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { generateSummary } from './vigolium-summary.mjs';

const { parseConfig } = await import('../server/dist/config.js');
const { openDatabase } = await import('../server/dist/db.js');
const { createRuntimeServer } = await import('../server/dist/http.js');
const { createRealAccount } = await import('../server/dist/auth/index.js');

const outputDir = resolve('vigolium-result/automatic');
const dataDir = await mkdtemp(join(tmpdir(), 'rewind-vigolium-'));
const cli = resolve('node_modules/@vigolium/vigolium/bin/vigolium.js');
let database;
let server;

async function run(args) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 360_000);
  try {
    const [code] = await once(child, 'exit');
    if (code !== 0) throw new Error(`Vigolium exited with code ${code}`);
  } finally {
    clearTimeout(timer);
  }
}

try {
  await mkdir(outputDir, { recursive: true });
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
  });
  database = openDatabase(config, { seedNow: new Date('2026-09-01T00:00:00Z') });
  server = createRuntimeServer(config, database);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const targets = ['/health', '/profiles', '/auth/session', '/real/groups'];
  const scanFlags = [
    'scan',
    '--passive-only',
    '--only',
    'dynamic-assessment',
    '--skip-heuristics',
    '--scope-origin',
    'strict',
    '--redirect-mode',
    'off',
    '--rate-limit',
    '5',
    '--scanning-max-duration',
    '5m',
  ];
  const credentials = [];
  async function request(path, token, body, expectedStatus = 200) {
    const response = await fetch(`${origin}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, expectedStatus, `Unexpected status for ${path}`);
    return response.json();
  }
  async function provision(username) {
    const password = randomUUID();
    const account = await createRealAccount(database, username, username, password);
    assert.equal(account.ok, true, 'Disposable account creation failed');
    const auth = await request('/auth/login', null, { username, password, clientType: 'native' });
    assert.equal(typeof auth.token, 'string');
    credentials.push(password, auth.token);
    return auth.token;
  }
  async function scan(paths, token, label) {
    const flags = ['--db', join(dataDir, `${label}.sqlite`), '--skip-dependency-check'];
    await run([
      ...scanFlags,
      ...flags,
      ...(token ? ['-H', `Authorization: Bearer ${token}`] : []),
      ...paths.flatMap((path) => ['-t', `${origin}${path}`]),
    ]);
    await run([
      'export',
      ...flags,
      '--format',
      'html,jsonl',
      '--omit-response',
      '-o',
      join(dataDir, label),
    ]);
    for (const extension of ['html', 'jsonl']) {
      let content = await readFile(join(dataDir, `${label}.${extension}`), 'utf8');
      for (const credential of credentials) content = content.replaceAll(credential, '[REDACTED]');
      await writeFile(join(outputDir, `${label}.${extension}`), content);
    }
  }
  const owner = await provision('scan-owner');
  const member = await provision('scan-member');
  const outsider = await provision('scan-outsider');
  const created = await request(
    '/real/groups',
    owner,
    {
      name: 'Disposable scan group',
      prompt: 'Security setup trial',
      maxMembers: 4,
    },
    201,
  );
  const groupPath = `/real/groups/${created.group.id}`;
  const invitation = await request(`${groupPath}/invites`, owner, {}, 201);
  credentials.push(invitation.invite.code);
  await request('/real/invites/accept', member, { code: invitation.invite.code });
  const chatPath = `/realtime/groups/${created.group.id}/messages`;
  await request(chatPath, owner, { body: 'Disposable scan message' }, 201);
  const ownerTargets = [
    '/auth/session',
    '/real/groups',
    '/real/groups/current',
    groupPath,
    `${groupPath}/members`,
    chatPath,
  ];
  for (const path of ownerTargets) await request(path, owner);
  for (const path of ownerTargets) await request(path, member);
  await request(groupPath, outsider, null, 404);
  await request(`${groupPath}/members`, outsider, null, 404);
  await request('/auth/session', null, null, 401);
  await request(chatPath, outsider, null, 403);
  await request(chatPath, null, null, 401);
  await scan(targets, null, 'report');
  await scan(ownerTargets, owner, 'owner');
  await scan(ownerTargets, member, 'member');
  await scan([groupPath, `${groupPath}/members`, chatPath], outsider, 'outsider');
  for (const filename of [
    'report.html',
    'report.jsonl',
    'owner.html',
    'owner.jsonl',
    'member.html',
    'member.jsonl',
    'outsider.html',
    'outsider.jsonl',
  ]) {
    const reportPath = join(outputDir, filename);
    let report = await readFile(reportPath, 'utf8');
    for (const credential of credentials) report = report.replaceAll(credential, '[REDACTED]');
    await writeFile(reportPath, report);
  }
  await writeFile(
    join(outputDir, 'scope.json'),
    JSON.stringify(
      {
        mode: 'passive HTTP',
        sourceCommit:
          process.env.GITHUB_SHA ||
          process.env.REWIND_SCAN_COMMIT ||
          execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        targets,
        ownerTargets,
        memberTargets: ownerTargets,
        outsiderTargets: [groupPath, `${groupPath}/members`, chatPath],
        contexts: [
          { file: 'report', identity: 'Public / signed out' },
          { file: 'owner', identity: 'Group owner' },
          { file: 'member', identity: 'Joined member' },
          { file: 'outsider', identity: 'Outside the group' },
        ],
        expectedStatuses: { outsider: { [chatPath]: 403 } },
        accessChecks: {
          ownerRoutes: '200',
          outsiderGroupAndMembers: '404',
          memberRoutes: '200',
          outsiderChat: '403',
          anonymousChat: '401',
          anonymousSession: '401',
        },
        completedAt: new Date().toISOString(),
        limitations:
          'Passive HTTP with owner, joined member and outsider accounts, group and chat requests. Active checks run separately. No source audit, media journeys or browser crawling. Local HTTP auth is enabled only in this disposable loopback runtime.',
      },
      null,
      2,
    ) + '\n',
  );
  await generateSummary(outputDir);
  console.log(`Vigolium reports: ${outputDir}`);
} finally {
  if (server?.listening) {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
  database?.close();
  await rm(dataDir, { recursive: true, force: true });
}
