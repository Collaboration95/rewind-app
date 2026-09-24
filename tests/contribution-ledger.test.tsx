import { fireEvent, render } from '@testing-library/react-native';

import { ContributionLedger } from '../src/contributions/ContributionLedger';
import type {
  ContributionLedgerEntry,
  ContributionLedgerPage,
  ContributionLedgerState,
} from '../src/domain/contributions';

function entry(
  state: ContributionLedgerState,
  contributionId: string,
  overrides: Partial<ContributionLedgerEntry> = {},
): ContributionLedgerEntry {
  const corrected = state === 'deleted' || state === 'replaced';
  return {
    contributionId,
    jobId: `job-${contributionId}`,
    state,
    durationSeconds: 4.5,
    createdAt: '2026-09-10T12:00:00.000Z',
    updatedAt: '2026-09-10T12:01:00.000Z',
    attempts: 1,
    progress: 0,
    failureCategory: state === 'failed' ? 'processing_failed' : null,
    retryable: state === 'queued' || state === 'failed',
    replaced: state === 'replaced',
    restored: corrected ? { count: 1, seconds: 4.5 } : null,
    ...overrides,
  };
}

function page(entries: ContributionLedgerEntry[] = []): ContributionLedgerPage {
  return {
    cycleId: 'cycle-1',
    memberId: 'member-1',
    allowance: {
      maxCount: 5,
      maxSeconds: 30,
      countUsed: 2,
      secondsUsed: 9,
      deletionsUsed: 1,
      deletionAvailability: 'used',
    },
    entries,
    pagination: { limit: 50, hasMore: false, nextCursor: null },
  };
}

describe('ContributionLedger', () => {
  it('distinguishes multiple submissions across all six states using metadata and allowance impact', async () => {
    const states: ContributionLedgerState[] = [
      'queued',
      'processing',
      'sealed',
      'failed',
      'deleted',
      'replaced',
    ];
    const entries = states.map((state, index) => entry(state, `contribution-${index + 1}`));
    const result = await render(
      <ContributionLedger view={{ status: 'ready', page: page(entries) }} />,
    );

    for (let index = 0; index < states.length; index += 1) {
      const row = result.getByTestId(`contribution-ledger-entry-${index}`);
      expect(row.props.accessibilityLabel).toContain(`Submission ${index + 1}`);
      expect(row.props.accessibilityLabel).toContain(`reference contribution-${index + 1}`);
      expect(row.props.accessibilityLabel).toContain('Duration 4.5 seconds');
    }
    expect(result.getByText('Sealed for reveal')).toBeTruthy();
    expect(result.getByText('Replaced')).toBeTruthy();
    expect(result.getAllByText('Uses 1 contribution and 4.5 seconds of allowance.')).toHaveLength(
      4,
    );
    expect(
      result.getAllByText('Restored 1 contribution and 4.5 seconds of allowance.'),
    ).toHaveLength(2);
    expect(result.getByText(/This week’s correction has been used/)).toBeTruthy();
    expect(
      result.getByText('Eligible for retry. Retry is not available from this list.'),
    ).toBeTruthy();
    expect(result.queryByRole('button')).toBeNull();
  });

  it('keeps untrusted media fields out of the rendered tree and guards the visible reference', async () => {
    const leaked = {
      ...entry('sealed', 'file:///private/locked.mp4'),
      sourceUri: 'file:///private/locked.mp4',
      outputPath: '/private/locked.mp4',
      downloadPath: '/clips/locked/download',
      thumbnail: 'private-frame',
    } as ContributionLedgerEntry;
    const result = await render(
      <ContributionLedger view={{ status: 'ready', page: page([leaked]) }} />,
    );
    const tree = JSON.stringify(result.toJSON());
    expect(tree).not.toMatch(
      /private|file:\/\/|sourceUri|outputPath|downloadPath|thumbnail|share/i,
    );
    expect(result.getByText('Reference Unavailable')).toBeTruthy();
    expect(result.queryByRole('button')).toBeNull();
  });

  it('shows loading, denied, failure recovery, and empty states honestly', async () => {
    const loading = await render(<ContributionLedger view={{ status: 'loading' }} />);
    expect(loading.getByTestId('contribution-ledger-loading')).toBeTruthy();
    await loading.rerender(<ContributionLedger view={{ status: 'denied' }} onRetry={jest.fn()} />);
    expect(loading.getByTestId('contribution-ledger-denied')).toBeTruthy();
    expect(loading.queryByRole('button')).toBeNull();

    const onRetry = jest.fn();
    await loading.rerender(<ContributionLedger view={{ status: 'error' }} onRetry={onRetry} />);
    await fireEvent.press(loading.getByRole('button', { name: 'Retry loading contributions' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    await loading.rerender(<ContributionLedger view={{ status: 'ready', page: page() }} />);
    expect(loading.getByTestId('contribution-ledger-empty')).toBeTruthy();
    expect(loading.queryByRole('button')).toBeNull();
  });

  it('offers bounded pagination only with a callback and disables it while loading', async () => {
    const nextPage = {
      ...page([entry('queued', 'contribution-1')]),
      pagination: {
        limit: 1,
        hasMore: true,
        nextCursor: 'opaque-cursor',
      },
    };
    const onLoadMore = jest.fn();
    const result = await render(
      <ContributionLedger view={{ status: 'ready', page: nextPage }} onLoadMore={onLoadMore} />,
    );
    await fireEvent.press(result.getByRole('button', { name: 'Load more contributions' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    await result.rerender(
      <ContributionLedger
        view={{ status: 'ready', page: nextPage, loadingMore: true }}
        onLoadMore={onLoadMore}
      />,
    );
    expect(
      result.getByRole('button', { name: 'Loading more contributions…' }).props.accessibilityState,
    ).toEqual({ disabled: true });

    await result.rerender(<ContributionLedger view={{ status: 'ready', page: nextPage }} />);
    expect(result.getByText('More contributions are available.')).toBeTruthy();
    expect(result.queryByRole('button')).toBeNull();
  });
});
