import { createRealAccountVideoRuntimeClient } from '../src/capture/real-account-video-runtime';
import { ClipUploadSession } from '../src/capture/clip-uploader';
import type { ClipUploadInput, PendingClipUpload } from '../src/domain/video';

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const pending: PendingClipUpload = {
  contribution: {
    createdAt: '2026-09-28T00:00:00.000Z',
    cycleId: 'real-cycle-1',
    durationSeconds: 8,
    groupId: 'real/group-1',
    id: 'contribution-1',
    memberId: 'real-profile-1',
  },
  existing: false,
  job: {
    contributionId: 'contribution-1',
    createdAt: '2026-09-28T00:00:00.000Z',
    groupId: 'real/group-1',
    id: 'clip-job-1',
    kind: 'clip',
    status: 'pending',
  },
};

const input: ClipUploadInput = {
  byteLength: 3,
  durationSeconds: 8,
  hasAudio: true,
  height: 1280,
  idempotencyKey: 'clip-key-1234',
  mimeType: 'video/mp4',
  sourceUri: 'staged://aabbccddeeff001122334455',
  width: 720,
};

describe('real account video runtime', () => {
  it('deletes a committed server job when Cancel precedes its registration response', async () => {
    let sendReceipt!: () => void;
    const registeredJobs = new Set<string>();
    let quotaSeconds = 0;
    const authenticatedRequest = jest.fn((path: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        expect(path).toBe('/contributions/upload/clip-job-1?groupId=real%2Fgroup-1');
        registeredJobs.delete(pending.job.id);
        quotaSeconds -= input.durationSeconds;
        return Promise.resolve(response({ cancelled: true }));
      }
      expect(path).toBe('/contributions/upload?groupId=real%2Fgroup-1');
      registeredJobs.add(pending.job.id);
      quotaSeconds += input.durationSeconds;
      return new Promise<Response>((resolve, reject) => {
        sendReceipt = () => resolve(response({ upload: pending }, 201));
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted after commit', 'AbortError')),
        );
      });
    });
    const client = createRealAccountVideoRuntimeClient(authenticatedRequest, {
      transferMode: 'server',
    });
    const session = new ClipUploadSession({
      uploadClip: (clip, signal) =>
        client.uploadClip!('ignored-session', 'real/group-1', clip, signal),
      cancelClipUpload: (jobId) =>
        client.cancelClipUpload!('ignored-session', 'real/group-1', jobId),
    });

    const uploading = session.upload(input);
    const cancelled = expect(uploading).rejects.toMatchObject({ code: 'cancelled' });
    expect(registeredJobs.size).toBe(1);
    expect(quotaSeconds).toBe(8);
    await session.cancel();
    expect(session.getProgress()).toEqual({ status: 'cancelled', percent: 0 });
    expect(authenticatedRequest).toHaveBeenCalledTimes(1);
    expect(authenticatedRequest.mock.calls[0][1]?.signal).toBeUndefined();

    sendReceipt();
    await cancelled;
    expect(authenticatedRequest).toHaveBeenCalledTimes(2);
    expect(registeredJobs.size).toBe(0);
    expect(quotaSeconds).toBe(0);
    expect(session.getProgress()).toEqual({ status: 'cancelled', percent: 0 });
  });

  it('refuses server registration when cancellation already happened', async () => {
    const authenticatedRequest = jest.fn();
    const client = createRealAccountVideoRuntimeClient(authenticatedRequest);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.uploadClip!('ignored-session', 'real/group-1', input, controller.signal),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(authenticatedRequest).not.toHaveBeenCalled();
  });

  it('aborts byte staging and does not register after a late staging response', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' });
    const fetchSource = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: async () => blob,
    } as Response);
    let finishStaging!: () => void;
    let reachedStaging!: () => void;
    const stagingStarted = new Promise<void>((resolve) => (reachedStaging = resolve));
    const authenticatedRequest = jest.fn((_path: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      reachedStaging();
      return new Promise<Response>((resolve) => {
        finishStaging = () =>
          resolve(response({ source: { uri: input.sourceUri, byteLength: 3 } }));
      });
    });
    try {
      const client = createRealAccountVideoRuntimeClient(authenticatedRequest);
      const controller = new AbortController();
      const uploading = client.uploadClip!(
        'ignored-session',
        'real/group-1',
        { ...input, sourceUri: 'blob:owned-capture' },
        controller.signal,
      );
      const cancelled = expect(uploading).rejects.toMatchObject({ code: 'cancelled' });
      await stagingStarted;
      expect(authenticatedRequest.mock.calls[0][1]?.signal).toBe(controller.signal);
      controller.abort();
      finishStaging();
      await cancelled;
      expect(authenticatedRequest).toHaveBeenCalledTimes(1);
      expect(authenticatedRequest.mock.calls[0][0]).toContain('/contributions/upload/source?');
      expect(controller.signal.aborted).toBe(true);
    } finally {
      fetchSource.mockRestore();
    }
  });

  it('loads the authenticated ledger and deletes a contribution in the selected group', async () => {
    const ledger = {
      cycleId: 'real-cycle-1',
      memberId: 'real-profile-1',
      allowance: {
        maxCount: 5,
        maxSeconds: 30,
        countUsed: 1,
        secondsUsed: 3,
        deletionsUsed: 0,
        deletionAvailability: 'available',
      },
      entries: [],
      pagination: { limit: 50, hasMore: false, nextCursor: null },
    };
    const authenticatedRequest = jest
      .fn()
      .mockResolvedValueOnce(response(ledger))
      .mockResolvedValueOnce(response({ deleted: true }));
    const client = createRealAccountVideoRuntimeClient(authenticatedRequest, {
      transferMode: 'server',
    });

    await expect(client.getContributionLedger('real/group-1')).resolves.toEqual(ledger);
    await expect(
      client.deleteContribution('ignored-session', 'real/group-1', 'contribution-1'),
    ).resolves.toBeUndefined();
    expect(authenticatedRequest.mock.calls).toEqual([
      ['/contributions?groupId=real%2Fgroup-1', undefined],
      ['/contributions/contribution-1?groupId=real%2Fgroup-1', { method: 'DELETE' }],
    ]);
  });

  it('stages, submits, processes, and cancels using the authenticated selected-group request', async () => {
    const authenticatedRequest = jest
      .fn()
      .mockResolvedValueOnce(response({ source: { uri: input.sourceUri, byteLength: 3 } }))
      .mockResolvedValueOnce(response({ upload: pending }, 201))
      .mockResolvedValueOnce(response({ job: { ...pending.job, status: 'ready' } }))
      .mockResolvedValueOnce(response({ cancelled: true }));
    const client = createRealAccountVideoRuntimeClient(authenticatedRequest, {
      transferMode: 'server',
    });

    await expect(
      client.stageClipSource?.('ignored-session', 'real/group-1', input.idempotencyKey, 'AQID'),
    ).resolves.toEqual({ uri: input.sourceUri, byteLength: 3 });
    await expect(client.uploadClip?.('ignored-session', 'real/group-1', input)).resolves.toEqual(
      pending,
    );
    await expect(
      client.processClipJob?.('ignored-session', 'real/group-1', pending.job.id),
    ).resolves.toMatchObject({ status: 'ready' });
    await expect(
      client.cancelClipUpload?.('ignored-session', 'real/group-1', pending.job.id),
    ).resolves.toBeUndefined();

    const paths = authenticatedRequest.mock.calls.map(([path]) => String(path));
    expect(paths).toEqual([
      expect.stringContaining('/contributions/upload/source?groupId=real%2Fgroup-1&'),
      '/contributions/upload?groupId=real%2Fgroup-1',
      '/contributions/jobs/clip-job-1/process?groupId=real%2Fgroup-1',
      '/contributions/upload/clip-job-1?groupId=real%2Fgroup-1',
    ]);
    expect(paths.join('&')).not.toMatch(/sessionId|token|authorization/i);
    expect(authenticatedRequest.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(authenticatedRequest.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(input));
  });

  it('checks the authenticated group-scoped job status after an already-processing response', async () => {
    jest.useFakeTimers();
    try {
      const processing = { id: pending.job.id, status: 'processing' };
      const authenticatedRequest = jest
        .fn()
        .mockResolvedValueOnce(response({ error: 'media_processing' }, 409))
        .mockResolvedValue(response({ clip: processing }));
      const client = createRealAccountVideoRuntimeClient(authenticatedRequest, {
        transferMode: 'server',
      });
      const result = client.processClipJob?.('ignored-session', 'real/group-1', pending.job.id);
      await jest.runAllTimersAsync();
      await expect(result).resolves.toMatchObject({ status: 'processing' });

      const paths = authenticatedRequest.mock.calls.map(([path]) => String(path));
      expect(paths[0]).toBe('/contributions/jobs/clip-job-1/process?groupId=real%2Fgroup-1');
      expect(
        paths.slice(1).every((path) => path === '/clips/clip-job-1?groupId=real%2Fgroup-1'),
      ).toBe(true);
      expect(paths.length).toBeGreaterThan(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports a retryable processing failure only after the scoped status confirms failure', async () => {
    const authenticatedRequest = jest
      .fn()
      .mockResolvedValueOnce(response({ error: 'media_processing' }, 409))
      .mockResolvedValueOnce(response({ clip: { id: pending.job.id, status: 'failed' } }));
    const client = createRealAccountVideoRuntimeClient(authenticatedRequest, {
      transferMode: 'server',
    });

    await expect(
      client.processClipJob?.('ignored-session', 'real/group-1', pending.job.id),
    ).rejects.toMatchObject({ code: 'media_processing_failed', status: 503 });
    expect(authenticatedRequest).toHaveBeenCalledTimes(2);
    expect(authenticatedRequest.mock.calls[1]?.[0]).toBe(
      '/clips/clip-job-1?groupId=real%2Fgroup-1',
    );
  });
});
