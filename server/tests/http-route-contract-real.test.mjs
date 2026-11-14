// Characterisation of the /real/* routes in server/src/http.ts: the transport
// and origin guard, session requirement, group membership checks, path decoding
// and JSON body handling. Records current behaviour ahead of a route-table
// refactor; expectations are observed values, not endorsements.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { defineCases, routeFixture, send } from './helpers/route-contract.mjs';

const ORIGIN = 'https://rewind.example';
const SECRET = 'route-contract-origin-secret';
const fx = await routeFixture({
  env: { REWIND_ALLOW_ORIGIN: ORIGIN, REWIND_ORIGIN_AUTH_SECRET: SECRET },
});
const MALFORMED = '%E0%A4%A';
/** What an authenticated reverse proxy adds in hosted environments. */
const proxy = {
  Origin: ORIGIN,
  'x-rewind-origin-auth': SECRET,
  'x-forwarded-proto': 'https',
  Host: 'rewind.example',
};

// Local loopback requests (no proxy headers) may use plain HTTP and carry no Origin.
const group = '/real/groups/{g}';

/** fetch() cannot override Host, so use node:http for that one case. */
function rawRequest(baseUrl, path, headers) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Session-first rows for a route: every /real route answers 401 without a session. */
const noSession = (method, path, body) => [
  { method, path, actor: 'none', body, status: 401, error: 'session_required' },
  { method, path, actor: 'unknown', body, status: 401, error: 'session_required' },
  { method, path, actor: 'garbage', body, status: 401, error: 'session_required' },
];

defineCases(fx, [
  // ---- session requirement on every /real route ------------------------
  ...noSession('GET', '/real/reminders/config'),
  ...noSession('GET', '/real/media/config'),
  ...noSession('GET', '/real/groups'),
  ...noSession('GET', '/real/groups/current'),
  ...noSession('POST', '/real/groups/current', {}),
  ...noSession('POST', '/real/groups', {}),
  ...noSession('GET', `${group}`),
  ...noSession('GET', `${group}/members`),
  ...noSession('GET', `${group}/settings`),
  ...noSession('POST', `${group}/settings`, {}),
  ...noSession('GET', `${group}/reminders`),
  ...noSession('POST', `${group}/reminders`, {}),
  ...noSession('GET', `${group}/reminders/destinations`),
  ...noSession('GET', `${group}/reminders/outbox`),
  ...noSession('POST', `${group}/reminders/destinations`, {}),
  ...noSession('POST', `${group}/reminders/destinations/d1`, {}),
  ...noSession('GET', `${group}/upload-intents`),
  ...noSession('POST', `${group}/upload-intents`, {}),
  ...noSession('GET', `${group}/upload-intents/i1`),
  ...noSession('POST', `${group}/upload-intents/i1/complete`, {}),
  ...noSession('POST', `${group}/upload-intents/i1/reconcile`, {}),
  ...noSession('POST', `${group}/reports`, {}),
  ...noSession('POST', `${group}/contributions/x/remove`, {}),
  ...noSession('POST', `${group}/invites`, {}),
  ...noSession('DELETE', `${group}/invites/i1`),
  ...noSession('POST', '/real/invites/accept', {}),
  ...noSession('GET', '/real/blocks'),
  ...noSession('POST', '/real/blocks', {}),
  ...noSession('DELETE', '/real/blocks/p1'),
  ...noSession('GET', '/real/unknown-route'),
  // decoding of group segments happens after the session check on /real
  {
    path: `/real/groups/${MALFORMED}/members`,
    actor: 'none',
    status: 401,
    error: 'session_required',
  },

  // ---- transport / origin guard ----------------------------------------
  {
    path: '/real/groups',
    actor: 'owner',
    headers: { Origin: 'https://attacker.example' },
    status: 403,
    error: 'auth_transport_unavailable',
    name: 'foreign Origin',
  },
  {
    path: '/real/groups',
    actor: 'owner',
    headers: { Origin: 'http://127.0.0.1' },
    status: 403,
    error: 'auth_transport_unavailable',
    name: 'Origin that is not the configured one',
  },
  {
    path: '/real/groups',
    actor: 'owner',
    headers: { 'x-forwarded-proto': 'https' },
    status: 403,
    error: 'auth_transport_unavailable',
    name: 'x-forwarded-proto without the origin-auth secret',
  },
  {
    path: '/real/groups',
    actor: 'owner',
    headers: { 'x-forwarded-proto': 'https', 'x-rewind-origin-auth': 'wrong-secret-value-xx' },
    status: 403,
    error: 'auth_transport_unavailable',
    name: 'wrong origin-auth secret',
  },
  {
    path: '/real/groups',
    actor: 'owner',
    headers: { 'x-forwarded-proto': 'http', 'x-rewind-origin-auth': SECRET },
    status: 403,
    error: 'auth_transport_unavailable',
    name: 'proxy secret with http scheme',
  },
  {
    path: '/real/groups',
    actor: 'none',
    headers: { Origin: 'https://attacker.example' },
    status: 403,
    error: 'auth_transport_unavailable',
    name: 'transport is checked before the session',
  },
  {
    path: '/real/groups',
    actor: 'owner',
    headers: proxy,
    status: 200,
    keys: ['groups'],
    name: 'authenticated proxy with the configured origin',
  },
  {
    path: '/real/groups',
    actor: 'owner',
    headers: { ...proxy, Origin: 'https://attacker.example' },
    status: 403,
    error: 'auth_transport_unavailable',
  },
  {
    path: '/real/groups',
    actor: 'owner',
    headers: { Origin: ORIGIN },
    status: 200,
    keys: ['groups'],
    name: 'configured Origin on loopback',
  },

  // ---- config endpoints -------------------------------------------------
  {
    path: '/real/reminders/config',
    actor: 'owner',
    status: 200,
    keys: ['providers', 'webPushPublicKey'],
  },
  {
    path: '/real/media/config',
    actor: 'owner',
    status: 200,
    keys: ['directTransfer', 'maxPhotoBytes', 'maxVideoBytes'],
  },
  {
    path: '/real/media/config?uploadProtocol=2',
    actor: 'owner',
    status: 200,
    keys: ['directTransfer', 'maxPhotoBytes', 'maxVideoBytes'],
  },
  {
    method: 'POST',
    path: '/real/reminders/config',
    actor: 'owner',
    status: 404,
    error: 'not_found',
  },
  { method: 'POST', path: '/real/media/config', actor: 'owner', status: 404, error: 'not_found' },

  // ---- groups: list / current / select / create -------------------------
  { path: '/real/groups', actor: 'owner', status: 200, keys: ['groups'] },
  {
    path: '/real/groups',
    actor: 'outsider',
    status: 200,
    keys: ['groups'],
    name: 'lists only own groups',
  },
  { path: '/real/groups/current', actor: 'owner', status: 200, keys: ['group'] },
  {
    method: 'POST',
    path: '/real/groups/current',
    actor: 'owner',
    body: {},
    status: 400,
    error: 'invalid_group',
  },
  {
    method: 'POST',
    path: '/real/groups/current',
    actor: 'owner',
    raw: '{bad',
    status: 400,
    error: 'invalid_group',
  },
  {
    method: 'POST',
    path: '/real/groups/current',
    actor: 'owner',
    body: { groupId: 5 },
    status: 400,
    error: 'invalid_group',
  },
  {
    method: 'POST',
    path: '/real/groups/current',
    actor: 'outsider',
    body: { groupId: '{g}' },
    status: 404,
    error: 'forbidden',
    name: 'selecting a group the caller is not in',
  },
  {
    method: 'POST',
    path: '/real/groups/current',
    actor: 'owner',
    body: { groupId: 'no-such-group' },
    status: 404,
    error: 'forbidden',
  },
  {
    method: 'POST',
    path: '/real/groups/current',
    actor: 'owner',
    oversize: 70_000,
    status: 413,
    error: 'payload_too_large',
  },
  {
    method: 'POST',
    path: '/real/groups/current',
    actor: 'owner',
    body: { groupId: '{g}' },
    status: 200,
    keys: ['group'],
    name: 'reselect own group',
  },
  {
    method: 'POST',
    path: '/real/groups',
    actor: 'creator',
    body: { name: 'Created by contract', prompt: 'A prompt?', maxMembers: 3 },
    status: 201,
    keys: ['cycle', 'group', 'memberId', 'releases'],
    name: 'create a group',
  },
  {
    method: 'POST',
    path: '/real/groups',
    actor: 'creator',
    raw: '{bad',
    status: 400,
    error: 'invalid_group',
  },
  {
    method: 'POST',
    path: '/real/groups',
    actor: 'creator',
    body: {},
    status: 400,
    error: 'invalid_group',
  },
  {
    method: 'POST',
    path: '/real/groups',
    actor: 'creator',
    body: { name: 'x', prompt: 'y', maxMembers: 99 },
    status: 400,
    error: 'invalid_group',
  },
  {
    method: 'POST',
    path: '/real/groups',
    actor: 'creator',
    oversize: 70_000,
    status: 413,
    error: 'payload_too_large',
  },
  // the group-creation bucket holds five tokens and invalid requests spend them too
  {
    method: 'POST',
    path: '/real/groups',
    actor: 'creator',
    body: {},
    status: 429,
    error: 'rate_limited',
    name: 'sixth attempt in the window',
  },
  {
    method: 'DELETE',
    path: '/real/groups',
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },
  {
    method: 'DELETE',
    path: '/real/groups/current',
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },

  // ---- single group + members -------------------------------------------
  { path: group, actor: 'owner', status: 200, keys: ['group'] },
  { path: group, actor: 'member', status: 200, keys: ['group'] },
  { path: group, actor: 'outsider', status: 404, error: 'forbidden' },
  { path: '/real/groups/no-such-group', actor: 'owner', status: 404, error: 'forbidden' },
  { path: `/real/groups/${MALFORMED}`, actor: 'owner', status: 400, error: 'invalid_request' },
  {
    method: 'POST',
    path: group,
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },
  {
    method: 'DELETE',
    path: group,
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },
  {
    path: `${group}/members`,
    actor: 'owner',
    status: 200,
    keys: ['group', 'members', 'pendingInviteCount'],
  },
  { path: `${group}/members`, actor: 'member', status: 200 },
  { path: `${group}/members`, actor: 'outsider', status: 404, error: 'forbidden' },
  {
    path: `/real/groups/${MALFORMED}/members`,
    actor: 'owner',
    status: 400,
    error: 'invalid_request',
  },
  {
    method: 'POST',
    path: `${group}/members`,
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },
  { path: `${group}/nope`, actor: 'owner', status: 404, error: 'not_found' },

  // ---- settings and reminder preference ---------------------------------
  { path: `${group}/reminders`, actor: 'owner', status: 200, keys: ['preference'] },
  { path: `${group}/reminders`, actor: 'outsider', status: 403, error: 'forbidden' },
  {
    path: `/real/groups/${MALFORMED}/reminders`,
    actor: 'owner',
    status: 400,
    error: 'invalid_request',
  },
  {
    path: `${group}/settings`,
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'GET settings has no handler (POST only)',
  },
  { path: `${group}/settings`, actor: 'outsider', status: 403, error: 'forbidden' },
  {
    path: `/real/groups/${MALFORMED}/settings`,
    actor: 'owner',
    status: 400,
    error: 'invalid_request',
  },
  {
    method: 'POST',
    path: `${group}/settings`,
    actor: 'outsider',
    body: { prompt: 'p' },
    status: 403,
    error: 'forbidden',
  },
  {
    method: 'POST',
    path: `${group}/settings`,
    actor: 'member',
    body: { prompt: 'Member prompt', timeZone: 'Asia/Singapore' },
    status: 403,
    error: 'forbidden',
    name: 'only the owner may change settings',
  },
  {
    method: 'POST',
    path: `/real/groups/${MALFORMED}/settings`,
    actor: 'owner',
    body: {},
    status: 400,
    error: 'invalid_request',
  },
  {
    method: 'POST',
    path: `${group}/settings`,
    actor: 'owner',
    raw: '{bad',
    status: 400,
    error: 'invalid_settings',
  },
  {
    method: 'POST',
    path: `${group}/settings`,
    actor: 'owner',
    body: { unknown: 1 },
    status: 400,
    error: 'invalid_settings',
  },
  {
    method: 'POST',
    path: `${group}/settings`,
    actor: 'owner',
    body: { prompt: '' },
    status: 400,
    error: 'invalid_settings',
    name: 'invalid prompt',
  },
  {
    method: 'POST',
    path: `${group}/settings`,
    actor: 'owner',
    oversize: 70_000,
    status: 413,
    error: 'payload_too_large',
  },
  {
    method: 'POST',
    path: `${group}/settings`,
    actor: 'owner',
    body: { prompt: 'Contract prompt', timeZone: 'Asia/Singapore' },
    status: 200,
    name: 'owner updates settings',
  },
  {
    method: 'POST',
    path: `${group}/reminders`,
    actor: 'outsider',
    body: { enabled: true },
    status: 403,
    error: 'forbidden',
  },
  {
    method: 'POST',
    path: `${group}/reminders`,
    actor: 'member',
    raw: '{bad',
    status: 400,
    error: 'invalid_settings',
  },
  {
    method: 'POST',
    path: `${group}/reminders`,
    actor: 'member',
    body: { prompt: 'x' },
    status: 400,
    error: 'invalid_settings',
    name: 'settings keys are rejected on reminders',
  },
  {
    method: 'POST',
    path: `${group}/reminders`,
    actor: 'member',
    body: { enabled: true },
    status: 400,
    error: 'invalid_preference',
    name: 'snoozedUntil is required',
  },
  {
    method: 'POST',
    path: `${group}/reminders`,
    actor: 'member',
    body: { enabled: true, snoozedUntil: null },
    status: 200,
    name: 'member sets own preference',
  },
  {
    method: 'DELETE',
    path: `${group}/settings`,
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },

  // ---- reminder destinations / outbox -----------------------------------
  { path: `${group}/reminders/destinations`, actor: 'owner', status: 200, keys: ['destinations'] },
  { path: `${group}/reminders/outbox`, actor: 'owner', status: 200, keys: ['outbox'] },
  { path: `${group}/reminders/destinations`, actor: 'outsider', status: 403, error: 'forbidden' },
  { path: `${group}/reminders/outbox`, actor: 'outsider', status: 403, error: 'forbidden' },
  {
    path: `/real/groups/${MALFORMED}/reminders/destinations`,
    actor: 'owner',
    status: 400,
    error: 'invalid_request',
  },
  {
    path: `${group}/reminders/destinations/${MALFORMED}`,
    actor: 'owner',
    status: 400,
    error: 'invalid_request',
  },
  {
    path: `${group}/reminders/destinations?deviceId=short`,
    actor: 'owner',
    status: 400,
    error: 'invalid_destination',
  },
  {
    path: `${group}/reminders/outbox?deviceId=aaaaaaaaaaaaaaaa`,
    actor: 'owner',
    status: 400,
    error: 'invalid_destination',
  },
  {
    path: `${group}/reminders/destinations?deviceId=aaaaaaaaaaaaaaaa&deviceId=bbbbbbbbbbbbbbbb`,
    actor: 'owner',
    status: 400,
    error: 'invalid_destination',
  },
  {
    path: `${group}/reminders/destinations?deviceId=aaaaaaaaaaaaaaaa`,
    actor: 'owner',
    status: 200,
    keys: ['destinations'],
  },
  {
    method: 'POST',
    path: `${group}/reminders/destinations`,
    actor: 'outsider',
    body: {},
    status: 403,
    error: 'forbidden',
  },
  {
    method: 'POST',
    path: `${group}/reminders/destinations`,
    actor: 'owner',
    raw: '{bad',
    status: 400,
    error: 'invalid_destination',
  },
  {
    method: 'POST',
    path: `${group}/reminders/destinations`,
    actor: 'owner',
    body: { extra: 1 },
    status: 400,
    error: 'invalid_destination',
  },
  {
    method: 'POST',
    path: `${group}/reminders/destinations`,
    actor: 'owner',
    oversize: 70_000,
    status: 413,
    error: 'payload_too_large',
  },
  {
    method: 'POST',
    path: `${group}/reminders/destinations`,
    actor: 'owner',
    body: { deviceId: 'aaaaaaaaaaaaaaaa', provider: 'webpush', destination: {} },
    status: 503,
    error: 'reminders_unavailable',
    name: 'no provider configured',
  },
  {
    method: 'POST',
    path: `${group}/reminders/destinations/d1`,
    actor: 'owner',
    body: { enabled: true },
    status: 404,
    error: 'destination_unavailable',
    name: 'only enabled:false is accepted',
  },
  {
    method: 'POST',
    path: `${group}/reminders/destinations/d1`,
    actor: 'owner',
    body: { other: 1 },
    status: 400,
    error: 'invalid_destination',
  },
  {
    method: 'POST',
    path: `${group}/reminders/destinations/d1`,
    actor: 'owner',
    body: { enabled: false },
    status: 404,
    error: 'destination_unavailable',
  },
  {
    method: 'POST',
    path: `${group}/reminders/outbox`,
    actor: 'owner',
    body: {},
    status: 405,
    error: 'method_not_allowed',
  },
  {
    method: 'DELETE',
    path: `${group}/reminders/destinations`,
    actor: 'owner',
    status: 405,
    error: 'method_not_allowed',
  },
  {
    method: 'GET',
    path: `${group}/reminders/destinations/d1`,
    actor: 'owner',
    status: 405,
    error: 'method_not_allowed',
  },

  // ---- upload intents (feature unavailable in this runtime) -------------
  { path: `${group}/upload-intents`, actor: 'outsider', status: 403, error: 'forbidden' },
  {
    method: 'POST',
    path: `${group}/upload-intents`,
    actor: 'outsider',
    body: {},
    status: 403,
    error: 'forbidden',
  },
  {
    path: `/real/groups/${MALFORMED}/upload-intents`,
    actor: 'owner',
    status: 400,
    error: 'invalid_request',
  },
  {
    path: `${group}/upload-intents/${MALFORMED}`,
    actor: 'owner',
    status: 400,
    error: 'invalid_request',
  },
  {
    path: `${group}/upload-intents`,
    actor: 'owner',
    status: 503,
    error: 'upload_intents_unavailable',
  },
  {
    method: 'POST',
    path: `${group}/upload-intents`,
    actor: 'owner',
    body: {},
    status: 503,
    error: 'upload_intents_unavailable',
  },
  {
    path: `${group}/upload-intents/i1`,
    actor: 'owner',
    status: 503,
    error: 'upload_intents_unavailable',
  },
  {
    method: 'POST',
    path: `${group}/upload-intents/i1/complete`,
    actor: 'owner',
    body: {},
    status: 503,
    error: 'upload_intents_unavailable',
  },
  {
    method: 'POST',
    path: `${group}/upload-intents/i1/reconcile`,
    actor: 'owner',
    body: {},
    status: 503,
    error: 'upload_intents_unavailable',
  },

  // ---- reports and moderation -------------------------------------------
  {
    method: 'POST',
    path: `/real/groups/${MALFORMED}/reports`,
    actor: 'owner',
    body: {},
    status: 400,
    error: 'invalid_request',
  },
  {
    method: 'POST',
    path: `${group}/reports`,
    actor: 'owner',
    raw: '{bad',
    status: 400,
    error: 'invalid_report',
  },
  {
    method: 'POST',
    path: `${group}/reports`,
    actor: 'owner',
    body: {},
    status: 400,
    error: 'invalid_report',
  },
  {
    method: 'POST',
    path: `${group}/reports`,
    actor: 'owner',
    oversize: 70_000,
    status: 413,
    error: 'payload_too_large',
  },
  {
    method: 'POST',
    path: `${group}/reports`,
    actor: 'owner',
    body: { messageId: 'no-such-message', reason: 'spam' },
    status: 404,
    error: 'not_found',
  },
  {
    method: 'POST',
    path: `${group}/reports`,
    actor: 'outsider',
    body: { messageId: 'no-such-message', reason: 'spam' },
    status: 404,
    error: 'not_found',
  },
  {
    method: 'GET',
    path: `${group}/reports`,
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },
  {
    method: 'POST',
    path: `/real/groups/${MALFORMED}/contributions/x/remove`,
    actor: 'owner',
    status: 400,
    error: 'invalid_request',
  },
  {
    method: 'POST',
    path: `${group}/contributions/${MALFORMED}/remove`,
    actor: 'owner',
    status: 400,
    error: 'invalid_request',
  },
  {
    method: 'POST',
    path: `${group}/contributions/no-such-contribution/remove`,
    actor: 'owner',
    status: 404,
    error: 'not_found',
  },
  {
    method: 'POST',
    path: `${group}/contributions/no-such-contribution/remove`,
    actor: 'member',
    status: 403,
    error: 'forbidden',
    name: 'only the owner may remove moments',
  },
  {
    method: 'POST',
    path: `${group}/contributions/no-such-contribution/remove`,
    actor: 'outsider',
    status: 404,
    error: 'not_found',
  },
  {
    method: 'GET',
    path: `${group}/contributions/no-such-contribution/remove`,
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },

  // ---- blocks -----------------------------------------------------------
  { path: '/real/blocks', actor: 'owner', status: 200, keys: ['blocked'] },
  {
    method: 'POST',
    path: '/real/blocks',
    actor: 'owner',
    body: {},
    status: 404,
    error: 'not_found',
  },
  {
    method: 'POST',
    path: '/real/blocks',
    actor: 'owner',
    raw: '{bad',
    status: 404,
    error: 'not_found',
  },
  {
    method: 'POST',
    path: '/real/blocks',
    actor: 'owner',
    body: { profileId: 'no-such-profile' },
    status: 404,
    error: 'not_found',
  },
  {
    method: 'POST',
    path: '/real/blocks',
    actor: 'owner',
    oversize: 70_000,
    status: 413,
    error: 'payload_too_large',
  },
  {
    method: 'DELETE',
    path: '/real/blocks/no-such-profile',
    actor: 'owner',
    status: 200,
    keys: ['blocked'],
  },
  {
    method: 'DELETE',
    path: `/real/blocks/${MALFORMED}`,
    actor: 'owner',
    status: 400,
    error: 'invalid_request',
  },
  {
    method: 'GET',
    path: '/real/blocks/p1',
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },
  {
    method: 'DELETE',
    path: '/real/blocks',
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },

  // ---- invitations ------------------------------------------------------
  {
    method: 'POST',
    path: '/real/invites/accept',
    actor: 'outsider',
    raw: '{bad',
    status: 400,
    error: 'invalid_invite',
  },
  {
    method: 'POST',
    path: '/real/invites/accept',
    actor: 'outsider',
    raw: '[]',
    status: 400,
    error: 'invalid_invite',
  },
  {
    method: 'POST',
    path: '/real/invites/accept',
    actor: 'outsider',
    body: {},
    status: 400,
    error: 'invite_malformed',
  },
  {
    method: 'POST',
    path: '/real/invites/accept',
    actor: 'outsider',
    body: { code: 'ZZZZZZZZZZZZ' },
    status: 400,
    error: 'invite_malformed',
    name: 'wrong shape',
  },
  {
    method: 'POST',
    path: '/real/invites/accept',
    actor: 'outsider',
    body: { code: 'ZZZZZZ' },
    status: 400,
    error: 'invite_malformed',
    name: 'unknown well-formed code (no oracle)',
  },
  {
    method: 'POST',
    path: '/real/invites/accept',
    actor: 'outsider',
    oversize: 70_000,
    status: 413,
    error: 'payload_too_large',
  },
  {
    method: 'GET',
    path: '/real/invites/accept',
    actor: 'outsider',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },
  {
    method: 'POST',
    path: `${group}/invites`,
    actor: 'outsider',
    body: {},
    status: 404,
    error: 'invite_not_found',
  },
  {
    method: 'POST',
    path: `${group}/invites`,
    actor: 'member',
    body: {},
    status: 403,
    error: 'invite_forbidden',
  },
  {
    method: 'POST',
    path: `/real/groups/${MALFORMED}/invites`,
    actor: 'owner',
    body: {},
    status: 400,
    error: 'invalid_request',
  },
  {
    method: 'POST',
    path: `${group}/invites`,
    actor: 'owner',
    raw: '{bad',
    status: 400,
    error: 'invalid_invite',
  },
  {
    method: 'POST',
    path: `${group}/invites`,
    actor: 'owner',
    body: { expiresInSeconds: 1 },
    status: 400,
    error: 'invite_invalid_expiry',
  },
  {
    method: 'POST',
    path: `${group}/invites`,
    actor: 'owner',
    oversize: 70_000,
    status: 413,
    error: 'payload_too_large',
  },
  {
    method: 'POST',
    path: `${group}/invites`,
    actor: 'owner',
    body: {},
    status: 201,
    keys: ['invite'],
    name: 'create invite',
  },
  {
    method: 'GET',
    path: `${group}/invites`,
    actor: 'owner',
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },
  {
    method: 'DELETE',
    path: `${group}/invites/no-such-invite`,
    actor: 'owner',
    status: 404,
    error: 'invite_not_found',
  },
  {
    method: 'DELETE',
    path: `${group}/invites/no-such-invite`,
    actor: 'outsider',
    status: 404,
    error: 'invite_not_found',
  },
  {
    method: 'DELETE',
    path: `${group}/invites/${MALFORMED}`,
    actor: 'owner',
    status: 400,
    error: 'invalid_request',
  },
  {
    method: 'DELETE',
    path: `/real/groups/${MALFORMED}/invites/i1`,
    actor: 'owner',
    status: 400,
    error: 'invalid_request',
  },
  {
    method: 'POST',
    path: `${group}/invites/i1`,
    actor: 'owner',
    body: {},
    status: 404,
    error: 'not_found',
    name: 'wrong method',
  },

  // ---- unknown / unsupported -------------------------------------------
  { path: '/real/unknown-route', actor: 'owner', status: 404, error: 'not_found' },
  { path: '/real/', actor: 'owner', status: 404, error: 'not_found' },
  { path: '/real/groups/{g}/members/extra', actor: 'owner', status: 404, error: 'not_found' },
  { method: 'PUT', path: '/real/groups', actor: 'owner', status: 405, error: 'method_not_allowed' },
  {
    method: 'PATCH',
    path: '/real/groups/{g}',
    actor: 'owner',
    status: 405,
    error: 'method_not_allowed',
  },
  { method: 'HEAD', path: '/real/groups', actor: 'owner', status: 405, noBody: true },
  {
    method: 'PUT',
    path: '/real/groups',
    actor: 'none',
    status: 405,
    error: 'method_not_allowed',
    name: 'method gate runs before the session check',
  },
]);

test('a non-loopback Host without proxy credentials is refused on /real', async () => {
  const response = await rawRequest(fx.c.baseUrl, '/real/groups', {
    Host: 'example.test',
    ...fx.actors.owner.headers,
  });
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(response.text).error, 'auth_transport_unavailable');
});

test('real routes: JSON replies keep their own CORS posture', async () => {
  const noOrigin = await send(fx, { path: '/real/groups', actor: 'owner' });
  assert.equal(noOrigin.response.headers.get('access-control-allow-origin'), null);
  const allowed = await send(fx, {
    path: '/real/groups',
    actor: 'owner',
    headers: { Origin: ORIGIN },
  });
  assert.equal(allowed.response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(allowed.response.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(allowed.response.headers.get('vary'), 'Origin');
  const rejected = await send(fx, {
    path: '/real/groups',
    actor: 'owner',
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.response.headers.get('access-control-allow-origin'), null);
  assert.equal(rejected.response.headers.get('access-control-allow-credentials'), null);
  assert.equal(rejected.response.headers.get('vary'), 'Origin');
});

test('real routes: OPTIONS preflight answers 204 without a session or transport check', async () => {
  const preflight = (path, origin) =>
    send(fx, {
      method: 'OPTIONS',
      path,
      headers: origin ? { Origin: origin, 'Access-Control-Request-Method': 'POST' } : {},
    });
  for (const path of [
    '/real/groups',
    '/real/groups/{g}/members',
    '/real/does-not-exist',
    '/realtime/groups/{g}/messages',
    '/archive',
    '/cycles/{c}/premiere',
    '/clips/x',
    '/contributions/x',
  ]) {
    const allowed = await preflight(path, ORIGIN);
    assert.equal(allowed.status, 204, path);
    assert.equal(allowed.text, '');
    const { headers } = allowed.response;
    assert.equal(headers.get('access-control-allow-origin'), ORIGIN, path);
    assert.equal(headers.get('access-control-allow-credentials'), 'true', path);
    assert.equal(headers.get('access-control-allow-methods'), 'GET, HEAD, POST, DELETE, OPTIONS');
    assert.equal(
      headers.get('access-control-allow-headers'),
      'Authorization, Content-Type, Range, Last-Event-ID',
    );
    assert.equal(headers.get('cache-control'), 'no-store');
    const foreign = await preflight(path, 'https://attacker.example');
    assert.equal(foreign.status, 204, path);
    assert.equal(foreign.response.headers.get('access-control-allow-origin'), null, path);
    assert.equal(foreign.response.headers.get('vary'), 'Origin');
    const bare = await preflight(path);
    assert.equal(bare.status, 204, path);
    assert.equal(bare.response.headers.get('access-control-allow-origin'), null, path);
  }
});
