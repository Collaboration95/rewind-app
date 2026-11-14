// /real/* group, safety, invite, reminder and upload-intent routes.
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { validateRealSession } from '../auth';
import { type RuntimeConfig } from '../config';
import { type RewindDatabase } from '../db';
import {
  acceptRealGroupInvite,
  createRealGroupInvite,
  revokeRealGroupInvite,
} from '../groups/invites';
import { listRealGroupMemberSummaries } from '../groups/profiles';
import {
  createRealGroup,
  getCurrentRealGroup,
  getRealGroup,
  listRealGroups,
  selectRealGroup,
} from '../groups/real';
import {
  blockMember,
  listBlockedMembers,
  removeContribution,
  reportContent,
  unblockMember,
} from '../groups/safety';
import {
  getRealReminderPreference,
  updateRealGroupSettings,
  updateRealReminderPreference,
} from '../groups/settings';
import {
  completeUploadIntent,
  getUploadIntentStatus,
  reconcileUploadIntent,
  requestUploadIntent,
  type UploadIntentFailure,
  type UploadIntentRequest,
} from '../media/upload-intents';
import {
  disableReminderDestination,
  listReminderDestinations,
  listReminderOutbox,
  registerReminderDestination,
  reminderDeliveryStatus,
} from '../reminders/outbox';

import { MAX_STAGED_SOURCE_BYTES, finishRejectedRequest, requestBody } from './body';
import { RealRouteContext, Route, RuntimeServerOptions, findRoute } from './context';
import { acquireRequestCapacity, createRequestLimiters, enforceRateLimit } from './limits';
import { signedInProfileId } from './media-access';
import {
  authClientSource,
  authJson,
  authOriginIsAllowed,
  authToken,
  authTransportIsSecure,
  decodePathSegment,
  sendDenied,
  sendNotFound,
} from './respond';

function handleReminderConfig(ctx: RealRouteContext): void {
  const { request, response, config, options } = ctx;
  authJson(request, response, config, 200, {
    providers: Object.keys(options.reminderProviders ?? {}).filter(
      (name) => name === 'expo' || name === 'webpush',
    ),
    webPushPublicKey: options.reminderProviders?.webpush
      ? (options.reminderWebPushPublicKey ?? null)
      : null,
  });
}

function handleMediaConfig(ctx: RealRouteContext): void {
  const { request, response, config, url, options } = ctx;
  authJson(request, response, config, 200, {
    // Earlier installed clients reject signed lifecycle-tag headers. Keep
    // their server-owned staging path until they negotiate tag-aware uploads.
    directTransfer:
      options.uploadIntents?.transport.backend === 's3' &&
      url.searchParams.getAll('uploadProtocol').length === 1 &&
      url.searchParams.get('uploadProtocol') === '2',
    maxVideoBytes: MAX_STAGED_SOURCE_BYTES,
    maxPhotoBytes: 10 * 1024 * 1024,
  });
}

async function handleReminderDestination(
  ctx: RealRouteContext,
  match: RegExpMatchArray,
): Promise<void> {
  const { request, response, config, database, url, now, currentClock, options, token, session } =
    ctx;
  const groupId = decodePathSegment(match[1], response, config);
  const id = match[3] ? decodePathSegment(match[3], response, config) : null;
  if (!groupId || (match[3] && !id)) return;
  if (!signedInProfileId(database, session.account.id, groupId, now))
    return sendDenied(response, config);
  const actor = { sessionToken: token!, groupId };
  if (request.method === 'GET' && !id) {
    const kind = match[2];
    const deviceIds = url.searchParams.getAll('deviceId');
    if (
      deviceIds.length > 0 &&
      (kind !== 'destinations' ||
        deviceIds.length !== 1 ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(deviceIds[0]))
    ) {
      authJson(request, response, config, 400, {
        error: 'invalid_destination',
        message: 'Use a valid reminder device identity.',
      });
      return;
    }
    const rows =
      kind === 'outbox'
        ? listReminderOutbox(database, actor, currentClock())
        : listReminderDestinations(database, actor, currentClock(), deviceIds[0]);
    if (!rows) return sendDenied(response, config);
    authJson(request, response, config, 200, { [kind]: rows });
    return;
  }
  if (request.method !== 'POST' || match[2] !== 'destinations') {
    authJson(request, response, config, 405, {
      error: 'method_not_allowed',
      message: 'Use the supported reminder action.',
    });
    return;
  }
  const body = await requestBody(request, config, 8192);
  const keys = id ? ['enabled'] : ['deviceId', 'provider', 'destination'];
  if (!body || Object.keys(body).some((key) => !keys.includes(key))) {
    authJson(request, response, config, 400, {
      error: 'invalid_destination',
      message: 'Use a valid reminder destination for this device.',
    });
    return;
  }
  if (id) {
    if (
      body.enabled !== false ||
      !disableReminderDestination(database, actor, id, currentClock())
    ) {
      authJson(request, response, config, 404, {
        error: 'destination_unavailable',
        message: 'This reminder destination is unavailable.',
      });
      return;
    }
    authJson(request, response, config, 200, { disabled: true });
    return;
  }
  const provider = body.provider;
  if ((provider !== 'expo' && provider !== 'webpush') || !options.reminderProviders?.[provider]) {
    authJson(request, response, config, 503, {
      error: 'reminders_unavailable',
      message: 'This reminder provider is not configured.',
    });
    return;
  }
  const result = registerReminderDestination(
    database,
    actor,
    { deviceId: body.deviceId, provider, destination: body.destination },
    currentClock(),
  );
  if (!result.ok) {
    authJson(request, response, config, result.reason === 'forbidden' ? 403 : 400, {
      error: result.reason,
      message: 'This reminder destination cannot be registered.',
    });
    return;
  }
  authJson(request, response, config, 200, { destination: result.destination });
}

async function handleUploadIntent(ctx: RealRouteContext, match: RegExpMatchArray): Promise<void> {
  const { request, response, config, database, now, currentClock, options, token, session } = ctx;
  const groupId = decodePathSegment(match[1], response, config);
  const intentId = match[2] ? decodePathSegment(match[2], response, config) : null;
  if (groupId === null || (match[2] && intentId === null)) return;
  const actor = { sessionToken: token!, groupId };
  if (!signedInProfileId(database, session.account.id, groupId, now))
    return sendDenied(response, config);
  const deps = options.uploadIntents ? { ...options.uploadIntents, now: currentClock } : null;
  if (!deps) {
    authJson(request, response, config, 503, {
      error: 'upload_intents_unavailable',
      message: 'Direct transfer is unavailable. Use the existing upload option.',
    });
    return;
  }
  const failed = (reason: UploadIntentFailure) => {
    const status =
      reason === 'session_required'
        ? 401
        : reason === 'forbidden'
          ? 403
          : reason === 'not_found'
            ? 404
            : reason === 'storage_failed'
              ? 503
              : [
                    'closed_cycle',
                    'quota_exceeded',
                    'idempotency_conflict',
                    'expired',
                    'version_conflict',
                    'replacement_conflict',
                  ].includes(reason)
                ? 409
                : 400;
    authJson(request, response, config, status, {
      error: `upload_intent_${reason}`,
      message:
        reason === 'quota_exceeded'
          ? 'This week has no remaining contribution allowance.'
          : 'This transfer cannot be completed. Check your connection and capture allowance.',
    });
  };
  if (intentId && !match[3] && request.method === 'GET') {
    const result = getUploadIntentStatus(database, actor, intentId, deps);
    if (!result.ok) return failed(result.reason);
    authJson(request, response, config, 200, { intent: result.value });
    return;
  }
  if (request.method !== 'POST' || (intentId && !match[3])) {
    authJson(request, response, config, 405, {
      error: 'method_not_allowed',
      message: 'Use the supported intent request, status or completion action.',
    });
    return;
  }
  const body = await requestBody(request, config, 8 * 1024);
  const keys = intentId
    ? match[3] === '/reconcile'
      ? []
      : ['versionId']
    : [
        'idempotencyKey',
        'mediaType',
        'contentType',
        'byteLength',
        'sha256',
        'durationSeconds',
        'trimStartSeconds',
        'trimEndSeconds',
        'mode',
        'clientProcessed',
        'replacesContributionId',
      ];
  if (!body || Object.keys(body).some((key) => !keys.includes(key)))
    return failed('invalid_request');
  const release = acquireRequestCapacity(
    (options.requestLimiters ?? createRequestLimiters(config)).processing,
    request,
    response,
    config,
  );
  if (!release) return;
  try {
    if (intentId) {
      const result =
        match[3] === '/reconcile'
          ? await reconcileUploadIntent(database, actor, { intentId }, deps)
          : await completeUploadIntent(
              database,
              actor,
              { intentId, versionId: typeof body.versionId === 'string' ? body.versionId : '' },
              deps,
            );
      if (!result.ok) return failed(result.reason);
      authJson(request, response, config, 200, { intent: result.value });
    } else {
      const result = await requestUploadIntent(
        database,
        actor,
        body as unknown as UploadIntentRequest,
        deps,
      );
      if (!result.ok) return failed(result.reason);
      authJson(request, response, config, 200, result.value);
    }
  } finally {
    release();
  }
}

async function handleGroupSettings(ctx: RealRouteContext, match: RegExpMatchArray): Promise<void> {
  const { request, response, config, database, currentClock, options, token, session } = ctx;
  const groupId = decodePathSegment(match[1], response, config);
  if (groupId === null) return;
  const kind = match[2];
  if (!getRealGroup(database, session.account.id, groupId)) {
    authJson(request, response, config, 403, {
      error: 'forbidden',
      message: 'You do not have access to this group.',
    });
    return;
  }
  if (request.method === 'GET') {
    if (kind !== 'reminders') return sendNotFound(response, config);
    const preference = getRealReminderPreference(
      database,
      session.account.id,
      groupId,
      currentClock(),
    );
    authJson(request, response, config, 200, {
      preference: preference && {
        ...preference,
        delivery: reminderDeliveryStatus(
          database,
          session.account.id,
          options.reminderProviders ?? {},
          currentClock(),
        ),
      },
    });
    return;
  }
  const body = await requestBody(request, config);
  const allowedKeys = kind === 'settings' ? ['prompt', 'timeZone'] : ['enabled', 'snoozedUntil'];
  if (!body || Object.keys(body).some((key) => !allowedKeys.includes(key))) {
    authJson(request, response, config, 400, {
      error: 'invalid_settings',
      message: 'Enter valid group settings or your own reminder preference.',
    });
    return;
  }
  const authorize = () =>
    token !== null && validateRealSession(database, token, currentClock()).status === 'valid';
  if (!authorize()) {
    authJson(request, response, config, 401, {
      error: 'session_required',
      message: 'A valid sign-in is required.',
    });
    return;
  }
  const result =
    kind === 'settings'
      ? updateRealGroupSettings(
          database,
          session.account.id,
          groupId,
          { prompt: body.prompt, timeZone: body.timeZone },
          currentClock(),
          authorize,
        )
      : updateRealReminderPreference(
          database,
          session.account.id,
          groupId,
          { enabled: body.enabled, snoozedUntil: body.snoozedUntil },
          currentClock(),
          authorize,
        );
  if (!result.ok) {
    authJson(
      request,
      response,
      config,
      result.reason === 'forbidden' ? 403 : result.reason === 'cycle_closed' ? 409 : 400,
      {
        error: result.reason,
        message:
          result.reason === 'forbidden'
            ? 'Only the group owner can change these settings.'
            : 'Check the prompt, timezone and reminder preference, then retry.',
      },
    );
    return;
  }
  authJson(
    request,
    response,
    config,
    200,
    kind === 'reminders' && 'preference' in result && result.preference
      ? {
          ...result,
          preference: {
            ...result.preference,
            delivery: reminderDeliveryStatus(
              database,
              session.account.id,
              options.reminderProviders ?? {},
              currentClock(),
            ),
          },
        }
      : result,
  );
}

function handleCurrentGroup(ctx: RealRouteContext): void {
  const { request, response, config, database, session } = ctx;
  authJson(request, response, config, 200, {
    group: getCurrentRealGroup(database, session.account.id),
  });
}

function handleListGroups(ctx: RealRouteContext): void {
  const { request, response, config, database, session } = ctx;
  authJson(request, response, config, 200, {
    groups: listRealGroups(database, session.account.id),
  });
}

async function handleSelectGroup(ctx: RealRouteContext): Promise<void> {
  const { request, response, config, database, session } = ctx;
  const body = await requestBody(request, config);
  if (!body || typeof body.groupId !== 'string') {
    authJson(request, response, config, 400, {
      error: 'invalid_group',
      message: 'Choose a group you belong to.',
    });
    return;
  }
  if (!selectRealGroup(database, session.account.id, body.groupId)) {
    authJson(request, response, config, 404, {
      error: 'forbidden',
      message: 'You do not have access to this group.',
    });
    return;
  }
  authJson(request, response, config, 200, {
    group: getCurrentRealGroup(database, session.account.id),
  });
}

async function handleReportContent(ctx: RealRouteContext, match: RegExpMatchArray): Promise<void> {
  const { request, response, config, database, now, session, limits } = ctx;
  if (
    !enforceRateLimit(
      limits.safety,
      session.account.id,
      now,
      request,
      response,
      config,
      'You have made too many safety requests. Please wait before trying again.',
    )
  )
    return;
  const groupId = decodePathSegment(match[1], response, config);
  if (groupId === null) return;
  const body = await requestBody(request, config, 8 * 1024);
  const result = reportContent(database, session.account.id, groupId, body ?? {}, now);
  if (result === 'invalid') {
    authJson(request, response, config, 400, {
      error: 'invalid_report',
      message: 'Report one message, moment or person, with a reason of up to 500 characters.',
    });
    return;
  }
  if (result === 'not_found') {
    authJson(request, response, config, 404, {
      error: 'not_found',
      message: 'That content was not found in this group.',
    });
    return;
  }
  authJson(request, response, config, 201, { reported: true });
}

function handleRemoveContribution(ctx: RealRouteContext, match: RegExpMatchArray): void {
  const { request, response, config, database, now, session } = ctx;
  const groupId = decodePathSegment(match[1], response, config);
  if (groupId === null) return;
  const contributionId = decodePathSegment(match[2], response, config);
  if (contributionId === null) return;
  const result = removeContribution(database, session.account.id, groupId, contributionId, now);
  if (result === 'forbidden') {
    authJson(request, response, config, 403, {
      error: 'forbidden',
      message: 'Only the group owner can remove moments.',
    });
    return;
  }
  if (result === 'not_found') {
    authJson(request, response, config, 404, {
      error: 'not_found',
      message: 'That moment was not found in this group.',
    });
    return;
  }
  authJson(request, response, config, 200, { removed: true });
}

function handleListBlocks(ctx: RealRouteContext): void {
  const { request, response, config, database, session } = ctx;
  authJson(request, response, config, 200, {
    blocked: listBlockedMembers(database, session.account.id),
  });
}

async function handleBlock(ctx: RealRouteContext): Promise<void> {
  const { request, response, config, database, now, session, limits } = ctx;
  if (
    !enforceRateLimit(
      limits.safety,
      session.account.id,
      now,
      request,
      response,
      config,
      'You have made too many safety requests. Please wait before trying again.',
    )
  )
    return;
  const body = await requestBody(request, config, 8 * 1024);
  const profileId = typeof body?.profileId === 'string' ? body.profileId : '';
  if (!profileId || blockMember(database, session.account.id, profileId, now) !== 'blocked') {
    authJson(request, response, config, 404, {
      error: 'not_found',
      message: 'That member was not found in your groups.',
    });
    return;
  }
  authJson(request, response, config, 201, { blocked: true });
}

function handleUnblock(ctx: RealRouteContext, match: RegExpMatchArray): void {
  const { request, response, config, database, now, session, limits } = ctx;
  if (
    !enforceRateLimit(
      limits.safety,
      session.account.id,
      now,
      request,
      response,
      config,
      'You have made too many safety requests. Please wait before trying again.',
    )
  )
    return;
  const profileId = decodePathSegment(match[1], response, config);
  if (profileId === null) return;
  unblockMember(database, session.account.id, profileId);
  authJson(request, response, config, 200, { blocked: false });
}

function handleGroupMembers(ctx: RealRouteContext, match: RegExpMatchArray): void {
  const { request, response, config, database, now, session } = ctx;
  const groupId = decodePathSegment(match[1], response, config);
  if (groupId === null) return;
  const summary = listRealGroupMemberSummaries(database, session.account.id, groupId, now);
  if (!summary) {
    authJson(request, response, config, 404, {
      error: 'forbidden',
      message: 'You do not have access to this group.',
    });
    return;
  }
  authJson(request, response, config, 200, summary);
}

async function handleAcceptInvite(ctx: RealRouteContext): Promise<void> {
  const { request, response, config, database, now, session } = ctx;
  const body = await requestBody(request, config);
  if (!body) {
    authJson(request, response, config, 400, {
      status: 'malformed',
      error: 'invalid_invite',
      message: 'Enter a valid invitation code.',
    });
    return;
  }
  let result: ReturnType<typeof acceptRealGroupInvite>;
  try {
    result = acceptRealGroupInvite(
      database,
      session.account,
      body.code,
      body.groupId,
      now,
      authClientSource(request, config),
    );
  } catch {
    authJson(request, response, config, 409, {
      status: 'denied',
      error: 'invite_accept_failed',
      message: 'The invitation could not be accepted. No partial membership was saved.',
    });
    return;
  }
  if (!result.ok) {
    const status =
      result.status === 'throttled'
        ? 429
        : result.status === 'denied'
          ? 404
          : result.status === 'full'
            ? 409
            : 400;
    authJson(request, response, config, status, {
      status: result.status,
      error: `invite_${result.status}`,
      message:
        result.status === 'expired'
          ? "That code isn't valid or has expired."
          : result.status === 'replayed'
            ? 'This invitation has already been used.'
            : result.status === 'full'
              ? 'This group has reached its member limit.'
              : result.status === 'denied'
                ? 'You do not have access to this group.'
                : result.status === 'throttled'
                  ? 'Too many invitation attempts. Please try again later.'
                  : "That code isn't valid or has expired.",
    });
    return;
  }
  authJson(request, response, config, 200, result);
}

function handleGetGroup(ctx: RealRouteContext, match: RegExpMatchArray): void {
  const { request, response, config, database, session } = ctx;
  const groupId = decodePathSegment(match[1], response, config);
  if (groupId === null) return;
  const group = getRealGroup(database, session.account.id, groupId);
  if (!group) {
    authJson(request, response, config, 404, {
      error: 'forbidden',
      message: 'You do not have access to this group.',
    });
    return;
  }
  authJson(request, response, config, 200, { group });
}

async function handleCreateGroup(ctx: RealRouteContext): Promise<void> {
  const { request, response, config, database, now, session, limits } = ctx;
  if (
    !enforceRateLimit(
      limits.groups,
      session.account.id,
      now,
      request,
      response,
      config,
      'You have reached the group creation limit. Please try again later.',
    )
  )
    return;
  const body = await requestBody(request, config);
  if (!body) {
    authJson(request, response, config, 400, {
      error: 'invalid_group',
      message: 'Enter a valid group name, prompt, and member limit from 2 to 10.',
    });
    return;
  }
  // Recheck durable ownership after receiving the body: concurrent requests
  // must not both pass at nineteen groups before either has committed.
  const owned = database
    .prepare('SELECT COUNT(*) AS count FROM real_group_metadata WHERE owner_account_id = ?')
    .get(session.account.id) as { count: number };
  if (owned.count >= 20) {
    authJson(request, response, config, 429, {
      error: 'rate_limited',
      message: 'You can own up to twenty groups, so a new one can’t be created right now.',
    });
    finishRejectedRequest(request, response);
    return;
  }
  let created: ReturnType<typeof createRealGroup>;
  try {
    created = createRealGroup(
      database,
      session.account,
      {
        name: body.name,
        prompt: body.prompt,
        maxMembers: body.maxMembers,
        timeZone: body.timeZone,
      },
      now,
      config.realCycleDurationMs,
    );
  } catch {
    authJson(request, response, config, 409, {
      error: 'group_create_failed',
      message: 'The group could not be created. No partial group was saved.',
    });
    return;
  }
  if (!created) {
    authJson(request, response, config, 400, {
      error: 'invalid_group',
      message: 'Enter a valid group name, prompt, and member limit from 2 to 10.',
    });
    return;
  }
  authJson(request, response, config, 201, created);
}

function handleRevokeInvite(ctx: RealRouteContext, match: RegExpMatchArray): void {
  const { request, response, config, database, session } = ctx;
  const groupId = decodePathSegment(match[1], response, config);
  const inviteId = decodePathSegment(match[2], response, config);
  if (groupId === null || inviteId === null) return;
  if (!revokeRealGroupInvite(database, groupId, session.account.id, inviteId)) {
    authJson(request, response, config, 404, {
      error: 'invite_not_found',
      message: 'That active invitation is no longer available.',
    });
    return;
  }
  authJson(request, response, config, 200, { revoked: true });
}

async function handleCreateInvite(ctx: RealRouteContext, match: RegExpMatchArray): Promise<void> {
  const { request, response, config, database, now, session } = ctx;
  const groupId = decodePathSegment(match[1], response, config);
  if (groupId === null) return;
  const body = await requestBody(request, config);
  if (body === null) {
    authJson(request, response, config, 400, {
      error: 'invalid_invite',
      message: 'The invitation expiry is invalid.',
    });
    return;
  }
  const ttlSeconds =
    typeof body.expiresInSeconds === 'number'
      ? body.expiresInSeconds
      : typeof body.expiresInSeconds === 'string'
        ? Number(body.expiresInSeconds)
        : undefined;
  let result: ReturnType<typeof createRealGroupInvite>;
  try {
    result = createRealGroupInvite(database, groupId, session.account.id, ttlSeconds, now);
  } catch {
    authJson(request, response, config, 409, {
      error: 'invite_create_failed',
      message: 'The invitation could not be created. No partial invitation was saved.',
    });
    return;
  }
  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : result.reason === 'forbidden' ? 403 : 400;
    authJson(request, response, config, status, {
      error: `invite_${result.reason}`,
      message:
        result.reason === 'invalid_expiry'
          ? 'Choose an invitation expiry between five minutes and seven days.'
          : 'You cannot create an invitation for this group.',
    });
    return;
  }
  authJson(request, response, config, 201, { invite: result.invite });
}

export const realRoutes: readonly Route<RealRouteContext>[] = [
  { methods: ['GET'], path: '/real/reminders/config', handle: handleReminderConfig },
  { methods: ['GET'], path: '/real/media/config', handle: handleMediaConfig },
  {
    methods: '*',
    path: /^\/real\/groups\/([^/]+)\/reminders\/(destinations|outbox)(?:\/([^/]+))?$/,
    handle: handleReminderDestination,
  },
  {
    methods: '*',
    path: /^\/real\/groups\/([^/]+)\/upload-intents(?:\/([^/]+)(\/(?:complete|reconcile))?)?$/,
    handle: handleUploadIntent,
  },
  {
    methods: ['GET', 'POST'],
    path: /^\/real\/groups\/([^/]+)\/(settings|reminders)$/,
    handle: handleGroupSettings,
  },
  { methods: ['GET'], path: '/real/groups/current', handle: handleCurrentGroup },
  { methods: ['GET'], path: '/real/groups', handle: handleListGroups },
  { methods: ['POST'], path: '/real/groups/current', handle: handleSelectGroup },
  { methods: ['POST'], path: /^\/real\/groups\/([^/]+)\/reports$/, handle: handleReportContent },
  {
    methods: ['POST'],
    path: /^\/real\/groups\/([^/]+)\/contributions\/([^/]+)\/remove$/,
    handle: handleRemoveContribution,
  },
  { methods: ['GET'], path: '/real/blocks', handle: handleListBlocks },
  { methods: ['POST'], path: '/real/blocks', handle: handleBlock },
  { methods: ['DELETE'], path: /^\/real\/blocks\/([^/]+)$/, handle: handleUnblock },
  { methods: ['GET'], path: /^\/real\/groups\/([^/]+)\/members$/, handle: handleGroupMembers },
  { methods: ['POST'], path: '/real/invites/accept', handle: handleAcceptInvite },
  { methods: ['GET'], path: /^\/real\/groups\/([^/]+)$/, handle: handleGetGroup },
  { methods: ['POST'], path: '/real/groups', handle: handleCreateGroup },
  {
    methods: ['DELETE'],
    path: /^\/real\/groups\/([^/]+)\/invites\/([^/]+)$/,
    handle: handleRevokeInvite,
  },
  { methods: ['POST'], path: /^\/real\/groups\/([^/]+)\/invites$/, handle: handleCreateInvite },
];

export async function handleRealGroupRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  database: RewindDatabase,
  url: URL,
  now: Date,
  currentClock: () => Date = () => now,
  options: RuntimeServerOptions = {},
): Promise<void> {
  if (!authTransportIsSecure(request, config) || !authOriginIsAllowed(request, config)) {
    authJson(request, response, config, 403, {
      error: 'auth_transport_unavailable',
      message: 'Group access is unavailable on this connection.',
    });
    return;
  }
  const token = authToken(request);
  const session = token
    ? validateRealSession(database, token, now)
    : { status: 'invalid' as const };
  if (session.status !== 'valid') {
    authJson(request, response, config, 401, {
      error: 'session_required',
      message: 'A valid sign-in is required.',
    });
    return;
  }
  const limits = options.requestLimiters ?? createRequestLimiters(config);
  const ctx: RealRouteContext = {
    request,
    response,
    config,
    database,
    url,
    now,
    currentClock,
    options,
    token,
    session,
    limits,
  };
  const found = findRoute(realRoutes, request.method, url.pathname);
  if (found) return found.route.handle(ctx, found.match);
  authJson(request, response, config, 404, {
    error: 'not_found',
    message: 'The requested real-group resource was not found.',
  });
}
