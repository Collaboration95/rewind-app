import { Blob as NodeBlob } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';
import { Platform } from 'react-native';

import {
  createDirectTransferClient,
  digestTransferBytes,
  type DirectTransferIntent,
} from '../src/capture/direct-transfer';
import { createRealAccountVideoRuntimeClient } from '../src/capture/real-account-video-runtime';
import { RealAccountClient } from '../src/auth/real-account-client';
import type { ClipUploadInput } from '../src/domain/video';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(),
  readAsStringAsync: jest.fn(),
  EncodingType: { Base64: 'base64' },
}));

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: jest.fn(async (_algorithm: string, bytes: Uint8Array) => {
    const { createHash } = jest.requireActual('node:crypto') as typeof import('node:crypto');
    const buffer = createHash('sha256').update(bytes).digest();
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }),
}));

const bytes = Uint8Array.from([0, 255, 128, 42]);
const now = new Date('2026-10-02T12:00:00Z');
const sha = async (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const input: ClipUploadInput = {
  idempotencyKey: 'direct-key-12345',
  sourceUri: 'file:///private/capture.mp4',
  mimeType: 'video/mp4',
  byteLength: bytes.length,
  durationSeconds: 1,
  width: 720,
  height: 1280,
  hasAudio: true,
  trimStartSeconds: 0,
  trimEndSeconds: 1,
};
function response(value: unknown, status = 200, version?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    headers: { get: (name: string) => (name === 'x-amz-version-id' ? (version ?? null) : null) },
  } as Response;
}
function fixture() {
  const checkpoints = new Map<string, string>();
  const checkpointStore = {
    getItem: jest.fn(async (key: string) => checkpoints.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      checkpoints.set(key, value);
    }),
  };
  let current: DirectTransferIntent = {
    id: 'intent-1',
    cycleId: 'cycle-1',
    profileId: 'profile-1',
    state: 'open',
    expiresAt: '2026-10-02T12:15:00.000Z',
    versionId: null,
    contributionId: null,
    jobId: null,
  };
  let request: Record<string, unknown>;
  let uploaded: Uint8Array | null = null;
  let puts = 0;
  let contributions = 0;
  const root = '/real/groups/group-1/upload-intents';
  const api = jest.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === root && init?.method === 'POST') {
      request = JSON.parse(String(init.body));
      return response({
        intent: current,
        upload:
          current.state !== 'open'
            ? null
            : {
                method: 'PUT',
                url: 'https://private-storage.invalid/object?opaque=signature',
                expiresAt: current.expiresAt,
                headers: {
                  'content-type': request.contentType,
                  'x-amz-checksum-sha256': Buffer.from(String(request.sha256), 'hex').toString(
                    'base64',
                  ),
                },
              },
      });
    }
    if (path === `${root}/intent-1`) return response({ intent: current });
    if (path === `${root}/intent-1/complete` || path === `${root}/intent-1/reconcile`) {
      expect(JSON.parse(String(init?.body))).toEqual(
        path.endsWith('/reconcile') ? {} : { versionId: 'version-1' },
      );
      if (path.endsWith('/reconcile') && uploaded === null)
        return response({ error: 'upload_intent_source_unavailable' }, 503);
      expect(uploaded).toEqual(bytes);
      if (current.state !== 'completed') contributions++;
      current = {
        ...current,
        state: 'completed',
        versionId: 'version-1',
        contributionId: 'contribution-1',
        jobId: 'job-1',
      };
      return response({ intent: current });
    }
    throw new Error(`Unexpected app path ${path}`);
  });
  const storageFetch = jest.fn(
    async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      puts++;
      const body = init?.body;
      uploaded =
        body && 'arrayBuffer' in Object(body)
          ? new Uint8Array(await (body as Blob).arrayBuffer())
          : new Uint8Array(body as ArrayBuffer);
      return response(null, 200, 'version-1');
    },
  );
  const options = {
    sha256: sha,
    checkpointStore,
    storageFetch: storageFetch as typeof fetch,
    now: () => now,
  };
  return {
    api,
    storageFetch,
    checkpointStore,
    checkpoints,
    options,
    root,
    client: createDirectTransferClient(api, options),
    source: () => ({ kind: 'base64' as const, base64: Buffer.from(bytes).toString('base64') }),
    get uploaded() {
      return uploaded;
    },
    get puts() {
      return puts;
    },
    get contributions() {
      return contributions;
    },
    get status() {
      return current;
    },
    set status(value: DirectTransferIntent) {
      current = value;
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('direct private transfer', () => {
  it('passes the signed incoming lifecycle tag unchanged to private storage', async () => {
    const c = fixture();
    const original = c.api.getMockImplementation()!;
    c.api.mockImplementationOnce(async (path, init) => {
      const body = await (await original(path, init)).json();
      body.upload.headers['x-amz-tagging'] = 'rewind-media-class=incoming';
      return response(body);
    });
    await c.client.transferContribution('group-1', input, c.source());
    expect(c.storageFetch.mock.calls[0][1]?.headers).toMatchObject({
      'x-amz-tagging': 'rewind-media-class=incoming',
    });
    expect(c.contributions).toBe(1);
  });

  it.each(['rewind-media-class=films', 'rewind-media-class=incoming&other=value'])(
    'rejects an unexpected lifecycle tag %s before upload',
    async (tagging) => {
      const c = fixture();
      const original = c.api.getMockImplementation()!;
      c.api.mockImplementationOnce(async (path, init) => {
        const body = await (await original(path, init)).json();
        body.upload.headers['x-amz-tagging'] = tagging;
        return response(body);
      });
      await expect(
        c.client.transferContribution('group-1', input, c.source()),
      ).rejects.toMatchObject({
        code: 'invalid_response',
      });
      expect(c.storageFetch).not.toHaveBeenCalled();
    },
  );

  it('default native file reader and durable checkpoint adapter preserve binary identity across client reconstruction', async () => {
    await AsyncStorage.clear();
    jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({
      exists: true,
      isDirectory: false,
      size: bytes.length,
      uri: input.sourceUri,
      modificationTime: 0,
    });
    jest
      .mocked(FileSystem.readAsStringAsync)
      .mockResolvedValue(Buffer.from(bytes).toString('base64'));
    const c = fixture();
    const options = { ...c.options, checkpointStore: undefined };
    await createDirectTransferClient(c.api, options).transferContribution('group-1', input, {
      kind: 'file',
      uri: input.sourceUri,
    });
    jest.mocked(FileSystem.readAsStringAsync).mockRejectedValueOnce(new Error('removed source'));
    await createDirectTransferClient(c.api, options).transferContribution('group-1', input, {
      kind: 'file',
      uri: input.sourceUri,
    });
    expect(c.puts).toBe(1);
    expect(c.contributions).toBe(1);
    expect(FileSystem.readAsStringAsync).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getAllKeys()).toHaveLength(1);
    await AsyncStorage.clear();
  });
  it.each(['base64', 'blob', 'file'] as const)(
    'hashes and PUTs exact %s bytes without app credentials',
    async (kind) => {
      const c = fixture();
      const dispose = jest.fn();
      const readNativeFile = jest.fn(async () => bytes);
      const client = createDirectTransferClient(c.api, { ...c.options, readNativeFile });
      const source =
        kind === 'base64'
          ? { ...c.source(), dispose }
          : kind === 'blob'
            ? {
                kind,
                blob: new NodeBlob([bytes], { type: 'video/mp4' }) as unknown as Blob,
                dispose,
              }
            : { kind, uri: input.sourceUri, dispose };
      const progress = jest.fn();
      await expect(
        client.transferContribution('group-1', input, source, { onProgress: progress }),
      ).resolves.toMatchObject({ state: 'completed', versionId: 'version-1' });
      expect(c.puts).toBe(1);
      expect(c.uploaded).toEqual(bytes);
      const request = JSON.parse(String(c.api.mock.calls[0][1]?.body));
      expect(request.sha256).toBe(await sha(bytes));
      expect(request.byteLength).toBe(bytes.length);
      expect(request.sourceUri).toBeUndefined();
      const [url, init] = c.storageFetch.mock.calls[0];
      expect(url).toMatch(/^https:\/\/private-storage/);
      expect(init).toMatchObject({
        method: 'PUT',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      expect(JSON.stringify(init?.headers)).not.toMatch(/authorization|cookie|session|bearer/i);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(progress.mock.calls.at(-1)?.[0]).toEqual({
        phase: 'complete',
        sentBytes: bytes.length,
        totalBytes: bytes.length,
      });
      expect([...c.checkpoints.values()].join('')).not.toMatch(
        /signature|private\/capture|sourceUri|authorization|sessionToken/,
      );
      if (kind === 'file') expect(readNativeFile).toHaveBeenCalledWith(input.sourceUri);
    },
  );

  it('uses native bearer only on the actual real API client path', async () => {
    const c = fixture();
    const appFetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) =>
      c.api(String(url).replace('https://app.invalid', ''), init),
    );
    const auth = new RealAccountClient(
      'https://app.invalid',
      { read: async () => null, write: async () => {}, clear: async () => {} },
      appFetch as typeof fetch,
    );
    const client = createDirectTransferClient(
      (path, init) => auth.request(path, init ?? {}, 'opaque-native-app-token'),
      c.options,
    );
    await client.transferContribution('group-1', input, c.source());
    expect(new Headers(appFetch.mock.calls[0][1]?.headers).get('Authorization')).toBe(
      'Bearer opaque-native-app-token',
    );
    expect(JSON.stringify(c.storageFetch.mock.calls)).not.toContain('opaque-native-app-token');
    expect([...c.checkpoints.values()].join('')).not.toContain('opaque-native-app-token');
  });

  it('uses browser cookie authentication only on the actual real API path', async () => {
    const os = Object.getOwnPropertyDescriptor(Platform, 'OS');
    const browserWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { href: 'https://app.invalid/', origin: 'https://app.invalid' } },
    });
    try {
      const c = fixture();
      const appFetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) =>
        c.api(String(url).replace('https://app.invalid', ''), init),
      );
      const auth = new RealAccountClient(
        'https://app.invalid',
        { read: async () => null, write: async () => {}, clear: async () => {} },
        appFetch as typeof fetch,
      );
      const client = createDirectTransferClient(
        (path, init) => auth.request(path, init ?? {}, 'ignored-web-token'),
        c.options,
      );
      await client.transferContribution('group-1', input, c.source());
      expect(appFetch.mock.calls[0][1]?.credentials).toBe('include');
      expect(new Headers(appFetch.mock.calls[0][1]?.headers).get('Authorization')).toBeNull();
      expect(c.storageFetch.mock.calls[0][1]?.credentials).toBe('omit');
      expect(JSON.stringify(c.storageFetch.mock.calls)).not.toContain('ignored-web-token');
    } finally {
      if (os) Object.defineProperty(Platform, 'OS', os);
      if (browserWindow) Object.defineProperty(globalThis, 'window', browserWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  });

  it('pins photo duration to three seconds and uses the same protocol', async () => {
    const c = fixture();
    await c.client.transferContribution(
      'group-1',
      {
        ...input,
        mediaType: 'photo',
        mimeType: 'image/jpeg',
        width: 1280,
        height: 720,
        durationSeconds: 500,
        trimEndSeconds: 500,
      },
      c.source(),
    );
    expect(JSON.parse(String(c.api.mock.calls[0][1]?.body))).toMatchObject({
      mediaType: 'photo',
      durationSeconds: 3,
      trimStartSeconds: 0,
      trimEndSeconds: 3,
      contentType: 'image/jpeg',
    });
  });

  it.each([
    { byteLength: 0 },
    { byteLength: 50 * 1024 * 1024 + 1 },
    { mimeType: 'video/webm' },
    { durationSeconds: 16 },
    { width: 0 },
    { hasAudio: false },
    { trimEndSeconds: 16 },
    { sourceDurationSeconds: 0.5 },
    { idempotencyKey: 'bad' },
    { replacesContributionId: '../secret' },
  ])('rejects invalid preflight before intent/PUT: %j', async (invalid) => {
    const c = fixture();
    await expect(
      c.client.transferContribution(
        'group-1',
        { ...input, ...invalid } as ClipUploadInput,
        c.source(),
      ),
    ).rejects.toMatchObject({ code: 'validation', retryable: false });
    expect(c.api).not.toHaveBeenCalled();
    expect(c.storageFetch).not.toHaveBeenCalled();
  });

  it('checks actual source size and copies native bytes before hashing or transfer', async () => {
    const c = fixture();
    await expect(
      c.client.transferContribution('group-1', { ...input, byteLength: 3 }, c.source()),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(c.api).not.toHaveBeenCalled();
    const original = new Uint8Array(bytes);
    const client = createDirectTransferClient(c.api, {
      ...c.options,
      readNativeFile: async () => original,
      sha256: async (value) => {
        const digest = await sha(value);
        if (value.length === bytes.length) original.fill(0);
        return digest;
      },
    });
    await client.transferContribution('group-1', input, { kind: 'file', uri: input.sourceUri });
    expect(c.uploaded).toEqual(bytes);
  });

  it('lost intent response repeats identical metadata and idempotency, never bytes', async () => {
    const c = fixture();
    const first = c.api.getMockImplementation()!;
    c.api.mockImplementationOnce(async (path, init) => {
      await first(path, init);
      throw new Error('lost response');
    });
    await c.client.transferContribution('group-1', input, c.source());
    expect(c.api.mock.calls[0][1]?.body).toBe(c.api.mock.calls[1][1]?.body);
    expect(c.puts).toBe(1);
    expect(c.contributions).toBe(1);
  });

  it('lost completion response queries status and does not repeat PUT or allowance', async () => {
    const c = fixture();
    const original = c.api.getMockImplementation()!;
    c.api.mockImplementation(async (path, init) => {
      const result = await original(path, init);
      if (path.endsWith('/complete')) throw new Error('lost completion');
      return result;
    });
    await expect(
      c.client.transferContribution('group-1', input, c.source()),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(c.api.mock.calls.at(-1)?.[0]).toBe(`${c.root}/intent-1`);
    expect(c.puts).toBe(1);
    expect(c.contributions).toBe(1);
  });

  it('lost completion request safely retries the same known version after status remains open', async () => {
    const c = fixture();
    const original = c.api.getMockImplementation()!;
    let lost = false;
    c.api.mockImplementation(async (path, init) => {
      if (path.endsWith('/complete') && !lost) {
        lost = true;
        throw new Error('request lost');
      }
      return original(path, init);
    });
    await c.client.transferContribution('group-1', input, c.source());
    const completions = c.api.mock.calls.filter(([path]) => path.endsWith('/complete'));
    expect(completions).toHaveLength(2);
    expect(completions[0][1]?.body).toBe(completions[1][1]?.body);
    expect(c.puts).toBe(1);
    expect(c.contributions).toBe(1);
  });

  it('lost PUT response journals before dispatch and reconciles exact bytes without a second PUT across restart', async () => {
    const c = fixture();
    const original = c.storageFetch.getMockImplementation()!;
    c.storageFetch.mockImplementationOnce(async (url, init) => {
      expect([...c.checkpoints.values()].some((row) => JSON.parse(row).putStarted)).toBe(true);
      await original(url, init);
      throw new Error('lost PUT');
    });
    const dispose = jest.fn();
    await expect(
      c.client.transferContribution('group-1', input, { ...c.source(), dispose }),
    ).resolves.toMatchObject({ state: 'completed', versionId: 'version-1' });
    const restarted = createDirectTransferClient(c.api, c.options);
    await expect(
      restarted.transferContribution('group-1', input, c.source()),
    ).resolves.toMatchObject({ state: 'completed', versionId: 'version-1' });
    expect(c.puts).toBe(1);
    expect(c.contributions).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    const reconcile = c.api.mock.calls.filter(([path]) => path.endsWith('/reconcile'));
    expect(reconcile).toHaveLength(1);
    expect(reconcile[0][1]).toMatchObject({ method: 'POST', body: '{}' });
    expect(c.api.mock.calls.at(-1)?.[0]).toBe(`${c.root}/intent-1`);
  });

  it('missing exposed version header is recoverable and cannot register unknown bytes', async () => {
    const c = fixture();
    c.storageFetch.mockResolvedValueOnce(response(null));
    await expect(c.client.transferContribution('group-1', input, c.source())).rejects.toMatchObject(
      { code: 'upload_intent_source_unavailable' },
    );
    expect(c.api.mock.calls.some(([path]) => path.endsWith('/complete'))).toBe(false);
  });

  it('missing CORS version exposure reconciles a stored upload before any source disposal', async () => {
    const c = fixture();
    const original = c.storageFetch.getMockImplementation()!;
    c.storageFetch.mockImplementationOnce(async (url, init) => {
      await original(url, init);
      return response(null);
    });
    const dispose = jest.fn(() => {
      expect(c.status.state).toBe('completed');
    });
    await c.client.transferContribution('group-1', input, { ...c.source(), dispose });
    expect(c.puts).toBe(1);
    expect(c.contributions).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(c.api.mock.calls.some(([path]) => path.endsWith('/complete'))).toBe(false);
  });

  it.each(['response', 'request'])(
    'lost reconciliation %s checks status and bounds retries without another PUT',
    async (kind) => {
      const c = fixture();
      const put = c.storageFetch.getMockImplementation()!;
      c.storageFetch.mockImplementationOnce(async (url, init) => {
        await put(url, init);
        throw new Error('lost storage response');
      });
      const api = c.api.getMockImplementation()!;
      let lost = false;
      c.api.mockImplementation(async (path, init) => {
        if (path.endsWith('/reconcile') && !lost) {
          lost = true;
          if (kind === 'response') await api(path, init);
          throw new Error('lost reconciliation ' + kind);
        }
        return api(path, init);
      });
      await c.client.transferContribution('group-1', input, c.source());
      expect(c.puts).toBe(1);
      expect(c.contributions).toBe(1);
      expect(c.api.mock.calls.filter(([path]) => path.endsWith('/reconcile'))).toHaveLength(
        kind === 'request' ? 2 : 1,
      );
    },
  );

  it.each([
    ['upload_intent_source_unavailable', 503, 2],
    ['upload_intent_version_conflict', 409, 1],
  ] as const)(
    'unresolved reconciliation %s never reuploads or disposes, including durable retry',
    async (code, status, attempts) => {
      const c = fixture();
      const put = c.storageFetch.getMockImplementation()!;
      c.storageFetch.mockImplementationOnce(async (url, init) => {
        await put(url, init);
        throw new Error('lost storage response');
      });
      const api = c.api.getMockImplementation()!;
      c.api.mockImplementation(async (path, init) =>
        path.endsWith('/reconcile') ? response({ error: code }, status) : api(path, init),
      );
      const dispose = jest.fn();
      await expect(
        c.client.transferContribution('group-1', input, { ...c.source(), dispose }),
      ).rejects.toMatchObject({ code });
      expect(c.api.mock.calls.filter(([path]) => path.endsWith('/reconcile'))).toHaveLength(
        attempts,
      );
      await expect(
        createDirectTransferClient(c.api, c.options).transferContribution('group-1', input, {
          ...c.source(),
          dispose,
        }),
      ).rejects.toMatchObject({ code });
      expect(c.api.mock.calls.filter(([path]) => path.endsWith('/reconcile'))).toHaveLength(
        attempts * 2,
      );
      expect(c.puts).toBe(1);
      expect(c.contributions).toBe(0);
      expect(dispose).not.toHaveBeenCalled();
    },
  );

  it('cancel/group switch during reconciliation suppresses late confirmed acceptance and disposal', async () => {
    const c = fixture();
    const put = c.storageFetch.getMockImplementation()!;
    c.storageFetch.mockImplementationOnce(async (url, init) => {
      await put(url, init);
      throw new Error('lost');
    });
    const started = deferred<void>();
    const wait = deferred<Response>();
    const api = c.api.getMockImplementation()!;
    c.api.mockImplementation(async (path, init) => {
      if (path.endsWith('/reconcile')) {
        started.resolve();
        return wait.promise;
      }
      return api(path, init);
    });
    const dispose = jest.fn();
    const work = c.client.transferContribution('group-1', input, { ...c.source(), dispose });
    const rejected = expect(work).rejects.toMatchObject({ code: 'cancelled' });
    await started.promise;
    c.client.cancel('group-1');
    wait.resolve(await api(`${c.root}/intent-1/reconcile`, { method: 'POST', body: '{}' }));
    await rejected;
    expect(dispose).not.toHaveBeenCalled();
  });

  it('a durable unknown-version retry reconciles without rereading a missing source file', async () => {
    const c = fixture();
    const put = c.storageFetch.getMockImplementation()!;
    c.storageFetch.mockImplementationOnce(async (url, init) => {
      await put(url, init);
      throw new Error('lost');
    });
    const api = c.api.getMockImplementation()!;
    c.api.mockImplementation(async (path, init) =>
      path.endsWith('/reconcile')
        ? response({ error: 'upload_intent_source_unavailable' }, 503)
        : api(path, init),
    );
    const dispose = jest.fn();
    await expect(
      c.client.transferContribution('group-1', input, { ...c.source(), dispose }),
    ).rejects.toMatchObject({ code: 'upload_intent_source_unavailable' });
    expect(dispose).not.toHaveBeenCalled();
    c.api.mockImplementation(api);
    const readNativeFile = jest.fn(async () => {
      throw new Error('source removed');
    });
    const recovered = await createDirectTransferClient(c.api, {
      ...c.options,
      readNativeFile,
    }).transferContribution('group-1', input, { kind: 'file', uri: input.sourceUri, dispose });
    expect(recovered.state).toBe('completed');
    expect(readNativeFile).not.toHaveBeenCalled();
    expect(c.puts).toBe(1);
    expect(c.contributions).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('completed retry uses authenticated status without rereading disposed source or duplicating quota', async () => {
    const c = fixture();
    const dispose = jest.fn();
    await c.client.transferContribution('group-1', input, { ...c.source(), dispose });
    const restarted = createDirectTransferClient(c.api, {
      ...c.options,
      readNativeFile: async () => {
        throw new Error('already disposed');
      },
    });
    await restarted.transferContribution('group-1', input, { kind: 'file', uri: input.sourceUri });
    expect(c.puts).toBe(1);
    expect(c.contributions).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    c.api.mockResolvedValueOnce(response({ error: 'forbidden' }, 403));
    await expect(
      restarted.transferContribution('group-1', input, c.source()),
    ).rejects.toMatchObject({ status: 403, retryable: false });
  });

  it('pins server version on recovery and rejects a different completion version', async () => {
    const c = fixture();
    await c.client.transferContribution('group-1', input, c.source());
    c.status = { ...c.status, versionId: 'foreign-version' };
    await expect(c.client.transferContribution('group-1', input, c.source())).rejects.toMatchObject(
      { code: 'version_conflict', retryable: false },
    );
    expect(c.puts).toBe(1);
  });

  it('rejects a changed owner/cycle and closure between PUT and completion', async () => {
    const c = fixture();
    await c.client.transferContribution('group-1', input, c.source());
    c.status = { ...c.status, cycleId: 'new-cycle' };
    await expect(c.client.transferContribution('group-1', input, c.source())).rejects.toMatchObject(
      { code: 'idempotency_conflict' },
    );
    const closed = fixture();
    const original = closed.api.getMockImplementation()!;
    closed.api.mockImplementation(async (path, init) =>
      path.endsWith('/complete')
        ? response({ error: 'upload_intent_closed_cycle' }, 409)
        : original(path, init),
    );
    const dispose = jest.fn();
    await expect(
      closed.client.transferContribution('group-1', input, { ...closed.source(), dispose }),
    ).rejects.toMatchObject({ code: 'upload_intent_closed_cycle', retryable: false });
    expect(dispose).not.toHaveBeenCalled();
    expect(closed.puts).toBe(1);
    expect(closed.contributions).toBe(0);
  });

  it('recovers a missing PUT version from a server-pinned status without resending bytes', async () => {
    const c = fixture();
    const original = c.storageFetch.getMockImplementation()!;
    c.storageFetch.mockImplementationOnce(async (url, init) => {
      await original(url, init);
      c.status = { ...c.status, state: 'pinned', versionId: 'version-1' };
      return response(null);
    });
    await c.client.transferContribution('group-1', input, c.source());
    expect(c.puts).toBe(1);
    expect(c.contributions).toBe(1);
  });

  it('reports local disposal failure truthfully and retries cleanup without another PUT', async () => {
    const c = fixture();
    const dispose = jest
      .fn()
      .mockRejectedValueOnce(new Error('local file busy'))
      .mockResolvedValueOnce(undefined);
    await expect(
      c.client.transferContribution('group-1', input, { ...c.source(), dispose }),
    ).rejects.toMatchObject({ code: 'source_disposal_failed' });
    expect(c.contributions).toBe(1);
    await c.client.transferContribution('group-1', input, { ...c.source(), dispose });
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(c.puts).toBe(1);
    expect(c.contributions).toBe(1);
  });

  it('rejects changed request metadata and byte checksum on retries', async () => {
    const c = fixture();
    c.api.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
    await expect(c.client.transferContribution('group-1', input, c.source())).rejects.toMatchObject(
      { code: 'offline' },
    );
    await expect(
      c.client.transferContribution('group-1', { ...input, trimEndSeconds: 0.5 }, c.source()),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      c.client.transferContribution('group-1', input, {
        kind: 'base64',
        base64: Buffer.from([1, 2, 3, 4]).toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(c.puts).toBe(0);
  });

  it('abort during PUT suppresses completion, disposal and late success', async () => {
    const c = fixture();
    const wait = deferred<Response>();
    const started = deferred<void>();
    const dispose = jest.fn();
    c.storageFetch.mockImplementationOnce(async () => {
      started.resolve();
      return wait.promise;
    });
    const controller = new AbortController();
    const work = c.client.transferContribution(
      'group-1',
      input,
      { ...c.source(), dispose },
      { signal: controller.signal },
    );
    const rejected = expect(work).rejects.toMatchObject({ code: 'cancelled', retryable: false });
    await started.promise;
    controller.abort();
    wait.resolve(response(null, 200, 'version-1'));
    await rejected;
    expect(dispose).not.toHaveBeenCalled();
    expect(c.api.mock.calls.some(([path]) => path.endsWith('/complete'))).toBe(false);
  });

  it('group switch/current-generation fence suppresses late API work and stale disposal', async () => {
    const c = fixture();
    const wait = deferred<Response>();
    const started = deferred<void>();
    let selected = true;
    c.storageFetch.mockImplementationOnce(async () => {
      started.resolve();
      return wait.promise;
    });
    const work = c.client.transferContribution('group-1', input, c.source(), {
      isCurrent: () => selected,
    });
    const rejected = expect(work).rejects.toMatchObject({ code: 'cancelled' });
    await started.promise;
    selected = false;
    c.client.dispose();
    wait.resolve(response(null, 200, 'version-1'));
    await rejected;
    expect(c.api.mock.calls.some(([path]) => path.endsWith('/complete'))).toBe(false);
  });

  it('journal storage failure prevents PUT and concurrent identical calls share one transfer', async () => {
    const c = fixture();
    c.checkpointStore.setItem.mockRejectedValueOnce(new Error('quota full'));
    await expect(c.client.transferContribution('group-1', input, c.source())).rejects.toMatchObject(
      { code: 'checkpoint_failed' },
    );
    expect(c.storageFetch).not.toHaveBeenCalled();
    await Promise.all([
      c.client.transferContribution('group-1', input, c.source()),
      c.client.transferContribution('group-1', input, c.source()),
    ]);
    expect(c.puts).toBe(1);
    expect(c.contributions).toBe(1);
  });

  it.each([401, 403, 409])(
    'authorization/quota/cycle rejection %s is terminal and carries no storage request',
    async (status) => {
      const c = fixture();
      c.api.mockResolvedValueOnce(
        response({ error: status === 409 ? 'upload_intent_closed_cycle' : 'forbidden' }, status),
      );
      await expect(
        c.client.transferContribution('group-1', input, c.source()),
      ).rejects.toMatchObject({ status, retryable: false });
      expect(c.storageFetch).not.toHaveBeenCalled();
    },
  );

  it('XML/HTML app responses, XML storage failure, expiry and malicious headers stay readable', async () => {
    const c = fixture();
    c.api
      .mockResolvedValueOnce({
        ...response(null, 502),
        json: async () => {
          throw new SyntaxError('<html>');
        },
      } as Response)
      .mockResolvedValueOnce({
        ...response(null, 502),
        json: async () => {
          throw new SyntaxError('<html>');
        },
      } as Response);
    await expect(c.client.transferContribution('group-1', input, c.source())).rejects.toMatchObject(
      { code: 'invalid_response' },
    );
    c.storageFetch.mockResolvedValueOnce(response('<Error>AccessDenied</Error>', 403));
    await expect(c.client.transferContribution('group-1', input, c.source())).rejects.toMatchObject(
      { code: 'storage_expired' },
    );
    c.status = { ...c.status, state: 'expired' };
    await expect(c.client.transferContribution('group-1', input, c.source())).rejects.toMatchObject(
      { code: 'expired', retryable: false },
    );
    const other = fixture();
    const original = other.api.getMockImplementation()!;
    other.api.mockImplementationOnce(async (path, init) => {
      const body = await (await original(path, init)).json();
      body.upload.headers.Authorization = 'Bearer stolen';
      return response(body);
    });
    await expect(
      other.client.transferContribution('group-1', input, other.source()),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(other.storageFetch).not.toHaveBeenCalled();
  });
});

describe('platform checksum adapters', () => {
  it('native hashes raw bytes rather than the base64 string', async () => {
    await expect(digestTransferBytes(bytes)).resolves.toBe(await sha(bytes));
    expect(await digestTransferBytes(bytes)).not.toBe(
      await sha(new TextEncoder().encode(Buffer.from(bytes).toString('base64'))),
    );
  });

  it('passes an exact ArrayBuffer through the installed React Native binary request converter', async () => {
    const c = fixture();
    await c.client.transferContribution('group-1', input, c.source());
    const body = c.storageFetch.mock.calls[0][1]!.body;
    expect(body).toBeInstanceOf(ArrayBuffer);
    const { default: convertRequestBody } = jest.requireActual(
      'react-native/Libraries/Network/convertRequestBody',
    ) as { default: (body: unknown) => { base64: string } };
    // Both installed RCTNetworking platform wrappers call this converter;
    // their native implementations decode this bridge value to binary bytes.
    const bridge = convertRequestBody(body);
    expect(new Uint8Array(Buffer.from(bridge.base64, 'base64'))).toEqual(bytes);
    expect(c.storageFetch.mock.calls[0][1]!.credentials).toBe('omit');
  });
  it('browser uses Web Crypto on exact bytes and requires a secure crypto boundary', async () => {
    const os = Object.getOwnPropertyDescriptor(Platform, 'OS');
    const crypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    try {
      await expect(digestTransferBytes(bytes)).resolves.toBe(await sha(bytes));
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
      await expect(digestTransferBytes(bytes)).rejects.toMatchObject({
        code: 'checksum_unavailable',
      });
    } finally {
      if (os) Object.defineProperty(Platform, 'OS', os);
      if (crypto) Object.defineProperty(globalThis, 'crypto', crypto);
      else delete (globalThis as { crypto?: unknown }).crypto;
    }
  });
});

describe('real runtime direct-transfer compatibility', () => {
  it('holds staged source locally and preserves authoritative legacy receipt metadata', async () => {
    const c = fixture();
    const original = c.api.getMockImplementation()!;
    c.api.mockImplementation(async (path, init) =>
      path === '/contributions?groupId=group-1'
        ? response({
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
            entries: [
              {
                contributionId: 'contribution-1',
                jobId: 'job-1',
                state: 'queued',
                durationSeconds: 1,
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
                attempts: 0,
                progress: 0,
                failureCategory: null,
                retryable: true,
                replaced: false,
                restored: null,
              },
            ],
            pagination: { limit: 50, hasMore: false, nextCursor: null },
          })
        : original(path, init),
    );
    const client = createRealAccountVideoRuntimeClient(c.api, {
      ...c.options,
      transferMode: 'direct',
    });
    const staged = await client.stageClipSource!(
      'ignored-opaque-app-token',
      'group-1',
      input.idempotencyKey,
      c.source().base64,
    );
    expect(c.api).not.toHaveBeenCalled();
    const uploaded = await client.uploadClip!('ignored-opaque-app-token', 'group-1', {
      ...input,
      sourceUri: staged.uri,
    });
    expect(uploaded).toMatchObject({
      contribution: { id: 'contribution-1', createdAt: now.toISOString(), memberId: 'profile-1' },
      job: { id: 'job-1', status: 'pending' },
    });
    await client.uploadClip!('ignored-opaque-app-token', 'group-1', {
      ...input,
      sourceUri: staged.uri,
    });
    expect(c.puts).toBe(1);
    expect(c.contributions).toBe(1);
    expect(JSON.stringify(c.api.mock.calls)).not.toContain('ignored-opaque-app-token');
    client.dispose();
  });
});
