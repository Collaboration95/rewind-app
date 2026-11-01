import { createHash } from 'node:crypto';
import * as FileSystem from 'expo-file-system/legacy';

import { ClipUploadError, MAX_CLIP_BYTES } from '../src/capture/clip-uploader';
import {
  createDirectTransferClient,
  decodeTransferBase64,
  type DirectTransferIntent,
  type DirectTransferProgress,
} from '../src/capture/direct-transfer';
import type { ClipUploadInput } from '../src/domain/video';

jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(),
  readAsStringAsync: jest.fn(),
  EncodingType: { Base64: 'base64' },
}));

const MEDIA = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
const MEDIA_BASE64 = Buffer.from(MEDIA).toString('base64');
const NOW = new Date('2026-10-02T12:00:00Z');
const ROOT = '/real/groups/group-1/upload-intents';
const sha = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const baseInput: ClipUploadInput = {
  idempotencyKey: 'direct-key-12345',
  sourceUri: 'file:///private/capture.mp4',
  mimeType: 'video/mp4',
  byteLength: MEDIA.length,
  durationSeconds: 1,
  width: 720,
  height: 1280,
  hasAudio: true,
  trimStartSeconds: 0,
  trimEndSeconds: 1,
};

function reply(body: unknown, status = 200, version?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name: string) => (name === 'x-amz-version-id' ? (version ?? null) : null) },
  } as Response;
}

type Step = Response | Error | ((init?: RequestInit) => Response | Promise<Response>);

/** In-memory upload-intent server plus private storage, with per-route scripted overrides. */
function harness() {
  const checkpoints = new Map<string, string>();
  const checkpointStore = {
    getItem: jest.fn(async (key: string) => checkpoints.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      checkpoints.set(key, value);
    }),
  };
  let intent: DirectTransferIntent = {
    id: 'intent-1',
    cycleId: 'cycle-1',
    profileId: 'profile-1',
    state: 'open',
    expiresAt: '2026-10-02T12:15:00.000Z',
    versionId: null,
    contributionId: null,
    jobId: null,
  };
  const scripts = new Map<string, Step[]>();
  const calls: string[] = [];
  let lastRequest: Record<string, unknown> = {};
  let stored = false;
  let puts = 0;
  let capabilityOverride: ((cap: Record<string, unknown>) => unknown) | undefined;

  const capability = () => {
    const base = {
      method: 'PUT',
      url: 'https://private-storage.invalid/object?sig=1',
      expiresAt: intent.expiresAt,
      headers: {
        'content-type': lastRequest.contentType,
        'x-amz-checksum-sha256': Buffer.from(String(lastRequest.sha256), 'hex').toString('base64'),
      },
    };
    return capabilityOverride ? capabilityOverride(base) : base;
  };

  const complete = () => {
    intent = {
      ...intent,
      state: 'completed',
      versionId: 'version-1',
      contributionId: 'contribution-1',
      jobId: 'job-1',
    };
  };

  const api = jest.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    const route = path === ROOT ? '' : path.slice(ROOT.length);
    const key = `${init?.method ?? 'GET'} ${route}`;
    calls.push(key);
    const queue = scripts.get(key);
    const step = queue?.shift();
    if (step) {
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step(init) : step;
    }
    if (key === 'POST ') {
      lastRequest = JSON.parse(String(init?.body));
      return reply({ intent, upload: intent.state === 'open' ? capability() : null });
    }
    if (key === 'GET /intent-1') return reply({ intent });
    if (key === 'POST /intent-1/complete') {
      complete();
      return reply({ intent });
    }
    if (key === 'POST /intent-1/reconcile') {
      if (!stored) return reply({ error: 'upload_intent_source_unavailable' }, 503);
      complete();
      return reply({ intent });
    }
    throw new Error(`Unexpected app request ${key}`);
  });

  const storageFetch = jest.fn(async (_url: unknown, _init?: RequestInit) => {
    puts += 1;
    stored = true;
    return reply(null, 200, 'version-1');
  });

  const progress: DirectTransferProgress[] = [];
  const options = {
    sha256: sha,
    checkpointStore,
    storageFetch: storageFetch as unknown as typeof fetch,
    now: () => NOW,
  };

  const makeClient = (
    extra: Partial<NonNullable<Parameters<typeof createDirectTransferClient>[1]>> = {},
  ) => createDirectTransferClient(api, { ...options, ...extra });
  type Client = ReturnType<typeof createDirectTransferClient>;
  const transfer = (
    overrides: Partial<ClipUploadInput> = {},
    source: Parameters<Client['transferContribution']>[2] = {
      kind: 'base64',
      base64: MEDIA_BASE64,
    },
    groupId = 'group-1',
    control: Parameters<Client['transferContribution']>[3] = {},
    client: Client = makeClient(),
  ) =>
    client.transferContribution(groupId, { ...baseInput, ...overrides }, source, {
      onProgress: (p) => progress.push(p),
      ...control,
    });

  return {
    api,
    calls,
    checkpoints,
    checkpointStore,
    storageFetch,
    progress,
    get puts() {
      return puts;
    },
    script(key: string, ...steps: Step[]) {
      scripts.set(key, steps);
    },
    setIntent(patch: Partial<DirectTransferIntent>) {
      intent = { ...intent, ...patch };
    },
    markStored() {
      stored = true;
    },
    setCapability(fn: (cap: Record<string, unknown>) => unknown) {
      capabilityOverride = fn;
    },
    client: makeClient,
    transfer,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<ClipUploadError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ClipUploadError);
    return error as ClipUploadError;
  }
  throw new Error('Expected the transfer to fail');
}

describe('happy path', () => {
  it('walks through the phases in order and uploads exactly once', async () => {
    const h = harness();

    const result = await h.transfer();

    expect(result).toMatchObject({
      state: 'completed',
      contributionId: 'contribution-1',
      jobId: 'job-1',
    });
    expect(h.progress.map((p) => p.phase)).toEqual([
      'preparing',
      'requesting',
      'uploading',
      'uploading',
      'completing',
      'complete',
    ]);
    expect(h.progress.every((p) => p.totalBytes === MEDIA.length)).toBe(true);
    expect(h.puts).toBe(1);
    const [url, init] = h.storageFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://private-storage.invalid/object?sig=1');
    expect(init).toMatchObject({
      method: 'PUT',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
  });

  it('runs the source disposer exactly once even when the transfer is repeated', async () => {
    const h = harness();
    const dispose = jest.fn();
    const source = { kind: 'base64' as const, base64: MEDIA_BASE64, dispose };
    const client = h.client();

    await h.transfer({}, source, 'group-1', {}, client);
    await h.transfer({}, source, 'group-1', {}, client);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(h.puts).toBe(1);
  });

  it('transfers a Blob without copying it to base64', async () => {
    const h = harness();
    const blob = new Blob([MEDIA]);

    await h.transfer({}, { kind: 'blob', blob });

    expect((h.storageFetch.mock.calls[0][1] as RequestInit).body).toBe(blob);
  });

  it('reads a native file through the injected reader', async () => {
    const h = harness();
    const readNativeFile = jest.fn(async () => MEDIA);
    const client = h.client({ readNativeFile });

    await h.transfer(
      {},
      { kind: 'file', uri: 'file:///private/capture.mp4' },
      'group-1',
      {},
      client,
    );

    expect(readNativeFile).toHaveBeenCalledWith('file:///private/capture.mp4');
  });
});

describe('input validation', () => {
  it.each([
    ['a short idempotency key', { idempotencyKey: 'short' }],
    ['an idempotency key with illegal characters', { idempotencyKey: 'bad key with spaces!' }],
    ['a zero byte length', { byteLength: 0 }],
    ['a fractional byte length', { byteLength: 1.5 }],
    ['an oversized byte length', { byteLength: MAX_CLIP_BYTES + 1 }],
    ['a non-integer width', { width: 720.5 }],
    ['a zero height', { height: 0 }],
    ['a non-MP4 video', { mimeType: 'video/quicktime' as 'video/mp4' }],
    ['a video without audio', { hasAudio: false as never }],
    [
      'a trim end beyond 15 seconds',
      { trimStartSeconds: 0, trimEndSeconds: 16, durationSeconds: 16 },
    ],
    ['a clip shorter than half a second', { durationSeconds: 0.2, trimEndSeconds: 0.2 }],
    ['a negative trim start', { trimStartSeconds: -1 }],
    ['a trim end past the source duration', { sourceDurationSeconds: 0.5 }],
    ['an unknown capture mode', { mode: 'sepia' as never }],
    ['a malformed replacement id', { replacesContributionId: 'has spaces' }],
    ['a non-boolean clientProcessed flag', { clientProcessed: 'yes' as never }],
  ])('rejects %s with a terminal validation error before any network call', async (_l, patch) => {
    const h = harness();

    const error = await failureOf(h.transfer(patch));

    expect(error).toMatchObject({ code: 'validation', retryable: false });
    expect(h.api).not.toHaveBeenCalled();
    expect(h.storageFetch).not.toHaveBeenCalled();
  });

  it('rejects an image mime type for a video and a video mime type for a photo', async () => {
    const h = harness();

    await expect(h.transfer({ mimeType: 'image/jpeg' as never })).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(
      h.transfer({ mediaType: 'photo', mimeType: 'video/mp4' as never }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it.each([
    ['an empty group id', ''],
    ['an over-long group id', 'g'.repeat(129)],
  ])('rejects %s', async (_label, groupId) => {
    const h = harness();

    await expect(h.transfer({}, undefined, groupId)).rejects.toMatchObject({
      code: 'validation',
      retryable: false,
    });
    expect(h.api).not.toHaveBeenCalled();
  });

  it('accepts replacement and client-processed metadata and forwards it to the server', async () => {
    const h = harness();

    await h.transfer({ replacesContributionId: 'old-contribution_1', clientProcessed: true });

    const body = JSON.parse(String(h.api.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      replacesContributionId: 'old-contribution_1',
      clientProcessed: true,
      mode: 'ccd',
    });
  });
});

describe('decodeTransferBase64', () => {
  it('decodes valid padded and unpadded base64', () => {
    expect(Array.from(decodeTransferBase64('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(decodeTransferBase64('AQI='))).toEqual([1, 2]);
    expect(Array.from(decodeTransferBase64(''))).toEqual([]);
  });

  it.each([
    ['illegal characters', 'AQ!D'],
    ['a bad length', 'AQI'],
    ['data URL prefix', 'data:video/mp4;base64,AQID'],
    ['an over-long string', 'A'.repeat(Math.ceil(MAX_CLIP_BYTES / 3) * 4 + 4)],
  ])('rejects %s with a terminal validation error', (_label, value) => {
    expect(() => decodeTransferBase64(value)).toThrow(ClipUploadError);
    try {
      decodeTransferBase64(value);
    } catch (error) {
      expect(error).toMatchObject({ code: 'validation', retryable: false });
    }
  });
});

describe('source reading', () => {
  it('reports a size-mismatched Blob as a missing source', async () => {
    const h = harness();

    const error = await failureOf(
      h.transfer({}, { kind: 'blob', blob: new Blob([new Uint8Array(3)]) }),
    );

    expect(error).toMatchObject({ code: 'missing_source', retryable: false });
    expect(h.api).not.toHaveBeenCalled();
  });

  it('reports a non-file URI for a file source as a missing source', async () => {
    const h = harness();

    await expect(h.transfer({}, { kind: 'file', uri: 'content://media/1' })).rejects.toMatchObject({
      code: 'missing_source',
    });
  });

  it('reports a reader failure as a missing source', async () => {
    const h = harness();
    const client = h.client({
      readNativeFile: async () => {
        throw new Error('ENOENT');
      },
    });

    await expect(
      h.transfer({}, { kind: 'file', uri: 'file:///gone.mp4' }, 'group-1', {}, client),
    ).rejects.toMatchObject({ code: 'missing_source', retryable: false });
  });

  it('rejects base64 content that is not valid base64', async () => {
    const h = harness();

    await expect(h.transfer({}, { kind: 'base64', base64: 'not base64!' })).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('rejects bytes whose length differs from the declared byte length', async () => {
    const h = harness();

    const error = await failureOf(h.transfer({ byteLength: MEDIA.length + 1 }));

    expect(error).toMatchObject({ code: 'validation', retryable: false });
    expect(error.message).toMatch(/size changed/);
  });

  describe('default native file reader', () => {
    const getInfoAsync = FileSystem.getInfoAsync as jest.Mock;
    const readAsStringAsync = FileSystem.readAsStringAsync as jest.Mock;

    it.each([
      ['a missing file', { exists: false }],
      ['a directory', { exists: true, isDirectory: true, size: 8 }],
      ['an empty file', { exists: true, isDirectory: false, size: 0 }],
      ['an oversized file', { exists: true, isDirectory: false, size: MAX_CLIP_BYTES + 1 }],
    ])('rejects %s before reading it', async (_label, info) => {
      const h = harness();
      getInfoAsync.mockResolvedValueOnce(info);

      const error = await failureOf(
        h.transfer({}, { kind: 'file', uri: 'file:///private/capture.mp4' }),
      );

      expect(error).toMatchObject({ code: 'validation', retryable: false });
      expect(readAsStringAsync).not.toHaveBeenCalled();
    });

    it('decodes a stored file as base64', async () => {
      const h = harness();
      getInfoAsync.mockResolvedValueOnce({ exists: true, isDirectory: false, size: MEDIA.length });
      readAsStringAsync.mockResolvedValueOnce(MEDIA_BASE64);

      await h.transfer({}, { kind: 'file', uri: 'file:///private/capture.mp4' });

      expect(readAsStringAsync).toHaveBeenCalledWith('file:///private/capture.mp4', {
        encoding: 'base64',
      });
      expect(h.puts).toBe(1);
    });
  });
});

describe('private upload capability verification', () => {
  const rejected = async (mutate: (cap: Record<string, unknown>) => unknown) => {
    const h = harness();
    h.setCapability(mutate);
    const error = await failureOf(h.transfer());
    expect(h.storageFetch).not.toHaveBeenCalled();
    return error;
  };

  it('rejects an unparseable URL', async () => {
    expect(await rejected((cap) => ({ ...cap, url: 'not a url' }))).toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
  });

  it.each([
    ['plain HTTP', { url: 'http://private-storage.invalid/o' }],
    ['embedded credentials', { url: 'https://user:pw@private-storage.invalid/o' }],
    ['a URL fragment', { url: 'https://private-storage.invalid/o#frag' }],
    ['a non-PUT method', { method: 'POST' }],
    ['an expiry after the intent expires', { expiresAt: '2026-10-02T13:00:00.000Z' }],
    ['an already-past expiry', { expiresAt: '2026-10-02T11:00:00.000Z' }],
    ['a non-date expiry', { expiresAt: 'soon' }],
  ])('rejects %s as an expired, non-retryable capability', async (_label, patch) => {
    expect(await rejected((cap) => ({ ...cap, ...patch }))).toMatchObject({
      code: 'expired',
      retryable: false,
    });
  });

  it.each([
    ['a disallowed header', (h: Record<string, unknown>) => ({ ...h, authorization: 'Bearer x' })],
    [
      'a header with a line break',
      (h: Record<string, unknown>) => ({ ...h, 'cache-control': 'a\r\nb' }),
    ],
    ['a non-string header value', (h: Record<string, unknown>) => ({ ...h, 'cache-control': 5 })],
    [
      'a duplicate header in a different case',
      (h: Record<string, unknown>) => ({ ...h, 'Content-Type': 'video/mp4' }),
    ],
  ])('rejects %s', async (_label, mutateHeaders) => {
    const error = await rejected((cap) => ({
      ...cap,
      headers: mutateHeaders(cap.headers as Record<string, unknown>),
    }));

    expect(error).toMatchObject({ code: 'invalid_response', retryable: false });
    expect(error.message).toMatch(/headers/);
  });

  it('rejects a lifecycle tag other than the incoming class', async () => {
    const error = await rejected((cap) => ({
      ...cap,
      headers: { ...(cap.headers as object), 'x-amz-tagging': 'rewind-media-class=permanent' },
    }));

    expect(error.message).toMatch(/lifecycle/);
  });

  it('rejects a content type or checksum that does not match the verified media', async () => {
    const wrongType = await rejected((cap) => ({
      ...cap,
      headers: { ...(cap.headers as object), 'content-type': 'video/webm' },
    }));
    const wrongChecksum = await rejected((cap) => ({
      ...cap,
      headers: { ...(cap.headers as object), 'x-amz-checksum-sha256': 'AAAA' },
    }));

    expect(wrongType.message).toMatch(/does not match/);
    expect(wrongChecksum.message).toMatch(/does not match/);
  });

  it('rejects a missing upload object', async () => {
    const h = harness();
    h.setCapability(() => null);

    await expect(h.transfer()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('API failures', () => {
  it.each([401, 403])('maps HTTP %i to a terminal authorization error', async (status) => {
    const h = harness();
    h.script('POST ', reply({ error: 'nope' }, status));

    const error = await failureOf(h.transfer());

    expect(error).toMatchObject({ code: 'authorization', retryable: false, status });
    expect(h.calls).toEqual(['POST ']);
  });

  it.each([
    ['upload_quota_exceeded', 409, false, /no remaining contribution allowance/],
    ['upload_source_unavailable', 409, false, /Storage has not confirmed/],
    ['upload_storage_failed', 409, false, /Storage has not confirmed/],
    ['upload_version_conflict', 409, false, /conflicting media versions/],
    ['upload_closed_cycle', 409, false, /collection has closed/],
    ['upload_intent_expired', 410, false, /transfer has expired/],
    ['something_else', 400, false, /could not be accepted/],
  ])('explains %s (HTTP %i)', async (code, status, retryable, message) => {
    const h = harness();
    h.script('POST ', reply({ error: code }, status));

    const error = await failureOf(h.transfer());

    expect(error).toMatchObject({ code, retryable, status });
    expect(error.message).toMatch(message);
  });

  it('retries the intent request once on a retryable server error and then succeeds', async () => {
    const h = harness();
    h.script('POST ', reply({ error: 'overloaded' }, 503));

    await h.transfer();

    expect(h.calls.filter((c) => c === 'POST ')).toHaveLength(2);
    expect(h.progress.map((p) => p.phase)).toContain('reconciling');
  });

  it('gives up when the retried intent request also fails', async () => {
    const h = harness();
    h.script('POST ', reply({ error: 'overloaded' }, 429), reply({ error: 'overloaded' }, 429));

    const error = await failureOf(h.transfer());

    expect(error).toMatchObject({ status: 429, retryable: true });
    expect(h.progress.at(-1)?.phase).toBe('failed');
  });

  it('reports a rate-limit (429) without a body code with the default retryable error', async () => {
    const h = harness();
    h.script('POST ', reply({}, 429), reply({}, 429));

    await expect(h.transfer()).rejects.toMatchObject({ code: 'transfer_failed', retryable: true });
  });

  it('maps a transport error from the secure request layer to insecure_transport', async () => {
    const h = harness();
    h.script('POST ', Object.assign(new Error('blocked'), { reason: 'insecure-transport' }));

    await expect(h.transfer()).rejects.toMatchObject({
      code: 'insecure_transport',
      retryable: false,
    });
  });

  it('maps an expired-session error thrown by the request layer to authorization', async () => {
    const h = harness();
    h.script('POST ', Object.assign(new Error('expired'), { status: 401, reason: 'expired' }));

    await expect(h.transfer()).rejects.toMatchObject({
      code: 'authorization',
      retryable: false,
      status: 401,
    });
  });

  it('treats a lost response as offline and retryable', async () => {
    const h = harness();
    h.script(
      'POST ',
      new TypeError('Network request failed'),
      new TypeError('Network request failed'),
    );

    await expect(h.transfer()).rejects.toMatchObject({ code: 'offline', retryable: true });
  });

  it.each([
    ['an array body', reply([])],
    ['a null body', reply(null)],
    [
      'unparseable JSON',
      {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('<html>');
        },
      } as unknown as Response,
    ],
  ])('treats %s as an invalid, retryable response', async (_label, response) => {
    const h = harness();
    h.script('POST ', response, response);

    await expect(h.transfer()).rejects.toMatchObject({ code: 'invalid_response', retryable: true });
  });

  it.each([
    ['no id', { id: '' }],
    ['no cycle', { cycleId: '' }],
    ['an unknown state', { state: 'weird' as never }],
    ['a non-date expiry', { expiresAt: 'later' }],
    ['a pinned state without a version', { state: 'pinned' as const, versionId: null }],
    ['the "pending" placeholder version', { versionId: 'pending' }],
    [
      'a completed state without a contribution',
      { state: 'completed' as const, versionId: 'v', contributionId: null },
    ],
  ])('rejects an intent with %s', async (_label, patch) => {
    const h = harness();
    h.setIntent(patch);

    await expect(h.transfer()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects an intent that has already expired', async () => {
    const h = harness();
    h.setIntent({ expiresAt: '2026-10-02T11:59:00.000Z' });

    await expect(h.transfer()).rejects.toMatchObject({ code: 'expired', retryable: false });
  });
});

describe('recovery from a saved checkpoint', () => {
  async function interruptAfterIntent(h: ReturnType<typeof harness>, client = h.client()) {
    // An unverifiable capability aborts the first attempt after the intent is journaled.
    h.setCapability((cap) => ({ ...cap, url: 'http://insecure.invalid/o' }));
    await expect(h.transfer({}, undefined, 'group-1', {}, client)).rejects.toMatchObject({
      code: 'expired',
    });
    h.setCapability((cap) => cap);
    h.calls.length = 0;
  }

  it('re-requests the upload address for a journaled intent that never started its PUT', async () => {
    const h = harness();
    await interruptAfterIntent(h);

    await h.transfer();

    expect(h.calls).toEqual(['GET /intent-1', 'POST ', 'POST /intent-1/complete']);
    expect(h.puts).toBe(1);
  });

  it('accepts a re-request that reveals the intent was already completed', async () => {
    const h = harness();
    await interruptAfterIntent(h);
    h.setIntent({ state: 'completed', versionId: 'version-1', contributionId: 'c', jobId: 'j' });
    // status() reports the intent as still open; the repeat POST reveals completion.
    h.script('GET /intent-1', reply({ intent: { ...baseOpenIntent(), versionId: null } }));

    const result = await h.transfer();

    expect(result.state).toBe('completed');
    expect(h.puts).toBe(0);
    expect(h.calls).toEqual(['GET /intent-1', 'POST ']);
  });

  it('skips the PUT when the re-request shows storage already holds a pinned version', async () => {
    const h = harness();
    await interruptAfterIntent(h);
    h.script('GET /intent-1', reply({ intent: baseOpenIntent() }));
    h.script(
      'POST ',
      reply({
        intent: { ...baseOpenIntent(), state: 'pinned', versionId: 'version-1' },
        upload: null,
      }),
    );

    await h.transfer();

    expect(h.puts).toBe(0);
    expect(h.calls).toContain('POST /intent-1/complete');
  });

  it('uses the server-pinned version found by the status check without uploading again', async () => {
    const h = harness();
    await interruptAfterIntent(h);
    h.script(
      'GET /intent-1',
      reply({ intent: { ...baseOpenIntent(), state: 'pinned', versionId: 'version-1' } }),
    );

    await h.transfer();

    expect(h.puts).toBe(0);
    expect(h.calls).toEqual(['GET /intent-1', 'POST /intent-1/complete']);
  });

  it('refuses to resend bytes when a PUT may have happened but no version is known', async () => {
    const h = harness();
    // First attempt: the PUT response is lost and the server cannot confirm any stored object.
    h.storageFetch.mockRejectedValueOnce(new TypeError('connection reset'));
    await expect(h.transfer()).rejects.toMatchObject({ code: 'upload_intent_source_unavailable' });
    expect(h.storageFetch).toHaveBeenCalledTimes(1);
    h.calls.length = 0;

    // Retry: the journal says the PUT started, so only reconciliation may run; it finds no version.
    h.script('POST /intent-1/reconcile', reply({ intent: baseOpenIntent() }));
    const error = await failureOf(h.transfer());

    expect(error).toMatchObject({ code: 'version_unknown', retryable: true });
    expect(h.storageFetch).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual(['GET /intent-1', 'POST /intent-1/reconcile']);
  });

  it('completes a journaled PUT once reconciliation finds the stored version', async () => {
    const h = harness();
    h.storageFetch.mockRejectedValueOnce(new TypeError('connection reset'));
    await expect(h.transfer()).rejects.toBeInstanceOf(ClipUploadError);
    h.markStored();
    h.calls.length = 0;

    const result = await h.transfer();

    expect(result.state).toBe('completed');
    expect(h.storageFetch).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual(['GET /intent-1', 'POST /intent-1/reconcile']);
  });

  it('finishes from a reconciliation that only pins the version', async () => {
    const h = harness();
    h.storageFetch.mockRejectedValueOnce(new TypeError('connection reset'));
    await expect(h.transfer()).rejects.toBeInstanceOf(ClipUploadError);
    h.script(
      'POST /intent-1/reconcile',
      reply({ intent: { ...baseOpenIntent(), state: 'pinned', versionId: 'version-1' } }),
    );
    h.calls.length = 0;

    const result = await h.transfer();

    expect(result.state).toBe('completed');
    expect(h.calls).toEqual([
      'GET /intent-1',
      'POST /intent-1/reconcile',
      'POST /intent-1/complete',
    ]);
  });

  it('rejects a checkpoint saved for different metadata', async () => {
    const h = harness();
    await h.transfer();
    const [key, saved] = [...h.checkpoints.entries()][0];
    h.checkpoints.set(
      key,
      JSON.stringify({ ...JSON.parse(saved), groupId: 'someone-elses-group' }),
    );

    await expect(h.transfer()).rejects.toMatchObject({
      code: 'idempotency_conflict',
      retryable: false,
    });
  });

  it.each([
    ['corrupt JSON', '{not json'],
    ['a wrong format version', JSON.stringify({ format: 2 })],
  ])('rejects a checkpoint with %s as a conflicting capture', async (_label, value) => {
    const h = harness();
    await h.transfer();
    const [key] = [...h.checkpoints.keys()];
    h.checkpoints.set(key, value);

    await expect(h.transfer()).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('fails clearly when the checkpoint cannot be loaded or saved', async () => {
    const loadFails = harness();
    loadFails.checkpointStore.getItem.mockRejectedValueOnce(new Error('disk'));
    await expect(loadFails.transfer()).rejects.toMatchObject({
      code: 'checkpoint_failed',
      retryable: true,
    });

    const saveFails = harness();
    saveFails.checkpointStore.setItem.mockRejectedValueOnce(new Error('full'));
    await expect(saveFails.transfer()).rejects.toMatchObject({ code: 'checkpoint_failed' });
    expect(saveFails.storageFetch).not.toHaveBeenCalled();
  });

  it('refuses media whose hash is not a 64-character hex digest', async () => {
    const h = harness();
    const sha256 = jest
      .fn<Promise<string>, [Uint8Array]>()
      .mockResolvedValueOnce('a'.repeat(64))
      .mockResolvedValue('not-a-digest');

    await expect(
      h.transfer({}, undefined, 'group-1', {}, h.client({ sha256 })),
    ).rejects.toMatchObject({
      code: 'checksum_unavailable',
      retryable: false,
    });
    expect(h.api).not.toHaveBeenCalled();
  });

  it('detects a different server intent identity than the journaled one', async () => {
    const h = harness();
    await interruptAfterIntent(h);
    h.script('GET /intent-1', reply({ intent: { ...baseOpenIntent(), id: 'intent-2' } }));

    await expect(h.transfer()).rejects.toMatchObject({
      code: 'idempotency_conflict',
      retryable: false,
    });
  });

  it('detects a changed owner or cycle', async () => {
    const h = harness();
    await interruptAfterIntent(h);
    h.script(
      'GET /intent-1',
      reply({ intent: { ...baseOpenIntent(), profileId: 'someone-else' } }),
    );

    await expect(h.transfer()).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('detects bytes that changed between journaling and upload', async () => {
    const h = harness();
    await interruptAfterIntent(h);
    const tampered = Buffer.from(Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9])).toString('base64');

    const error = await failureOf(h.transfer({}, { kind: 'base64', base64: tampered }));

    expect(error).toMatchObject({ code: 'idempotency_conflict', retryable: false });
    expect(h.puts).toBe(0);
  });
});

function baseOpenIntent(): DirectTransferIntent {
  return {
    id: 'intent-1',
    cycleId: 'cycle-1',
    profileId: 'profile-1',
    state: 'open',
    expiresAt: '2026-10-02T12:15:00.000Z',
    versionId: null,
    contributionId: null,
    jobId: null,
  };
}

describe('storage and completion failures', () => {
  it('does not retry a rejected (403) PUT when the server still has no version', async () => {
    const h = harness();
    h.storageFetch.mockResolvedValueOnce(reply(null, 403));

    const error = await failureOf(h.transfer());

    expect(error).toMatchObject({ code: 'storage_expired', retryable: true, status: 403 });
    expect(h.calls).not.toContain('POST /intent-1/reconcile');
  });

  it('reconciles after a 5xx PUT and completes when storage confirms the object', async () => {
    const h = harness();
    h.storageFetch.mockImplementationOnce(async () => {
      h.markStored();
      return reply(null, 500);
    });

    const result = await h.transfer();

    expect(result.state).toBe('completed');
    expect(h.calls).toContain('POST /intent-1/reconcile');
    expect(h.puts).toBe(0);
  });

  it('uses a version pinned by the server after a lost PUT response, without reconciling', async () => {
    const h = harness();
    h.storageFetch.mockRejectedValueOnce(new TypeError('connection reset'));
    h.script(
      'GET /intent-1',
      reply({ intent: { ...baseOpenIntent(), state: 'pinned', versionId: 'version-1' } }),
    );

    const result = await h.transfer();

    expect(result.state).toBe('completed');
    expect(h.calls).not.toContain('POST /intent-1/reconcile');
    expect(h.storageFetch).toHaveBeenCalledTimes(1);
  });

  it('uses a version that only reconciliation can pin after a failed PUT', async () => {
    const h = harness();
    h.storageFetch.mockResolvedValueOnce(reply(null, 500));
    h.script(
      'POST /intent-1/reconcile',
      reply({ intent: { ...baseOpenIntent(), state: 'pinned', versionId: 'version-1' } }),
    );

    const result = await h.transfer();

    expect(result.state).toBe('completed');
    expect(h.calls).toContain('POST /intent-1/complete');
    expect(h.storageFetch).toHaveBeenCalledTimes(1);
  });

  it('reports version_unknown when reconciliation cannot find an uploaded version', async () => {
    const h = harness();
    h.storageFetch.mockResolvedValueOnce(reply(null, 500));
    h.script('POST /intent-1/reconcile', reply({ intent: { ...baseOpenIntent() } }));

    const error = await failureOf(h.transfer());

    expect(error).toMatchObject({ code: 'version_unknown', retryable: true });
    expect(error.message).toMatch(/do not resend/);
  });

  it('reports a missing x-amz-version-id and reconciles instead of guessing', async () => {
    const h = harness();
    h.storageFetch.mockResolvedValueOnce(reply(null, 200, undefined));

    await expect(h.transfer()).rejects.toBeInstanceOf(ClipUploadError);
    // Never complete with an invented version: reconciliation runs, completion does not.
    expect(h.calls).toContain('POST /intent-1/reconcile');
    expect(h.calls).not.toContain('POST /intent-1/complete');
  });

  it('checks status then retries completion once after a retryable completion failure', async () => {
    const h = harness();
    h.script('POST /intent-1/complete', reply({ error: 'busy' }, 503));

    const result = await h.transfer();

    expect(result.state).toBe('completed');
    expect(h.calls.filter((c) => c === 'POST /intent-1/complete')).toHaveLength(2);
    expect(h.puts).toBe(1);
  });

  it('accepts a completion that actually landed before the response was lost', async () => {
    const h = harness();
    h.script('POST /intent-1/complete', (init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ versionId: 'version-1' });
      h.setIntent({
        state: 'completed',
        versionId: 'version-1',
        contributionId: 'contribution-1',
        jobId: 'job-1',
      });
      return reply({ error: 'lost' }, 502);
    });

    const result = await h.transfer();

    expect(result.state).toBe('completed');
    expect(h.calls.filter((c) => c === 'POST /intent-1/complete')).toHaveLength(1);
  });

  it('does not retry a terminal completion rejection', async () => {
    const h = harness();
    h.script('POST /intent-1/complete', reply({ error: 'upload_quota_exceeded' }, 409));

    await expect(h.transfer()).rejects.toMatchObject({
      code: 'upload_quota_exceeded',
      retryable: false,
    });
    expect(h.calls.filter((c) => c === 'POST /intent-1/complete')).toHaveLength(1);
  });

  it('rejects a completion answer that is not actually completed', async () => {
    const h = harness();
    h.script(
      'POST /intent-1/complete',
      reply({ intent: { ...baseOpenIntent(), state: 'pinned', versionId: 'version-1' } }),
    );

    await expect(h.transfer()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects a completion that pins a different version than the one uploaded', async () => {
    const h = harness();
    h.script(
      'POST /intent-1/complete',
      reply({
        intent: {
          ...baseOpenIntent(),
          state: 'completed',
          versionId: 'version-OTHER',
          contributionId: 'c',
          jobId: 'j',
        },
      }),
    );

    await expect(h.transfer()).rejects.toMatchObject({
      code: 'version_conflict',
      retryable: false,
    });
  });

  it('reports a disposal failure after registration without losing the receipt', async () => {
    const h = harness();
    const dispose = jest
      .fn()
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockResolvedValue(undefined);
    const source = { kind: 'base64' as const, base64: MEDIA_BASE64, dispose };
    const client = h.client();

    await expect(h.transfer({}, source, 'group-1', {}, client)).rejects.toMatchObject({
      code: 'source_disposal_failed',
    });
    const retry = await h.transfer({}, source, 'group-1', {}, client);

    expect(retry.state).toBe('completed');
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(h.puts).toBe(1);
  });
});

describe('cancellation and concurrency', () => {
  it('cancels before any network call when the caller is no longer current', async () => {
    const h = harness();

    const error = await failureOf(h.transfer({}, undefined, 'group-1', { isCurrent: () => false }));

    expect(error).toMatchObject({ code: 'cancelled', retryable: false });
    expect(h.api).not.toHaveBeenCalled();
    expect(h.progress).toEqual([]);
  });

  it('cancels when the caller becomes stale mid-flight and never disposes or completes', async () => {
    const h = harness();
    let current = true;
    const dispose = jest.fn();
    h.script('POST ', (init) => {
      current = false;
      return reply({ intent: baseOpenIntent(), upload: null }, 200);
    });

    const error = await failureOf(
      h.transfer({}, { kind: 'base64', base64: MEDIA_BASE64, dispose }, 'group-1', {
        isCurrent: () => current,
      }),
    );

    expect(error.code).toBe('cancelled');
    expect(dispose).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('POST /intent-1/complete');
    expect(h.progress.some((p) => p.phase === 'failed')).toBe(false);
  });

  it('honours an already-aborted signal', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      h.transfer({}, undefined, 'group-1', { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(h.puts).toBe(0);
  });

  it('cancel(groupId, key) aborts only the matching transfer', async () => {
    const h = harness();
    const client = h.client();
    let release!: () => void;
    h.script(
      'POST ',
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(reply({ intent: baseOpenIntent(), upload: null }));
        }),
    );
    const pending = client.transferContribution('group-1', baseInput, {
      kind: 'base64',
      base64: MEDIA_BASE64,
    });
    const settled = pending.catch((error) => error as ClipUploadError);
    await new Promise((resolve) => setTimeout(resolve, 0));

    client.cancel('group-1', 'a-different-key-1');
    expect(h.api).toHaveBeenCalledTimes(1);
    client.cancel('group-1', baseInput.idempotencyKey);
    release();

    expect(await settled).toMatchObject({ code: 'cancelled' });
  });

  it('dispose() cancels every transfer and invalidates the client generation', async () => {
    const h = harness();
    const client = h.client();
    let release!: () => void;
    h.script(
      'POST ',
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(reply({ intent: baseOpenIntent(), upload: null }));
        }),
    );
    const settled = client
      .transferContribution('group-1', baseInput, { kind: 'base64', base64: MEDIA_BASE64 })
      .catch((error) => error as ClipUploadError);
    await new Promise((resolve) => setTimeout(resolve, 0));

    client.dispose();
    release();

    expect(await settled).toMatchObject({ code: 'cancelled' });
  });

  it('rejects a conflicting second call while the first is still running', async () => {
    const h = harness();
    const client = h.client();
    let release!: () => void;
    h.script(
      'POST ',
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(reply({ intent: baseOpenIntent(), upload: null }));
        }),
    );
    const first = client
      .transferContribution('group-1', baseInput, { kind: 'base64', base64: MEDIA_BASE64 })
      .catch((error) => error as ClipUploadError);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const conflicting = client.transferContribution(
      'group-1',
      { ...baseInput, byteLength: 4 },
      { kind: 'base64', base64: MEDIA_BASE64 },
    );
    await expect(conflicting).rejects.toMatchObject({
      code: 'idempotency_conflict',
      retryable: false,
    });

    const differentSource = client.transferContribution('group-1', baseInput, {
      kind: 'base64',
      base64: Buffer.from(Uint8Array.from([8, 7, 6, 5, 4, 3, 2, 1])).toString('base64'),
    });
    await expect(differentSource).rejects.toMatchObject({ code: 'idempotency_conflict' });
    release();
    await first;
  });

  it('shares one run between identical concurrent calls', async () => {
    const h = harness();
    const client = h.client();
    const source = { kind: 'base64' as const, base64: MEDIA_BASE64 };

    const [a, b] = await Promise.all([
      client.transferContribution('group-1', baseInput, source),
      client.transferContribution('group-1', baseInput, source),
    ]);

    expect(a).toBe(b);
    expect(h.puts).toBe(1);
    expect(h.calls.filter((c) => c === 'POST ')).toHaveLength(1);
  });
});
