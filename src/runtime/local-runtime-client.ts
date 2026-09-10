import type { CurrentCycleResult, Cycle } from '../domain/cycles';
import type { Group, MemberId, MembershipDenied } from '../domain/profiles';

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
  getGroupForMember(actingMemberId: MemberId): Promise<Group | MembershipDenied>;
  getCurrentCycle(groupId: string, actingMemberId: MemberId): Promise<CurrentCycleResult>;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ErrorPayload {
  error?: string;
  message?: string;
}

export class LocalRuntimeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
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

  async getGroupForMember(actingMemberId: MemberId): Promise<Group | MembershipDenied> {
    try {
      const body = await this.request<{ group: Group }>(
        `/groups/current?memberId=${encodeURIComponent(actingMemberId)}`,
      );
      return body.group;
    } catch (error) {
      if (error instanceof LocalRuntimeError && error.status === 403)
        return { kind: 'MembershipDenied' };
      throw error;
    }
  }

  async getCurrentCycle(groupId: string, actingMemberId: MemberId): Promise<CurrentCycleResult> {
    try {
      const body = await this.request<{ cycle: Cycle }>(
        `/cycles/current?groupId=${encodeURIComponent(groupId)}&memberId=${encodeURIComponent(actingMemberId)}`,
      );
      return body.cycle;
    } catch (error) {
      if (!(error instanceof LocalRuntimeError)) throw error;
      if (error.status === 403) return { kind: 'MembershipDenied' };
      if (error.status === 404) return { kind: 'NotFound' };
      return { kind: 'RecoverableFailure' };
    }
  }

  private async request<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { Accept: 'application/json' },
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
      );
    }
    return payload as T;
  }
}
