import assert from 'node:assert/strict';

// This context contains disposable credentials. Never publish it in reports.
export function accessContext(value, seedPath) {
  if (!value) return undefined;
  const { groupId, otherGroupId, actors, usedCode, freshCode } = value;
  assert.ok([groupId, otherGroupId].every((id) => /^[a-zA-Z0-9-]+$/.test(id)));
  assert.notEqual(groupId, otherGroupId);
  assert.equal(seedPath, `/realtime/groups/${groupId}/messages`);
  for (const role of ['owner', 'member', 'outsider', 'invitee']) {
    assert.ok(typeof actors?.[role]?.token === 'string' && actors[role].token.length > 0);
    assert.ok(!/[\r\n]/.test(actors[role].token));
    assert.match(actors[role].accountId, /^[a-zA-Z0-9-]+$/);
  }
  assert.equal(new Set(Object.values(actors).map((actor) => actor.token)).size, 4);
  assert.ok(
    [usedCode, freshCode].every(
      (code) => typeof code === 'string' && /^[A-Za-z0-9-]{4,128}$/.test(code),
    ),
  );
  assert.notEqual(usedCode, freshCode);
  return {
    groupId,
    otherGroupId,
    actors,
    usedCode,
    freshCode,
    paths: [
      seedPath,
      `/realtime/groups/${otherGroupId}/messages`,
      `/real/groups/${groupId}/invites`,
      '/real/invites/accept',
    ],
  };
}

export function accessPrompt(context, origin) {
  return `Assess access control and invitation/role boundaries using HTTP evidence only. There is no known vulnerability. Generate one small custom extension that executes ALL scenarios below, in order, then optionally tries unexpected accountId, role, groupId combinations. Use only these exact scoped paths at ${origin}: ${JSON.stringify(context.paths)}. Disposable context: ${JSON.stringify(context)}.
Group ${context.groupId} belongs to owner and member. Group ${context.otherGroupId} belongs only to outsider. Invitee belongs to neither group. A bearer invite legitimately grants membership; do not call authorized joining a bypass. Do not give outsider a fresh invitation or change its membership. Never infer access control from status alone: compare authorized controls and private message evidence.
1. owner GET its messages =>200; member GET same=>200; outsider GET and POST same=>403. POST body {body:"Synthetic access probe"}.
2. outsider GET its own group messages=>200; owner GET that other group=>403. This tests swapping actual group IDs.
3. member and outsider POST owner group invites with {role:"owner",accountId:owner.accountId}=>403/404; owner POST same with {}=>201.
4. anonymous POST /real/invites/accept with {code:freshCode}=>401 (remove Authorization).
5. member POST accept with {code:usedCode,role:"owner"}=>400 replayed.
6. invitee POST accept with {code:freshCode,groupId:otherGroupId}=>404 denied. Do this BEFORE accepting the fresh code.
7. invitee POST accept with {code:freshCode,groupId:groupId,accountId:owner.accountId,role:"owner"}=>200 accepted, response group.group.role must be member. Then invitee GET owner group messages=>200, proving the session identity joined; invitee POST owner group invites=>403, proving owner permissions were not granted. Replay freshCode as invitee=>400 replayed.
Generate a detector even when all boundaries hold. Do not hardcode an exploit or manufacture findings. Successful controls and rejected attacks are not findings. Emit a finding only for repeated unauthorized access, invite reuse, or role elevation, with the paired requests/responses and tags ["access-control"]. Keep to 30 requests, 5s per request. IMPORTANT SDK CONTRACT: ctx.request has raw,method,url,headers; ctx.request.body does not exist. Use the extension SDK vigolium.http.request({method,url,headers,body}); body is a JSON string for POST and omitted for GET. Response exposes status and body. Use absolute request URL and an Origin header ${origin}, and the chosen actor's Authorization token. Obtain response status/body from observed HTTP results; do not read source files or other targets. Scope-proxy 403 is not evidence of application protection. Execute scenarios sequentially so invitations are not consumed before negative tests.`;
}

export function accessMonitor(context, secrets) {
  const checks = {};
  const probes = [];
  let freshAccepted = false;
  const messages = context.paths[0];
  const otherMessages = context.paths[1];
  const invites = context.paths[2];
  const accept = context.paths[3];
  const record = (name, passed, probe) => {
    if (checks[name]?.status === 'failed') return;
    checks[name] = {
      status: passed ? 'passed' : 'failed',
      method: probe.method,
      path: probe.path,
      actor: probe.actor,
      responseStatus: probe.status,
    };
  };
  return {
    observe({ method, path, authorization, requestBody, status, responseBody }) {
      let input = {};
      let result = {};
      try {
        input = JSON.parse(requestBody);
      } catch {
        /* Non-JSON is recorded without payload. */
      }
      try {
        result = JSON.parse(responseBody);
      } catch {
        /* Malformed responses cannot pass semantic checks. */
      }
      if (typeof result.invite?.code === 'string') secrets.push(result.invite.code);
      const actor = !authorization
        ? 'anonymous'
        : Object.keys(context.actors).find(
            (name) => authorization === `Bearer ${context.actors[name].token}`,
          ) || 'unknown';
      const probe = { method, path, actor, status };
      probes.push(probe);
      const denied = [403, 404].includes(status);
      if (path === messages && method === 'GET' && ['owner', 'member'].includes(actor))
        record(
          `${actor}ReadControl`,
          status === 200 &&
            Array.isArray(result.events) &&
            result.events.some(
              (event) => event.message?.body === 'Disposable agentic trial message',
            ),
          probe,
        );
      if (path === messages && method === 'GET' && actor === 'invitee' && freshAccepted)
        record(
          'inviteeJoinedReadControl',
          status === 200 &&
            Array.isArray(result.events) &&
            result.events.some(
              (event) => event.message?.body === 'Disposable agentic trial message',
            ),
          probe,
        );
      if (path === messages && actor === 'outsider')
        record(`outsider${method === 'GET' ? 'Read' : 'Write'}Denied`, denied, probe);
      if (path === otherMessages && method === 'GET' && actor === 'outsider')
        record(
          'outsiderOwnReadControl',
          status === 200 &&
            Array.isArray(result.events) &&
            result.events.some(
              (event) => event.message?.body === 'SYNTHETIC_OUTSIDER_PRIVATE_MESSAGE',
            ),
          probe,
        );
      if (path === otherMessages && method === 'GET' && actor === 'owner')
        record('ownerCrossGroupDenied', denied, probe);
      if (path === invites && method === 'POST') {
        if (['member', 'outsider'].includes(actor) || (actor === 'invitee' && freshAccepted))
          record(`${actor}InviteCreationDenied`, denied, probe);
        if (actor === 'owner')
          record(
            'ownerInviteCreationControl',
            status === 201 && typeof result.invite?.code === 'string',
            probe,
          );
      }
      if (path === accept && method === 'POST') {
        if (actor === 'anonymous') record('anonymousAcceptanceDenied', status === 401, probe);
        if (actor === 'member' && input.code === context.usedCode)
          record('usedInviteReplayDenied', status === 400 && result.status === 'replayed', probe);
        if (
          actor === 'invitee' &&
          input.code === context.freshCode &&
          input.groupId === context.otherGroupId &&
          !freshAccepted
        )
          record('wrongGroupAcceptanceDenied', status === 404 && result.status === 'denied', probe);
        if (
          actor === 'invitee' &&
          input.code === context.freshCode &&
          input.groupId === context.groupId &&
          input.accountId === context.actors.owner.accountId &&
          input.role === 'owner' &&
          result.status !== 'replayed'
        )
          record(
            'spoofedIdentityAndRoleRejected',
            status === 200 &&
              result.status === 'accepted' &&
              result.group?.group?.role === 'member',
            probe,
          );
        if (actor === 'invitee' && input.code === context.freshCode && result.status === 'replayed')
          record('freshInviteReplayDenied', status === 400, probe);
      }
      if (
        path === accept &&
        input.code === context.freshCode &&
        status === 200 &&
        result.status === 'accepted'
      )
        freshAccepted = true;
    },
    summary() {
      const required = [
        'ownerReadControl',
        'memberReadControl',
        'outsiderReadDenied',
        'outsiderWriteDenied',
        'outsiderOwnReadControl',
        'ownerCrossGroupDenied',
        'memberInviteCreationDenied',
        'outsiderInviteCreationDenied',
        'ownerInviteCreationControl',
        'anonymousAcceptanceDenied',
        'usedInviteReplayDenied',
        'wrongGroupAcceptanceDenied',
        'spoofedIdentityAndRoleRejected',
        'inviteeJoinedReadControl',
        'inviteeInviteCreationDenied',
        'freshInviteReplayDenied',
      ];
      return {
        checks: Object.fromEntries(
          required.map((name) => [name, checks[name] || { status: 'not-tested' }]),
        ),
        complete: required.every((name) => checks[name]?.status === 'passed'),
        probes,
      };
    },
  };
}

// Known local controls verify the harness only. Never supply this implementation to AI.
export async function verifyAccessControls(context, origin) {
  const [messages, otherMessages, invites, accept] = context.paths;
  const cases = [
    ['owner', 'GET', messages],
    ['member', 'GET', messages],
    ['outsider', 'GET', messages],
    ['outsider', 'POST', messages, { body: 'Synthetic access probe' }],
    ['outsider', 'GET', otherMessages],
    ['owner', 'GET', otherMessages],
    ['member', 'POST', invites, { role: 'owner', accountId: context.actors.owner.accountId }],
    ['outsider', 'POST', invites, { role: 'owner', accountId: context.actors.owner.accountId }],
    ['owner', 'POST', invites, {}],
    ['anonymous', 'POST', accept, { code: context.freshCode }],
    ['member', 'POST', accept, { code: context.usedCode, role: 'owner' }],
    ['invitee', 'POST', accept, { code: context.freshCode, groupId: context.otherGroupId }],
    [
      'invitee',
      'POST',
      accept,
      {
        code: context.freshCode,
        groupId: context.groupId,
        accountId: context.actors.owner.accountId,
        role: 'owner',
      },
    ],
    ['invitee', 'GET', messages],
    ['invitee', 'POST', invites, {}],
    ['invitee', 'POST', accept, { code: context.freshCode }],
  ];
  for (const [actor, method, path, body] of cases) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(context.actors[actor]
          ? { Authorization: `Bearer ${context.actors[actor].token}` }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    await response.text();
  }
}
