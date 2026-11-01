// /realtime/groups/* chat history, SSE events, messages and reactions.
import { type IncomingMessage, type ServerResponse } from 'node:http';

import { validateRealSession } from '../auth';
import {
  SUPPORTED_CHAT_REACTION,
  createChatMessage,
  currentReactionRevision,
  latestChatEventId,
  listChatEventMetadata,
  listChatEvents,
  listChatHistoryPage,
  listChatReactionSnapshot,
  nextReactionRevision,
  toggleChatReaction,
  type ChatReactionEvent,
} from '../chat';
import { type RuntimeConfig } from '../config';
import { getMessage, type RewindDatabase } from '../db';
import { canInteractWithChatMessage, isChatEventHidden, visibleChatEvent } from '../groups/safety';
import { SAFE_DENIAL } from '../policy';
import { encodeSseCheckpoint, encodeSseEvent, encodeSseReaction } from '../realtime';

import { requestBody } from './body';
import { MediaRouteContext, Route } from './context';
import { enforceRateLimit } from './limits';
import { AuthorisedMediaIdentity, signedInProfileId } from './media-access';
import {
  authCorsHeaders,
  authJson,
  authOriginIsAllowed,
  authToken,
  authTransportIsSecure,
  decodePathSegment,
  sendDenied,
  sendJson,
  sendNotFound,
} from './respond';

function acceptsEventStream(request: IncomingMessage): boolean {
  const accept = request.headers.accept;
  return (Array.isArray(accept) ? accept.join(',') : (accept ?? ''))
    .toLowerCase()
    .includes('text/event-stream');
}

/** EventSource hides HTTP response bodies/statuses behind a generic onerror.
 * Return a terminal SSE frame when the caller is a standard EventSource so
 * clients can stop reconnecting and disable chat actions deterministically. */
function sendRealtimeAccessDenied(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  status: number = SAFE_DENIAL.status,
  message: string = SAFE_DENIAL.message,
): boolean {
  if (!acceptsEventStream(request)) return false;
  const hasAuthCredential = Boolean(request.headers.authorization || request.headers.cookie);
  response.writeHead(200, {
    ...(hasAuthCredential
      ? authCorsHeaders(request, config)
      : { 'Access-Control-Allow-Origin': config.allowOrigin }),
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range, Last-Event-ID',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  });
  response.end(
    [
      'event: access-denied',
      `data: ${JSON.stringify({ allowed: false, status, error: 'forbidden', message })}`,
      '',
      '',
    ].join('\n'),
  );
  return true;
}

function writeRealtimeAccessDenied(
  response: ServerResponse,
  status: number = SAFE_DENIAL.status,
  message: string = SAFE_DENIAL.message,
): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(
    [
      'event: access-denied',
      `data: ${JSON.stringify({ allowed: false, status, error: 'forbidden', message })}`,
      '',
      '',
    ].join('\n'),
  );
}

function requireAuthorisedChatGroup(
  request: IncomingMessage,
  database: RewindDatabase,
  response: ServerResponse,
  config: RuntimeConfig,
  at: Date,
  groupId: string,
): AuthorisedMediaIdentity | null {
  const deny = (status: number = SAFE_DENIAL.status, message: string = SAFE_DENIAL.message) => {
    if (!sendRealtimeAccessDenied(request, response, config, status, message)) {
      sendJson(response, config, status, {
        error: status === 401 ? 'session_required' : 'forbidden',
        message,
      });
    }
    return null;
  };
  if (!authTransportIsSecure(request, config) || !authOriginIsAllowed(request, config)) {
    return deny(403, 'Chat access is unavailable on this connection.');
  }
  const token = authToken(request);
  const session = token ? validateRealSession(database, token, at) : { status: 'invalid' as const };
  if (session.status !== 'valid') {
    return deny(401, 'Sign in again to join this group chat.');
  }
  const profileId = signedInProfileId(database, session.account.id, groupId, at);
  if (!profileId) return deny();
  for (const [name, value] of Object.entries(authCorsHeaders(request, config)))
    response.setHeader(name, value);
  return { accountId: session.account.id, groupId, memberId: profileId };
}

function chatIdentityIsCurrent(
  request: IncomingMessage,
  database: RewindDatabase,
  identity: AuthorisedMediaIdentity,
  at: Date,
): boolean {
  const token = authToken(request);
  const session = token ? validateRealSession(database, token, at) : { status: 'invalid' as const };
  return Boolean(
    session.status === 'valid' &&
    session.account.id === identity.accountId &&
    signedInProfileId(database, identity.accountId, identity.groupId, at) === identity.memberId,
  );
}

function handleChatHistory(ctx: MediaRouteContext, match: RegExpMatchArray): void {
  const { request, response, config, database, now, url } = ctx;
  const groupId = decodePathSegment(match[1], response, config);
  if (groupId === null) return;
  const identity = requireAuthorisedChatGroup(request, database, response, config, now(), groupId);
  if (!identity) return;
  const rawLimit = url.searchParams.get('limit');
  const parsedLimit = rawLimit === null ? 100 : Number(rawLimit);
  const rawBeforeEventId = url.searchParams.get('beforeEventId');
  const beforeEventId = rawBeforeEventId === null ? undefined : Number(rawBeforeEventId);
  if (
    !Number.isInteger(parsedLimit) ||
    parsedLimit < 1 ||
    parsedLimit > 100 ||
    (beforeEventId !== undefined && (!Number.isSafeInteger(beforeEventId) || beforeEventId < 1))
  ) {
    sendJson(response, config, 400, {
      error: 'invalid_chat_cursor',
      message: 'The chat history page cursor or size is invalid.',
    });
    return;
  }
  // Read the revision first: the page then reflects at least that revision.
  const reactionRevision = currentReactionRevision();
  const page = listChatHistoryPage(database, identity.groupId, {
    beforeEventId,
    limit: parsedLimit,
  });
  page.events = page.events.flatMap((event) => {
    const visible = visibleChatEvent(database, identity.accountId, event);
    return visible ? [visible] : [];
  });
  sendJson(response, config, 200, { ...page, reactionRevision });
}

async function handleChatEvents(ctx: MediaRouteContext, match: RegExpMatchArray): Promise<void> {
  const { request, response, config, database, options, now, requestLimiters, url } = ctx;
  const groupId = decodePathSegment(match[1], response, config);
  if (groupId === null) return;
  const identity = requireAuthorisedChatGroup(request, database, response, config, now(), groupId);
  if (!identity) return;
  const lastEventHeader = request.headers['last-event-id'];
  const lastEventValue = Array.isArray(lastEventHeader)
    ? lastEventHeader[0]
    : (lastEventHeader ?? url.searchParams.get('sinceEventId'));
  const parsedLastEventId = lastEventValue ? Number(lastEventValue) : 0;
  const sinceEventId =
    Number.isSafeInteger(parsedLastEventId) && parsedLastEventId >= 0 ? parsedLastEventId : 0;
  const startFromLatest =
    url.searchParams.get('startFromLatest') === 'true' &&
    lastEventValue === null &&
    !url.searchParams.has('sinceEventId');
  const metadataOnly = url.searchParams.get('metadataOnly') === 'true';
  const hub = options.realtimeHub;
  if (!hub) {
    sendJson(response, config, 500, {
      error: 'realtime_unavailable',
      message: 'The local realtime transport is not available.',
    });
    return;
  }
  const releaseStream = requestLimiters.streams.tryAcquire(identity.accountId);
  if (!releaseStream) {
    authJson(request, response, config, 429, {
      error: 'rate_limited',
      message: 'You have too many open chat connections. Close another Rewind tab and retry.',
    });
    return;
  }
  response.once('close', releaseStream);
  response.once('finish', releaseStream);
  response.writeHead(200, {
    ...authCorsHeaders(request, config),
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range, Last-Event-ID',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  });
  response.write(': connected\n\n');
  const writeEvent = (event: Parameters<typeof encodeSseEvent>[0]) => {
    const visible = visibleChatEvent(database, identity.accountId, event);
    if (!visible) return;
    if (!response.writableEnded && !response.destroyed) {
      response.write(encodeSseEvent(visible, { metadataOnly }));
    }
  };
  const writeReaction = (event: ChatReactionEvent) => {
    // Unread observers only count messages; a reaction never reaches them.
    if (metadataOnly || endUnauthorisedStream()) return;
    // Hidden or reported content for this viewer stays hidden, and the
    // payload holds only the shared aggregate, never the actor's own state.
    if (
      isChatEventHidden(database, identity.accountId, {
        id: event.messageId,
        memberId: event.authorMemberId,
      })
    )
      return;
    if (!response.writableEnded && !response.destroyed) response.write(encodeSseReaction(event));
  };
  const subscribeToGroup = (
    listener: (event: Parameters<typeof encodeSseEvent>[0]) => void,
  ): (() => void) =>
    hub.subscribe(groupId, (event) => {
      if (event.type === 'reaction') writeReaction(event);
      else listener(event);
    });
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
  };
  response.once('close', cleanup);
  const streamIsAuthorised = () => {
    return chatIdentityIsCurrent(request, database, identity, now());
  };
  const endUnauthorisedStream = () => {
    if (streamIsAuthorised()) return false;
    unsubscribe();
    writeRealtimeAccessDenied(response);
    if (!response.writableEnded && !response.destroyed) response.end();
    return true;
  };
  const writeAuthorisedEvent = (event: Parameters<typeof encodeSseEvent>[0]) => {
    if (endUnauthorisedStream()) return;
    writeEvent(event);
  };
  if (startFromLatest) {
    // Buffer while taking the database watermark so a concurrent commit is
    // either included in that watermark or delivered once from the buffer.
    const pending: Parameters<typeof encodeSseEvent>[0][] = [];
    let priming = true;
    unsubscribe = subscribeToGroup((event) => {
      if (priming) pending.push(event);
      else writeAuthorisedEvent(event);
    });
    const checkpoint = latestChatEventId(database, groupId);
    if (response.destroyed || response.writableEnded) {
      unsubscribe();
      return;
    }
    if (!endUnauthorisedStream()) response.write(encodeSseCheckpoint(checkpoint));
    for (const event of pending.sort((left, right) => left.eventId - right.eventId)) {
      if (event.eventId > checkpoint) writeAuthorisedEvent(event);
    }
    priming = false;
  } else {
    // Buffer live events while draining the persisted log through a fixed
    // watermark. Events committed after that watermark are flushed once the
    // replay is complete; events at or below it are covered by replay.
    let priming = true;
    const pending: Parameters<typeof encodeSseEvent>[0][] = [];
    let lastDeliveredEventId = sinceEventId;
    const deliverOnce = (event: Parameters<typeof encodeSseEvent>[0]) => {
      if (event.eventId <= lastDeliveredEventId) return;
      writeAuthorisedEvent(event);
      lastDeliveredEventId = event.eventId;
    };
    unsubscribe = subscribeToGroup((event) => {
      if (priming) pending.push(event);
      else deliverOnce(event);
    });
    const watermark = latestChatEventId(database, groupId);
    while (lastDeliveredEventId < watermark) {
      if (response.destroyed || response.writableEnded) break;
      const page = metadataOnly
        ? listChatEventMetadata(database, groupId, lastDeliveredEventId, 100)
        : listChatEvents(database, groupId, lastDeliveredEventId, 100);
      let progressed = false;
      for (const event of page) {
        if (event.eventId > watermark) break;
        deliverOnce(event);
        progressed = true;
      }
      if (!progressed || lastDeliveredEventId >= watermark) break;
      // Let concurrent message requests publish while replay continues. Their
      // events remain buffered until the captured watermark has been drained.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (const event of pending.sort((left, right) => left.eventId - right.eventId)) {
      if (response.destroyed || response.writableEnded) break;
      if (event.eventId > watermark) deliverOnce(event);
    }
    priming = false;
  }
  if (response.destroyed || response.writableEnded) {
    cleanup();
    return;
  }
  heartbeat = setInterval(() => {
    if (response.writableEnded || response.destroyed || endUnauthorisedStream()) return;
    response.write(': keep-alive\n\n');
  }, options.realtimeHeartbeatIntervalMs ?? 15_000);
  heartbeat.unref();
}

async function handleSendChatMessage(
  ctx: MediaRouteContext,
  match: RegExpMatchArray,
): Promise<void> {
  const { request, response, config, database, options, now, requestLimiters } = ctx;
  const groupId = decodePathSegment(match[1], response, config);
  if (groupId === null) return;
  const identity = requireAuthorisedChatGroup(request, database, response, config, now(), groupId);
  if (!identity) return;
  if (
    !enforceRateLimit(
      requestLimiters.chat,
      identity.accountId,
      now(),
      request,
      response,
      config,
      'You are sending messages too quickly. Please wait before trying again.',
    )
  )
    return;
  const body = await requestBody(request, config);
  if (!chatIdentityIsCurrent(request, database, identity, now())) {
    sendDenied(response, config);
    return;
  }
  const result = createChatMessage(database, {
    groupId,
    memberId: identity.memberId,
    body: typeof body?.body === 'string' ? body.body : '',
    messageId: typeof body?.messageId === 'string' ? body.messageId : undefined,
    replyToMessageId:
      typeof body?.replyToMessageId === 'string' ? body.replyToMessageId : undefined,
    now,
  });
  if (!result.ok) {
    if (result.reason === 'membership_denied') return sendDenied(response, config);
    if (result.reason === 'reply_not_found') return sendNotFound(response, config);
    sendJson(response, config, result.reason === 'duplicate_message' ? 409 : 400, {
      error: `message_${result.reason}`,
      message:
        result.reason === 'empty_body'
          ? 'Enter a message before sending.'
          : result.reason === 'body_too_long'
            ? 'Message text is too long.'
            : result.reason === 'invalid_timestamp'
              ? 'The message timestamp is invalid.'
              : result.reason === 'duplicate_message'
                ? 'This message retry conflicts with an existing message.'
                : 'Replies can only target an original message.',
    });
    return;
  }
  if (!result.deduplicated) options.realtimeHub?.publish(result.event);
  sendJson(response, config, result.deduplicated ? 200 : 201, {
    event: result.event,
    message: result.event.message,
    ...(result.deduplicated ? { deduplicated: true } : {}),
  });
}

async function handleChatReaction(ctx: MediaRouteContext, match: RegExpMatchArray): Promise<void> {
  const { request, response, config, database, options, now, url } = ctx;
  const groupId = decodePathSegment(match[1], response, config);
  const messageId = decodePathSegment(match[2], response, config);
  const pathEmoji = match[3] ? decodePathSegment(match[3], response, config) : undefined;
  if (groupId === null || messageId === null || pathEmoji === null) return;
  const identity = requireAuthorisedChatGroup(request, database, response, config, now(), groupId);
  if (!identity) return;
  if (request.method === 'GET') {
    const message = getMessage(database, groupId, messageId);
    if (!message || !canInteractWithChatMessage(database, identity.memberId, message))
      return sendNotFound(response, config);
    const visible = visibleChatEvent(database, identity.accountId, { message });
    if (!visible) return sendNotFound(response, config);
    sendJson(response, config, 200, visible);
    return;
  }
  const body = await requestBody(request, config);
  if (!chatIdentityIsCurrent(request, database, identity, now())) {
    sendDenied(response, config);
    return;
  }
  const emoji =
    pathEmoji ??
    (typeof body?.emoji === 'string' ? body.emoji : url.searchParams.get('emoji')) ??
    SUPPORTED_CHAT_REACTION;
  const active =
    request.method === 'DELETE'
      ? false
      : typeof body?.active === 'boolean'
        ? body.active
        : body?.action === 'remove'
          ? false
          : body?.action === 'add'
            ? true
            : undefined;
  const result = toggleChatReaction(database, {
    groupId,
    memberId: identity.memberId,
    messageId,
    emoji,
    active,
    now,
  });
  if (!result.ok) {
    if (result.reason === 'membership_denied') return sendDenied(response, config);
    if (result.reason === 'message_not_found') return sendNotFound(response, config);
    sendJson(response, config, 400, {
      error: `reaction_${result.reason}`,
      message:
        result.reason === 'unsupported_reaction'
          ? 'That reaction is not supported.'
          : 'The reaction timestamp is invalid.',
    });
    return;
  }
  const visible = visibleChatEvent(database, identity.accountId, { message: result.message });
  if (!visible) return sendNotFound(response, config);
  // Counts and revision are taken in this synchronous run, so they order
  // against every other reaction change. Each stream filters per viewer.
  const reactionRevision = nextReactionRevision();
  options.realtimeHub?.publish({
    type: 'reaction',
    groupId,
    messageId,
    authorMemberId: result.message.memberId,
    reactionCounts: result.message.reactionCounts ?? {},
    revision: reactionRevision,
    occurredAt: now().toISOString(),
  });
  sendJson(response, config, 200, { ...result, message: visible.message, reactionRevision });
}

// Reconnect reconciliation: current counts for already-loaded messages,
// including ones older than the latest history page.
async function handleChatReactionCounts(
  ctx: MediaRouteContext,
  match: RegExpMatchArray,
): Promise<void> {
  const { request, response, config, database, now } = ctx;
  const groupId = decodePathSegment(match[1], response, config);
  if (groupId === null) return;
  const identity = requireAuthorisedChatGroup(request, database, response, config, now(), groupId);
  if (!identity) return;
  const body = await requestBody(request, config);
  if (!chatIdentityIsCurrent(request, database, identity, now())) {
    sendDenied(response, config);
    return;
  }
  const messageIds = Array.isArray(body?.messageIds) ? body.messageIds : null;
  if (
    !messageIds ||
    messageIds.length > 100 ||
    messageIds.some((id: unknown) => typeof id !== 'string' || id.length === 0 || id.length > 200)
  ) {
    sendJson(response, config, 400, {
      error: 'invalid_reaction_snapshot',
      message: 'Send up to 100 message ids.',
    });
    return;
  }
  const revision = currentReactionRevision();
  const messages = listChatReactionSnapshot(database, groupId, messageIds as string[]).flatMap(
    ({ messageId, memberId, reactionCounts }) =>
      isChatEventHidden(database, identity.accountId, { id: messageId, memberId })
        ? []
        : [{ messageId, reactionCounts }],
  );
  sendJson(response, config, 200, { revision, messages });
}

export const chatRoutes: readonly Route<MediaRouteContext>[] = [
  { methods: ['GET'], path: /^\/realtime\/groups\/([^/]+)\/messages$/, handle: handleChatHistory },
  { methods: ['GET'], path: /^\/realtime\/groups\/([^/]+)\/events$/, handle: handleChatEvents },
  {
    methods: ['POST'],
    path: /^\/realtime\/groups\/([^/]+)\/messages$/,
    handle: handleSendChatMessage,
  },
  {
    methods: ['GET', 'POST', 'DELETE'],
    path: /^\/realtime\/groups\/([^/]+)\/messages\/([^/]+)\/reactions(?:\/([^/]+))?$/,
    handle: handleChatReaction,
  },
  {
    methods: ['POST'],
    path: /^\/realtime\/groups\/([^/]+)\/reaction-counts$/,
    handle: handleChatReactionCounts,
  },
];
