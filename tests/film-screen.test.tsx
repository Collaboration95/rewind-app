import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';

import * as archiveDownload from '../src/archive/archive-download';
import type {
  RealAccountArchiveClient,
  RealArchiveClip,
  RealArchivePage,
} from '../src/auth/real-account-client';
import { FilmScreen, segmentAt } from '../src/real/Film';
import { ToastProvider } from '../src/ui/primitives';
import { getLatestMockVideoPlayer, type MockVideoPlayer } from './mocks/expo-video';

const segments = [
  { contributionId: 'mine', startSeconds: 0, durationSeconds: 3, hidden: false, mine: true },
  { contributionId: 'blocked', startSeconds: 3, durationSeconds: 2, hidden: true, mine: false },
  { contributionId: 'theirs', startSeconds: 5, durationSeconds: 3, hidden: false, mine: false },
];

function renderFilm(isOwner = true) {
  const client = {
    getPremiere: jest.fn(async () => ({
      state: 'ready',
      cycleId: 'cycle-1',
      filmId: 'film-1',
      playbackUrl: 'https://media.invalid/film.mp4',
      segments,
    })),
    getArchivePage: jest.fn(async () => ({ archive: { clips: [] } })),
  } as unknown as RealAccountArchiveClient;
  const request = jest.fn(
    async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response,
  );
  return {
    request,
    screen: render(
      <ToastProvider>
        <FilmScreen
          client={client}
          cycleId="cycle-1"
          groupId="group-1"
          isOwner={isOwner}
          label="Premiere · 24 h left"
          onChat={jest.fn()}
          onClose={jest.fn()}
          request={request}
        />
      </ToastProvider>,
    ),
  };
}

it('finds the segment playing at a time', () => {
  expect(segmentAt(segments, 0)).toBe(0);
  expect(segmentAt(segments, 4)).toBe(1);
  expect(segmentAt(segments, 7.9)).toBe(2);
});

it('skips hidden moments, offers report and removal only on others, and follows the player', async () => {
  const { screen: pending, request } = renderFilm();
  const ui = await pending;
  await waitFor(() => expect(getLatestMockVideoPlayer()?.replacements).toHaveLength(1));
  const player = getLatestMockVideoPlayer() as MockVideoPlayer;
  await waitFor(() => expect(ui.getByTestId('real-film-pause')).toBeTruthy());
  // Your own moment: nothing to report or remove.
  expect(ui.queryByTestId('real-film-report')).toBeNull();
  expect(ui.queryByTestId('real-film-remove')).toBeNull();
  // The button follows the player, not the request to play.
  await act(async () => player.emit('playingChange', { isPlaying: false }));
  expect(ui.getByLabelText('Play')).toBeTruthy();
  // A hidden moment is skipped to the next visible one.
  await act(async () => player.emit('timeUpdate', { currentTime: 3.2 }));
  expect(player.currentTime).toBe(5);
  expect(ui.getByTestId('real-film-report')).toBeTruthy();
  await fireEvent.press(ui.getByTestId('real-film-remove'));
  await fireEvent.press(ui.getByText('Remove'));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/real/groups/group-1/contributions/theirs/remove',
      expect.objectContaining({ method: 'POST' }),
    ),
  );
  await ui.unmount();
});

// --- Own-clip discovery (#522) and export outcomes (#525) -------------------

const clip = (id: string, cycleId: string): RealArchiveClip => ({
  id,
  contributionId: `c-${id}`,
  cycleId,
  createdAt: '2026-09-18T08:15:00.000Z',
  downloadUrl: `https://media.invalid/${id}.mp4`,
  playbackUrl: null,
});

/** A clip page; `next` null means the clip list is exhausted. */
const clipPage = (clips: RealArchiveClip[], next: string | null): RealArchivePage => ({
  archive: { films: [], clips },
  pagination: { filmCursor: null, clipCursor: next, hasMoreFilms: false, hasMoreClips: !!next },
});

type Pages = Record<string, RealArchivePage | Error | (() => Promise<RealArchivePage>)>;

function pagedClient(pages: Pages, cycleId = 'cycle-1') {
  const getArchivePage = jest.fn(
    async (_group: string, request?: { clipCursor?: string | null }) => {
      const entry = pages[request?.clipCursor ?? 'first'];
      if (entry instanceof Error) throw entry;
      return typeof entry === 'function' ? entry() : entry;
    },
  );
  let authorizations = 0;
  const getFreshArchiveMedia = jest.fn(
    async (_group: string, media: { id: string; contributionId?: string }) => ({
      ...media,
      cycleId,
      createdAt: '2026-09-18T08:15:00.000Z',
      publishedAt: '2026-09-18T08:15:00.000Z',
      downloadUrl: `https://fresh.invalid/${media.id}-${(authorizations += 1)}`,
    }),
  );
  const getPremiere = jest.fn(async (_group: string, cycle: string) => ({
    state: 'ready',
    cycleId: cycle,
    filmId: `film-${cycle}`,
    playbackUrl: 'https://media.invalid/film.mp4',
    segments,
  }));
  return {
    getArchivePage,
    getFreshArchiveMedia,
    getPremiere,
  } as unknown as RealAccountArchiveClient & {
    getArchivePage: jest.Mock;
    getFreshArchiveMedia: jest.Mock;
  };
}

function filmElement(client: RealAccountArchiveClient, cycleId = 'cycle-1', groupId = 'group-1') {
  return (
    <ToastProvider>
      <FilmScreen
        client={client}
        cycleId={cycleId}
        groupId={groupId}
        isOwner={false}
        label="Released 5 Oct"
        onChat={jest.fn()}
        onClose={jest.fn()}
        request={jest.fn()}
      />
    </ToastProvider>
  );
}

async function openEndCard(element: React.ReactElement) {
  const ui = await render(element);
  await waitFor(() => expect(getLatestMockVideoPlayer()?.replacements.length).toBeGreaterThan(0));
  await act(async () => (getLatestMockVideoPlayer() as MockVideoPlayer).emit('playToEnd'));
  await waitFor(() => expect(ui.getByTestId('real-film-end')).toBeTruthy());
  return ui;
}

describe('own clips on the end card', () => {
  const picked = { kind: 'default' } as const;
  let download: jest.SpyInstance;
  let pick: jest.SpyInstance;

  beforeEach(() => {
    pick = jest.spyOn(archiveDownload, 'pickArchiveExportDestination').mockResolvedValue(picked);
    download = jest
      .spyOn(archiveDownload, 'downloadReleasedArchiveMediaTo')
      .mockImplementation(async (media) => ({
        filename: `${media.id}.mp4`,
        method: 'native',
        uri: 'file:///x',
      }));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.replaceProperty(Platform, 'OS', 'ios');
  });

  const savedIds = () => download.mock.calls.map(([media]) => (media as { id: string }).id);
  const fifty = (cycle: string, prefix: string) =>
    Array.from({ length: 50 }, (_, index) => clip(`${prefix}${index}`, cycle));

  it('finds an older cycle that sits entirely beyond the first 50 clips', async () => {
    const client = pagedClient({
      first: clipPage(fifty('cycle-9', 'new'), 'p2'),
      p2: clipPage(fifty('cycle-8', 'mid'), 'p3'),
      p3: clipPage([clip('old-1', 'cycle-1'), clip('old-2', 'cycle-1')], null),
    });
    const ui = await openEndCard(filmElement(client));

    await fireEvent.press(await ui.findByTestId('real-film-save-mine'));
    await waitFor(() => expect(savedIds()).toEqual(['old-1', 'old-2']));
    expect(
      client.getArchivePage.mock.calls.map(([, request]) => request.clipCursor ?? null),
    ).toEqual([null, 'p2', 'p3']);
    // Metadata-only discovery; every download authorizes afresh.
    expect(client.getFreshArchiveMedia).toHaveBeenCalledTimes(2);
    expect(client.getFreshArchiveMedia).toHaveBeenCalledWith('group-1', {
      id: 'old-1',
      contributionId: 'c-old-1',
    });
    expect(await ui.findByText('Saved 2 moments.')).toBeTruthy();
  });

  it('keeps one copy of a clip that straddles a page boundary and ignores other cycles', async () => {
    const straddling = clip('edge', 'cycle-1');
    const client = pagedClient({
      first: clipPage([clip('a', 'cycle-1'), straddling, clip('x', 'cycle-2')], 'p2'),
      p2: clipPage([straddling, clip('b', 'cycle-1'), clip('y', 'cycle-3')], null),
    });
    const ui = await openEndCard(filmElement(client));
    await fireEvent.press(await ui.findByTestId('real-film-save-mine'));
    await waitFor(() => expect(savedIds()).toEqual(['a', 'edge', 'b']));
  });

  it('stops on a repeated cursor instead of looping', async () => {
    const client = pagedClient({
      first: clipPage([clip('a', 'cycle-1')], 'loop'),
      loop: clipPage([clip('b', 'cycle-1')], 'loop'),
    });
    const ui = await openEndCard(filmElement(client));
    await fireEvent.press(await ui.findByTestId('real-film-save-mine'));
    await waitFor(() => expect(savedIds()).toEqual(['a', 'b']));
    expect(client.getArchivePage).toHaveBeenCalledTimes(2);
  });

  it('says so when there are genuinely no own clips', async () => {
    const client = pagedClient({ first: clipPage([clip('x', 'cycle-2')], null) });
    const ui = await openEndCard(filmElement(client));
    expect(await ui.findByTestId('real-film-mine-none')).toBeTruthy();
    expect(ui.queryByTestId('real-film-save-mine')).toBeNull();
    expect(ui.queryByTestId('real-film-mine-retry')).toBeNull();
  });

  it('shows loading, then a retry when a later page fails, never a partial save', async () => {
    let release!: () => void;
    const pages: Pages = {
      first: () =>
        new Promise<RealArchivePage>((resolve) => {
          release = () => resolve(clipPage([clip('a', 'cycle-1')], 'p2'));
        }),
      p2: new Error('second page failed'),
    };
    const client = pagedClient(pages);
    const ui = await openEndCard(filmElement(client));
    expect(ui.getByTestId('real-film-mine-loading')).toBeTruthy();
    expect(ui.queryByTestId('real-film-save-mine')).toBeNull();

    await act(async () => release());
    const retry = await ui.findByTestId('real-film-mine-retry');
    expect(ui.queryByTestId('real-film-save-mine')).toBeNull();
    expect(download).not.toHaveBeenCalled();

    pages.p2 = clipPage([clip('b', 'cycle-1')], null);
    pages.first = clipPage([clip('a', 'cycle-1')], 'p2');
    await fireEvent.press(retry);
    await fireEvent.press(await ui.findByTestId('real-film-save-mine'));
    await waitFor(() => expect(savedIds()).toEqual(['a', 'b']));
  });

  it('discards a slow response after the cycle changes', async () => {
    let releaseStale!: () => void;
    const client = pagedClient({
      first: () =>
        new Promise<RealArchivePage>((resolve) => {
          releaseStale = () => resolve(clipPage([clip('stale', 'cycle-1')], null));
        }),
    });
    const fresh = pagedClient({ first: clipPage([clip('fresh', 'cycle-2')], null) });
    const ui = await render(filmElement(client, 'cycle-1'));
    await waitFor(() => expect(client.getArchivePage).toHaveBeenCalledTimes(1));
    await ui.rerender(filmElement(fresh, 'cycle-2'));
    await waitFor(() => expect(fresh.getArchivePage).toHaveBeenCalled());
    await act(async () => releaseStale());
    await waitFor(() => expect(getLatestMockVideoPlayer()?.replacements.length).toBeGreaterThan(0));
    await act(async () => (getLatestMockVideoPlayer() as MockVideoPlayer).emit('playToEnd'));
    await fireEvent.press(await ui.findByTestId('real-film-save-mine'));
    await waitFor(() => expect(savedIds()).toEqual(['fresh']));
  });

  it('ignores a response that arrives after the screen closed', async () => {
    let release!: () => void;
    const client = pagedClient({
      first: () =>
        new Promise<RealArchivePage>((resolve) => {
          release = () => resolve(clipPage([clip('late', 'cycle-1')], null));
        }),
    });
    const ui = await render(filmElement(client));
    await waitFor(() => expect(client.getArchivePage).toHaveBeenCalled());
    await ui.unmount();
    await act(async () => release());
    expect(download).not.toHaveBeenCalled();
  });

  it('does not claim a save when the folder picker is cancelled', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    pick.mockResolvedValue(null);
    const client = pagedClient({ first: clipPage([clip('a', 'cycle-1')], null) });
    const ui = await openEndCard(filmElement(client));
    await fireEvent.press(ui.getByTestId('real-film-save'));
    expect(await ui.findByText('Save cancelled. Nothing was saved.')).toBeTruthy();
    expect(ui.queryByText(/^Saved/)).toBeNull();
    expect(client.getFreshArchiveMedia).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('reports the folder only after the export was observed', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const client = pagedClient({ first: clipPage([], null) });
    const ui = await openEndCard(filmElement(client));
    await fireEvent.press(ui.getByTestId('real-film-save'));
    expect(await ui.findByText('Saved to the folder you chose.')).toBeTruthy();
    expect(client.getFreshArchiveMedia).toHaveBeenCalledWith('group-1', { id: 'film-cycle-1' });
  });

  it('keeps a failed export retryable and says nothing was saved', async () => {
    download.mockRejectedValueOnce(new Error('disk full'));
    const client = pagedClient({ first: clipPage([], null) });
    const ui = await openEndCard(filmElement(client));
    await fireEvent.press(ui.getByTestId('real-film-save'));
    expect(
      await ui.findByText('The film could not be saved. Try again when connected.'),
    ).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-film-save'));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
  });

  it('says saving is unavailable when the device cannot export', async () => {
    pick.mockRejectedValue(new archiveDownload.ArchiveDownloadError('no picker', 'unavailable'));
    const client = pagedClient({ first: clipPage([], null) });
    const ui = await openEndCard(filmElement(client));
    await fireEvent.press(ui.getByTestId('real-film-save'));
    expect(await ui.findByText('Saving is not available on this device.')).toBeTruthy();
  });

  it('reports a partial batch when a clip fails and saves only the rest on retry', async () => {
    const client = pagedClient({
      first: clipPage([clip('a', 'cycle-1'), clip('b', 'cycle-1'), clip('c', 'cycle-1')], null),
    });
    download.mockImplementation(async (media: { id: string }) => {
      if (media.id === 'b' && download.mock.calls.filter(([m]) => m.id === 'b').length === 1)
        throw new Error('network');
      return { filename: `${media.id}.mp4`, method: 'native', uri: 'file:///x' };
    });
    const ui = await openEndCard(filmElement(client));
    await fireEvent.press(await ui.findByTestId('real-film-save-mine'));
    expect(
      await ui.findByText('Saved 1 of 3 moments. The rest could not be saved. Try again.'),
    ).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-film-save-mine'));
    await waitFor(() => expect(savedIds()).toEqual(['a', 'b', 'b', 'c']));
  });

  it('stops the remaining clips when an export is cancelled', async () => {
    const client = pagedClient({
      first: clipPage([clip('a', 'cycle-1'), clip('b', 'cycle-1'), clip('c', 'cycle-1')], null),
    });
    download.mockImplementation(async (media: { id: string }) =>
      media.id === 'b'
        ? { filename: 'b.mp4', method: 'cancelled', uri: '' }
        : { filename: `${media.id}.mp4`, method: 'native', uri: 'file:///x' },
    );
    const ui = await openEndCard(filmElement(client));
    await fireEvent.press(await ui.findByTestId('real-film-save-mine'));
    expect(await ui.findByText('Saved 1 of 3 before you cancelled.')).toBeTruthy();
    expect(savedIds()).toEqual(['a', 'b']);
  });

  it('ignores a repeated tap while a save is running', async () => {
    let finish!: () => void;
    download.mockImplementation(
      (media: { id: string }) =>
        new Promise((resolve) => {
          finish = () => resolve({ filename: `${media.id}.mp4`, method: 'native', uri: 'f' });
        }),
    );
    const client = pagedClient({ first: clipPage([], null) });
    const ui = await openEndCard(filmElement(client));
    await fireEvent.press(ui.getByTestId('real-film-save'));
    await fireEvent.press(ui.getByTestId('real-film-save'));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(pick).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() => expect(ui.getByText('Saved.')).toBeTruthy());
  });
});
