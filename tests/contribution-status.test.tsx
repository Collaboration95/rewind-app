import { act, fireEvent, render } from '@testing-library/react-native';
import {
  ContributionStatusPanel,
  ContributionStatusProvider,
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
