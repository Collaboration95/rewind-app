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
    };
    const repositories = createRuntimeRepositories(client);
    await expect(repositories.groupRepository.getGroupForMember('demo-1')).resolves.toMatchObject({
      id: 'demo-group',
    });
    await expect(
      repositories.cycleRepository.getCurrentCycle('demo-group', 'demo-1'),
    ).resolves.toEqual({ kind: 'NotFound' });
  });
});
