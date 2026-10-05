import { createDemoArchiveClient } from '../src/demo/demo-archive-client';
import type { RuntimeClient } from '../src/runtime/local-runtime-client';

const film = {
  id: 'film-1',
  cycleId: 'cycle-1',
  publishedAt: '2026-10-05T00:00:00Z',
  downloadUrl: 'https://demo.test/film-new',
};
const empty = {
  archive: { films: [], clips: [] },
  filmCursor: null,
  clipCursor: null,
  hasMoreFilms: false,
  hasMoreClips: false,
};

describe('published Demo media adapter', () => {
  it('uses the Demo session for premiere and paged published media', async () => {
    const getPremiere = jest.fn().mockResolvedValue({ state: 'locked', cycleId: 'cycle-1' });
    const getReleasedArchivePage = jest
      .fn()
      .mockResolvedValue({ ...empty, archive: { films: [film], clips: [] } });
    const client = createDemoArchiveClient(
      { getPremiere, getReleasedArchivePage } as unknown as RuntimeClient,
      'demo-session',
    );
    expect(await client.getPremiere('demo-group', 'cycle-1')).toEqual({
      state: 'locked',
      cycleId: 'cycle-1',
    });
    expect(getPremiere).toHaveBeenCalledWith('demo-session', 'demo-group', 'cycle-1');
    const page = await client.getArchivePage('demo-group', { filmCursor: 'next' });
    expect(getReleasedArchivePage).toHaveBeenCalledWith('demo-session', 'demo-group', {
      filmCursor: 'next',
    });
    expect(page.archive.films).toEqual([{ ...film, playbackUrl: null }]);
    expect(page.pagination.hasMoreFilms).toBe(false);
  });
  it('refreshes downloads from the runtime and follows pagination', async () => {
    const getReleasedArchivePage = jest
      .fn()
      .mockResolvedValueOnce({ ...empty, filmCursor: 'next', hasMoreFilms: true })
      .mockResolvedValueOnce({ ...empty, archive: { films: [film], clips: [] } });
    const client = createDemoArchiveClient(
      { getReleasedArchivePage } as unknown as RuntimeClient,
      'demo-session',
    );
    expect(await client.getFreshArchiveMedia('demo-group', { id: 'film-1' })).toEqual({
      ...film,
      playbackUrl: null,
    });
    expect(getReleasedArchivePage).toHaveBeenLastCalledWith('demo-session', 'demo-group', {
      filmCursor: 'next',
      clipCursor: null,
      limit: 50,
    });
  });
  it('does not supply missing or mismatched own clips', async () => {
    const getReleasedArchivePage = jest.fn().mockResolvedValue({
      ...empty,
      archive: {
        films: [],
        clips: [
          {
            id: 'clip-1',
            contributionId: 'own-1',
            cycleId: 'cycle-1',
            createdAt: '2026-10-05',
            downloadUrl: 'https://demo.test/clip',
          },
        ],
      },
    });
    const client = createDemoArchiveClient(
      { getReleasedArchivePage } as unknown as RuntimeClient,
      'demo-session',
    );
    await expect(
      client.getFreshArchiveMedia('demo-group', { id: 'clip-1', contributionId: 'other' }),
    ).rejects.toThrow('no longer available');
  });
});
