import type { CurrentCycleResult, Cycle, CycleAdvanceResult } from '../domain/cycles';
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
  getDemoSession?(sessionId: string): Promise<DemoSession>;
  createDemoSession?(memberId: MemberId, groupId?: string): Promise<DemoSession>;
  invalidateDemoSession?(sessionId: string): Promise<DemoSession>;
  resetDemoData?(sessionId: string): Promise<void>;
  createGroup?(sessionId: string, input: CreateGroupInput): Promise<CreateGroupResult>;
  createInvite?(sessionId: string, groupId: string, expiresInSeconds?: number): Promise<LocalInvite>;
  acceptInvite?(sessionId: string, code: string, groupId?: string): Promise<InviteAcceptance>;
  uploadClip?(sessionId: string, groupId: string, input: ClipUploadInput): Promise<PendingClipUpload>;
  cancelClipUpload?(sessionId: string, groupId: string, jobId: string): Promise<void>;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new LocalRuntimeError('The local runtime URL must start with http:// or https://.');
  }
  return trimmed;
}

export class LocalRuntimeClient implements RuntimeClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, fetchImpl: FetchLike = fetch) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
  }

  async getHealth(): Promise<RuntimeHealth> {
    return this.request<RuntimeHealth>('/health');
  }

  async getGroupForMember(
    actingMemberId: MemberId,
    sessionId?: string,
  ): Promise<Group | MembershipDenied> {
    try {
      const sessionQuery = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : '';
      const body = await this.request<{ group: Group }>(
        `/groups/current?memberId=${encodeURIComponent(actingMemberId)}${sessionQuery}`,
      );
      return body.group;
    } catch (error) {
      if (error instanceof LocalRuntimeError && error.status === 403)
        return { kind: 'MembershipDenied' };
      throw error;
    }
  }

  async getCurrentCycle(
    groupId: string,
    actingMemberId: MemberId,
    sessionId?: string,
  ): Promise<CurrentCycleResult> {
    try {
      const sessionQuery = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : '';
      const body = await this.request<{ cycle: Cycle }>(
        `/cycles/current?groupId=${encodeURIComponent(groupId)}&memberId=${encodeURIComponent(actingMemberId)}${sessionQuery}`,
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
    actingMemberId: MemberId,
    advanceSeconds: number,
    sessionId?: string,
  ): Promise<CycleAdvanceResult> {
    try {
      const sessionQuery = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : '';
      const body = await this.request<{ cycle: Cycle }>(
        `/cycles/demo/advance?groupId=${encodeURIComponent(groupId)}&memberId=${encodeURIComponent(actingMemberId)}&advanceSeconds=${encodeURIComponent(String(advanceSeconds))}${sessionQuery}`,
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

  async acceptInvite(
    sessionId: string,
    code: string,
    groupId?: string,
  ): Promise<InviteAcceptance> {
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

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
      });
    } catch {
      throw new LocalRuntimeError(
        `Could not reach the local runtime at ${this.baseUrl}. Check that the service is running and the URL is reachable.`,
      );
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // The error below remains actionable even when a proxy returns invalid JSON.
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
}
