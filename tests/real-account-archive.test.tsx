import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';

import * as archiveDownload from '../src/archive/archive-download';
import { RealAccountArchiveScreen } from '../src/archive/ArchiveScreen';
import type { ReleasedArchiveMedia } from '../src/domain/archive';
import { getLatestMockVideoPlayer, resetMockVideoPlayers } from './mocks/expo-video';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function archiveBody(downloadCapability = 'stale') {
  return {
    archive: {
      films: [
        {
          id: 'film-old',
          cycleId: 'cycle-old',
          publishedAt: '2026-09-01T00:00:00.000Z',
          downloadPath: `/private-media/film?cap=${downloadCapability}`,
          playbackPath: '/private-media/film?cap=old-play',
        },
      ],
      clips: [
        {
          id: 'clip-own',
          contributionId: 'contribution-own',
          cycleId: 'cycle-old',
          createdAt: '2026-09-02T00:00:00.000Z',
          downloadPath: `/private-media/clip?cap=${downloadCapability}`,
        },
      ],
    },
    pagination: {
      filmCursor: null,
      clipCursor: null,
      hasMoreFilms: false,
      hasMoreClips: false,
    },
  };
}

const props = (authenticatedRequest: (path: string) => Promise<Response>) => ({
  baseUrl: 'https://api.example.test',
  groupId: 'group-one',
  cycleId: 'cycle-current',
  authenticatedRequest,
  onBack: jest.fn(),
});

function stubAppState() {
  const listeners = new Set<(state: string) => void>();
  const appState = AppState as unknown as {
    addEventListener: (
      event: string,
      listener: (state: string) => void,
    ) => {
      remove: () => void;
    };
  };
  const original = appState.addEventListener;
  appState.addEventListener = (_event, listener) => {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  };
  return {
    emit(state: string) {
      for (const listener of listeners) listener(state);
    },
    restore() {
      appState.addEventListener = original;
    },
  };
}

beforeEach(() => {
  resetMockVideoPlayers();
});

it('renews playback capabilities before playing with audio and when the app resumes', async () => {
  const appState = stubAppState();
  let premiereRead = 0;
  const authenticatedRequest = jest.fn(async (path: string) => {
    if (path.startsWith('/archive?')) return jsonResponse(archiveBody());
    if (path.startsWith('/cycles/')) {
      premiereRead += 1;
      return jsonResponse({
        premiere: {
          state: 'premiere',
          cycleId: 'cycle-current',
          filmId: 'film-current',
          playbackPath: `/private-media/current?cap=play-${premiereRead}`,
        },
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const result = await render(<RealAccountArchiveScreen {...props(authenticatedRequest)} />);

  try {
    const play = await result.findByTestId('real-archive-play');
    const player = getLatestMockVideoPlayer();
    expect(player).not.toBeNull();
    await fireEvent.press(play);
    await waitFor(() => expect(player?.playing).toBe(true));
    expect(player?.muted).toBe(false);
    expect(player?.replacements).toEqual([
      'https://api.example.test/private-media/current?cap=play-2',
    ]);

    await act(async () => {
      appState.emit('background');
      appState.emit('active');
    });
    await waitFor(() => expect(player?.replacements).toHaveLength(2));
    expect(player?.replacements[1]).toBe(
      'https://api.example.test/private-media/current?cap=play-3',
    );
    expect(player?.playing).toBe(true);
    expect(
      authenticatedRequest.mock.calls.filter(([path]) => path.startsWith('/cycles/')),
    ).toHaveLength(3);
  } finally {
    result.unmount();
    appState.restore();
  }
});

it('refreshes the selected own-clip capability before downloading', async () => {
  const downloaded: ReleasedArchiveMedia[] = [];
  const queue = jest.spyOn(archiveDownload, 'createArchiveDownloadQueue').mockReturnValue((async (
    media,
  ) => {
    downloaded.push(media);
    return { filename: 'clip.mp4', method: 'native', uri: 'file:///cache/clip.mp4' };
  }) as ReturnType<typeof archiveDownload.createArchiveDownloadQueue>);
  let archiveRead = 0;
  const authenticatedRequest = jest.fn(async (path: string) => {
    if (path.startsWith('/archive?')) {
      archiveRead += 1;
      return jsonResponse(archiveBody(archiveRead === 1 ? 'old' : 'fresh'));
    }
    if (path.startsWith('/cycles/')) {
      return jsonResponse({ premiere: { state: 'processing', cycleId: 'cycle-current' } });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const result = await render(<RealAccountArchiveScreen {...props(authenticatedRequest)} />);

  try {
    await fireEvent.press(await result.findByLabelText('Download your released clip'));
    await waitFor(() => expect(downloaded).toHaveLength(1));
    expect(downloaded[0]).toMatchObject({
      id: 'clip-own',
      contributionId: 'contribution-own',
      downloadUrl: 'https://api.example.test/private-media/clip?cap=fresh',
    });
    expect(archiveRead).toBe(2);
    expect(result.getByText('Saved to this device.')).toBeTruthy();
  } finally {
    result.unmount();
    queue.mockRestore();
  }
});

it('shows a terminal failed release without offering stale playback', async () => {
  const archiveRequest = jest.fn(async (path: string) => {
    if (path.startsWith('/archive?')) return jsonResponse(archiveBody());
    return jsonResponse({ premiere: { state: 'failed', cycleId: 'cycle-current' } });
  });
  const failed = await render(<RealAccountArchiveScreen {...props(archiveRequest)} />);
  await failed.findByTestId('archive-premiere-failed');
  expect(failed.queryByTestId('real-archive-video-player')).toBeNull();
  failed.unmount();
});

it('shows an expired-session message when Archive authentication fails', async () => {
  const expired = await render(
    <RealAccountArchiveScreen
      {...props(async () => jsonResponse({ error: 'session_expired' }, 401))}
    />,
  );
  expect(await expired.findByText(/Your sign-in expired/)).toBeTruthy();
  expired.unmount();
});

it('shows the offline connection state without offering stale playback', async () => {
  const offline = await render(
    <RealAccountArchiveScreen
      {...props(async () => {
        throw new TypeError('Failed to fetch');
      })}
    />,
  );
  await offline.findByTestId('real-archive-unavailable');
  expect(offline.getByText(/archive connection is unavailable/i)).toBeTruthy();
  expect(offline.queryByTestId('real-archive-video-player')).toBeNull();
  offline.unmount();
});

it('removes playback controls and explains an expired session after renewal fails', async () => {
  let premiereRead = 0;
  const authenticatedRequest = jest.fn(async (path: string) => {
    if (path.startsWith('/archive?')) return jsonResponse(archiveBody());
    premiereRead += 1;
    if (premiereRead === 1) {
      return jsonResponse({
        premiere: {
          state: 'premiere',
          cycleId: 'cycle-current',
          filmId: 'film-current',
          playbackPath: '/private-media/current?cap=initial',
        },
      });
    }
    return jsonResponse({ error: 'session_expired' }, 401);
  });
  const result = await render(<RealAccountArchiveScreen {...props(authenticatedRequest)} />);

  await fireEvent.press(await result.findByTestId('real-archive-play'));
  expect(await result.findByText(/Your sign-in expired/i)).toBeTruthy();
  expect(result.queryByTestId('real-archive-video-player')).toBeNull();
  expect(result.getByTestId('real-archive-refresh-playback')).toBeTruthy();
  result.unmount();
});

it('explains an expired session when refreshing an archive download capability fails', async () => {
  let archiveRead = 0;
  const authenticatedRequest = jest.fn(async (path: string) => {
    if (path.startsWith('/archive?')) {
      archiveRead += 1;
      return archiveRead === 1
        ? jsonResponse(archiveBody())
        : jsonResponse({ error: 'session_expired' }, 401);
    }
    return jsonResponse({ premiere: { state: 'processing', cycleId: 'cycle-current' } });
  });
  const result = await render(<RealAccountArchiveScreen {...props(authenticatedRequest)} />);

  await fireEvent.press(await result.findByLabelText('Download your released clip'));
  expect(await result.findByText(/Your sign-in expired/i)).toBeTruthy();
  result.unmount();
});

it('releases the old group player and archive items when the selected group changes', async () => {
  const authenticatedRequest = jest.fn(async (path: string) => {
    if (path.startsWith('/archive?')) {
      if (path.includes('groupId=group-two')) {
        const body = archiveBody('group-two-capability');
        body.archive.films[0].id = 'film-group-two';
        body.archive.films[0].cycleId = 'cycle-group-two';
        return jsonResponse(body);
      }
      return jsonResponse(archiveBody());
    }
    const cycleId = path.includes('cycle-group-two') ? 'cycle-group-two' : 'cycle-current';
    return jsonResponse({
      premiere: {
        state: 'premiere',
        cycleId,
        filmId: `film-${cycleId}`,
        playbackPath: `/private-media/${cycleId}?cap=play`,
      },
    });
  });
  const scope = (groupId: string) => (
    <RealAccountArchiveScreen key={groupId} {...props(authenticatedRequest)} groupId={groupId} />
  );
  const result = await render(scope('group-one'));
  await result.findByTestId('archive-film-cycle-film-old');
  const oldPlayer = getLatestMockVideoPlayer();
  expect(oldPlayer?.released).toBe(false);

  await fireEvent.press(await result.findByTestId('real-archive-play'));
  await waitFor(() => expect(oldPlayer?.playing).toBe(true));
  await result.rerender(scope('group-two'));
  await result.findByTestId('archive-film-cycle-film-group-two');
  expect(oldPlayer?.released).toBe(true);
  expect(result.queryByTestId('archive-film-cycle-film-old')).toBeNull();
});
