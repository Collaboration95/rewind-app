import {
  CONTRIBUTION_LEDGER_STATES,
  parseContributionLedgerPage,
} from '../src/domain/contributions';

type Json = Record<string, unknown>;

const entry = (overrides: Json = {}): Json => ({
  contributionId: 'c-1',
  jobId: 'job-1',
  state: 'sealed',
  durationSeconds: 5,
  mediaType: 'video',
  createdAt: '2026-10-14T08:00:00.000Z',
  updatedAt: '2026-10-14T08:01:00.000Z',
  attempts: 1,
  progress: 100,
  failureCategory: null,
  retryable: false,
  replaced: false,
  restored: null,
  ...overrides,
});

const page = (overrides: Json = {}): Json => ({
  cycleId: 'cycle-1',
  memberId: 'member-1',
  allowance: {
    maxCount: 5,
    maxSeconds: 30,
    countUsed: 1,
    secondsUsed: 5,
    deletionsUsed: 0,
    deletionAvailability: 'available',
  },
  entries: [entry()],
  pagination: { limit: 50, hasMore: false, nextCursor: null },
  ...overrides,
});

const withAllowance = (patch: Json) =>
  page({ allowance: { ...(page().allowance as Json), ...patch } });
const withPagination = (patch: Json) =>
  page({ pagination: { ...(page().pagination as Json), ...patch } });

describe('parseContributionLedgerPage', () => {
  it('accepts a valid page and copies only the known fields', () => {
    const parsed = parseContributionLedgerPage(
      page({
        secret: 'x',
        entries: [entry({ extra: 'dropped', playbackUrl: 'https://media.invalid/a.mp4' })],
      }),
    );
    expect(parsed).toEqual({
      cycleId: 'cycle-1',
      memberId: 'member-1',
      allowance: {
        maxCount: 5,
        maxSeconds: 30,
        countUsed: 1,
        secondsUsed: 5,
        deletionsUsed: 0,
        deletionAvailability: 'available',
      },
      entries: [
        {
          contributionId: 'c-1',
          jobId: 'job-1',
          state: 'sealed',
          durationSeconds: 5,
          mediaType: 'video',
          createdAt: '2026-10-14T08:00:00.000Z',
          updatedAt: '2026-10-14T08:01:00.000Z',
          attempts: 1,
          progress: 100,
          failureCategory: null,
          retryable: false,
          replaced: false,
          restored: null,
        },
      ],
      pagination: { limit: 50, hasMore: false, nextCursor: null },
    });
  });

  it('knows every ledger state', () => {
    expect(CONTRIBUTION_LEDGER_STATES).toEqual([
      'queued',
      'processing',
      'sealed',
      'failed',
      'deleted',
      'replaced',
    ]);
  });

  it('accepts an empty cycle id (no current cycle) but not a malformed one', () => {
    expect(parseContributionLedgerPage(page({ cycleId: '' }))?.cycleId).toBe('');
    expect(parseContributionLedgerPage(page({ cycleId: '../x' }))).toBeNull();
    expect(parseContributionLedgerPage(page({ cycleId: 7 }))).toBeNull();
  });

  it('labels older entries that omit the media type as video and keeps photos', () => {
    const { mediaType: _omitted, ...legacy } = entry();
    void _omitted;
    const parsed = parseContributionLedgerPage(
      page({
        entries: [legacy, entry({ contributionId: 'c-2', mediaType: 'photo' })],
      }),
    );
    expect(parsed?.entries.map((item) => item.mediaType)).toEqual(['video', 'photo']);
  });

  it('keeps a failed entry with its failure category and null job', () => {
    const parsed = parseContributionLedgerPage(
      page({
        entries: [
          entry({
            state: 'failed',
            jobId: null,
            failureCategory: 'source_unavailable',
            retryable: true,
          }),
        ],
      }),
    );
    expect(parsed?.entries[0]).toMatchObject({
      state: 'failed',
      jobId: null,
      failureCategory: 'source_unavailable',
      retryable: true,
    });
  });

  it('accepts deleted and replaced entries only with restored seconds', () => {
    const restored = { count: 1, seconds: 5, ignored: true };
    const parsed = parseContributionLedgerPage(
      page({
        entries: [
          entry({ contributionId: 'd', state: 'deleted', restored }),
          entry({ contributionId: 'r', state: 'replaced', replaced: true, restored }),
        ],
      }),
    );
    expect(parsed?.entries.map((item) => item.restored)).toEqual([
      { count: 1, seconds: 5 },
      { count: 1, seconds: 5 },
    ]);
    expect(
      parseContributionLedgerPage(page({ entries: [entry({ state: 'deleted', restored: null })] })),
    ).toBeNull();
    expect(
      parseContributionLedgerPage(
        page({ entries: [entry({ restored: { count: 1, seconds: 5 } })] }),
      ),
    ).toBeNull();
    expect(
      parseContributionLedgerPage(
        page({ entries: [entry({ state: 'replaced', replaced: false, restored })] }),
      ),
    ).toBeNull();
    expect(parseContributionLedgerPage(page({ entries: [entry({ replaced: true })] }))).toBeNull();
  });

  it.each<[string, Json]>([
    ['non-object entry restored', { state: 'deleted', restored: 'yes' }],
    ['restored count other than one', { state: 'deleted', restored: { count: 2, seconds: 5 } }],
    ['negative restored seconds', { state: 'deleted', restored: { count: 1, seconds: -1 } }],
    ['unsafe contribution id', { contributionId: 'a/b' }],
    ['non-string contribution id', { contributionId: 4 }],
    ['unsafe job id', { jobId: 'a b' }],
    ['undefined job id', { jobId: undefined }],
    ['unknown state', { state: 'archived' }],
    ['zero duration', { durationSeconds: 0 }],
    ['negative duration', { durationSeconds: -3 }],
    ['non-finite duration', { durationSeconds: Number.POSITIVE_INFINITY }],
    ['string duration', { durationSeconds: '5' }],
    ['invalid createdAt', { createdAt: 'yesterday' }],
    ['non-string updatedAt', { updatedAt: 12 }],
    ['negative attempts', { attempts: -1 }],
    ['progress above 100', { progress: 101 }],
    ['negative progress', { progress: -1 }],
    ['unknown failure category', { failureCategory: 'exploded' }],
    ['undefined failure category', { failureCategory: undefined }],
    ['non-boolean retryable', { retryable: 'yes' }],
    ['non-boolean replaced', { replaced: 0 }],
  ])('rejects the page when an entry has %s', (_name, patch) => {
    expect(parseContributionLedgerPage(page({ entries: [entry(patch)] }))).toBeNull();
  });

  it('accepts every documented failure category', () => {
    for (const category of [
      'invalid_metadata',
      'source_unavailable',
      'processing_failed',
      'unknown',
    ])
      expect(
        parseContributionLedgerPage(
          page({ entries: [entry({ state: 'failed', failureCategory: category })] }),
        )?.entries[0]?.failureCategory,
      ).toBe(category);
  });

  it('rejects entries that are not objects', () => {
    for (const bad of [null, 'x', 5, [], undefined])
      expect(parseContributionLedgerPage(page({ entries: [bad] }))).toBeNull();
  });

  it('rejects duplicate contribution ids', () => {
    expect(parseContributionLedgerPage(page({ entries: [entry(), entry()] }))).toBeNull();
  });

  it('rejects more entries than the page limit', () => {
    expect(
      parseContributionLedgerPage(
        page({
          entries: [entry(), entry({ contributionId: 'c-2' })],
          pagination: { limit: 1, hasMore: false, nextCursor: null },
        }),
      ),
    ).toBeNull();
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['an array', []],
    ['a string', 'ledger'],
    ['a missing allowance', { ...page(), allowance: undefined }],
    ['a missing pagination', { ...page(), pagination: undefined }],
    ['non-array entries', page({ entries: {} })],
    ['an unsafe member id', page({ memberId: 'a b' })],
    ['an absent member id', page({ memberId: undefined })],
  ])('rejects %s', (_name, value) => {
    expect(parseContributionLedgerPage(value)).toBeNull();
  });

  it.each<[string, Json]>([
    ['negative maxCount', { maxCount: -1 }],
    ['non-numeric maxSeconds', { maxSeconds: '30' }],
    ['non-finite countUsed', { countUsed: Number.NaN }],
    ['negative secondsUsed', { secondsUsed: -5 }],
    ['negative deletionsUsed', { deletionsUsed: -1 }],
    ['unknown deletion availability', { deletionAvailability: 'maybe' }],
  ])('rejects an allowance with %s', (_name, patch) => {
    expect(parseContributionLedgerPage(withAllowance(patch))).toBeNull();
  });

  it('accepts the used and unavailable deletion states', () => {
    for (const availability of ['used', 'unavailable'])
      expect(
        parseContributionLedgerPage(withAllowance({ deletionAvailability: availability }))
          ?.allowance.deletionAvailability,
      ).toBe(availability);
  });

  it.each<[string, Json]>([
    ['a zero limit', { limit: 0 }],
    ['a limit above 100', { limit: 101 }],
    ['a fractional limit', { limit: 1.5 }],
    ['a string limit', { limit: '50' }],
    ['a non-boolean hasMore', { hasMore: 'no' }],
    ['a non-string cursor', { hasMore: true, nextCursor: 5 }],
    ['an unsafe cursor', { hasMore: true, nextCursor: 'a b' }],
    ['an over-long cursor', { hasMore: true, nextCursor: 'a'.repeat(513) }],
    ['more pages but no cursor', { hasMore: true, nextCursor: null }],
    ['a cursor on the last page', { hasMore: false, nextCursor: 'abc' }],
  ])('rejects pagination with %s', (_name, patch) => {
    expect(parseContributionLedgerPage(withPagination(patch))).toBeNull();
  });

  it('keeps a valid cursor when more pages exist', () => {
    expect(
      parseContributionLedgerPage(withPagination({ hasMore: true, nextCursor: 'abc_-9' }))
        ?.pagination,
    ).toEqual({ limit: 50, hasMore: true, nextCursor: 'abc_-9' });
  });

  describe('latestContribution', () => {
    it('is omitted when the server does not send it', () => {
      expect(parseContributionLedgerPage(page())).not.toHaveProperty('latestContribution');
    });

    it('is null when the server sends null', () => {
      expect(parseContributionLedgerPage(page({ latestContribution: null }))).toHaveProperty(
        'latestContribution',
        null,
      );
    });

    it('is parsed independently of the page entries', () => {
      const parsed = parseContributionLedgerPage(
        page({ entries: [], latestContribution: entry({ contributionId: 'newest' }) }),
      );
      expect(parsed?.latestContribution?.contributionId).toBe('newest');
    });

    it('rejects the page when the latest contribution is malformed', () => {
      expect(
        parseContributionLedgerPage(page({ latestContribution: entry({ state: 'nope' }) })),
      ).toBeNull();
      expect(parseContributionLedgerPage(page({ latestContribution: 'x' }))).toBeNull();
    });
  });
});
