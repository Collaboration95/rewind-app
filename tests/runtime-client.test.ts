import { LocalRuntimeClient, LocalRuntimeError } from '../src/runtime/local-runtime-client';
import { createRuntimeRepositories } from '../src/runtime/runtime-repositories';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('LocalRuntimeClient', () => {
  it('normalizes the base URL and reads typed health data', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response(200, {
        ok: true,
        service: 'rewind-local-runtime',
        version: '0.1.0',
        ready: true,
        checks: { sqlite: true, ffmpegConfigured: true },
        addresses: { local: 'http://127.0.0.1:8787', lan: null },
      }),
    );
    const client = new LocalRuntimeClient('http://127.0.0.1:8787/', fetchImpl);
    expect(client.baseUrl).toBe('http://127.0.0.1:8787');
    await expect(client.getHealth()).resolves.toMatchObject({ version: '0.1.0', ready: true });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8787/health', {
      headers: { Accept: 'application/json' },
    });
  });

  it('maps a safe membership denial and not-found cycle without exposing transport details', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        response(403, { error: 'forbidden', message: 'You do not have access to this resource.' }),
      )
      .mockResolvedValueOnce(
        response(404, { error: 'not_found', message: 'The requested resource was not found.' }),
      );
    const client = new LocalRuntimeClient('http://localhost:8787', fetchImpl);
    await expect(client.getGroupForMember('demo-outsider')).resolves.toEqual({
      kind: 'MembershipDenied',
    });
    await expect(client.getCurrentCycle('demo-group', 'demo-1')).resolves.toEqual({
      kind: 'NotFound',
    });
  });

  it('returns an actionable error when the local service cannot be reached', async () => {
    const client = new LocalRuntimeClient(
      'http://localhost:8787',
      jest.fn().mockRejectedValue(new Error('offline')),
    );
    await expect(client.getHealth()).rejects.toThrow(
      'Could not reach the local runtime at http://localhost:8787',
    );
  });

  it('rejects non-http runtime URLs before a request is made', () => {
    expect(() => new LocalRuntimeClient('localhost:8787')).toThrow(LocalRuntimeError);
  });

  it('adapts group and cycle reads through domain repository ports', async () => {
    const client = {
      baseUrl: 'http://localhost:8787',
      getHealth: jest.fn(),
      getGroupForMember: jest.fn().mockResolvedValue({
        id: 'demo-group',
        name: 'Weekend People',
        memberIds: ['demo-1'],
        currentCycleId: 'demo-cycle',
      }),
      getCurrentCycle: jest.fn().mockResolvedValue({ kind: 'NotFound' as const }),
      advanceDemoCycle: jest.fn(),
    };
    const repositories = createRuntimeRepositories(client);
    await expect(repositories.groupRepository.getGroupForMember('demo-1')).resolves.toMatchObject({
      id: 'demo-group',
    });
    await expect(
      repositories.cycleRepository.getCurrentCycle('demo-group', 'demo-1'),
    ).resolves.toEqual({ kind: 'NotFound' });
  });

  it('creates, restores, invalidates, and resets a local Demo session through typed mutations', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        response(201, {
          session: {
            id: 'demo-session-2',
            accessKind: 'demo',
            actor: { memberId: 'demo-2', displayName: 'Birch', isSynthetic: true },
            groupId: 'demo-group',
            startedAt: '2026-09-10T12:00:00.000Z',
            expiresAt: '2026-09-10T20:00:00.000Z',
            invalidatedAt: null,
          },
        }),
      )
      .mockResolvedValueOnce(response(200, { session: { id: 'demo-session-2' } }))
      .mockResolvedValueOnce(response(200, { session: { id: 'demo-session-2' } }))
      .mockResolvedValueOnce(response(200, { reset: true }));
    const client = new LocalRuntimeClient('http://localhost:8787', fetchImpl);
    await expect(client.createDemoSession('demo-2')).resolves.toMatchObject({
      id: 'demo-session-2',
    });
    await expect(client.getDemoSession('demo-session-2')).resolves.toMatchObject({
      id: 'demo-session-2',
    });
    await expect(client.invalidateDemoSession('demo-session-2')).resolves.toMatchObject({
      id: 'demo-session-2',
    });
    await expect(client.resetDemoData('demo-session-2')).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
      ['http://localhost:8787/sessions/demo', 'POST'],
      ['http://localhost:8787/sessions/demo-session-2', 'GET'],
      ['http://localhost:8787/sessions/demo-session-2', 'DELETE'],
      ['http://localhost:8787/demo/reset?sessionId=demo-session-2', 'POST'],
    ]);
  });

  it('exposes owner demo cycle advance through a typed control port', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response(200, {
        cycle: {
          id: 'demo-cycle',
          groupId: 'demo-group',
          prompt: 'Prompt',
          startsAt: '2026-09-01T00:00:00.000Z',
          endsAt: '2026-09-11T23:00:00.000Z',
          status: 'collecting',
          lockState: 'locked',
          quota: { maxCount: 5, maxSeconds: 30 },
          contributionUsage: { countUsed: 0, secondsUsed: 0 },
        },
        advanceSeconds: 3600,
        eventId: 'cycle-control-event',
      }),
    );
    const client = new LocalRuntimeClient('http://localhost:8787', fetchImpl);
    await expect(client.advanceDemoCycle('demo-group', 'demo-1', 3600)).resolves.toMatchObject({
      id: 'demo-cycle',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:8787/cycles/demo/advance?groupId=demo-group&memberId=demo-1&advanceSeconds=3600',
      { method: 'POST', headers: { Accept: 'application/json' } },
    );
  });

  it('maps owner-control access denial without exposing server details', async () => {
    const client = new LocalRuntimeClient(
      'http://localhost:8787',
      jest.fn().mockResolvedValue(response(403, { error: 'forbidden', message: 'hidden' })),
    );
    await expect(client.advanceDemoCycle('demo-group', 'demo-2', 3600)).resolves.toEqual({
      kind: 'OwnerControlDenied',
    });
  });

  it('creates and accepts session-bound local invites', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        response(201, {
          invite: {
            id: 'invite-ab12cd34',
            code: 'AB12CD34',
            groupId: 'demo-group',
            status: 'active',
            createdAt: '2026-09-10T12:00:00.000Z',
            expiresAt: '2026-09-10T12:10:00.000Z',
            usedAt: null,
          },
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          invite: {
            id: 'invite-ab12cd34',
            code: 'AB12CD34',
            groupId: 'demo-group',
            status: 'used',
            createdAt: '2026-09-10T12:00:00.000Z',
            expiresAt: '2026-09-10T12:10:00.000Z',
            usedAt: '2026-09-10T12:01:00.000Z',
          },
          group: {
            id: 'demo-group',
            name: 'Weekend People',
            memberIds: ['demo-1', 'demo-2'],
            currentCycleId: 'demo-cycle',
            actingMemberRole: 'member',
          },
          session: { id: 'session-2', groupId: 'demo-group' },
        }),
      );
    const client = new LocalRuntimeClient('http://localhost:8787', fetchImpl);
    await expect(client.createInvite('session-1', 'demo-group', 600)).resolves.toMatchObject({
      code: 'AB12CD34',
    });
    await expect(client.acceptInvite('session-2', 'AB12CD34')).resolves.toMatchObject({
      invite: { status: 'used' },
      session: { groupId: 'demo-group' },
    });
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
      ['http://localhost:8787/invites?sessionId=session-1&groupId=demo-group', 'POST'],
      ['http://localhost:8787/invites/accept?sessionId=session-2', 'POST'],
    ]);
  });

  it('uploads and cancels a clip through the session-bound media route', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        response(201, {
          upload: {
            existing: false,
            contribution: { id: 'contribution-1', durationSeconds: 8 },
            job: { id: 'job-1', status: 'pending' },
          },
        }),
      )
      .mockResolvedValueOnce(response(200, { cancelled: true }));
    const client = new LocalRuntimeClient('http://localhost:8787', fetchImpl);
    const input = {
      byteLength: 1024,
      durationSeconds: 8,
      hasAudio: true as const,
      height: 1280,
      idempotencyKey: 'retryable-1',
      mimeType: 'video/mp4' as const,
      sourceUri: 'file://clip.mp4',
      width: 720,
    };
    await expect(client.uploadClip('session-1', 'demo-group', input)).resolves.toMatchObject({
      job: { id: 'job-1' },
    });
    await expect(client.cancelClipUpload('session-1', 'demo-group', 'job-1')).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
      ['http://localhost:8787/contributions/upload?sessionId=session-1&groupId=demo-group', 'POST'],
      ['http://localhost:8787/contributions/upload/job-1?sessionId=session-1&groupId=demo-group', 'DELETE'],
    ]);
  });
});
