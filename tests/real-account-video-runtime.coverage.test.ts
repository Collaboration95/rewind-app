import { createHash } from 'node:crypto';

import { ClipUploadError } from '../src/capture/clip-uploader';
import { createRealAccountVideoRuntimeClient } from '../src/capture/real-account-video-runtime';
import type { ClipUploadInput, PendingClipUpload } from '../src/domain/video';
import { LocalRuntimeError } from '../src/runtime/local-runtime-client';

const MEDIA = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
const MEDIA_BASE64 = Buffer.from(MEDIA).toString('base64');
const NOW = new Date('2026-10-02T12:00:00Z');
const GROUP = 'group-1';
const KEY = 'runtime-key-12345';
const sha = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function reply(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

function unreadable(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError('<html>');
    },
  } as unknown as Response;
}

const input: ClipUploadInput = {
  idempotencyKey: KEY,
  sourceUri: 'staged://aabbccddeeff001122334455',
  mimeType: 'video/mp4',
  byteLength: MEDIA.length,
  durationSeconds: 1,
  width: 720,
  height: 1280,
  hasAudio: true,
  trimStartSeconds: 0,
  trimEndSeconds: 1,
};

const pending: PendingClipUpload = {
  contribution: {
    id: 'contribution-1',
    cycleId: 'cycle-1',
    groupId: GROUP,
    memberId: 'profile-1',
    durationSeconds: 1,
    createdAt: NOW.toISOString(),
  },
  job: {
    id: 'job-1',
    contributionId: 'contribution-1',
    groupId: GROUP,
    kind: 'clip',
    status: 'pending',
    createdAt: NOW.toISOString(),
  },
  existing: false,
};

function ledgerEntry(state: string, overrides: Record<string, unknown> = {}) {
  const gone = state === 'deleted' || state === 'replaced';
  return {
    contributionId: 'contribution-1',
    jobId: 'job-1',
    state,
    durationSeconds: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    attempts: 0,
    progress: 0,
    failureCategory: null,
    retryable: true,
    replaced: state === 'replaced',
    restored: gone ? { count: 1, seconds: 1 } : null,
    ...overrides,
  };
}

function ledger(entries: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    cycleId: 'cycle-1',
    memberId: 'profile-1',
    allowance: {
      maxCount: 5,
      maxSeconds: 30,
      countUsed: 1,
      secondsUsed: 1,
      deletionsUsed: 0,
      deletionAvailability: 'available',
    },
    entries,
    pagination: { limit: 50, hasMore: false, nextCursor: null },
    ...overrides,
  };
}

/**
 * Real authenticated-request fake: the intent endpoint completes immediately,
 * so the actual direct-transfer client runs without any module mocks.
 */
function directApi(ledgerBody: unknown = ledger([ledgerEntry('queued')])) {
  const completed = {
    id: 'intent-1',
    cycleId: 'cycle-1',
    profileId: 'profile-1',
    state: 'completed',
    expiresAt: '2026-10-02T12:15:00.000Z',
    versionId: 'version-1',
    contributionId: 'contribution-1',
    jobId: 'job-1',
  };
  return jest.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    if (path.endsWith('/upload-intents') && init?.method === 'POST')
      return reply({ intent: completed, upload: null });
    if (path.endsWith('/upload-intents/intent-1')) return reply({ intent: completed });
    if (path.startsWith('/contributions?')) return reply(ledgerBody);
    throw new Error(`Unexpected request ${path}`);
  });
}

function directClient(api: jest.Mock, extra: Record<string, unknown> = {}) {
  const checkpoints = new Map<string, string>();
  return createRealAccountVideoRuntimeClient(api, {
    transferMode: 'direct',
    sha256: sha,
    now: () => NOW,
    checkpointStore: {
      getItem: async (key: string) => checkpoints.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        checkpoints.set(key, value);
      },
    },
    ...extra,
  });
}

function serverClient(api: jest.Mock) {
  return createRealAccountVideoRuntimeClient(api, { transferMode: 'server' });
}

afterEach(() => jest.restoreAllMocks());

describe('server mode: error mapping', () => {
  it('turns server messages and codes into typed runtime errors', async () => {
    const api = jest
      .fn()
      .mockResolvedValue(reply({ message: 'Upload too large.', error: 'payload_too_large' }, 413));
    const client = serverClient(api);

    await expect(
      client.stageClipSource!('ignored', GROUP, KEY, MEDIA_BASE64),
    ).rejects.toMatchObject({
      name: 'LocalRuntimeError',
      message: 'Upload too large.',
      status: 413,
      code: 'payload_too_large',
    });
  });

  it('uses a generic message when the error body is unreadable or has no message', async () => {
    const client = serverClient(
      jest.fn().mockResolvedValueOnce(unreadable(500)).mockResolvedValueOnce(reply({}, 403)),
    );

    await expect(client.cancelClipUpload!('s', GROUP, 'job-1')).rejects.toMatchObject({
      message: 'The media request could not be completed.',
      status: 500,
      code: undefined,
    });
    await expect(client.deleteContribution('s', GROUP, 'c-1')).rejects.toMatchObject({
      message: 'The media request could not be completed.',
      status: 403,
    });
  });

  it.each([401, 403, 429])('surfaces HTTP %i from the ledger endpoint', async (status) => {
    const client = serverClient(jest.fn().mockResolvedValue(reply({ message: 'Denied.' }, status)));

    await expect(client.getContributionLedger(GROUP)).rejects.toMatchObject({
      status,
      message: 'Denied.',
    });
  });

  it('rejects a malformed ledger with a stable code', async () => {
    const client = serverClient(jest.fn().mockResolvedValue(reply({ entries: 'nope' })));

    await expect(client.getContributionLedger(GROUP)).rejects.toMatchObject({
      code: 'invalid_contribution_ledger',
      message: 'Contributions could not be loaded.',
    });
  });

  it('returns an empty ledger as-is', async () => {
    const empty = ledger([]);
    const client = serverClient(jest.fn().mockResolvedValue(reply(empty)));

    await expect(client.getContributionLedger(GROUP)).resolves.toMatchObject({ entries: [] });
  });
});

describe('server mode: staging', () => {
  it('rejects undecodable base64 before any request', async () => {
    const api = jest.fn();
    const client = serverClient(api);

    await expect(client.stageClipSource!('s', GROUP, KEY, '***')).rejects.toMatchObject({
      message: 'The captured clip could not be prepared for upload.',
    });
    await expect(
      client.stagePhotoSource('s', GROUP, KEY, '***', 'image/png'),
    ).rejects.toBeInstanceOf(LocalRuntimeError);
    expect(api).not.toHaveBeenCalled();
  });

  it('stages a photo with its own content type and an encoded key', async () => {
    const api = jest
      .fn()
      .mockResolvedValue(reply({ source: { uri: 'staged://p', byteLength: 8 } }));
    const client = serverClient(api);

    await expect(
      client.stagePhotoSource('s', 'group/1', 'key with space', MEDIA_BASE64, 'image/jpeg'),
    ).resolves.toEqual({ uri: 'staged://p', byteLength: 8 });

    const [path, init] = api.mock.calls[0];
    expect(path).toBe(
      '/contributions/upload/source?groupId=group%2F1&idempotencyKey=key%20with%20space',
    );
    expect(init.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(Array.from(init.body as Uint8Array)).toEqual(Array.from(MEDIA));
  });

  it('forwards the abort signal when staging video bytes', async () => {
    const api = jest
      .fn()
      .mockResolvedValue(reply({ source: { uri: 'staged://v', byteLength: 8 } }));
    const controller = new AbortController();

    await serverClient(api).stageClipSource!('s', GROUP, KEY, MEDIA_BASE64, controller.signal);

    expect(api.mock.calls[0][1].signal).toBe(controller.signal);
  });
});

describe('server mode: upload', () => {
  it('refuses to start when the signal is already aborted', async () => {
    const api = jest.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(
      serverClient(api).uploadClip!('s', GROUP, input, controller.signal),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(api).not.toHaveBeenCalled();
  });

  it('reports an unreadable browser capture as a missing source', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false } as Response);
    const api = jest.fn();

    await expect(
      serverClient(api).uploadClip!('s', GROUP, { ...input, sourceUri: 'blob:capture-1' }),
    ).rejects.toMatchObject({ code: 'missing_source', status: 400 });
    expect(api).not.toHaveBeenCalled();
  });

  it('stages a browser blob first and registers the server-side source it returns', async () => {
    const blob = new Blob([MEDIA]);
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, blob: async () => blob } as unknown as Response);
    const api = jest
      .fn()
      .mockResolvedValueOnce(reply({ source: { uri: 'staged://server-uri', byteLength: 8 } }))
      .mockResolvedValueOnce(reply({ upload: pending }, 201));

    const result = await serverClient(api).uploadClip!('s', GROUP, {
      ...input,
      sourceUri: 'blob:capture-1',
      byteLength: 1,
    });

    expect(result).toEqual(pending);
    expect(fetchSpy).toHaveBeenCalledWith('blob:capture-1', {
      credentials: 'omit',
      signal: undefined,
    });
    expect(api.mock.calls[0][1].body).toBe(blob);
    expect(JSON.parse(api.mock.calls[1][1].body)).toMatchObject({
      sourceUri: 'staged://server-uri',
      byteLength: 8,
    });
  });

  it('does not register if the signal aborts after staging a blob', async () => {
    const controller = new AbortController();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, blob: async () => new Blob([MEDIA]) } as unknown as Response);
    const api = jest.fn().mockImplementationOnce(async () => {
      controller.abort();
      return reply({ source: { uri: 'staged://x', byteLength: 8 } });
    });

    await expect(
      serverClient(api).uploadClip!(
        's',
        GROUP,
        { ...input, sourceUri: 'blob:capture-1' },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('surfaces a quota rejection from registration', async () => {
    const api = jest
      .fn()
      .mockResolvedValue(
        reply({ message: 'No uploads left this week.', error: 'quota_exceeded' }, 409),
      );

    await expect(serverClient(api).uploadClip!('s', GROUP, input)).rejects.toMatchObject({
      status: 409,
      code: 'quota_exceeded',
      message: 'No uploads left this week.',
    });
  });
});

describe('server mode: processClipJob', () => {
  const job = { ...pending.job, status: 'ready' as const };

  it('returns the job when processing starts normally', async () => {
    const api = jest.fn().mockResolvedValue(reply({ job }));

    await expect(serverClient(api).processClipJob!('s', GROUP, 'job-1')).resolves.toEqual(job);
  });

  it('surfaces a non-conflict processing failure', async () => {
    const api = jest
      .fn()
      .mockResolvedValue(reply({ message: 'Worker unavailable.', error: 'unavailable' }, 503));

    await expect(serverClient(api).processClipJob!('s', GROUP, 'job-1')).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
    });
  });

  it('polls a conflicting job until it becomes ready', async () => {
    jest.useFakeTimers();
    try {
      const api = jest
        .fn()
        .mockResolvedValueOnce(reply({}, 409))
        .mockResolvedValueOnce(reply({ clip: { ...job, status: 'processing' } }))
        .mockResolvedValueOnce(reply({ clip: job }));
      const result = serverClient(api).processClipJob!('s', GROUP, 'job/1');
      await jest.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toEqual(job);
      expect(api.mock.calls[1][0]).toBe('/clips/job%2F1?groupId=group-1');
      expect(api).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats a cancelled job as a failed processing attempt', async () => {
    const api = jest
      .fn()
      .mockResolvedValueOnce(reply({}, 409))
      .mockResolvedValueOnce(reply({ clip: { ...job, status: 'cancelled' } }));

    await expect(serverClient(api).processClipJob!('s', GROUP, 'job-1')).rejects.toMatchObject({
      code: 'media_processing_failed',
      status: 503,
    });
  });

  it('stops polling after eight checks and returns the last known status', async () => {
    jest.useFakeTimers();
    try {
      const processing = { ...job, status: 'processing' as const };
      const api = jest
        .fn()
        .mockResolvedValueOnce(reply({}, 409))
        .mockResolvedValue(reply({ clip: processing }));
      const result = serverClient(api).processClipJob!('s', GROUP, 'job-1');
      await jest.advanceTimersByTimeAsync(10_000);

      await expect(result).resolves.toEqual(processing);
      // 1 process call + 8 polls + 1 final status read.
      expect(api).toHaveBeenCalledTimes(10);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('direct mode: local staging', () => {
  it('keeps staged media local, derives a deterministic uri and reports its size', async () => {
    const api = jest.fn();
    const client = directClient(api);

    const first = await client.stageClipSource!('s', 'group/1', KEY, MEDIA_BASE64);
    const again = await client.stageClipSource!('s', 'group/1', KEY, MEDIA_BASE64);

    expect(first).toEqual({ uri: `direct-transfer://group%2F1/${KEY}`, byteLength: MEDIA.length });
    expect(again).toEqual(first);
    expect(api).not.toHaveBeenCalled();
  });

  it.each([
    ['a short key', 'group-1', 'short'],
    ['a key with illegal characters', 'group-1', 'bad key!!!!'],
    ['an empty group', '', KEY],
    ['an over-long group', 'g'.repeat(129), KEY],
  ])('rejects %s with a 400 validation error', async (_label, group, key) => {
    const client = directClient(jest.fn());

    await expect(client.stageClipSource!('s', group, key, MEDIA_BASE64)).rejects.toMatchObject({
      status: 400,
      code: 'validation',
      message: 'The capture key or selected group is invalid.',
    });
  });

  it('rejects invalid base64 as a terminal validation failure', async () => {
    const client = directClient(jest.fn());

    await expect(client.stageClipSource!('s', GROUP, KEY, 'not base64!')).rejects.toMatchObject({
      code: 'validation',
      retryable: false,
    });
  });

  it('refuses to restage different media under the same capture key', async () => {
    const client = directClient(jest.fn());
    await client.stageClipSource!('s', GROUP, KEY, MEDIA_BASE64);

    await expect(
      client.stageClipSource!('s', GROUP, KEY, Buffer.from([9, 9]).toString('base64')),
    ).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
    await expect(
      client.stagePhotoSource('s', GROUP, KEY, MEDIA_BASE64, 'image/png'),
    ).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
  });

  it('stages photos locally with their own mime type', async () => {
    const api = jest.fn();
    const client = directClient(api);

    await expect(
      client.stagePhotoSource('s', GROUP, 'photo-key-12345', MEDIA_BASE64, 'image/jpeg'),
    ).resolves.toEqual({
      uri: 'direct-transfer://group-1/photo-key-12345',
      byteLength: MEDIA.length,
    });
    expect(api).not.toHaveBeenCalled();
  });

  it('forgets staged media when its transfer is cancelled', async () => {
    const api = directApi();
    const client = directClient(api);
    const staged = await client.stageClipSource!('s', GROUP, KEY, MEDIA_BASE64);

    client.cancelDirectTransfers(GROUP, KEY);
    // Only the opaque uri is left: with nothing held and no checkpoint, the bytes cannot be rebuilt.
    const error = await client.uploadClip!('s', GROUP, { ...input, sourceUri: staged.uri }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ClipUploadError);
    expect(api).not.toHaveBeenCalled();
  });

  it('keeps media staged for other groups and keys when cancelling one', async () => {
    const api = directApi();
    const client = directClient(api);
    await client.stageClipSource!('s', 'group-other', KEY, MEDIA_BASE64);
    const mine = await client.stageClipSource!('s', GROUP, KEY, MEDIA_BASE64);
    await client.stageClipSource!('s', GROUP, 'another-key-123', MEDIA_BASE64);

    client.cancelDirectTransfers(GROUP, 'another-key-123');

    await expect(
      client.uploadClip!('s', GROUP, { ...input, sourceUri: mine.uri }),
    ).resolves.toMatchObject({ existing: true });
  });

  it('dispose() clears everything staged', async () => {
    const client = directClient(directApi());
    const staged = await client.stageClipSource!('s', GROUP, KEY, MEDIA_BASE64);

    client.dispose();

    await expect(
      client.uploadClip!('s', GROUP, { ...input, sourceUri: staged.uri }),
    ).rejects.toBeInstanceOf(ClipUploadError);
  });
});

describe('direct mode: uploadClip', () => {
  async function staged(client: ReturnType<typeof directClient>) {
    return client.stageClipSource!('s', GROUP, KEY, MEDIA_BASE64);
  }

  it('completes and builds the legacy receipt from the authoritative ledger', async () => {
    const api = directApi();
    const client = directClient(api);
    const { uri } = await staged(client);

    const result = await client.uploadClip!('s', GROUP, { ...input, sourceUri: uri });

    expect(result).toEqual({
      contribution: {
        id: 'contribution-1',
        cycleId: 'cycle-1',
        groupId: GROUP,
        memberId: 'profile-1',
        durationSeconds: 1,
        createdAt: NOW.toISOString(),
      },
      job: {
        id: 'job-1',
        contributionId: 'contribution-1',
        groupId: GROUP,
        kind: 'clip',
        status: 'pending',
        createdAt: NOW.toISOString(),
      },
      existing: true,
    });
  });

  it.each([
    ['queued', 'pending'],
    ['processing', 'processing'],
    ['sealed', 'ready'],
    ['failed', 'failed'],
    ['deleted', 'cancelled'],
    ['replaced', 'cancelled'],
  ])('maps ledger state %s to job status %s', async (state, status) => {
    const client = directClient(directApi(ledger([ledgerEntry(state)])));
    const { uri } = await staged(client);

    const result = await client.uploadClip!('s', GROUP, { ...input, sourceUri: uri });

    expect(result.job.status).toBe(status);
  });

  it.each([
    ['no matching entry', ledger([ledgerEntry('queued', { contributionId: 'someone-else' })])],
    ['a different cycle', ledger([ledgerEntry('queued')], { cycleId: 'cycle-2' })],
    ['a different member', ledger([ledgerEntry('queued')], { memberId: 'profile-9' })],
    ['an unreadable ledger', { entries: 'bad' }],
  ])('reports the contribution as registered when the ledger has %s', async (_l, body) => {
    const client = directClient(directApi(body));
    const { uri } = await staged(client);

    await expect(
      client.uploadClip!('s', GROUP, { ...input, sourceUri: uri }),
    ).rejects.toMatchObject({ status: 503, code: 'contribution_registered' });
  });

  it('propagates a ledger HTTP failure after registration', async () => {
    const api = directApi();
    const base = api.getMockImplementation()!;
    api.mockImplementation(async (path, init) =>
      path.startsWith('/contributions?') ? reply({ message: 'Try later.' }, 429) : base(path, init),
    );
    const client = directClient(api);
    const { uri } = await staged(client);

    await expect(
      client.uploadClip!('s', GROUP, { ...input, sourceUri: uri }),
    ).rejects.toMatchObject({ status: 429, message: 'Try later.' });
  });

  it.each([
    ['another group', { group: 'group-2' }],
    ['another capture key', { key: 'different-key-123' }],
    ['another mime type', { mimeType: 'image/png' }],
  ])('refuses staged media that belongs to %s', async (_label, change) => {
    const api = directApi();
    const client = directClient(api);
    const { uri } = await staged(client);
    const patch = change as { group?: string; key?: string; mimeType?: string };

    await expect(
      client.uploadClip!('s', patch.group ?? GROUP, {
        ...input,
        sourceUri: uri,
        idempotencyKey: patch.key ?? KEY,
        mimeType: (patch.mimeType ?? 'video/mp4') as ClipUploadInput['mimeType'],
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(api).not.toHaveBeenCalled();
  });

  it('rejects a source that is not local captured media', async () => {
    const api = directApi();

    await expect(
      directClient(api).uploadClip!('s', GROUP, {
        ...input,
        sourceUri: 'https://example.com/v.mp4',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'missing_source' });
    expect(api).not.toHaveBeenCalled();
  });

  it('cannot rebuild an unstaged direct-transfer uri that has no completed checkpoint', async () => {
    const api = directApi();

    await expect(
      directClient(api).uploadClip!('s', GROUP, {
        ...input,
        sourceUri: `direct-transfer://${GROUP}/${KEY}`,
      }),
    ).rejects.toMatchObject({ code: 'validation', retryable: false });
    expect(api).not.toHaveBeenCalled();
  });

  it('recovers a completed transfer from its checkpoint without the original bytes', async () => {
    const api = directApi();
    const client = directClient(api);
    const { uri } = await staged(client);
    await client.uploadClip!('s', GROUP, { ...input, sourceUri: uri });
    // The staged bytes are released after success; only the checkpoint remains.

    const again = await client.uploadClip!('s', GROUP, {
      ...input,
      sourceUri: `direct-transfer://${GROUP}/${KEY}`,
    });

    expect(again.contribution.id).toBe('contribution-1');
  });

  it('reads a browser blob capture and transfers it directly', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, blob: async () => new Blob([MEDIA]) } as unknown as Response);
    const api = directApi();

    const result = await directClient(api).uploadClip!('s', GROUP, {
      ...input,
      sourceUri: 'blob:http://localhost/abc',
    });

    expect(result.job.id).toBe('job-1');
  });

  it('reports an unreadable browser blob as a missing source', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false } as Response);

    await expect(
      directClient(directApi()).uploadClip!('s', GROUP, { ...input, sourceUri: 'blob:gone' }),
    ).rejects.toMatchObject({ status: 400, code: 'missing_source' });
  });

  it('reads a native file capture through the injected reader', async () => {
    const readNativeFile = jest.fn(async () => MEDIA);
    const client = directClient(directApi(), { readNativeFile });

    await client.uploadClip!('s', GROUP, { ...input, sourceUri: 'file:///private/capture.mp4' });

    expect(readNativeFile).toHaveBeenCalledWith('file:///private/capture.mp4');
  });

  it('honours an already-aborted signal before touching the network', async () => {
    const api = directApi();
    const controller = new AbortController();
    controller.abort();
    const client = directClient(api);
    const { uri } = await staged(client);

    await expect(
      client.uploadClip!('s', GROUP, { ...input, sourceUri: uri }, controller.signal),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(api).not.toHaveBeenCalled();
  });

  it('exposes transferContribution and an empty baseUrl', () => {
    const client = directClient(directApi());

    expect(client.baseUrl).toBe('');
    expect(typeof client.transferContribution).toBe('function');
  });
});
