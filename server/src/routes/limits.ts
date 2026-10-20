// In-process concurrency limits and rate limiters for the runtime.
import { type IncomingMessage, type ServerResponse } from 'node:http';

import { UsedStates } from '../auth/cognito';
import { type RuntimeConfig } from '../config';

import { finishRejectedRequest } from './body';
import { authJson, sendJson } from './respond';

export interface RequestLimiters {
  cognitoStates: UsedStates;
  intake: ConcurrencyLimiter;
  processing: ConcurrencyLimiter;
  archive: ConcurrencyLimiter;
  registration: RegistrationRateLimiter;
  chat: AccountTokenBucket;
  groups: AccountTokenBucket;
  safety: AccountTokenBucket;
  streams: AccountStreamLimiter;
}

class ConcurrencyLimiter {
  private active = 0;

  constructor(private readonly limit: number) {}

  tryAcquire(): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }
}

export function createRequestLimiters(config: RuntimeConfig): RequestLimiters {
  return {
    cognitoStates: new UsedStates(),
    intake: new ConcurrencyLimiter(config.maxConcurrentIntakes),
    processing: new ConcurrencyLimiter(config.maxConcurrentProcessing),
    archive: new ConcurrencyLimiter(2),
    registration: new RegistrationRateLimiter(),
    chat: new AccountTokenBucket(30, 60 * 1000),
    groups: new AccountTokenBucket(5, 24 * 60 * 60 * 1000),
    safety: new AccountTokenBucket(20, 10 * 60 * 1000),
    streams: new AccountStreamLimiter(),
  };
}

const REGISTRATION_WINDOW_MS = 15 * 60 * 1000;

const REGISTRATION_ATTEMPT_LIMIT = 5;

const MAX_REGISTRATION_RATE_LIMIT_SOURCES = 10_000;

export class RegistrationRateLimiter {
  private readonly sources = new Map<string, { count: number; windowStartedAt: number }>();

  tryAcquire(
    source: string,
    nowMs: number,
  ): { allowed: true } | { allowed: false; retryAfter: number } {
    for (const [key, bucket] of this.sources) {
      if (nowMs - bucket.windowStartedAt >= REGISTRATION_WINDOW_MS) this.sources.delete(key);
    }

    const bucket = this.sources.get(source);
    if (!bucket) {
      if (this.sources.size >= MAX_REGISTRATION_RATE_LIMIT_SOURCES) {
        return { allowed: false, retryAfter: Math.ceil(REGISTRATION_WINDOW_MS / 1000) };
      }
      this.sources.set(source, { count: 1, windowStartedAt: nowMs });
      return { allowed: true };
    }
    if (bucket.count >= REGISTRATION_ATTEMPT_LIMIT) {
      return {
        allowed: false,
        retryAfter: Math.max(
          1,
          Math.ceil((bucket.windowStartedAt + REGISTRATION_WINDOW_MS - nowMs) / 1000),
        ),
      };
    }
    bucket.count += 1;
    return { allowed: true };
  }
}

// ponytail: one runtime host today. Before scaling to multiple hosts, move
// buckets and stream leases to a shared atomic store (for example Redis).
class AccountTokenBucket {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
  ) {}
  tryAcquire(
    accountId: string,
    nowMs: number,
  ): { allowed: true } | { allowed: false; retryAfter: number } {
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.updatedAt >= this.windowMs) this.buckets.delete(key);
    }
    let bucket = this.buckets.get(accountId);
    if (!bucket) {
      if (this.buckets.size >= MAX_REGISTRATION_RATE_LIMIT_SOURCES)
        return { allowed: false, retryAfter: Math.ceil(this.windowMs / 1000) };
      bucket = { tokens: this.capacity, updatedAt: nowMs };
      this.buckets.set(accountId, bucket);
    }
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + (Math.max(0, nowMs - bucket.updatedAt) * this.capacity) / this.windowMs,
    );
    bucket.updatedAt = nowMs;
    if (bucket.tokens < 1)
      return {
        allowed: false,
        retryAfter: Math.max(
          1,
          Math.ceil(((1 - bucket.tokens) * this.windowMs) / this.capacity / 1000),
        ),
      };
    bucket.tokens -= 1;
    return { allowed: true };
  }
}

class AccountStreamLimiter {
  private readonly active = new Map<string, number>();
  tryAcquire(accountId: string): (() => void) | null {
    const count = this.active.get(accountId) ?? 0;
    if (count >= 5) return null;
    this.active.set(accountId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.active.get(accountId) ?? 1) - 1;
      if (next > 0) this.active.set(accountId, next);
      else this.active.delete(accountId);
    };
  }
}

export function enforceRateLimit(
  limiter: Pick<RegistrationRateLimiter, 'tryAcquire'>,
  key: string,
  now: Date,
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  message: string,
): boolean {
  const result = limiter.tryAcquire(key, now.getTime());
  if (result.allowed) return true;
  authJson(
    request,
    response,
    config,
    429,
    { error: 'rate_limited', message },
    { 'Retry-After': String(result.retryAfter) },
  );
  finishRejectedRequest(request, response);
  return false;
}

export function acquireRequestCapacity(
  limiter: ConcurrencyLimiter,
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
): (() => void) | null {
  const release = limiter.tryAcquire();
  if (release) return release;
  sendJson(response, config, 429, {
    error: 'concurrency_limit',
    message: 'The server is at its configured concurrency limit. Retry the request.',
  });
  finishRejectedRequest(request, response);
  return null;
}
