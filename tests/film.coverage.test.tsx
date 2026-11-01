import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Platform } from 'react-native';

import * as archiveDownload from '../src/archive/archive-download';
import type { RealAccountArchiveClient, RealArchiveClip } from '../src/auth/real-account-client';
import type { FilmSegment } from '../src/domain/premiere';
import { FilmScreen, segmentAt } from '../src/real/Film';
import { ToastProvider } from '../src/ui/primitives';
import { MockVideoPlayer, getLatestMockVideoPlayer } from './mocks/expo-video';

// ReportSheet has its own tests; here it only has to hand a reason to the screen.
jest.mock('../src/real/ReportSheet', () => ({
  ReportSheet: ({
    onSend,
    onCancel,
  }: {
    onSend: (reason: string, alsoBlock: boolean) => Promise<string | null>;
    onCancel: () => void;
  }) => {
    const { useState } = jest.requireActual('react');
    const { Pressable, Text, View } = jest.requireActual('react-native');
    const [failure, setFailure] = useState(null as string | null);
    return (
      <View testID="report-sheet">
        <Pressable
          onPress={async () => setFailure(await onSend('spam', false))}
          testID="report-send"
        >
          <Text>Send report</Text>
        </Pressable>
        <Pressable onPress={onCancel} testID="report-cancel">
          <Text>Cancel report</Text>
        </Pressable>
        {failure ? <Text testID="report-failure">{failure}</Text> : null}
      </View>
    );
  },
}));

const segs: FilmSegment[] = [
  { contributionId: 'mine', startSeconds: 0, durationSeconds: 3, hidden: false, mine: true },
  { contributionId: 'blocked', startSeconds: 3, durationSeconds: 2, hidden: true, mine: false },
  { contributionId: 'theirs', startSeconds: 5, durationSeconds: 3, hidden: false, mine: false },
  { contributionId: 'also', startSeconds: 8, durationSeconds: 2, hidden: false, mine: false },
];

const jsonResponse = (ok: boolean, status = ok ? 200 : 500) =>
  ({ ok, status, json: async () => ({}) }) as Response;

const clip = (id: string): RealArchiveClip => ({
  id,
  contributionId: `c-${id}`,
  cycleId: 'cycle-1',
  createdAt: '2026-09-18T08:15:00.000Z',
  downloadUrl: `https://media.invalid/${id}.mp4`,
  playbackUrl: null,
});

function makeClient(
  options: {
    premiere?: () => Promise<unknown>;
    clips?: RealArchiveClip[] | Error;
    segments?: FilmSegment[];
  } = {},
) {
  const getPremiere = jest.fn(
    options.premiere ??
      (async () => ({
        state: 'ready',
        cycleId: 'cycle-1',
        filmId: 'film-1',
        playbackUrl: 'https://media.invalid/film.mp4',
        segments: options.segments ?? segs,
      })),
  );
  const getArchivePage = jest.fn(async () => {
    if (options.clips instanceof Error) throw options.clips;
    return {
      archive: { films: [], clips: options.clips ?? [] },
      pagination: { filmCursor: null, clipCursor: null, hasMoreFilms: false, hasMoreClips: false },
    };
  });
  const getFreshArchiveMedia = jest.fn(async (_group: string, media: { id: string }) => ({
    ...media,
    cycleId: 'cycle-1',
    createdAt: '2026-09-18T08:15:00.000Z',
    publishedAt: '2026-09-18T08:15:00.000Z',
    downloadUrl: `https://fresh.invalid/${media.id}`,
  }));
  return {
    getPremiere,
    getArchivePage,
    getFreshArchiveMedia,
  } as unknown as RealAccountArchiveClient & {
    getPremiere: jest.Mock;
    getArchivePage: jest.Mock;
    getFreshArchiveMedia: jest.Mock;
  };
}

async function open(
  options: {
    client?: ReturnType<typeof makeClient>;
    isOwner?: boolean;
    request?: jest.Mock;
  } = {},
) {
  const client = options.client ?? makeClient();
  const request = options.request ?? jest.fn(async () => jsonResponse(true));
  const onClose = jest.fn();
  const onChat = jest.fn();
  const element: ReactElement = (
    <ToastProvider>
      <FilmScreen
        client={client}
        cycleId="cycle-1"
        groupId="group-1"
        isOwner={options.isOwner ?? false}
        label="Released 5 Oct"
        onChat={onChat}
        onClose={onClose}
        request={request}
      />
    </ToastProvider>
  );
  const ui = await render(element);
  return { ui, client, request, onClose, onChat };
}

const player = () => getLatestMockVideoPlayer() as MockVideoPlayer;
async function playing(options: Parameters<typeof open>[0] = {}) {
  const view = await open(options);
  await waitFor(() => expect(view.ui.getByTestId('real-film-pause')).toBeTruthy());
  return view;
}
async function finish(options: Parameters<typeof open>[0] = {}) {
  const view = await playing(options);
  await act(async () => player().emit('playToEnd'));
  await view.ui.findByTestId('real-film-end');
  return view;
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.replaceProperty(Platform, 'OS', 'ios');
});

describe('segmentAt', () => {
  it('falls back to the first segment before any has started', () => {
    expect(segmentAt([{ ...segs[2] }], 0)).toBe(0);
    expect(segmentAt([], 4)).toBe(0);
  });

  it('allows a small timing tolerance at a boundary', () => {
    expect(segmentAt(segs, 4.96)).toBe(2);
    expect(segmentAt(segs, 4.9)).toBe(1);
  });
});

describe('opening the film', () => {
  it('shows progress while the film is being fetched', async () => {
    let release!: (value: unknown) => void;
    const client = makeClient({ premiere: () => new Promise((resolve) => (release = resolve)) });
    const { ui } = await open({ client });
    expect(await ui.findByText('Opening the film…')).toBeTruthy();
    expect(ui.queryByTestId('real-film-pause')).toBeNull();
    await act(async () =>
      release({
        state: 'ready',
        filmId: 'f',
        playbackUrl: 'https://m.invalid/f.mp4',
        segments: segs,
      }),
    );
    await waitFor(() => expect(ui.getByTestId('real-film-pause')).toBeTruthy());
    expect(ui.queryByText('Opening the film…')).toBeNull();
  });

  it('offers a retry when the film is not ready, then plays once it is', async () => {
    const premieres = [
      { state: 'processing' },
      { state: 'ready', filmId: 'f', playbackUrl: 'https://m.invalid/f.mp4', segments: segs },
    ];
    const client = makeClient({ premiere: async () => premieres.shift() });
    const { ui } = await open({ client });
    expect(await ui.findByText('Couldn’t open the film')).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-film-retry'));
    await waitFor(() => expect(ui.getByTestId('real-film-pause')).toBeTruthy());
    expect(player().playing).toBe(true);
    expect(player().replacements).toEqual(['https://m.invalid/f.mp4']);
  });

  it('offers a retry when the request fails', async () => {
    const client = makeClient({
      premiere: async () => {
        throw new Error('offline');
      },
    });
    const { ui } = await open({ client });
    expect(await ui.findByTestId('real-film-retry')).toBeTruthy();
    expect(ui.queryByTestId('real-film-pause')).toBeNull();
  });

  it('shows the error step when the player cannot take the source', async () => {
    jest.spyOn(MockVideoPlayer.prototype, 'replaceAsync').mockRejectedValueOnce(new Error('bad'));
    const { ui } = await open();
    expect(await ui.findByTestId('real-film-retry')).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-film-retry'));
    await waitFor(() => expect(ui.getByTestId('real-film-pause')).toBeTruthy());
  });

  it('plays a film that has no segment list as one bar', async () => {
    const client = makeClient({
      premiere: async () => ({
        state: 'ready',
        filmId: 'f',
        playbackUrl: 'https://m.invalid/f.mp4',
      }),
    });
    const { ui } = await open({ client });
    await waitFor(() => expect(ui.getByTestId('real-film-pause')).toBeTruthy());
    // Nothing to report: there is no moment to attribute.
    expect(ui.queryByTestId('real-film-report')).toBeNull();
    await act(async () => player().emit('timeUpdate', { currentTime: 12 }));
    expect(ui.getByTestId('real-film')).toBeTruthy();
  });
});

describe('controls', () => {
  it('closes the film, pausing playback first', async () => {
    const { ui, onClose } = await playing();
    await fireEvent.press(ui.getByTestId('real-film-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(player().playing).toBe(false);
  });

  it('toggles between Pause and Play following the player', async () => {
    const { ui } = await playing();
    expect(ui.getByLabelText('Pause')).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-film-pause'));
    expect(player().playing).toBe(false);
    expect(await ui.findByLabelText('Play')).toBeTruthy();
    await fireEvent.press(ui.getByTestId('real-film-pause'));
    expect(player().playing).toBe(true);
    expect(await ui.findByLabelText('Pause')).toBeTruthy();
  });

  it('skips forward over hidden moments and previous returns to the first moment', async () => {
    const { ui } = await playing();
    await fireEvent.press(ui.getByTestId('real-film-next'));
    expect(player().currentTime).toBe(5);
    await fireEvent.press(ui.getByTestId('real-film-next'));
    expect(player().currentTime).toBe(8);
    await fireEvent.press(ui.getByTestId('real-film-back'));
    expect(player().currentTime).toBe(5);
    await fireEvent.press(ui.getByTestId('real-film-back'));
    expect(player().currentTime).toBe(0);
    // Already at the first moment: previous restarts it.
    await fireEvent.press(ui.getByTestId('real-film-back'));
    expect(player().currentTime).toBe(0);
  });

  it('ends the film when next is pressed on the last moment', async () => {
    const { ui } = await playing();
    await act(async () => player().emit('timeUpdate', { currentTime: 8.5 }));
    await fireEvent.press(ui.getByTestId('real-film-next'));
    expect(await ui.findByTestId('real-film-end')).toBeTruthy();
    expect(player().playing).toBe(false);
  });

  it('ends the film when playback reaches a hidden moment with nothing visible after it', async () => {
    const trailing: FilmSegment[] = [
      segs[0],
      { contributionId: 'gone', startSeconds: 3, durationSeconds: 2, hidden: true, mine: false },
    ];
    const { ui } = await playing({ client: makeClient({ segments: trailing }) });
    await act(async () => player().emit('timeUpdate', { currentTime: 3.5 }));
    expect(await ui.findByTestId('real-film-end')).toBeTruthy();
  });

  it('does not crash skipping when every moment is hidden', async () => {
    const allHidden = segs.map((segment) => ({ ...segment, hidden: true }));
    const { ui } = await playing({ client: makeClient({ segments: allHidden }) });
    await act(async () => {});
    // The first timeUpdate finds nothing to skip to and ends the film.
    await act(async () => player().emit('timeUpdate', { currentTime: 0.5 }));
    expect(await ui.findByTestId('real-film-end')).toBeTruthy();
  });
});

describe('reporting a moment', () => {
  it('reports the current moment from the player, hides it and thanks the viewer', async () => {
    const { ui, request } = await playing();
    await act(async () => player().emit('timeUpdate', { currentTime: 5.5 }));
    await fireEvent.press(ui.getByTestId('real-film-report'));
    expect(player().playing).toBe(false);
    await fireEvent.press(await ui.findByTestId('report-send'));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        '/real/groups/group-1/reports',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ contributionId: 'theirs', reason: 'spam' }),
        }),
      ),
    );
    expect(
      await ui.findByText('Thanks. The Rewind team reviews reports within 24 hours.'),
    ).toBeTruthy();
    expect(ui.queryByTestId('report-sheet')).toBeNull();
    // The reported moment is skipped from now on.
    await act(async () => player().emit('timeUpdate', { currentTime: 5.6 }));
    expect(player().currentTime).toBe(8);
  });

  it('shows the failure inside the sheet and keeps the moment when the report fails', async () => {
    const request = jest.fn(async () => jsonResponse(false, 500));
    const { ui } = await playing({ request });
    await act(async () => player().emit('timeUpdate', { currentTime: 5.5 }));
    await fireEvent.press(ui.getByTestId('real-film-report'));
    await fireEvent.press(await ui.findByTestId('report-send'));
    expect(await ui.findByTestId('report-failure')).toHaveTextContent(
      'The report could not be sent. Try again.',
    );
    expect(ui.getByTestId('report-sheet')).toBeTruthy();
  });

  it('falls back to a generic message when the request throws a network error', async () => {
    const request = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { ui } = await playing({ request });
    await act(async () => player().emit('timeUpdate', { currentTime: 5.5 }));
    await fireEvent.press(ui.getByTestId('real-film-report'));
    await fireEvent.press(await ui.findByTestId('report-send'));
    expect(await ui.findByTestId('report-failure')).toHaveTextContent(
      'The report could not be sent. Try again.',
    );
  });

  it('can be cancelled', async () => {
    const { ui, request } = await playing();
    await act(async () => player().emit('timeUpdate', { currentTime: 5.5 }));
    await fireEvent.press(ui.getByTestId('real-film-report'));
    await fireEvent.press(await ui.findByTestId('report-cancel'));
    expect(ui.queryByTestId('report-sheet')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('offers reporting the last moment someone else made from the end card', async () => {
    const { ui, request } = await playing();
    await act(async () => player().emit('timeUpdate', { currentTime: 9.5 }));
    await act(async () => player().emit('playToEnd'));
    await fireEvent.press(await ui.findByTestId('real-film-report-end'));
    await fireEvent.press(await ui.findByTestId('report-send'));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        '/real/groups/group-1/reports',
        expect.objectContaining({
          body: JSON.stringify({ contributionId: 'also', reason: 'spam' }),
        }),
      ),
    );
  });

  it('omits the end-card report link when every moment is your own or hidden', async () => {
    const own = [segs[0], { ...segs[1] }];
    const { ui } = await finish({ client: makeClient({ segments: own }) });
    expect(ui.queryByTestId('real-film-report-end')).toBeNull();
  });
});

describe('removing a moment as the owner', () => {
  it('asks first and lets the owner keep the moment', async () => {
    const { ui, request } = await playing({ isOwner: true });
    await act(async () => player().emit('timeUpdate', { currentTime: 5.5 }));
    await fireEvent.press(ui.getByTestId('real-film-remove'));
    expect(await ui.findByText('Remove this moment?')).toBeTruthy();
    await fireEvent.press(ui.getByText('Keep it'));
    expect(ui.queryByTestId('real-film-remove-dialog')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('closes the confirmation from the backdrop without removing anything', async () => {
    const { ui, request } = await playing({ isOwner: true });
    await act(async () => player().emit('timeUpdate', { currentTime: 5.5 }));
    await fireEvent.press(ui.getByTestId('real-film-remove'));
    await ui.findByTestId('real-film-remove-dialog');
    await fireEvent.press(ui.getByRole('button', { name: 'Dismiss', hidden: true }));
    expect(ui.queryByTestId('real-film-remove-dialog')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('removes the moment and skips it afterwards', async () => {
    const { ui, request } = await playing({ isOwner: true });
    await act(async () => player().emit('timeUpdate', { currentTime: 5.5 }));
    await fireEvent.press(ui.getByTestId('real-film-remove'));
    await fireEvent.press(await ui.findByTestId('real-film-remove-confirm'));
    expect(await ui.findByText('Removed. Nobody sees this moment any more.')).toBeTruthy();
    expect(request).toHaveBeenCalledWith(
      '/real/groups/group-1/contributions/theirs/remove',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
    expect(ui.queryByTestId('real-film-remove-dialog')).toBeNull();
    await act(async () => player().emit('timeUpdate', { currentTime: 5.6 }));
    expect(player().currentTime).toBe(8);
  });

  it('keeps the dialog open and says so when removal fails', async () => {
    const request = jest.fn(async () => jsonResponse(false, 500));
    const { ui } = await playing({ isOwner: true, request });
    await act(async () => player().emit('timeUpdate', { currentTime: 5.5 }));
    await fireEvent.press(ui.getByTestId('real-film-remove'));
    await fireEvent.press(await ui.findByTestId('real-film-remove-confirm'));
    expect(await ui.findByText('The moment could not be removed. Try again.')).toBeTruthy();
    expect(ui.getByTestId('real-film-remove-dialog')).toBeTruthy();
  });

  it('hides the remove action from members', async () => {
    const { ui } = await playing({ isOwner: false });
    await act(async () => player().emit('timeUpdate', { currentTime: 5.5 }));
    expect(ui.getByTestId('real-film-report')).toBeTruthy();
    expect(ui.queryByTestId('real-film-remove')).toBeNull();
  });
});

describe('the end card', () => {
  it('opens Chat', async () => {
    const { ui, onChat } = await finish();
    await fireEvent.press(ui.getByTestId('real-film-chat'));
    expect(onChat).toHaveBeenCalledTimes(1);
  });

  it('replays the film from the start', async () => {
    const { ui, client } = await finish();
    await fireEvent.press(ui.getByTestId('real-film-replay'));
    await waitFor(() => expect(client.getPremiere).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(ui.getByTestId('real-film-pause')).toBeTruthy());
    expect(ui.queryByTestId('real-film-end')).toBeNull();
  });

  describe('saving your own moments', () => {
    let pick: jest.SpyInstance;
    let download: jest.SpyInstance;
    beforeEach(() => {
      pick = jest
        .spyOn(archiveDownload, 'pickArchiveExportDestination')
        .mockResolvedValue({ kind: 'default' });
      download = jest
        .spyOn(archiveDownload, 'downloadReleasedArchiveMediaTo')
        .mockImplementation(async (media) => ({
          filename: `${media.id}.mp4`,
          method: 'native',
          uri: 'file:///x',
        }));
    });

    it('reports a single saved moment in the singular', async () => {
      const { ui } = await finish({ client: makeClient({ clips: [clip('a')] }) });
      await fireEvent.press(await ui.findByTestId('real-film-save-mine'));
      expect(await ui.findByText('Saved 1 moment.')).toBeTruthy();
    });

    it('does not download again once everything has been saved', async () => {
      const { ui } = await finish({ client: makeClient({ clips: [clip('a')] }) });
      await fireEvent.press(await ui.findByTestId('real-film-save-mine'));
      await ui.findByText('Saved 1 moment.');
      await fireEvent.press(ui.getByTestId('real-film-save-mine'));
      expect(await ui.findByText('Your moments are already saved.')).toBeTruthy();
      expect(download).toHaveBeenCalledTimes(1);
    });

    it('says nothing was saved when the picker is cancelled', async () => {
      pick.mockResolvedValue(null);
      const { ui } = await finish({ client: makeClient({ clips: [clip('a')] }) });
      await fireEvent.press(await ui.findByTestId('real-film-save-mine'));
      expect(await ui.findByText('Save cancelled. Nothing was saved.')).toBeTruthy();
      expect(download).not.toHaveBeenCalled();
    });

    it('says saving is unavailable on a device that cannot export', async () => {
      pick.mockRejectedValue(new archiveDownload.ArchiveDownloadError('none', 'unavailable'));
      const { ui } = await finish({ client: makeClient({ clips: [clip('a')] }) });
      await fireEvent.press(await ui.findByTestId('real-film-save-mine'));
      expect(await ui.findByText('Saving is not available on this device.')).toBeTruthy();
    });

    it('says none were saved when every download fails', async () => {
      download.mockRejectedValue(new Error('network'));
      const { ui } = await finish({ client: makeClient({ clips: [clip('a'), clip('b')] }) });
      await fireEvent.press(await ui.findByTestId('real-film-save-mine'));
      expect(
        await ui.findByText('Your moments could not be saved. Try again when connected.'),
      ).toBeTruthy();
    });

    it('says none were saved when cancelled on the first clip', async () => {
      download.mockResolvedValue({ filename: 'a.mp4', method: 'cancelled', uri: '' });
      const { ui } = await finish({ client: makeClient({ clips: [clip('a')] }) });
      await fireEvent.press(await ui.findByTestId('real-film-save-mine'));
      expect(await ui.findByText('Save cancelled. Nothing was saved.')).toBeTruthy();
    });

    it('offers a retry when the own-moments lookup fails, then lets you save', async () => {
      const client = makeClient({ clips: new Error('boom') });
      const { ui } = await finish({ client });
      const retry = await ui.findByTestId('real-film-mine-retry');
      expect(retry).toHaveTextContent('Your moments couldn’t be loaded. Try again');
      client.getArchivePage.mockResolvedValue({
        archive: { films: [], clips: [clip('a')] },
        pagination: {
          filmCursor: null,
          clipCursor: null,
          hasMoreFilms: false,
          hasMoreClips: false,
        },
      });
      await fireEvent.press(retry);
      expect(await ui.findByTestId('real-film-save-mine')).toBeTruthy();
      expect(ui.queryByTestId('real-film-mine-retry')).toBeNull();
    });

    it('labels the link while a save is running and ignores a second tap', async () => {
      let release!: () => void;
      download.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ filename: 'a.mp4', method: 'native', uri: 'f' });
          }),
      );
      const { ui } = await finish({ client: makeClient({ clips: [clip('a')] }) });
      await fireEvent.press(await ui.findByTestId('real-film-save-mine'));
      expect(await ui.findByText('Saving your moments…')).toBeTruthy();
      await fireEvent.press(ui.getByTestId('real-film-save-mine'));
      expect(pick).toHaveBeenCalledTimes(1);
      await act(async () => release());
      expect(await ui.findByText('Saved 1 moment.')).toBeTruthy();
    });

    it('does not announce results after the screen is closed mid-save', async () => {
      let release!: () => void;
      download.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ filename: 'a.mp4', method: 'native', uri: 'f' });
          }),
      );
      const { ui } = await finish({ client: makeClient({ clips: [clip('a')] }) });
      await fireEvent.press(await ui.findByTestId('real-film-save-mine'));
      await waitFor(() => expect(download).toHaveBeenCalled());
      await ui.unmount();
      await act(async () => release());
      expect(download).toHaveBeenCalledTimes(1);
    });

    it('saves the whole film with a fresh authorization and confirms it', async () => {
      const { ui, client } = await finish();
      await fireEvent.press(ui.getByTestId('real-film-save'));
      expect(await ui.findByText('Saved.')).toBeTruthy();
      expect(client.getFreshArchiveMedia).toHaveBeenCalledWith('group-1', { id: 'film-1' });
      expect(download).toHaveBeenCalledTimes(1);
    });

    it('names the chosen folder on Android and handles a cancelled export', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      const { ui } = await finish({ client: makeClient({ clips: [clip('a')] }) });
      await fireEvent.press(ui.getByTestId('real-film-save'));
      expect(await ui.findByText('Saved to the folder you chose.')).toBeTruthy();
      download.mockResolvedValueOnce({ filename: 'f.mp4', method: 'cancelled', uri: '' });
      await fireEvent.press(ui.getByTestId('real-film-save'));
      expect(await ui.findByText('Save cancelled. Nothing was saved.')).toBeTruthy();
    });

    it('ignores the film save when the film has no id yet', async () => {
      const client = makeClient({
        premiere: async () => ({
          state: 'ready',
          filmId: '',
          playbackUrl: 'https://m.invalid/f.mp4',
        }),
      });
      const { ui } = await finish({ client });
      await fireEvent.press(ui.getByTestId('real-film-save'));
      expect(pick).not.toHaveBeenCalled();
    });
  });
});
