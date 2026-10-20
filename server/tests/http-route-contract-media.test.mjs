// Characterisation of the non-/real, non-/auth HTTP routes in server/src/http.ts:
// chat (/realtime/groups/...), contributions, clips, premiere and archive.
// These pin today's status codes, error codes and JSON headers so a refactor of
// the route table can be checked against them. Legacy film/download routes are
// intentionally not covered.
import assert from 'node:assert/strict';
import test from 'node:test';
import { defineCases, fill, routeFixture, send } from './helpers/route-contract.mjs';

const fx = await routeFixture();
const MALFORMED = '%E0%A4%A';
const KEY = 'route-contract-key';

/** Rows common to every group-scoped media route: session, membership, groupId, path decoding. */
function mediaRoute(method, path, { malformed, missingGroup = true, extra = {} } = {}) {
  const withGroup = `${path}${path.includes('?') ? '&' : '?'}groupId={g}`;
  return [
    { method, path: withGroup, actor: 'none', status: 401, error: 'session_required', ...extra },
    { method, path: withGroup, actor: 'unknown', status: 401, error: 'session_required', ...extra },
    { method, path: withGroup, actor: 'garbage', status: 401, error: 'session_required', ...extra },
    { method, path: withGroup, actor: 'outsider', status: 403, error: 'forbidden', ...extra },
    ...(missingGroup
      ? [
          { method, path, actor: 'owner', status: 403, error: 'forbidden', ...extra },
          {
            method,
            path: `${path}${path.includes('?') ? '&' : '?'}groupId=`,
            actor: 'owner',
            status: 403,
            error: 'forbidden',
            ...extra,
          },
          {
            method,
            path: `${path}${path.includes('?') ? '&' : '?'}groupId=${MALFORMED}`,
            actor: 'owner',
            status: 403,
            error: 'forbidden',
            ...extra,
          },
        ]
      : []),
    ...(malformed
      ? [
          {
            method,
            path: malformed,
            actor: 'owner',
            status: 400,
            error: 'invalid_request',
            ...extra,
          },
        ]
      : []),
  ];
}

defineCases(fx, [
  // ---- chat history ----------------------------------------------------
  ...['/realtime/groups/{g}/messages', '/realtime/groups/{g}/events'].flatMap((path) => [
    { path, actor: 'none', status: 401, error: 'session_required' },
    { path, actor: 'unknown', status: 401, error: 'session_required' },
    { path, actor: 'outsider', status: 403, error: 'forbidden' },
    { path: path.replace('{g}', MALFORMED), actor: 'owner', status: 400, error: 'invalid_request' },
    // decoding happens before authentication on the realtime routes
    { path: path.replace('{g}', MALFORMED), actor: 'none', status: 400, error: 'invalid_request' },
  ]),
  {
    path: '/realtime/groups/nonexistent-group/messages',
    actor: 'owner',
    status: 403,
    error: 'forbidden',
  },
  {
    path: '/realtime/groups/{g}/messages?limit=0',
    actor: 'owner',
    status: 400,
    error: 'invalid_chat_cursor',
  },
  {
    path: '/realtime/groups/{g}/messages?limit=101',
    actor: 'owner',
    status: 400,
    error: 'invalid_chat_cursor',
  },
  {
    path: '/realtime/groups/{g}/messages?limit=abc',
    actor: 'owner',
    status: 400,
    error: 'invalid_chat_cursor',
  },
  {
    path: '/realtime/groups/{g}/messages?beforeEventId=0',
    actor: 'owner',
    status: 400,
    error: 'invalid_chat_cursor',
  },
  {
    path: '/realtime/groups/{g}/messages?beforeEventId=x',
    actor: 'owner',
    status: 400,
    error: 'invalid_chat_cursor',
  },
  {
    path: '/realtime/groups/{g}/messages',
    actor: 'owner',
    status: 200,
    keys: ['events', 'hasMore', 'nextCursor', 'reactionRevision', 'watermarkEventId'],
    name: 'history page',
  },
  // wrong method on the chat paths falls through to the generic 404
  {
    method: 'DELETE',
    path: '/realtime/groups/{g}/messages',
    actor: 'owner',
    status: 404,
    error: 'not_found',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/events',
    actor: 'owner',
    status: 404,
    error: 'not_found',
  },
  {
    method: 'GET',
    path: '/realtime/groups/{g}/reaction-counts',
    actor: 'owner',
    status: 404,
    error: 'not_found',
  },
  { path: '/realtime/groups/{g}', actor: 'owner', status: 404, error: 'not_found' },
  { path: '/realtime/groups/{g}/unknown', actor: 'owner', status: 404, error: 'not_found' },

  // ---- chat send -------------------------------------------------------
  {
    method: 'POST',
    path: '/realtime/groups/{g}/messages',
    actor: 'none',
    body: { body: 'hi' },
    status: 401,
    error: 'session_required',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/messages',
    actor: 'outsider',
    body: { body: 'hi' },
    status: 403,
    error: 'forbidden',
  },
  {
    method: 'POST',
    path: `/realtime/groups/${MALFORMED}/messages`,
    actor: 'owner',
    body: { body: 'hi' },
    status: 400,
    error: 'invalid_request',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/messages',
    actor: 'owner',
    raw: '{not json',
    status: 400,
    error: 'message_empty_body',
    name: 'invalid JSON is treated as an empty body',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/messages',
    actor: 'owner',
    raw: '[1,2]',
    status: 400,
    error: 'message_empty_body',
    name: 'array JSON is treated as an empty body',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/messages',
    actor: 'owner',
    body: {},
    status: 400,
    error: 'message_empty_body',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/messages',
    actor: 'owner',
    body: { body: 'x'.repeat(5000) },
    status: 400,
    error: 'message_body_too_long',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/messages',
    actor: 'owner',
    body: { body: 'hi', replyToMessageId: 'missing-message' },
    status: 404,
    error: 'not_found',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/messages',
    actor: 'owner',
    oversize: 70_000,
    status: 413,
    error: 'payload_too_large',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/messages',
    actor: 'owner',
    body: { body: 'hello', messageId: 'rc-message-1' },
    status: 201,
    keys: ['event', 'message'],
    name: 'happy path',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/messages',
    actor: 'owner',
    body: { body: 'hello', messageId: 'rc-message-1' },
    status: 200,
    keys: ['deduplicated', 'event', 'message'],
    name: 'same retry is deduplicated',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/messages',
    actor: 'owner',
    body: { body: 'different', messageId: 'rc-message-1' },
    status: 409,
    error: 'message_duplicate_message',
  },

  // ---- reactions -------------------------------------------------------
  ...['GET', 'POST', 'DELETE'].flatMap((method) => [
    {
      method,
      path: '/realtime/groups/{g}/messages/rc-message-1/reactions',
      actor: 'none',
      status: 401,
      error: 'session_required',
    },
    {
      method,
      path: '/realtime/groups/{g}/messages/rc-message-1/reactions',
      actor: 'outsider',
      status: 403,
      error: 'forbidden',
    },
    {
      method,
      path: `/realtime/groups/${MALFORMED}/messages/rc-message-1/reactions`,
      actor: 'owner',
      status: 400,
      error: 'invalid_request',
    },
    {
      method,
      path: `/realtime/groups/{g}/messages/${MALFORMED}/reactions`,
      actor: 'owner',
      status: 400,
      error: 'invalid_request',
    },
    {
      method,
      path: `/realtime/groups/{g}/messages/rc-message-1/reactions/${MALFORMED}`,
      actor: 'owner',
      status: 400,
      error: 'invalid_request',
    },
    {
      method,
      path: '/realtime/groups/{g}/messages/no-such-message/reactions',
      actor: 'owner',
      status: 404,
      error: 'not_found',
    },
  ]),
  {
    method: 'PUT',
    path: '/realtime/groups/{g}/messages/rc-message-1/reactions',
    actor: 'owner',
    status: 405,
    error: 'method_not_allowed',
  },
  {
    path: '/realtime/groups/{g}/messages/rc-message-1/reactions',
    actor: 'owner',
    status: 200,
    keys: ['message'],
    name: 'GET reaction view',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/messages/rc-message-1/reactions',
    actor: 'owner',
    body: { emoji: 'not-an-emoji' },
    status: 400,
    error: 'reaction_unsupported_reaction',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/messages/rc-message-1/reactions',
    actor: 'owner',
    raw: '{bad',
    status: 200,
    keys: ['message', 'ok', 'reaction', 'reactionRevision'],
    name: 'invalid JSON toggles the default reaction',
  },
  {
    method: 'DELETE',
    path: '/realtime/groups/{g}/messages/rc-message-1/reactions',
    actor: 'owner',
    status: 200,
    keys: ['message', 'ok', 'reaction', 'reactionRevision'],
    name: 'DELETE removes the default reaction',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/messages/rc-message-1/reactions',
    actor: 'owner',
    oversize: 70_000,
    status: 413,
    error: 'payload_too_large',
  },

  // ---- reaction snapshot ----------------------------------------------
  {
    method: 'POST',
    path: '/realtime/groups/{g}/reaction-counts',
    actor: 'none',
    body: { messageIds: [] },
    status: 401,
    error: 'session_required',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/reaction-counts',
    actor: 'outsider',
    body: { messageIds: [] },
    status: 403,
    error: 'forbidden',
  },
  {
    method: 'POST',
    path: `/realtime/groups/${MALFORMED}/reaction-counts`,
    actor: 'owner',
    body: { messageIds: [] },
    status: 400,
    error: 'invalid_request',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/reaction-counts',
    actor: 'owner',
    body: {},
    status: 400,
    error: 'invalid_reaction_snapshot',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/reaction-counts',
    actor: 'owner',
    raw: '{bad',
    status: 400,
    error: 'invalid_reaction_snapshot',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/reaction-counts',
    actor: 'owner',
    body: { messageIds: [1] },
    status: 400,
    error: 'invalid_reaction_snapshot',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/reaction-counts',
    actor: 'owner',
    body: { messageIds: Array.from({ length: 101 }, (_, i) => `m${i}`) },
    status: 400,
    error: 'invalid_reaction_snapshot',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/reaction-counts',
    actor: 'owner',
    oversize: 70_000,
    status: 413,
    error: 'payload_too_large',
  },
  {
    method: 'POST',
    path: '/realtime/groups/{g}/reaction-counts',
    actor: 'owner',
    body: { messageIds: ['rc-message-1'] },
    status: 200,
    keys: ['messages', 'revision'],
  },

  // ---- upload source ---------------------------------------------------
  ...mediaRoute('POST', `/contributions/upload/source?idempotencyKey=${KEY}`, {
    extra: { headers: { 'Content-Type': 'video/mp4' } },
  }),
  {
    method: 'POST',
    path: '/contributions/upload/source?groupId={g}',
    actor: 'owner',
    headers: { 'Content-Type': 'video/mp4' },
    status: 400,
    error: 'upload_invalid_key',
    name: 'missing idempotency key',
  },
  {
    method: 'POST',
    path: '/contributions/upload/source?groupId={g}&idempotencyKey=short',
    actor: 'owner',
    headers: { 'Content-Type': 'video/mp4' },
    status: 400,
    error: 'upload_invalid_key',
  },
  {
    method: 'POST',
    path: `/contributions/upload/source?groupId={g}&idempotencyKey=${KEY}`,
    actor: 'owner',
    headers: { 'Content-Type': 'text/plain' },
    status: 400,
    error: 'upload_invalid_media',
  },
  {
    method: 'POST',
    path: `/contributions/upload/source?groupId={g}&idempotencyKey=${KEY}`,
    actor: 'owner',
    status: 400,
    error: 'upload_invalid_media',
    name: 'no content type',
  },
  {
    method: 'GET',
    path: `/contributions/upload/source?groupId={g}&idempotencyKey=${KEY}`,
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },

  // ---- upload metadata -------------------------------------------------
  ...mediaRoute('POST', '/contributions/upload', { extra: { body: {} } }),
  {
    method: 'POST',
    path: '/contributions/upload?groupId={g}',
    actor: 'owner',
    body: { replacesContributionId: 5 },
    status: 400,
    error: 'upload_invalid_replacement_target',
  },
  {
    method: 'POST',
    path: '/contributions/upload?groupId={g}',
    actor: 'owner',
    body: {},
    status: 400,
    error: 'upload_invalid_key',
  },
  {
    method: 'POST',
    path: '/contributions/upload?groupId={g}',
    actor: 'owner',
    raw: '{bad',
    status: 400,
    error: 'upload_invalid_key',
    name: 'invalid JSON is treated as an empty body',
  },
  {
    method: 'POST',
    path: '/contributions/upload?groupId={g}',
    actor: 'owner',
    oversize: 70_000,
    status: 413,
    error: 'payload_too_large',
  },

  // ---- upload cancel ---------------------------------------------------
  ...mediaRoute('DELETE', '/contributions/upload/no-such-job', {
    malformed: `/contributions/upload/${MALFORMED}?groupId={g}`,
  }),
  {
    method: 'DELETE',
    path: '/contributions/upload/no-such-job?groupId={g}',
    actor: 'owner',
    status: 404,
    error: 'not_found',
  },

  // ---- job processing --------------------------------------------------
  ...mediaRoute('POST', '/contributions/jobs/no-such-job/process', {
    malformed: `/contributions/jobs/${MALFORMED}/process?groupId={g}`,
  }),
  {
    method: 'POST',
    path: '/contributions/jobs/no-such-job/process?groupId={g}',
    actor: 'owner',
    status: 404,
    error: 'not_found',
  },
  {
    method: 'GET',
    path: '/contributions/jobs/no-such-job/process?groupId={g}',
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },

  // ---- clip status (GET /clips/:id) -------------------------------------
  ...mediaRoute('GET', '/clips/no-such-clip', { malformed: `/clips/${MALFORMED}?groupId={g}` }),
  { path: '/clips/no-such-clip?groupId={g}', actor: 'owner', status: 404, error: 'not_found' },
  {
    method: 'POST',
    path: '/clips/no-such-clip?groupId={g}',
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },
  {
    path: `/clips/${MALFORMED}`,
    actor: 'none',
    status: 400,
    error: 'invalid_request',
    name: 'decoding happens before authentication',
  },

  // ---- contribution ledger and detail ----------------------------------
  ...mediaRoute('GET', '/contributions'),
  {
    path: '/contributions?groupId={g}',
    actor: 'owner',
    status: 200,
    keys: ['allowance', 'cycleId', 'entries', 'latestContribution', 'memberId', 'pagination'],
    name: 'empty ledger',
  },
  {
    path: '/contributions?groupId={g}&state=bogus',
    actor: 'owner',
    status: 400,
    error: 'invalid_ledger_request',
  },
  {
    path: '/contributions?groupId={g}&limit=0',
    actor: 'owner',
    status: 400,
    error: 'invalid_ledger_request',
  },
  {
    path: '/contributions?groupId={g}&cursor=bogus',
    actor: 'owner',
    status: 400,
    error: 'invalid_ledger_request',
  },
  ...mediaRoute('GET', '/contributions/no-such-contribution', {
    malformed: `/contributions/${MALFORMED}?groupId={g}`,
  }),
  ...mediaRoute('DELETE', '/contributions/no-such-contribution', {
    malformed: `/contributions/${MALFORMED}?groupId={g}`,
  }),
  {
    path: '/contributions/no-such-contribution?groupId={g}',
    actor: 'owner',
    status: 404,
    error: 'not_found',
  },
  {
    method: 'DELETE',
    path: '/contributions/no-such-contribution?groupId={g}',
    actor: 'owner',
    status: 404,
    error: 'contribution_not_found',
  },
  // the single-segment contribution route has no method check
  {
    method: 'POST',
    path: '/contributions/no-such-contribution?groupId={g}',
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'POST is served like GET',
  },
  {
    method: 'POST',
    path: '/contributions?groupId={g}',
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'POST collection is served like GET detail',
  },
  { path: '/contributions/a/b?groupId={g}', actor: 'owner', status: 404, error: 'not_found' },

  // ---- premiere --------------------------------------------------------
  ...mediaRoute('GET', '/cycles/{c}/premiere', {
    malformed: `/cycles/${MALFORMED}/premiere?groupId={g}`,
  }),
  {
    path: '/cycles/no-such-cycle/premiere?groupId={g}',
    actor: 'owner',
    status: 404,
    error: 'not_found',
  },
  {
    path: '/cycles/{c}/premiere?groupId={g}',
    actor: 'owner',
    status: 200,
    keys: ['premiere'],
    name: 'locked premiere',
  },
  {
    path: '/cycles/{c}/premiere?groupId={g}',
    actor: 'member',
    status: 200,
    keys: ['premiere'],
    name: 'member sees the premiere',
  },
  {
    method: 'POST',
    path: '/cycles/{c}/premiere?groupId={g}',
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },
  { path: '/cycles/{c}?groupId={g}', actor: 'owner', status: 404, error: 'not_found' },

  // ---- archive ---------------------------------------------------------
  ...mediaRoute('GET', '/archive'),
  {
    path: '/archive?groupId={g}',
    actor: 'owner',
    status: 200,
    keys: ['archive', 'pagination'],
    name: 'empty archive',
  },
  {
    path: '/archive?groupId={g}&filmCursor=bogus',
    actor: 'owner',
    status: 400,
    error: 'invalid_page_cursor',
  },
  {
    path: '/archive?groupId={g}&clipCursor=bogus',
    actor: 'owner',
    status: 400,
    error: 'invalid_page_cursor',
  },
  {
    path: '/archive?groupId={g}&limit=abc&includeFilms=false&includeClips=false',
    actor: 'owner',
    status: 200,
    keys: ['archive', 'pagination'],
  },
  {
    method: 'POST',
    path: '/archive?groupId={g}',
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },
  {
    method: 'DELETE',
    path: '/archive?groupId={g}',
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },
  { path: '/archive/extra?groupId={g}', actor: 'owner', status: 404, error: 'not_found' },
]);

test('smoke: bodies of the happy paths carry no volatile top-level surprises', async () => {
  const empty = await send(fx, { path: '/archive?groupId={g}', actor: 'owner' });
  assert.deepEqual(empty.json.archive, { films: [], clips: [] });
  assert.deepEqual(empty.json.pagination, {
    filmCursor: null,
    clipCursor: null,
    hasMoreFilms: false,
    hasMoreClips: false,
  });
  const premiere = await send(fx, { path: '/cycles/{c}/premiere?groupId={g}', actor: 'owner' });
  assert.deepEqual(premiere.json, { premiere: { state: 'locked', cycleId: fx.ids.c } });
  const ledger = await send(fx, { path: '/contributions?groupId={g}', actor: 'owner' });
  assert.deepEqual(ledger.json.entries, []);
});

test('a chat denial for an EventSource caller is a terminal SSE frame, not a JSON error', async () => {
  for (const [actor, path] of [
    ['none', '/realtime/groups/{g}/events'],
    ['outsider', '/realtime/groups/{g}/events'],
    ['outsider', '/realtime/groups/{g}/messages'],
  ]) {
    const { response, status, text } = await send(fx, {
      path,
      actor,
      headers: { Accept: 'text/event-stream' },
    });
    assert.equal(status, 200, `${actor} ${path}`);
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-cache, no-store');
    assert.match(text, /^event: access-denied\n/);
    assert.equal(JSON.parse(text.split('data: ')[1]).allowed, false);
  }
});

test('JSON routes outside /auth and /real send the configured wildcard origin; auth-guarded ones do not', async () => {
  const unknown = await send(fx, { path: '/nowhere' });
  assert.equal(unknown.response.headers.get('access-control-allow-origin'), '*');
  assert.equal(
    unknown.response.headers.get('access-control-allow-methods'),
    'GET, HEAD, POST, DELETE, OPTIONS',
  );
  const denied = await send(fx, { path: '/archive?groupId={g}' });
  assert.equal(denied.status, 401);
  assert.equal(denied.response.headers.get('access-control-allow-origin'), null);
  const outsider = await send(fx, { path: '/archive?groupId={g}', actor: 'outsider' });
  assert.equal(outsider.status, 403);
  assert.equal(outsider.response.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(outsider.json, {
    allowed: false,
    status: 403,
    error: 'forbidden',
    message: 'You do not have access to this resource.',
  });
});

test('fill() encodes placeholders', () => {
  assert.equal(fill(fx, '/x/{g}'), `/x/${encodeURIComponent(fx.ids.g)}`);
});
