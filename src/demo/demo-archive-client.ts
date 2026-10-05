import type {
  RealAccountArchiveClient,
  RealArchivePage,
  RealArchivePageRequest,
} from '../auth/real-account-client';
import type { RuntimeClient } from '../runtime/local-runtime-client';

/** Only the published-media interface is adapted. Demo identity never enters
 * the real-account provider or its authenticated transport. */
export function createDemoArchiveClient(
  runtime: RuntimeClient,
  sessionId: string,
): RealAccountArchiveClient {
  const getArchivePage = async (
    groupId: string,
    options: RealArchivePageRequest = {},
  ): Promise<RealArchivePage> => {
    const page = runtime.getReleasedArchivePage
      ? await runtime.getReleasedArchivePage(sessionId, groupId, options)
      : {
          archive: (await runtime.getReleasedArchive?.(sessionId, groupId)) ?? {
            films: [],
            clips: [],
          },
          filmCursor: null,
          clipCursor: null,
          hasMoreFilms: false,
          hasMoreClips: false,
        };
    return {
      archive: {
        films: page.archive.films.map((film) => ({ ...film, playbackUrl: null })),
        clips: page.archive.clips.map((clip) => ({ ...clip, playbackUrl: null })),
      },
      pagination: {
        filmCursor: page.filmCursor,
        clipCursor: page.clipCursor,
        hasMoreFilms: page.hasMoreFilms,
        hasMoreClips: page.hasMoreClips,
      },
    };
  };
  return {
    getArchivePage,
    async getPremiere(groupId, cycleId) {
      if (!runtime.getPremiere) throw new Error('The Demo runtime is unavailable.');
      return runtime.getPremiere(sessionId, groupId, cycleId);
    },
    async getFreshArchiveMedia(groupId, media) {
      let filmCursor: string | null = null;
      let clipCursor: string | null = null;
      const seen = new Set<string>();
      for (let index = 0; index < 100; index += 1) {
        const key = `${filmCursor ?? ''}:${clipCursor ?? ''}`;
        if (seen.has(key)) break;
        seen.add(key);
        const page = await getArchivePage(groupId, { filmCursor, clipCursor, limit: 50 });
        const found =
          'contributionId' in media
            ? page.archive.clips.find(
                (clip) => clip.id === media.id && clip.contributionId === media.contributionId,
              )
            : page.archive.films.find((film) => film.id === media.id);
        if (found) return found;
        if (!page.pagination.hasMoreFilms && !page.pagination.hasMoreClips) break;
        filmCursor = page.pagination.hasMoreFilms ? page.pagination.filmCursor : null;
        clipCursor = page.pagination.hasMoreClips ? page.pagination.clipCursor : null;
      }
      throw new Error('This released Demo media is no longer available.');
    },
  };
}
