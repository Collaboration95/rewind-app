import { act, fireEvent, render } from '@testing-library/react-native';
import {
  ContributionStatusPanel,
  ContributionStatusProvider,
  latestContributionStatus,
  useOptionalContributionStatus,
  type ContributionLifecycle,
  type ContributionStatus,
  type ContributionStatusScope,
  type ContributionStatusStore,
} from '../src/capture/contribution-status';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const base: ContributionStatus = {
  contributionId: 'contribution-test',
  createdAt: '2026-09-14T00:00:00.000Z',
  durationSeconds: 4,
  jobId: 'job-test',
  retryable: false,
  state: 'queued',
};

describe('ContributionStatusPanel', () => {
  it('derives the capture state and correction availability from the latest server ledger entry', () => {
    expect(
      latestContributionStatus({
        cycleId: 'cycle-1',
        memberId: 'member-1',
        allowance: {
          maxCount: 5,
          maxSeconds: 30,
          countUsed: 2,
          secondsUsed: 6,
          deletionsUsed: 1,
          deletionAvailability: 'used',
        },
        entries: [
          {
            contributionId: 'contribution-1',
            jobId: 'job-1',
            state: 'sealed',
            durationSeconds: 3,
            mediaType: 'video',
            createdAt: '2026-09-14T00:00:00.000Z',
            updatedAt: '2026-09-14T00:00:01.000Z',
            attempts: 1,
            progress: 100,
            failureCategory: null,
            retryable: false,
            replaced: false,
            restored: null,
          },
        ],
        pagination: { limit: 50, hasMore: false, nextCursor: null },
      }),
    ).toMatchObject({
      state: 'sealed',
      contributionId: 'contribution-1',
      deletionAvailability: 'used',
    });
  });

  it('hydrates the newest contribution beyond the oldest-first 50-entry page', () => {
    const olderEntries = Array.from({ length: 50 }, (_, index) => ({
      contributionId: `older-${index}`,
      jobId: `job-older-${index}`,
      state: 'sealed' as const,
      durationSeconds: 3,
      mediaType: 'video' as const,
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      updatedAt: '2026-09-30T00:00:00.000Z',
      attempts: 1,
      progress: 100,
      failureCategory: null,
      retryable: false,
      replaced: false,
      restored: null,
    }));
    const newest = {
      ...olderEntries[49],
      contributionId: 'newest-contribution',
      jobId: 'newest-job',
      state: 'processing' as const,
      createdAt: '2026-10-01T00:00:00.000Z',
      progress: 42,
    };

    expect(
      latestContributionStatus({
        cycleId: 'cycle-1',
        memberId: 'member-1',
        allowance: {
          maxCount: 100,
          maxSeconds: 300,
          countUsed: 51,
          secondsUsed: 153,
          deletionsUsed: 0,
          deletionAvailability: 'available',
        },
        entries: olderEntries,
        latestContribution: newest,
        pagination: { limit: 50, hasMore: true, nextCursor: 'next-page' },
      }),
    ).toMatchObject({
      state: 'processing',
      contributionId: 'newest-contribution',
      jobId: 'newest-job',
    });
  });

  it.each(['queued', 'processing', 'sealed'] as ContributionLifecycle[])(
    'renders the %s lifecycle using metadata only',
    async (state) => {
      const result = await render(
        <ContributionStatusPanel status={{ ...base, state }} testID="status" />,
      );

      await result.findByTestId(`status-${state}`);
      expect(result.queryByText(/file:\/\/|uri:|share|download|player|thumbnail/i)).toBeNull();
      expect(result.queryByRole('button', { name: /retry/i })).toBeNull();
    },
  );

  it('offers retry only for a retryable failure and does not expose a file location', async () => {
    const onRetry = jest.fn();
    const result = await render(
      <ContributionStatusPanel
        onRetry={onRetry}
        retryLabel="Retry contribution"
        status={{
          ...base,
          message: 'The local runtime is unavailable.',
          retryable: true,
          state: 'failed',
        }}
        testID="status"
      />,
    );

    await result.findByTestId('status-failed');
    await fireEvent.press(result.getByRole('button', { name: 'Retry contribution' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(result.queryByText(/file:\/\/|uri:|share|download|player|thumbnail/i)).toBeNull();
  });

  it('uses terminal failure copy and hides retry for non-retryable failures', async () => {
    const result = await render(
      <ContributionStatusPanel
        onRetry={() => undefined}
        status={{
          ...base,
          message: 'The contribution is not authorised.',
          retryable: false,
          state: 'failed',
        }}
        testID="status"
      />,
    );

    await result.findByTestId('status-failed');
    expect(
      result.getByText('This one can’t be retried. Take it again to add a new moment.'),
    ).toBeTruthy();
    expect(result.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('offers the bounded delete-and-replace action only when the owner supplies it', async () => {
    const onDelete = jest.fn();
    const result = await render(
      <ContributionStatusPanel
        deleteLabel="Delete and replace"
        onDelete={onDelete}
        status={{ ...base, state: 'sealed' }}
        testID="deletable-status"
      />,
    );

    await fireEvent.press(result.getByRole('button', { name: 'Delete and replace' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('explains when the bounded delete allowance is already used', async () => {
    const result = await render(
      <ContributionStatusPanel
        onRetry={() => undefined}
        onDelete={() => undefined}
        status={{ ...base, deletionAvailability: 'used', state: 'sealed' }}
        testID="used-status"
      />,
    );

    await result.findByTestId('used-status-delete-used');
    expect(result.queryByRole('button', { name: 'Delete and replace' })).toBeNull();
  });
  it('keeps status metadata scoped and restores it when the camera route remounts', async () => {
    const values = new Map<string, ContributionStatus>();
    const store: ContributionStatusStore = {
      clear: jest.fn(async (scope: ContributionStatusScope) => {
        values.delete(scope.sessionId);
      }),
      load: jest.fn(async (scope: ContributionStatusScope) => values.get(scope.sessionId) ?? null),
      save: jest.fn(async (scope: ContributionStatusScope, value: ContributionStatus) => {
        values.set(scope.sessionId, value);
      }),
    };

    function Writer() {
      const context = useOptionalContributionStatus();
      return (
        <ContributionStatusPanel
          onRetry={() => undefined}
          status={context?.status ?? null}
          testID="restored"
        />
      );
    }

    const scope = { groupId: 'group-1', memberId: 'member-1', sessionId: 'session-1' };
    values.set(scope.sessionId, { ...base, state: 'processing' });
    const first = await render(
      <ContributionStatusProvider scope={scope} store={store}>
        <Writer />
      </ContributionStatusProvider>,
    );
    await first.findByTestId('restored-processing');
    await act(async () => {
      first.unmount();
      await Promise.resolve();
    });

    const second = await render(
      <ContributionStatusProvider scope={scope} store={store}>
        <Writer />
      </ContributionStatusProvider>,
    );
    await second.findByTestId('restored-processing');
    expect(store.load).toHaveBeenCalled();
  });
});
