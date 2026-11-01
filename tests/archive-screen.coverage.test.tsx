import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import type {
  RealAccountArchiveClient,
  RealArchiveFilm,
  RealArchivePage,
} from '../src/auth/real-account-client';
import { ArchiveScreen } from '../src/real/Archive';
import type { HomeRelease } from '../src/real/home-model';

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const film = (id: string, overrides: Partial<RealArchiveFilm> = {}): RealArchiveFilm => ({
  id,
  cycleId: `cycle-${id}`,
  publishedAt: '2026-10-05T10:00:00.000Z',
  downloadUrl: `https://media.invalid/${id}-download.mp4`,
  playbackUrl: `https://media.invalid/${id}.mp4`,
  ...overrides,
});

const pageOf = (
  films: RealArchiveFilm[],
  more: { hasMoreFilms?: boolean; filmCursor?: string | null } = {},
): RealArchivePage => ({
  archive: { films, clips: [] },
  pagination: {
    filmCursor: more.filmCursor ?? null,
    clipCursor: null,
    hasMoreFilms: more.hasMoreFilms ?? false,
    hasMoreClips: false,
  },
});

const release = (
  cycleId: string,
  state: HomeRelease['state'],
  publishedAt: string | null = '2026-10-04T00:00:00.000Z',
): HomeRelease => ({ cycleId, endsAt: '2026-10-04T00:00:00.000Z', publishedAt, state });

function clientFor(getArchivePage: jest.Mock) {
  return { getArchivePage } as unknown as RealAccountArchiveClient;
}

type Props = Partial<React.ComponentProps<typeof ArchiveScreen>>;
function element(props: Props = {}) {
  return (
    <ArchiveScreen
      bottomInset={0}
      client={null}
      countdown={{ count: 3, unit: 'day' }}
      currentCycleId="current"
      groupId="group-1"
      header={<Text>Header slot</Text>}
      onOpenFilm={jest.fn()}
      prompt="What made you smile?"
      releases={[]}
      topInset={0}
      {...props}
    />
  );
}

describe('ArchiveScreen', () => {
  it('shows loading and the collecting card for the current cycle', async () => {
    const pending = new Promise<RealArchivePage>(() => {});
    const ui = await render(element({ client: clientFor(jest.fn(() => pending)) }));
    expect(ui.getByText('Header slot')).toBeTruthy();
    expect(ui.getByText('Archive')).toBeTruthy();
    expect(ui.getByText('Loading…')).toBeTruthy();
    expect(ui.getByText('This cycle · collecting')).toBeTruthy();
    expect(ui.getByText('What made you smile? · opens in 3 days · sealed until then')).toBeTruthy();
    expect(ui.queryByTestId('real-archive-first')).toBeNull();
  });

  it('uses the singular for a one-hour countdown', async () => {
    const ui = await render(
      element({
        countdown: { count: 1, unit: 'hour' },
        client: clientFor(jest.fn(async () => pageOf([]))),
      }),
    );
    expect(await ui.findByText(/opens in 1 hour · sealed until then/)).toBeTruthy();
  });

  it('explains that the first film comes at the end of the cycle when none exist', async () => {
    const ui = await render(element({ client: clientFor(jest.fn(async () => pageOf([]))) }));
    expect(await ui.findByTestId('real-archive-first')).toBeTruthy();
    expect(ui.getByText('Nothing here yet.')).toBeTruthy();
    expect(ui.getByText('Your first film')).toBeTruthy();
  });

  it('is unavailable without a client, and retry stays unavailable', async () => {
    const ui = await render(element({ client: null }));
    expect(await ui.findByTestId('real-archive-unavailable')).toBeTruthy();
    expect(ui.getByText('Couldn’t load the archive')).toBeTruthy();
    expect(ui.queryByText('Loading…')).toBeNull();
    expect(ui.queryByTestId('real-archive-now')).toBeNull();
    await fireEvent.press(ui.getByTestId('real-archive-retry'));
    expect(await ui.findByTestId('real-archive-unavailable')).toBeTruthy();
  });

  it('recovers when retry succeeds after a failed load', async () => {
    const getArchivePage = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(pageOf([film('a')]));
    const ui = await render(element({ client: clientFor(getArchivePage) }));
    await fireEvent.press(await ui.findByTestId('real-archive-retry'));
    expect(await ui.findByText('1 film so far')).toBeTruthy();
    expect(ui.queryByTestId('real-archive-unavailable')).toBeNull();
    expect(getArchivePage).toHaveBeenCalledWith('group-1', { limit: 20 });
  });

  it('lists earlier films and opens one with its release date', async () => {
    const onOpenFilm = jest.fn();
    const films = [
      film('a', {
        segments: [
          { contributionId: '1', startSeconds: 0, durationSeconds: 3, hidden: false, mine: true },
          { contributionId: '2', startSeconds: 3, durationSeconds: 3, hidden: true, mine: false },
          { contributionId: '3', startSeconds: 6, durationSeconds: 3, hidden: false, mine: false },
        ],
      }),
      film('b', { publishedAt: '2026-09-07T10:00:00.000Z' }),
    ];
    const ui = await render(
      element({ client: clientFor(jest.fn(async () => pageOf(films))), onOpenFilm }),
    );
    expect(await ui.findByText('2 films so far')).toBeTruthy();
    expect(ui.getByText('Earlier films')).toBeTruthy();
    // Hidden moments are not counted; films without segments show no count.
    expect(ui.getByText('2 moments')).toBeTruthy();
    expect(ui.queryByText('0 moments')).toBeNull();
    await fireEvent.press(ui.getByTestId('real-archive-watch-a'));
    expect(onOpenFilm).toHaveBeenCalledWith(
      'cycle-a',
      `Released ${shortDate(films[0].publishedAt)}`,
    );
    await fireEvent.press(
      ui.getByLabelText(`Play the film released ${shortDate(films[1].publishedAt)}`),
    );
    expect(onOpenFilm).toHaveBeenLastCalledWith(
      'cycle-b',
      `Released ${shortDate(films[1].publishedAt)}`,
    );
  });

  it('disables a film that has no playback URL', async () => {
    const ui = await render(
      element({
        client: clientFor(jest.fn(async () => pageOf([film('a', { playbackUrl: null })]))),
      }),
    );
    await ui.findByTestId('real-archive-film-a');
    expect(ui.getByTestId('real-archive-watch-a')).toBeDisabled();
  });

  describe('releases', () => {
    it('leads with a premiere, counts it, and hides its duplicate in the list', async () => {
      const onOpenFilm = jest.fn();
      const ui = await render(
        element({
          client: clientFor(
            jest.fn(async () => pageOf([film('same', { cycleId: 'last' }), film('old')])),
          ),
          onOpenFilm,
          releases: [release('last', 'premiere'), release('current', 'processing')],
        }),
      );
      expect(await ui.findByText('2 films so far')).toBeTruthy();
      expect(ui.getByText('Your film is here')).toBeTruthy();
      expect(ui.queryByTestId('real-archive-film-same')).toBeNull();
      expect(ui.getByTestId('real-archive-film-old')).toBeTruthy();
      expect(ui.queryByText('This cycle · collecting')).toBeNull();
      await fireEvent.press(ui.getByTestId('real-archive-play'));
      expect(onOpenFilm).toHaveBeenCalledWith('last', 'Premiere');
      await fireEvent.press(ui.getByLabelText('Play the film'));
      expect(onOpenFilm).toHaveBeenCalledTimes(2);
    });

    it('does not show the first-film message while a premiere is waiting', async () => {
      const ui = await render(
        element({
          client: clientFor(jest.fn(async () => pageOf([]))),
          releases: [release('last', 'premiere')],
        }),
      );
      expect(await ui.findByText('1 film so far')).toBeTruthy();
      expect(ui.queryByTestId('real-archive-first')).toBeNull();
    });

    it('says the film is developing, and that a delayed one is taking longer', async () => {
      const developing = await render(
        element({
          client: clientFor(jest.fn(async () => pageOf([]))),
          releases: [release('last', 'processing')],
        }),
      );
      expect(await developing.findByText('Your film is developing')).toBeTruthy();
      expect(developing.getByText('You can watch it once it’s out.')).toBeTruthy();
      await developing.unmount();

      const delayed = await render(
        element({
          client: clientFor(jest.fn(async () => pageOf([]))),
          releases: [release('last', 'delayed')],
        }),
      );
      expect(await delayed.findByText('Taking a little longer')).toBeTruthy();
      expect(delayed.getByText(/Nothing to play yet/)).toBeTruthy();
    });

    it('ignores releases for the current cycle', async () => {
      const ui = await render(
        element({
          client: clientFor(jest.fn(async () => pageOf([]))),
          releases: [release('current', 'premiere')],
        }),
      );
      expect(await ui.findByText('This cycle · collecting')).toBeTruthy();
      expect(ui.queryByText('Your film is here')).toBeNull();
    });

    it('quietly re-reads the first page when a release changes', async () => {
      const getArchivePage = jest
        .fn()
        .mockResolvedValueOnce(pageOf([film('old')]))
        .mockResolvedValueOnce(pageOf([film('new'), film('old')]));
      const client = clientFor(getArchivePage);
      const ui = await render(element({ client, releases: [release('last', 'processing')] }));
      await ui.findByTestId('real-archive-film-old');
      await ui.rerender(element({ client, releases: [release('last', 'premiere')] }));
      expect(await ui.findByTestId('real-archive-film-new')).toBeTruthy();
      expect(getArchivePage).toHaveBeenCalledTimes(2);
      // Unchanged releases do not trigger another read.
      await ui.rerender(element({ client, releases: [release('last', 'premiere')] }));
      expect(getArchivePage).toHaveBeenCalledTimes(2);
    });

    it('keeps the list when the quiet refresh fails', async () => {
      const getArchivePage = jest
        .fn()
        .mockResolvedValueOnce(pageOf([film('old')]))
        .mockRejectedValueOnce(new Error('offline'));
      const client = clientFor(getArchivePage);
      const ui = await render(element({ client, releases: [release('last', 'processing')] }));
      await ui.findByTestId('real-archive-film-old');
      await ui.rerender(element({ client, releases: [release('last', 'delayed')] }));
      await waitFor(() => expect(getArchivePage).toHaveBeenCalledTimes(2));
      expect(ui.getByTestId('real-archive-film-old')).toBeTruthy();
      expect(ui.queryByTestId('real-archive-unavailable')).toBeNull();
    });

    it('ignores a refresh that finishes after a newer one started', async () => {
      let first!: (page: RealArchivePage) => void;
      const getArchivePage = jest
        .fn()
        .mockResolvedValueOnce(pageOf([film('base')]))
        .mockImplementationOnce(() => new Promise<RealArchivePage>((resolve) => (first = resolve)))
        .mockResolvedValueOnce(pageOf([film('latest')]));
      const client = clientFor(getArchivePage);
      const ui = await render(element({ client, releases: [release('last', 'processing')] }));
      await ui.findByTestId('real-archive-film-base');
      await ui.rerender(element({ client, releases: [release('last', 'delayed')] }));
      await ui.rerender(element({ client, releases: [release('last', 'premiere')] }));
      await ui.findByTestId('real-archive-film-latest');
      await act(async () => first(pageOf([film('stale')])));
      expect(ui.queryByTestId('real-archive-film-stale')).toBeNull();
      expect(ui.getByTestId('real-archive-film-latest')).toBeTruthy();
    });
  });

  describe('older films', () => {
    const firstPage = pageOf([film('a'), film('b')], { hasMoreFilms: true, filmCursor: 'next-1' });

    it('loads the next page by cursor, skips films already shown and drops the button at the end', async () => {
      let release!: (page: RealArchivePage) => void;
      const getArchivePage = jest
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockImplementationOnce(
          () => new Promise<RealArchivePage>((resolve) => (release = resolve)),
        );
      const ui = await render(element({ client: clientFor(getArchivePage) }));
      await fireEvent.press(await ui.findByTestId('real-archive-older'));
      expect(await ui.findByText('Loading…', { exact: true })).toBeTruthy();
      // A second tap while loading does nothing.
      await fireEvent.press(ui.getByTestId('real-archive-older'));
      expect(getArchivePage).toHaveBeenCalledTimes(2);
      expect(getArchivePage).toHaveBeenLastCalledWith('group-1', {
        filmCursor: 'next-1',
        limit: 20,
      });
      await act(async () => release(pageOf([film('b'), film('c')])));
      expect(await ui.findByTestId('real-archive-film-c')).toBeTruthy();
      expect(ui.getAllByTestId(/^real-archive-film-/)).toHaveLength(3);
      expect(ui.getByText('3 films so far')).toBeTruthy();
      expect(ui.queryByTestId('real-archive-older')).toBeNull();
    });

    it('shows the unavailable state when loading more fails', async () => {
      const getArchivePage = jest
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockRejectedValueOnce(new Error('offline'));
      const ui = await render(element({ client: clientFor(getArchivePage) }));
      await fireEvent.press(await ui.findByTestId('real-archive-older'));
      expect(await ui.findByTestId('real-archive-unavailable')).toBeTruthy();
    });

    it('keeps older pages when a release change refreshes the first page', async () => {
      const getArchivePage = jest
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(pageOf([film('c')]))
        .mockResolvedValueOnce(
          pageOf([film('fresh'), film('a')], { hasMoreFilms: true, filmCursor: 'x' }),
        );
      const client = clientFor(getArchivePage);
      const ui = await render(element({ client, releases: [release('last', 'processing')] }));
      await fireEvent.press(await ui.findByTestId('real-archive-older'));
      await ui.findByTestId('real-archive-film-c');
      await ui.rerender(element({ client, releases: [release('last', 'premiere')] }));
      await ui.findByTestId('real-archive-film-fresh');
      expect(ui.getAllByTestId(/^real-archive-film-/).map((node) => node.props.testID)).toEqual([
        'real-archive-film-fresh',
        'real-archive-film-a',
        'real-archive-film-b',
        'real-archive-film-c',
      ]);
    });
  });
});
