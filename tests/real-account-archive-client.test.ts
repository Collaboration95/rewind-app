import {
  AuthRequestError,
  createRealAccountArchiveClient,
  resolvePublicMediaPath,
} from '../src/auth/real-account-client';

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const page = (filmCursor: string | null, clipCursor: string | null, clips: unknown[] = []) => ({
  archive: { films: [], clips },
  pagination: {
    filmCursor,
    clipCursor,
    hasMoreFilms: filmCursor !== null,
    hasMoreClips: clipCursor !== null,
  },
});

it('resolves only same-origin HTTPS capability paths without application credentials', () => {
  expect(resolvePublicMediaPath('https://api.example.test/v1', '/media/cap?key=opaque')).toBe(
    'https://api.example.test/media/cap?key=opaque',
  );
  for (const path of [
    'http://api.example.test/media/cap',
    'https://other.example.test/media/cap',
    '/media/cap?appsession=secret',
    '/media/cap?token=secret',
    '/media/cap#secret',
  ]) {
    expect(() => resolvePublicMediaPath('https://api.example.test', path)).toThrow(
      AuthRequestError,
    );
  }
});

it('requests scoped archive and premiere metadata without a session query', async () => {
  const request = jest.fn(async (path: string) => {
    if (path.startsWith('/archive?'))
      return response({
        archive: {
          films: [
            {
              id: 'film-1',
              cycleId: 'cycle-1',
              publishedAt: '2026-10-01T00:00:00Z',
              downloadPath: '/private-media/film?cap=download',
              playbackPath: '/private-media/film?cap=play',
            },
          ],
          clips: [],
        },
        pagination: {
          filmCursor: null,
          clipCursor: null,
          hasMoreFilms: false,
          hasMoreClips: false,
        },
      });
    return response({
      premiere: {
        state: 'premiere',
        cycleId: 'cycle/one',
        filmId: 'film-1',
        playbackPath: '/private-media/film?cap=fresh',
      },
    });
  });
  const client = createRealAccountArchiveClient('https://api.example.test', request);

  const archive = await client.getArchivePage('group one');
  expect(archive.archive.films[0]).toMatchObject({
    id: 'film-1',
    playbackUrl: 'https://api.example.test/private-media/film?cap=play',
    downloadUrl: 'https://api.example.test/private-media/film?cap=download',
  });
  expect(await client.getPremiere('group one', 'cycle/one')).toMatchObject({
    state: 'ready',
    cycleId: 'cycle/one',
    filmId: 'film-1',
    playbackUrl: 'https://api.example.test/private-media/film?cap=fresh',
  });
  expect(request.mock.calls).toEqual([
    ['/archive?groupId=group+one&limit=50'],
    ['/cycles/cycle%2Fone/premiere?groupId=group%20one'],
  ]);
  expect(
    request.mock.calls.flatMap(([path]) => [...new URLSearchParams(path.split('?')[1]).keys()]),
  ).not.toContain('sessionId');
});

it('renews older paged clip capabilities by stable owned asset identity', async () => {
  const calls: string[] = [];
  const request = jest.fn(async (path: string) => {
    calls.push(path);
    if (calls.length === 1) return response(page('film-next', 'clip-next'));
    return response(
      page(null, null, [
        {
          id: 'clip-2',
          contributionId: 'contribution-2',
          cycleId: 'cycle-2',
          createdAt: '2026-09-01T00:00:00Z',
          downloadPath: '/private-media/clip?cap=renewed',
        },
      ]),
    );
  });
  const client = createRealAccountArchiveClient('https://api.example.test', request);

  await expect(
    client.getFreshArchiveMedia('group-1', { id: 'clip-2', contributionId: 'contribution-2' }),
  ).resolves.toMatchObject({
    id: 'clip-2',
    contributionId: 'contribution-2',
    downloadUrl: 'https://api.example.test/private-media/clip?cap=renewed',
  });
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain('filmCursor=film-next');
  expect(calls[1]).toContain('clipCursor=clip-next');
});

it('reports removed archive assets instead of reusing stale capabilities', async () => {
  const request = jest.fn(async () => response(page(null, null)));
  const client = createRealAccountArchiveClient('https://api.example.test', request);

  await expect(
    client.getFreshArchiveMedia('group-1', { id: 'removed-film' }),
  ).rejects.toMatchObject({
    status: 404,
  });
});

it('preserves a terminal processing failure as a truthful premiere state', async () => {
  const request = jest.fn(async () =>
    response({ premiere: { state: 'failed', cycleId: 'cycle-failed' } }),
  );
  const client = createRealAccountArchiveClient('https://api.example.test', request);

  await expect(client.getPremiere('group-1', 'cycle-failed')).resolves.toEqual({
    state: 'failed',
    cycleId: 'cycle-failed',
  });
});
