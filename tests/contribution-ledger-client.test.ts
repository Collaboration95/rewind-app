import { LocalRuntimeClient, LocalRuntimeError } from '../src/runtime/local-runtime-client';

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const ledgerResponse = {
  cycleId: 'cycle-1',
  memberId: 'member-1',
  allowance: {
    maxCount: 5,
    maxSeconds: 30,
    countUsed: 1,
    secondsUsed: 4,
    deletionsUsed: 0,
    deletionAvailability: 'available',
  },
  entries: [
    {
      contributionId: 'contribution-1',
      jobId: 'clip-job-1',
      state: 'sealed',
      durationSeconds: 4,
      createdAt: '2026-09-10T12:00:00.000Z',
      updatedAt: '2026-09-10T12:01:00.000Z',
      attempts: 1,
      progress: 100,
      failureCategory: null,
      retryable: false,
      replaced: false,
      restored: null,
    },
  ],
  pagination: { limit: 1, hasMore: true, nextCursor: 'page-cursor' },
};

describe('contribution ledger runtime adapter', () => {
  it('requests only selected group/session and accepted filters, then copies whitelisted metadata', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response(200, {
        ...ledgerResponse,
        sourceUri: 'file:///private/locked.mp4',
        entries: [
          {
            ...ledgerResponse.entries[0],
            outputPath: '/private/locked.mp4',
            downloadPath: '/clips/locked/download',
            thumbnail: '/private/frame.jpg',
          },
        ],
      }),
    );
    const client = new LocalRuntimeClient('http://localhost:8787', fetchImpl);
    const page = await client.getContributionLedger('session one', 'group one', {
      state: 'sealed',
      limit: 1,
      cursor: 'cursor+/',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:8787/contributions?groupId=group%20one&sessionId=session%20one&state=sealed&limit=1&cursor=cursor%2B%2F',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ contributionId: 'contribution-1', state: 'sealed' });
    expect(Object.keys(page.entries[0]).sort()).toEqual([
      'attempts',
      'contributionId',
      'createdAt',
      'durationSeconds',
      'failureCategory',
      'jobId',
      'progress',
      'replaced',
      'restored',
      'retryable',
      'state',
      'updatedAt',
    ]);
    expect(JSON.stringify(page)).not.toMatch(
      /private|downloadPath|outputPath|sourceUri|thumbnail/i,
    );
  });

  it('rejects malformed or capability-shaped responses with a safe error', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          ...ledgerResponse,
          entries: [{ ...ledgerResponse.entries[0], contributionId: 'file:///private/clip.mp4' }],
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          ...ledgerResponse,
          pagination: { ...ledgerResponse.pagination, limit: 1000 },
        }),
      );
    const client = new LocalRuntimeClient('/api', fetchImpl);

    await expect(client.getContributionLedger('session-1', 'group-1')).rejects.toMatchObject({
      code: 'invalid_contribution_ledger',
      message: 'The contribution list could not be read. Try again.',
    });
    await expect(client.getContributionLedger('session-1', 'group-1')).rejects.toBeInstanceOf(
      LocalRuntimeError,
    );
  });

  it('preserves the server denial for the parent to show the access state', async () => {
    const client = new LocalRuntimeClient(
      '/api',
      jest.fn().mockResolvedValue(
        response(403, {
          error: 'forbidden',
          message: 'You do not have access to this resource.',
        }),
      ),
    );
    await expect(client.getContributionLedger('session-1', 'other-group')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });
});
