import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../server/dist/config.js';
import { openDatabase } from '../server/dist/db.js';
import { createRuntimeServer } from '../server/dist/http.js';
import { createRealAccount } from '../server/dist/auth/index.js';

// Application runtime lives in its own container, never in the AI worker.
export async function createRewindTarget({ endpoint = 'chat' } = {}) {
  assert.ok(['chat', 'groups'].includes(endpoint), 'Unsupported endpoint');
  const temporary = await mkdtemp(join(tmpdir(), 'rewind-dast-target-'));
  const database = openDatabase(
    parseConfig({
      REWIND_DATA_DIR: temporary,
      REWIND_HOST: '127.0.0.1',
      REWIND_PORT: '0',
      REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
    }),
  );
  const server = createRuntimeServer(
    parseConfig({
      REWIND_DATA_DIR: temporary,
      REWIND_HOST: '127.0.0.1',
      REWIND_PORT: '0',
      REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
    }),
    database,
  );
  async function close() {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const provision = async (username) => {
      const password = randomUUID();
      const account = await createRealAccount(database, username, username, password);
      assert.equal(account.ok, true);
      const login = await fetch(`${origin}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, clientType: 'native' }),
      });
      assert.equal(login.status, 200);
      const token = (await login.json()).token;
      assert.equal(typeof token, 'string');
      return {
        accountId: account.account.id,
        token,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      };
    };
    const owner = await provision('dast-owner');
    const outsider = await provision('dast-outsider');
    const member = await provision('dast-member');
    const group = await fetch(`${origin}/real/groups`, {
      method: 'POST',
      headers: owner.headers,
      body: JSON.stringify({
        name: 'Disposable DAST group',
        prompt: 'Synthetic trial',
        maxMembers: 4,
      }),
    });
    assert.equal(group.status, 201);
    const path = `/realtime/groups/${(await group.json()).group.id}/messages`;
    const body = JSON.stringify({ body: 'Disposable agentic trial message' });
    const check = async (method, headers, expected) => {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers,
        ...(method === 'POST' ? { body } : {}),
      });
      await response.text();
      assert.equal(response.status, expected);
      return response.status;
    };
    const baselines = {
      login: 200,
      groupCreation: 201,
      ownerPost: await check('POST', owner.headers, 201),
      ownerRead: await check('GET', owner.headers, 200),
      anonymousRead: await check('GET', {}, 401),
      outsiderRead: await check('GET', outsider.headers, 403),
      outsiderPost: await check('POST', outsider.headers, 403),
    };
    const accessChecks = {
      memberReadBeforeJoining: await check('GET', member.headers, 403),
      memberPostBeforeJoining: await check('POST', member.headers, 403),
    };
    const groupId = path.split('/')[3];
    const invitePath = `/real/groups/${groupId}/invites`;
    const unauthorizedInvite = await fetch(origin + invitePath, {
      method: 'POST',
      headers: outsider.headers,
      body: '{}',
    });
    await unauthorizedInvite.text();
    assert.ok([403, 404].includes(unauthorizedInvite.status));
    accessChecks.outsiderInviteCreation = unauthorizedInvite.status;
    const inviteResponse = await fetch(origin + invitePath, {
      method: 'POST',
      headers: owner.headers,
      body: '{}',
    });
    assert.equal(inviteResponse.status, 201);
    const invite = (await inviteResponse.json()).invite;
    accessChecks.ownerInviteCreation = 201;
    const accept = async (headers, code) =>
      fetch(`${origin}/real/invites/accept`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code, accountId: owner.accountId }),
      });
    const anonymousAccept = await accept({ 'Content-Type': 'application/json' }, invite.code);
    await anonymousAccept.text();
    assert.equal(anonymousAccept.status, 401);
    accessChecks.anonymousInviteAcceptance = 401;
    const accepted = await accept(member.headers, invite.code);
    assert.equal(accepted.status, 200);
    const joined = await accepted.json();
    assert.equal(joined.status, 'accepted');
    assert.equal(joined.group.group.role, 'member');
    assert.equal(
      database
        .prepare(
          "SELECT account_id AS accountId FROM real_group_memberships WHERE group_id = ? AND role = 'member'",
        )
        .get(groupId).accountId,
      member.accountId,
    );
    accessChecks.memberInviteAcceptance = 200;
    accessChecks.sessionAccountJoinedDespiteSpoofedAccountId = true;
    accessChecks.memberReadAfterJoining = await check('GET', member.headers, 200);
    accessChecks.memberPostAfterJoining = await check('POST', member.headers, 201);
    accessChecks.outsiderReadAfterJoining = await check('GET', outsider.headers, 403);
    accessChecks.outsiderPostAfterJoining = await check('POST', outsider.headers, 403);
    const replay = await accept(member.headers, invite.code);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).status, 'replayed');
    accessChecks.inviteReplay = 400;
    const memberInvite = await fetch(origin + invitePath, {
      method: 'POST',
      headers: member.headers,
      body: '{}',
    });
    await memberInvite.text();
    assert.equal(memberInvite.status, 403);
    accessChecks.memberInviteCreation = 403;
    return {
      origin,
      path: endpoint === 'groups' ? '/real/groups' : path,
      requestBody:
        endpoint === 'groups'
          ? { name: 'Disposable DAST group', prompt: 'Synthetic trial', maxMembers: 4 }
          : { body: 'Disposable agentic trial message' },
      token: owner.token,
      baselines,
      accessChecks,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[2] === '--serve') {
  const target = await createRewindTarget({
    endpoint: process.env.REWIND_AGENT_ENDPOINT || 'chat',
  });
  const directory = process.env.REWIND_TARGET_OUTPUT || '/reports';
  await writeFile(
    join(directory, 'target.json'),
    JSON.stringify({
      origin: target.origin,
      path: target.path,
      token: target.token,
      disposable: true,
      requestBody: target.requestBody,
      baselines: target.baselines,
      accessChecks: target.accessChecks,
    }),
  );
  await writeFile(join(directory, 'app-baselines.json'), JSON.stringify(target.baselines, null, 2));
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      await target.close();
      process.exit(0);
    });
}
