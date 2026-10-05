import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import type { RealAccountArchiveClient } from '../src/auth/real-account-client';
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
