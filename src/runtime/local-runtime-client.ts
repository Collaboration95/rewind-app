import type {
  CurrentCycleResult,
  Cycle,
  CycleAdvanceResult,
  DemoRevealState,
  CycleHistoryEntry,
} from '../domain/cycles';
import type { InviteAcceptance, LocalInvite } from '../domain/invites';
import type { ClipUploadInput, PendingClipUpload } from '../domain/video';
import type {
  CreateGroupInput,
  CreateGroupResult,
  Group,
  MemberId,
  MembershipDenied,
} from '../domain/profiles';
import type { DemoSession } from '../domain/session';
import type { Premiere } from '../domain/premiere';
import type { ReleasedArchive } from '../domain/archive';
import {
  parseContributionLedgerPage,
  type ContributionLedgerPage,
  type ContributionLedgerState,
} from '../domain/contributions';
import {
  RealtimeChatClient,
  type ChatMessage,
  type ChatMessageDraft,
  type ChatMessageEvent,
  type ChatReactionEmoji,
  type ChatReactionResult,
  type RealtimeSubscription,
  type SubscribeOptions,
} from '../chat/realtime-client';

export interface RuntimeHealth {
  ok: true;
  service: 'rewind-local-runtime';
  version: string;
  ready: true;
  checks: { sqlite: true; ffmpegConfigured: boolean };
  addresses: { local: string; lan: string | null };
}

export interface RuntimeClient {
  readonly baseUrl: string;
  getHealth(): Promise<RuntimeHealth>;
  getGroupForMember(
    actingMemberId: MemberId,
    sessionId?: string,
  ): Promise<Group | MembershipDenied>;
  getCurrentCycle(
    groupId: string,
    actingMemberId: MemberId,
    sessionId?: string,
  ): Promise<CurrentCycleResult>;
  advanceDemoCycle(
    groupId: string,
    actingMemberId: MemberId,
    advanceSeconds: number,
    sessionId?: string,
  ): Promise<CycleAdvanceResult>;
  revealDemoCycle?(sessionId: string, groupId: string): Promise<DemoRevealState>;
  getDemoSession?(sessionId: string): Promise<DemoSession>;
  createDemoSession?(memberId: MemberId, groupId?: string): Promise<DemoSession>;
  invalidateDemoSession?(sessionId: string): Promise<DemoSession>;
  resetDemoData?(sessionId: string): Promise<void>;
  createGroup?(sessionId: string, input: CreateGroupInput): Promise<CreateGroupResult>;
  createInvite?(
    sessionId: string,
    groupId: string,
    expiresInSeconds?: number,
  ): Promise<LocalInvite>;
  acceptInvite?(sessionId: string, code: string, groupId?: string): Promise<InviteAcceptance>;
  uploadClip?(
    sessionId: string,
    groupId: string,
    input: ClipUploadInput,
  ): Promise<PendingClipUpload>;
  stageClipSource?(
    sessionId: string,
    groupId: string,
    idempotencyKey: string,
    base64: string,
  ): Promise<{ uri: string; byteLength: number }>;
  createSyntheticDemoClip?(sessionId: string, groupId: string): Promise<PendingClipUpload>;
  cancelClipUpload?(sessionId: string, groupId: string, jobId: string): Promise<void>;
  processClipJob?(
    sessionId: string,
    groupId: string,
    jobId: string,
  ): Promise<PendingClipUpload['job']>;
  getPremiere?(sessionId: string, groupId: string, cycleId: string): Promise<Premiere>;
  getReleasedArchive?(sessionId: string, groupId: string): Promise<ReleasedArchive>;
  getCycleHistory?(sessionId: string, groupId: string): Promise<CycleHistoryEntry[]>;
  getContributionLedger?(
    sessionId: string,
    groupId: string,
    options?: { state?: ContributionLedgerState; limit?: number; cursor?: string },
  ): Promise<ContributionLedgerPage>;
  deleteContribution?(
    sessionId: string,
    groupId: string,
    contributionId: string,
  ): Promise<{ contributionId: string; jobId: string; restored: { count: 1; seconds: number } }>;
  createChatDraft?(body: string): ChatMessageDraft;
  sendChatMessage?(
    sessionId: string,
    groupId: string,
    bodyOrDraft: string | ChatMessageDraft,
  ): Promise<ChatMessageEvent>;
  retryChatMessage?(
    sessionId: string,
    groupId: string,
    draft: ChatMessageDraft,
  ): Promise<ChatMessageEvent>;
  sendChatReply?(
    sessionId: string,
    groupId: string,
    bodyOrDraft: string | ChatMessageDraft,
    replyToMessageId: string,
  ): Promise<ChatMessageEvent>;
  toggleChatReaction?(
    sessionId: string,
    groupId: string,
    messageId: string,
    emoji?: ChatReactionEmoji,
    active?: boolean,
  ): Promise<{ reaction: ChatReactionResult; message: ChatMessage }>;
  subscribeChat?(
    sessionId: string,
    groupId: string,
    options: SubscribeOptions,
  ): RealtimeSubscription;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Local runtime calls should not leave a screen waiting forever when a LAN
 * service goes offline or stops responding. The timeout is deliberately
 * short enough for recovery actions to remain usable, while allowing a
 * healthy local request a little room on a busy development machine.
 */
export const DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS = 10_000;
export const MEDIA_RUNTIME_REQUEST_TIMEOUT_MS = 75_000;
export const RUNTIME_OFFLINE_MESSAGE =
  'Server-backed actions are unavailable offline. Reconnect to the local runtime to continue.';

function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export interface LocalRuntimeClientOptions {
  requestTimeoutMs?: number;
}

interface ErrorPayload {
  error?: string;
  field?: string;
  message?: string;
  reason?: string;
}

export class LocalRuntimeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly details?: { field?: string; reason?: string },
  ) {
    super(message);
    this.name = 'LocalRuntimeError';
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/$/, '');
  if (/^\/(?:[^/].*)?$/i.test(trimmed)) return trimmed || '/';
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new LocalRuntimeError(
      'The local runtime URL must start with http://, https://, or a same-origin / path.',
    );
  }
  return trimmed;
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new LocalRuntimeError('The captured clip could not be prepared for upload.');
  }
}

export class LocalRuntimeClient implements RuntimeClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;
  private readonly realtimeChatClient: RealtimeChatClient;

  constructor(
    baseUrl: string,
    fetchImpl: FetchLike = fetch,
    options: LocalRuntimeClientOptions = {},
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    // Browser `window.fetch` throws "Illegal invocation" when it is later
    // called as an object method. Keep a lexical wrapper so both the native
    // fetch and injected test doubles are always invoked as plain functions.
    this.fetchImpl = (input, init) => fetchImpl(input, init);
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new LocalRuntimeError('The local runtime request timeout must be greater than zero.');
    }
    this.requestTimeoutMs = requestTimeoutMs;
    this.realtimeChatClient = new RealtimeChatClient(baseUrl, this.fetchImpl as typeof fetch, {
      sendTimeoutMs: requestTimeoutMs,
    });
  }

  async getHealth(): Promise<RuntimeHealth> {
    return this.request<RuntimeHealth>('/health');
  }

  async getGroupForMember(
    _actingMemberId: MemberId,
    sessionId?: string,
  ): Promise<Group | MembershipDenied> {
    try {
      // The server derives actor identity from the session. Keep the domain
      // argument for the repository port, but never serialize it as authority.
      const sessionQuery = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
      const body = await this.request<{ group: Group }>(`/groups/current${sessionQuery}`);
      return body.group;
    } catch (error) {
      if (error instanceof LocalRuntimeError && error.status === 403)
        return { kind: 'MembershipDenied' };
      throw error;
    }
  }

  async getCurrentCycle(
    groupId: string,
    _actingMemberId: MemberId,
    sessionId?: string,
  ): Promise<CurrentCycleResult> {
    try {
      const sessionQuery = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : '';
      const body = await this.request<{ cycle: Cycle }>(
        `/cycles/current?groupId=${encodeURIComponent(groupId)}${sessionQuery}`,
      );
      return body.cycle;
    } catch (error) {
      if (!(error instanceof LocalRuntimeError)) throw error;
      if (error.status === 403) return { kind: 'MembershipDenied' };
      if (error.status === 404) return { kind: 'NotFound' };
      return { kind: 'RecoverableFailure' };
    }
  }

  async advanceDemoCycle(
    groupId: string,
    _actingMemberId: MemberId,
    advanceSeconds: number,
    sessionId?: string,
  ): Promise<CycleAdvanceResult> {
    try {
      const sessionQuery = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : '';
      const body = await this.request<{ cycle: Cycle }>(
        `/cycles/demo/advance?groupId=${encodeURIComponent(groupId)}&advanceSeconds=${encodeURIComponent(String(advanceSeconds))}${sessionQuery}`,
        { method: 'POST' },
      );
      return body.cycle;
    } catch (error) {
      if (!(error instanceof LocalRuntimeError)) throw error;
      if (error.status === 403) return { kind: 'OwnerControlDenied' };
      if (error.status === 404) return { kind: 'NotFound' };
      if (error.status === 400) return { kind: 'InvalidRequest' };
      return { kind: 'RecoverableFailure' };
    }
  }

  async revealDemoCycle(sessionId: string, groupId: string): Promise<DemoRevealState> {
    const body = await this.request<{ reveal: DemoRevealState }>(
      `/demo/reveal?sessionId=${encodeURIComponent(sessionId)}&groupId=${encodeURIComponent(groupId)}`,
      { method: 'POST' },
      MEDIA_RUNTIME_REQUEST_TIMEOUT_MS,
    );
    return body.reveal;
  }

  async getDemoSession(sessionId: string): Promise<DemoSession> {
    const body = await this.request<{ session: DemoSession }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
    );
    return body.session;
  }

  async createDemoSession(memberId: MemberId, groupId?: string): Promise<DemoSession> {
    const body = await this.request<{ session: DemoSession }>('/sessions/demo', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId, ...(groupId ? { groupId } : {}) }),
    });
    return body.session;
  }

  async invalidateDemoSession(sessionId: string): Promise<DemoSession> {
    const body = await this.request<{ session: DemoSession }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    );
    return body.session;
  }

  async resetDemoData(sessionId: string): Promise<void> {
    await this.request<{ reset: true }>(`/demo/reset?sessionId=${encodeURIComponent(sessionId)}`, {
      method: 'POST',
    });
  }

  async createGroup(sessionId: string, input: CreateGroupInput): Promise<CreateGroupResult> {
    try {
      const body = await this.request<{ group: Group }>(
        '/groups?' + `sessionId=${encodeURIComponent(sessionId)}`,
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      return { ok: true, group: body.group };
    } catch (error) {
      if (!(error instanceof LocalRuntimeError) || error.status !== 400) throw error;
      if (error.code !== 'invalid_group') throw error;
      const field = error.details?.field;
      const reason = error.details?.reason;
      if (
        (field === 'name' || field === 'prompt' || field === 'owner') &&
        (reason === 'required' || reason === 'too_long' || reason === 'invalid')
      ) {
        return {
          ok: false,
          field,
          reason: field === 'owner' ? 'invalid_member' : reason,
        };
      }
      return { ok: false, field: 'prompt', reason: 'required' };
    }
  }

  async createInvite(
    sessionId: string,
    groupId: string,
    expiresInSeconds?: number,
  ): Promise<LocalInvite> {
    const body = await this.request<{ invite: LocalInvite }>(
      `/invites?sessionId=${encodeURIComponent(sessionId)}&groupId=${encodeURIComponent(groupId)}`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(expiresInSeconds ? { expiresInSeconds } : {}) }),
      },
    );
    return body.invite;
  }

  async acceptInvite(sessionId: string, code: string, groupId?: string): Promise<InviteAcceptance> {
    const groupQuery = groupId ? `&groupId=${encodeURIComponent(groupId)}` : '';
    return this.request<InviteAcceptance>(
      `/invites/accept?sessionId=${encodeURIComponent(sessionId)}${groupQuery}`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      },
    );
  }

  async uploadClip(
    sessionId: string,
    groupId: string,
    input: ClipUploadInput,
  ): Promise<PendingClipUpload> {
    const body = await this.request<{ upload: PendingClipUpload }>(
      `/contributions/upload?sessionId=${encodeURIComponent(sessionId)}&groupId=${encodeURIComponent(groupId)}`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    return body.upload;
  }

  async cancelClipUpload(sessionId: string, groupId: string, jobId: string): Promise<void> {
    await this.request<{ cancelled: true }>(
      `/contributions/upload/${encodeURIComponent(jobId)}?sessionId=${encodeURIComponent(sessionId)}&groupId=${encodeURIComponent(groupId)}`,
      { method: 'DELETE' },
    );
  }

  async processClipJob(
    sessionId: string,
    groupId: string,
    jobId: string,
  ): Promise<PendingClipUpload['job']> {
    try {
      const body = await this.request<{ job: PendingClipUpload['job'] }>(
        `/contributions/jobs/${encodeURIComponent(jobId)}/process?sessionId=${encodeURIComponent(sessionId)}&groupId=${encodeURIComponent(groupId)}`,
        { method: 'POST' },
        MEDIA_RUNTIME_REQUEST_TIMEOUT_MS,
      );
      return body.job;
    } catch (error) {
      // The server may still be finishing FFmpeg after a client-side timeout.
      // Read the redacted status endpoint before surfacing a false failure.
      if (
        error instanceof LocalRuntimeError &&
        (error.code === 'runtime_timeout' || error.status === 409)
      ) {
        return this.waitForProcessedClip(sessionId, groupId, jobId);
      }
      throw error;
    }
  }

  async getPremiere(sessionId: string, groupId: string, cycleId: string): Promise<Premiere> {
    const body = await this.request<{
      premiere:
        | { state: 'locked' | 'processing' | 'delayed'; cycleId: string }
        | { state: 'ready'; cycleId: string; filmId: string; playbackPath: string };
    }>(
      `/cycles/${encodeURIComponent(cycleId)}/premiere?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(sessionId)}`,
      {},
      MEDIA_RUNTIME_REQUEST_TIMEOUT_MS,
    );
    if (body.premiere.state !== 'ready') return body.premiere;
    const { playbackPath, ...premiere } = body.premiere;
    return { ...premiere, playbackUrl: `${this.baseUrl}${playbackPath}` };
  }

  async getReleasedArchive(sessionId: string, groupId: string): Promise<ReleasedArchive> {
    const body = await this.request<{
      archive: {
        films: { id: string; cycleId: string; publishedAt: string; downloadPath: string }[];
        clips: {
          id: string;
          contributionId: string;
          cycleId: string;
          createdAt: string;
          downloadPath: string;
        }[];
      };
    }>(
      `/archive?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(sessionId)}`,
      {},
      MEDIA_RUNTIME_REQUEST_TIMEOUT_MS,
    );
    return {
      films: body.archive.films.map(({ downloadPath, ...film }) => ({
        ...film,
        downloadUrl: `${this.baseUrl}${downloadPath}`,
      })),
      clips: body.archive.clips.map(({ downloadPath, ...clip }) => ({
        ...clip,
        downloadUrl: `${this.baseUrl}${downloadPath}`,
      })),
    };
  }

  async getCycleHistory(sessionId: string, groupId: string): Promise<CycleHistoryEntry[]> {
    const body = await this.request<{ cycles: CycleHistoryEntry[] }>(
      `/cycles/history?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(sessionId)}`,
    );
    return body.cycles;
  }

  async deleteContribution(
    sessionId: string,
    groupId: string,
    contributionId: string,
  ): Promise<{ contributionId: string; jobId: string; restored: { count: 1; seconds: number } }> {
    const body = await this.request<{
      deleted: true;
      contributionId: string;
      jobId: string;
      restored: { count: 1; seconds: number };
    }>(
      `/contributions/${encodeURIComponent(contributionId)}?sessionId=${encodeURIComponent(sessionId)}&groupId=${encodeURIComponent(groupId)}`,
      { method: 'DELETE' },
    );
    return {
      contributionId: body.contributionId,
      jobId: body.jobId,
      restored: body.restored,
    };
  }

  /** Planned GET /contributions contract. This remains unused until the
   * authenticated route is available and a parent mounts the ledger. */
  async getContributionLedger(
    sessionId: string,
    groupId: string,
    options: { state?: ContributionLedgerState; limit?: number; cursor?: string } = {},
  ): Promise<ContributionLedgerPage> {
    const filters = [
      `groupId=${encodeURIComponent(groupId)}`,
      `sessionId=${encodeURIComponent(sessionId)}`,
    ];
    if (options.state) filters.push(`state=${encodeURIComponent(options.state)}`);
    if (options.limit !== undefined)
      filters.push(`limit=${encodeURIComponent(String(options.limit))}`);
    if (options.cursor) filters.push(`cursor=${encodeURIComponent(options.cursor)}`);
    const payload = await this.request<unknown>(`/contributions?${filters.join('&')}`);
    const page = parseContributionLedgerPage(payload);
    if (!page) {
      throw new LocalRuntimeError(
        'The contribution list could not be read. Try again.',
        undefined,
        'invalid_contribution_ledger',
      );
    }
    return page;
  }

  async stageClipSource(
    sessionId: string,
    groupId: string,
    idempotencyKey: string,
    base64: string,
  ): Promise<{ uri: string; byteLength: number }> {
    const binary = decodeBase64(base64);
    const body = await this.request<{ source: { uri: string; byteLength: number } }>(
      `/contributions/upload/source?sessionId=${encodeURIComponent(sessionId)}&groupId=${encodeURIComponent(groupId)}&idempotencyKey=${encodeURIComponent(idempotencyKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'video/mp4' },
        body: binary as unknown as BodyInit,
      },
      MEDIA_RUNTIME_REQUEST_TIMEOUT_MS,
    );
    return body.source;
  }

  async createSyntheticDemoClip(sessionId: string, groupId: string): Promise<PendingClipUpload> {
    const body = await this.request<{ upload: PendingClipUpload }>(
      `/demo/synthetic-clip?sessionId=${encodeURIComponent(sessionId)}&groupId=${encodeURIComponent(groupId)}`,
      { method: 'POST' },
      MEDIA_RUNTIME_REQUEST_TIMEOUT_MS,
    );
    return body.upload;
  }

  createChatDraft(body: string): ChatMessageDraft {
    return this.realtimeChatClient.createDraft(body);
  }

  sendChatMessage(
    sessionId: string,
    groupId: string,
    bodyOrDraft: string | ChatMessageDraft,
  ): Promise<ChatMessageEvent> {
    return this.realtimeChatClient.sendMessage(sessionId, groupId, bodyOrDraft);
  }

  retryChatMessage(sessionId: string, groupId: string, draft: ChatMessageDraft) {
    return this.realtimeChatClient.retryMessage(sessionId, groupId, draft);
  }

  sendChatReply(
    sessionId: string,
    groupId: string,
    bodyOrDraft: string | ChatMessageDraft,
    replyToMessageId: string,
  ): Promise<ChatMessageEvent> {
    return this.realtimeChatClient.sendMessage(sessionId, groupId, bodyOrDraft, {
      replyToMessageId,
    });
  }

  toggleChatReaction(
    sessionId: string,
    groupId: string,
    messageId: string,
    emoji: ChatReactionEmoji = '✨',
    active?: boolean,
  ): Promise<{ reaction: ChatReactionResult; message: ChatMessage }> {
    return this.realtimeChatClient.toggleReaction(sessionId, groupId, messageId, emoji, active);
  }

  subscribeChat(
    sessionId: string,
    groupId: string,
    options: SubscribeOptions,
  ): RealtimeSubscription {
    return this.realtimeChatClient.subscribe(sessionId, groupId, options);
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    if (isBrowserOffline()) {
      throw new LocalRuntimeError(RUNTIME_OFFLINE_MESSAGE, undefined, 'runtime_offline');
    }
    let response: Response;
    let payload: unknown = null;
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutController =
      typeof AbortController === 'function' ? new AbortController() : undefined;
    const timeoutError = () =>
      new LocalRuntimeError(
        `The local runtime did not respond within ${timeoutMs} ms. Check that the service is running and the URL is reachable.`,
        undefined,
        'runtime_timeout',
      );
    try {
      const fetchPromise = this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        ...(timeoutController && !init.signal ? { signal: timeoutController.signal } : {}),
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          timeoutController?.abort();
          reject(timeoutError());
        }, timeoutMs);
      });
      response = await Promise.race([fetchPromise, timeoutPromise]);
      try {
        payload = await Promise.race([response.json(), timeoutPromise]);
      } catch (error) {
        if (timedOut) throw error;
        // The error below remains actionable even when a proxy returns invalid JSON.
      }
    } catch (error) {
      if (timedOut) throw error instanceof LocalRuntimeError ? error : timeoutError();
      throw new LocalRuntimeError(
        `Could not reach the local runtime at ${this.baseUrl}. Check that the service is running and the URL is reachable.`,
      );
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    if (!response.ok) {
      const errorPayload = (payload ?? {}) as ErrorPayload;
      throw new LocalRuntimeError(
        errorPayload.message || `Local runtime returned HTTP ${response.status}.`,
        response.status,
        errorPayload.error,
        {
          field: typeof errorPayload.field === 'string' ? errorPayload.field : undefined,
          reason: typeof errorPayload.reason === 'string' ? errorPayload.reason : undefined,
        },
      );
    }
    return payload as T;
  }

  private async waitForProcessedClip(
    sessionId: string,
    groupId: string,
    jobId: string,
  ): Promise<PendingClipUpload['job']> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const body = await this.request<{ clip: PendingClipUpload['job'] }>(
        `/clips/${encodeURIComponent(jobId)}?sessionId=${encodeURIComponent(sessionId)}&groupId=${encodeURIComponent(groupId)}`,
      );
      if (body.clip.status === 'ready') return body.clip;
      if (body.clip.status === 'failed' || body.clip.status === 'cancelled') {
        throw new LocalRuntimeError(
          'The clip could not be processed. Retry the job.',
          503,
          'media_processing_failed',
        );
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
    throw new LocalRuntimeError(
      'The clip is still processing. Check the contribution status and retry if needed.',
      undefined,
      'runtime_timeout',
    );
  }
}
