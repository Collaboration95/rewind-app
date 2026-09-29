import { createRealAccountVideoRuntimeClient } from '../src/capture/real-account-video-runtime';
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
  it('stages, submits, processes, and cancels using the authenticated selected-group request', async () => {
    const authenticatedRequest = jest
      .fn()
      .mockResolvedValueOnce(response({ source: { uri: input.sourceUri, byteLength: 3 } }))
      .mockResolvedValueOnce(response({ upload: pending }, 201))
      .mockResolvedValueOnce(response({ job: { ...pending.job, status: 'ready' } }))
      .mockResolvedValueOnce(response({ cancelled: true }));
    const client = createRealAccountVideoRuntimeClient(authenticatedRequest);

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
      const client = createRealAccountVideoRuntimeClient(authenticatedRequest);
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
    const client = createRealAccountVideoRuntimeClient(authenticatedRequest);

    await expect(
      client.processClipJob?.('ignored-session', 'real/group-1', pending.job.id),
    ).rejects.toMatchObject({ code: 'media_processing_failed', status: 503 });
    expect(authenticatedRequest).toHaveBeenCalledTimes(2);
    expect(authenticatedRequest.mock.calls[1]?.[0]).toBe(
      '/clips/clip-job-1?groupId=real%2Fgroup-1',
    );
  });
});
