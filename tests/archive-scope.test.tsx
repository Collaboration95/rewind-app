import { act, fireEvent, render } from '@testing-library/react-native';

import { ArchiveScreen } from '../src/archive/ArchiveScreen';
import type { ReleasedArchivePage } from '../src/domain/archive';
import type { RuntimeClient } from '../src/runtime/local-runtime-client';

let mockScope = 'old';
jest.mock('../src/session/DemoSessionProvider', () => ({
  useDemoSession: () => ({ session: { id: mockScope } }),
}));
jest.mock('../src/capsule/CapsuleProvider', () => ({
  useCapsule: () => ({
    state: { status: 'ready', group: { id: mockScope }, cycle: { id: mockScope } },
    retry: jest.fn(),
  }),
}));
jest.mock('../src/capsule/RevealEducationPanel', () => ({ RevealEducationPanel: () => null }));
jest.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: jest.fn() }));

function page(id: string, hasMoreFilms = false): ReleasedArchivePage {
  return {
    archive: {
      films: [{ id, cycleId: id, publishedAt: '2026-09-26', downloadUrl: '/media' }],
      clips: [],
    },
    filmCursor: hasMoreFilms ? 'older' : null,
    clipCursor: null,
    hasMoreFilms,
    hasMoreClips: false,
  };
}

it('does not merge an old pending archive page into a different session and group', async () => {
  mockScope = 'old';
  let resolveOldPage!: (value: ReleasedArchivePage) => void;
  const pending = new Promise<ReleasedArchivePage>((resolve) => {
    resolveOldPage = resolve;
  });
  const runtime = {
    getPremiere: jest.fn().mockResolvedValue({ state: 'locked', cycleId: 'current' }),
    getReleasedArchivePage: jest
      .fn()
      .mockResolvedValueOnce(page('old-film', true))
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(page('new-film')),
    getCycleHistoryPage: jest
      .fn()
      .mockResolvedValue({ cycles: [], nextCursor: null, hasMore: false }),
  } as unknown as RuntimeClient;
  const result = await render(<ArchiveScreen runtimeClient={runtime} />);
  await result.findByTestId('archive-film-cycle-old-film');
  await fireEvent.press(result.getByTestId('archive-load-more'));
  mockScope = 'new';
  await result.rerender(<ArchiveScreen runtimeClient={runtime} />);
  await result.findByTestId('archive-film-cycle-new-film');
  await act(async () => resolveOldPage(page('stale-film')));
  expect(result.queryByTestId('archive-film-cycle-stale-film')).toBeNull();
  expect(result.queryByTestId('archive-film-cycle-old-film')).toBeNull();
  expect(result.getByTestId('archive-film-cycle-new-film')).toBeTruthy();
});
