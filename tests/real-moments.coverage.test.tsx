import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { ContributionLedgerEntry, ContributionLedgerPage } from '../src/domain/contributions';
import { MomentsScreen, weekMoments } from '../src/real/Moments';
import { ToastProvider } from '../src/ui/primitives';

const NOW = Date.parse('2026-10-14T10:00:00.000Z');
const WINDOW_START = Date.parse('2026-10-12T00:00:00.000Z');

function entry(overrides: Partial<ContributionLedgerEntry> = {}): ContributionLedgerEntry {
  return {
    contributionId: 'c1',
    jobId: 'j1',
    state: 'sealed',
    durationSeconds: 7.4,
    mediaType: 'video',
    createdAt: '2026-10-14T08:00:00.000Z',
    updatedAt: '2026-10-14T08:00:00.000Z',
    attempts: 1,
    progress: 100,
    failureCategory: null,
    retryable: false,
    replaced: false,
    restored: null,
    ...overrides,
  };
}

function ledger(
  entries: ContributionLedgerEntry[],
  allowance: Partial<ContributionLedgerPage['allowance']> = {},
): ContributionLedgerPage {
  return {
    cycleId: 'cycle-1',
    memberId: 'member-1',
    allowance: {
      maxCount: 5,
      maxSeconds: 30,
      countUsed: entries.length,
      secondsUsed: 10,
      deletionsUsed: 0,
      deletionAvailability: 'available',
      ...allowance,
    },
    entries,
    pagination: { limit: 50, hasMore: false, nextCursor: null },
  };
}

async function setup(
  page: ContributionLedgerPage | null,
  props: Partial<React.ComponentProps<typeof MomentsScreen>> = {},
) {
  const handlers = {
    onBack: jest.fn(),
    onDelete: jest.fn(async () => {}),
    onRetry: jest.fn(async () => {}),
    onRetake: jest.fn(),
    onReload: jest.fn(),
  };
  await render(
    <ToastProvider>
      <MomentsScreen
        error={null}
        page={page}
        resetDays={3}
        windowStart={WINDOW_START}
        {...handlers}
        {...props}
      />
    </ToastProvider>,
  );
  return handlers;
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('weekMoments', () => {
  it('keeps only live moments from the current seven-day window', async () => {
    const kept = entry({ contributionId: 'kept' });
    const failed = entry({ contributionId: 'failed', state: 'failed' });
    const queued = entry({ contributionId: 'queued', state: 'queued' });
    const old = entry({ contributionId: 'old', createdAt: '2026-10-05T08:00:00.000Z' });
    const deleted = entry({
      contributionId: 'gone',
      state: 'deleted',
      restored: { count: 1, seconds: 7 },
    });
    const replaced = entry({
      contributionId: 'swapped',
      state: 'replaced',
      replaced: true,
      restored: { count: 1, seconds: 7 },
    });
    expect(
      weekMoments(ledger([kept, failed, queued, old, deleted, replaced]), WINDOW_START).map(
        (moment) => moment.contributionId,
      ),
    ).toEqual(['kept', 'failed', 'queued']);
  });

  it('is empty before the ledger has loaded', async () => {
    expect(weekMoments(null, WINDOW_START)).toEqual([]);
  });
});

describe('MomentsScreen', () => {
  it('shows a loading summary and no list before the ledger arrives, and goes back', async () => {
    const { onBack } = await setup(null);
    expect(screen.getByTestId('real-moments-count')).toHaveTextContent('…');
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByTestId('real-moments-list')).toBeNull();
    expect(screen.queryByText('Nothing sealed yet this week.')).toBeNull();
    // Without an allowance the weekly delete is treated as already used.
    expect(
      screen.getByText(/You used this week’s delete\. It comes back in 3 days\./),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('real-moments-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state with the allowance summary', async () => {
    await setup(ledger([], { countUsed: 0, secondsUsed: 0 }));
    expect(screen.getByTestId('real-moments-count')).toHaveTextContent('0 of 5');
    expect(screen.getByText('0 of 30 s · resets in 3 days')).toBeTruthy();
    expect(screen.getByText('Nothing sealed yet this week.')).toBeTruthy();
    expect(screen.getByText('Once a week, you can delete one and retake it.')).toBeTruthy();
  });

  it('describes photo and video moments without revealing content, and singular reset days', async () => {
    await setup(
      ledger([
        entry({ contributionId: 'v', mediaType: 'video' }),
        entry({ contributionId: 'p', mediaType: 'photo', durationSeconds: 3, state: 'queued' }),
      ]),
      { resetDays: 1 },
    );
    expect(screen.getByText('7 s · Today · sealed')).toBeTruthy();
    expect(screen.getByText('3 s · Today · uploading')).toBeTruthy();
    expect(screen.getByText('10 of 30 s · resets in 1 day')).toBeTruthy();
    expect(screen.getByLabelText('Video, 7 s, Today, sealed. Delete')).toBeTruthy();
    // Uploading moments cannot be deleted yet.
    expect(screen.getByLabelText('Photo, 3 s, Today, uploading')).toBeDisabled();
  });

  it('disables deleting once the weekly delete is used', async () => {
    await setup(ledger([entry()], { deletionAvailability: 'used', deletionsUsed: 1 }));
    expect(screen.getByLabelText('Video, 7 s, Today, sealed')).toBeDisabled();
    expect(screen.getByText(/You used this week’s delete/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('real-moment-0'));
    expect(screen.queryByTestId('real-moment-dialog')).toBeNull();
  });

  it('surfaces a load error and lets the person reload', async () => {
    const { onReload } = await setup(null, { error: 'Couldn’t load your moments.' });
    expect(screen.getByText('Couldn’t load your moments.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('real-moments-reload'));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('confirms before deleting a sealed moment, then offers a retake', async () => {
    const target = entry();
    const { onDelete, onRetake } = await setup(ledger([target]));
    await fireEvent.press(screen.getByTestId('real-moment-0'));
    expect(screen.getByText('Delete this video?')).toBeTruthy();
    expect(screen.getByText(/It’s gone for good, and its 7 s go back to your week/)).toBeTruthy();

    // "Keep it" closes without deleting.
    await fireEvent.press(screen.getByText('Keep it'));
    expect(screen.queryByTestId('real-moment-dialog')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('real-moment-0'));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('real-moment-delete-confirm'));
    });
    expect(onDelete).toHaveBeenCalledWith(target);
    expect(screen.queryByTestId('real-moment-dialog')).toBeNull();
    expect(screen.getByText('Deleted. Its seconds are back for this week.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('real-moments-retake'));
    expect(onRetake).toHaveBeenCalledTimes(1);
  });

  it('closes the confirmation when the backdrop is tapped', async () => {
    const { onDelete } = await setup(ledger([entry()]));
    await fireEvent.press(screen.getByTestId('real-moment-0'));
    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss', hidden: true }));
    expect(screen.queryByTestId('real-moment-dialog')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('titles the confirmation for a photo', async () => {
    await setup(ledger([entry({ mediaType: 'photo', durationSeconds: 3 })]));
    await fireEvent.press(screen.getByTestId('real-moment-0'));
    expect(screen.getByText('Delete this photo?')).toBeTruthy();
  });

  it('shows a busy state while deleting and blocks dismissal', async () => {
    let finish!: () => void;
    const onDelete = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await setup(ledger([entry()]), { onDelete });
    await fireEvent.press(screen.getByTestId('real-moment-0'));
    await fireEvent.press(screen.getByTestId('real-moment-delete-confirm'));
    expect(await screen.findByText('Deleting…')).toBeTruthy();
    expect(screen.getByText('Keep it')).toBeDisabled();
    await act(async () => finish());
    expect(screen.queryByTestId('real-moment-dialog')).toBeNull();
  });

  it('reports a failed delete and keeps the moment', async () => {
    const onDelete = jest.fn(async () => {
      throw new Error('You already deleted one this week.');
    });
    await setup(ledger([entry()]), { onDelete });
    await fireEvent.press(screen.getByTestId('real-moment-0'));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('real-moment-delete-confirm'));
    });
    expect(screen.getByText('You already deleted one this week.')).toBeTruthy();
    expect(screen.queryByTestId('real-moment-dialog')).toBeNull();
    expect(screen.queryByTestId('real-moments-retake')).toBeNull();
  });

  it('falls back to a generic message for raw network failures', async () => {
    const onDelete = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await setup(ledger([entry()]), { onDelete });
    await fireEvent.press(screen.getByTestId('real-moment-0'));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('real-moment-delete-confirm'));
    });
    expect(screen.getByText('That didn’t work. Try again.')).toBeTruthy();
  });

  describe('failed uploads', () => {
    const failed = entry({
      contributionId: 'f1',
      jobId: 'job-f1',
      state: 'failed',
      retryable: true,
      failureCategory: 'processing_failed',
    });

    it('offers retry and delete, and explains that deleting does not use the weekly delete', async () => {
      const { onRetry, onDelete, onRetake } = await setup(
        ledger([failed], { deletionAvailability: 'used', deletionsUsed: 1 }),
      );
      expect(screen.getByText('7 s · Today · didn’t finish uploading')).toBeTruthy();

      await act(async () => {
        await fireEvent.press(screen.getByTestId('real-moment-retry-0'));
      });
      expect(onRetry).toHaveBeenCalledWith(failed);
      expect(screen.getByText('Uploading again. It finishes in the background.')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('real-moment-delete-0'));
      expect(
        screen.getByText(/this doesn’t use your weekly delete\. Its 7 s go back to your week\./),
      ).toBeTruthy();
      await act(async () => {
        await fireEvent.press(screen.getByTestId('real-moment-delete-confirm'));
      });
      expect(onDelete).toHaveBeenCalledWith(failed);
      // Deleting a failed moment offers no retake.
      expect(screen.queryByTestId('real-moments-retake')).toBeNull();
      expect(onRetake).not.toHaveBeenCalled();
    });

    it('hides retry when the failure cannot be retried', async () => {
      await setup(ledger([entry({ ...failed, retryable: false })]));
      expect(screen.queryByTestId('real-moment-retry-0')).toBeNull();
      expect(screen.getByTestId('real-moment-delete-0')).toBeTruthy();
    });

    it('hides retry when there is no upload job to resume', async () => {
      await setup(ledger([entry({ ...failed, jobId: null })]));
      expect(screen.queryByTestId('real-moment-retry-0')).toBeNull();
    });

    it('reports a failed retry', async () => {
      const onRetry = jest.fn(async () => {
        throw new Error('The upload could not be restarted.');
      });
      await setup(ledger([failed]), { onRetry });
      await act(async () => {
        await fireEvent.press(screen.getByTestId('real-moment-retry-0'));
      });
      await waitFor(() =>
        expect(screen.getByTestId('real-moments-error')).toHaveTextContent(
          'The upload could not be restarted.',
        ),
      );
    });
  });
});
