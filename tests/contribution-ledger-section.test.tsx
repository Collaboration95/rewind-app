import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { ContributionLedgerSection } from '../src/contributions/ContributionLedgerSection';
import type { ContributionLedgerPage } from '../src/domain/contributions';
import { LocalRuntimeError, type RuntimeClient } from '../src/runtime/local-runtime-client';

function page(ids: string[], hasMore = false, memberId = 'member-1'): ContributionLedgerPage {
  return {
    cycleId: 'cycle-1',
    memberId,
    allowance: {
      maxCount: 5,
      maxSeconds: 30,
      countUsed: ids.length,
      secondsUsed: ids.length * 4,
      deletionsUsed: 0,
      deletionAvailability: 'available',
    },
    entries: ids.map((contributionId) => ({
      contributionId,
      jobId: `job-${contributionId}`,
      state: 'sealed',
      durationSeconds: 4,
      createdAt: '2026-09-10T12:00:00.000Z',
      updatedAt: '2026-09-10T12:00:00.000Z',
      attempts: 1,
      progress: 100,
      failureCategory: null,
      retryable: false,
      replaced: false,
      restored: null,
    })),
    pagination: { limit: 2, hasMore, nextCursor: hasMore ? 'cursor-1' : null },
  };
}

function client(read: jest.Mock): RuntimeClient {
  return { getContributionLedger: read } as unknown as RuntimeClient;
}

const scope = {
  sessionId: 'session-1',
  groupId: 'group-1',
  memberId: 'member-1',
  cycleId: 'cycle-1',
};

describe('ContributionLedgerSection', () => {
  it('fetches the signed-in scope and merges a bounded next page without duplicates', async () => {
    const read = jest
      .fn()
      .mockResolvedValueOnce(page(['clip-1', 'clip-2'], true))
      .mockResolvedValueOnce(page(['clip-2', 'clip-3']));
    const result = await render(<ContributionLedgerSection client={client(read)} {...scope} />);
    await result.findByTestId('contribution-ledger-ready');
    expect(read).toHaveBeenNthCalledWith(1, 'session-1', 'group-1');

    await fireEvent.press(result.getByRole('button', { name: 'Load more contributions' }));
    await waitFor(() => expect(result.getByText('Reference clip-3')).toBeTruthy());
    expect(read).toHaveBeenNthCalledWith(2, 'session-1', 'group-1', { cursor: 'cursor-1' });
    expect(result.getAllByText('Reference clip-2')).toHaveLength(1);
    expect(result.queryByRole('button', { name: 'Load more contributions' })).toBeNull();
  });

  it('keeps first-page entries when pagination fails and retries that page', async () => {
    const read = jest
      .fn()
      .mockResolvedValueOnce(page(['clip-1'], true))
      .mockRejectedValueOnce(new LocalRuntimeError('Runtime unavailable'))
      .mockResolvedValueOnce(page(['clip-2']));
    const result = await render(<ContributionLedgerSection client={client(read)} {...scope} />);
    await result.findByTestId('contribution-ledger-ready');
    await fireEvent.press(result.getByRole('button', { name: 'Load more contributions' }));
    await result.findByText('More contributions could not be loaded. Try again.');
    expect(result.getByText('Reference clip-1')).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Load more contributions' }));
    await result.findByText('Reference clip-2');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('shows denial without retry and recovers from a transient first-page failure', async () => {
    const read = jest
      .fn()
      .mockRejectedValueOnce(new LocalRuntimeError('Forbidden', 403, 'forbidden'))
      .mockRejectedValueOnce(new LocalRuntimeError('Runtime unavailable'))
      .mockResolvedValueOnce({ ...page(['clip-1']), cycleId: 'cycle-2' });
    const runtime = client(read);
    const result = await render(<ContributionLedgerSection client={runtime} {...scope} />);
    await result.findByTestId('contribution-ledger-denied');
    expect(result.queryByRole('button')).toBeNull();

    await result.rerender(
      <ContributionLedgerSection client={runtime} {...scope} cycleId="cycle-2" />,
    );
    await result.findByTestId('contribution-ledger-error');
    await fireEvent.press(result.getByRole('button', { name: 'Retry loading contributions' }));
    await result.findByTestId('contribution-ledger-ready');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('discards a previous scope response after a member change', async () => {
    let resolveOld: (value: ContributionLedgerPage) => void = () => undefined;
    const old = new Promise<ContributionLedgerPage>((resolve) => {
      resolveOld = resolve;
    });
    const read = jest
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce(page(['peer-clip'], false, 'member-2'));
    const runtime = client(read);
    const result = await render(<ContributionLedgerSection client={runtime} {...scope} />);
    await result.rerender(
      <ContributionLedgerSection client={runtime} {...scope} memberId="member-2" />,
    );
    await result.findByText('Reference peer-clip');
    await act(async () => resolveOld(page(['stale-clip'])));
    expect(result.queryByText('Reference stale-clip')).toBeNull();
    expect(result.getByText('Reference peer-clip')).toBeTruthy();
  });
});
