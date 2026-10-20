// /media/access/:token capabilities, premiere status and the Archive.
import { decodePageCursor, encodePageCursor } from '../archive/cursor';
import { REAL_SESSION_COOKIE } from '../auth';
import { getPremiereFilm, listReleasedArchive } from '../db';
import { filmSegments } from '../groups/safety';

import { MediaRouteContext, Route } from './context';
import { acquireRequestCapacity } from './limits';
import {
  filterServableArchive,
  mediaIdentityIsCurrent,
  openVerifiedServingFile,
  premiereState,
  protectedAssetPath,
  requireAuthorisedMediaGroup,
  servableOutput,
  streamMp4,
} from './media-access';
import {
  authCorsHeaders,
  authOriginIsAllowed,
  authToken,
  authTransportIsSecure,
  decodePathSegment,
  sendDenied,
  sendJson,
  sendNotFound,
} from './respond';

async function handleMediaAccess(ctx: MediaRouteContext, match: RegExpMatchArray): Promise<void> {
  const { request, response, config, database, options, now } = ctx;
  if (!authTransportIsSecure(request, config) || !authOriginIsAllowed(request, config))
    return sendDenied(response, config);
  const presented = authToken(request);
  if (
    (request.headers.authorization ||
      (request.headers.cookie ?? '').includes(`${REAL_SESSION_COOKIE}=`)) &&
    !presented
  )
    return sendDenied(response, config);
  const grant = options.mediaCapabilities?.resolve(database, match[1], now(), presented);
  if (!grant) return sendNotFound(response, config);
  for (const [name, value] of Object.entries(authCorsHeaders(request, config)))
    response.setHeader(name, value);
  const served = await openVerifiedServingFile(
    database,
    grant.jobId,
    grant.kind,
    grant.outputPath,
    config.dataDir,
    grant.memberId,
    now(),
    options,
  );
  if (!served) return sendNotFound(response, config);
  if ('capacityExceeded' in served) {
    sendJson(response, config, served.reason === 'size_policy' ? 413 : 429, {
      error: 'media_unavailable',
      message: 'Media delivery is unavailable. Retry shortly.',
    });
    return;
  }
  if (!options.mediaCapabilities?.resolve(database, match[1], now(), presented)) {
    await served.handle.close();
    served.releaseBudget();
    return sendNotFound(response, config);
  }
  streamMp4(
    request,
    response,
    config,
    served.handle,
    served.size,
    grant.purpose === 'download'
      ? grant.kind === 'film'
        ? 'rewind-group-film.mp4'
        : 'rewind-my-clip.mp4'
      : undefined,
    served.releaseBudget,
  );
}

async function handlePremiere(ctx: MediaRouteContext, match: RegExpMatchArray): Promise<void> {
  const { request, response, config, database, options, now, url } = ctx;
  const cycleId = decodePathSegment(match[1], response, config);
  if (cycleId === null) return;
  const groupId = url.searchParams.get('groupId');
  const identity = requireAuthorisedMediaGroup(request, database, response, config, now(), groupId);
  if (!identity) return;
  const film = getPremiereFilm(database, identity.groupId, cycleId);
  if (!film) return sendNotFound(response, config);
  let state = premiereState(film);
  // A published film whose bytes no longer match its finalized digest must
  // not be advertised as playable. It is reported as delayed and audited,
  // the same safe state used for an exhausted compile.
  if (state === 'ready' && film.filmId && film.outputPath) {
    if (
      !(await servableOutput(
        database,
        film.filmId,
        'film',
        film.outputPath,
        config.dataDir,
        identity.memberId,
        now(),
        options,
      ))
    )
      state = 'delayed';
  }
  if (!mediaIdentityIsCurrent(request, database, identity, now()))
    return sendDenied(response, config);
  const currentFilm = getPremiereFilm(database, identity.groupId, cycleId);
  if (
    state === 'ready' &&
    (currentFilm?.filmId !== film.filmId ||
      currentFilm.outputPath !== film.outputPath ||
      premiereState(currentFilm) !== 'ready')
  )
    state = 'delayed';
  sendJson(response, config, 200, {
    premiere:
      state === 'ready'
        ? {
            state,
            cycleId,
            filmId: film.filmId,
            segments: filmSegments(database, film.filmId!, identity.memberId),
            playbackPath: protectedAssetPath(
              database,
              request,
              identity,
              film.filmId!,
              'film',
              'play',
              options,
              now(),
            ),
          }
        : { state, cycleId },
  });
}

async function handleArchive(ctx: MediaRouteContext): Promise<void> {
  const { request, response, config, database, options, now, requestLimiters, url } = ctx;
  const groupId = url.searchParams.get('groupId');
  const identity = requireAuthorisedMediaGroup(request, database, response, config, now(), groupId);
  if (!identity) return;
  const releaseArchiveCapacity = acquireRequestCapacity(
    requestLimiters.archive,
    request,
    response,
    config,
  );
  if (!releaseArchiveCapacity) return;
  try {
    const parsedLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 50) : 50;
    const rawFilmCursor = url.searchParams.get('filmCursor');
    const rawClipCursor = url.searchParams.get('clipCursor');
    const filmCursor = decodePageCursor(rawFilmCursor, 3);
    const clipCursor = decodePageCursor(rawClipCursor, 2);
    if ((rawFilmCursor !== null && !filmCursor) || (rawClipCursor !== null && !clipCursor)) {
      sendJson(response, config, 400, {
        error: 'invalid_page_cursor',
        message: 'The archive cursor is invalid.',
      });
      return;
    }
    const archive = listReleasedArchive(database, identity.groupId, identity.memberId, {
      limit,
      includeFilms: url.searchParams.get('includeFilms') !== 'false',
      includeClips: url.searchParams.get('includeClips') !== 'false',
      filmCursor: filmCursor as [string, string, string] | null,
      clipCursor: clipCursor as [string, string] | null,
    });
    // Advertise finalized entries whose object still exists at its recorded
    // size. Tampered bytes are caught and audited when playback hashes them.
    const films = await filterServableArchive(
      database,
      'film',
      archive.films,
      config.dataDir,
      identity.memberId,
      now(),
      options,
    );
    const clips = await filterServableArchive(
      database,
      'clip',
      archive.clips,
      config.dataDir,
      identity.memberId,
      now(),
      options,
    );
    if (!mediaIdentityIsCurrent(request, database, identity, now()))
      return sendDenied(response, config);
    sendJson(response, config, 200, {
      archive: {
        films: films.map((film) => ({
          ...film,
          segments: filmSegments(database, film.id, identity.memberId),
          downloadPath: protectedAssetPath(
            database,
            request,
            identity,
            film.id,
            'film',
            'download',
            options,
            now(),
          ),
          playbackPath: protectedAssetPath(
            database,
            request,
            identity,
            film.id,
            'film',
            'play',
            options,
            now(),
          ),
        })),
        clips: clips.map((clip) => ({
          ...clip,
          downloadPath: protectedAssetPath(
            database,
            request,
            identity,
            clip.id,
            'clip',
            'download',
            options,
            now(),
          ),
        })),
      },
      pagination: {
        filmCursor: archive.nextFilmCursor ? encodePageCursor(archive.nextFilmCursor) : null,
        clipCursor: archive.nextClipCursor ? encodePageCursor(archive.nextClipCursor) : null,
        hasMoreFilms: archive.hasMoreFilms,
        hasMoreClips: archive.hasMoreClips,
      },
    });
  } finally {
    releaseArchiveCapacity();
  }
}

export const mediaAccessRoutes: readonly Route<MediaRouteContext>[] = [
  {
    methods: ['GET', 'HEAD'],
    path: /^\/media\/access\/([A-Za-z0-9_-]{43})$/,
    handle: handleMediaAccess,
  },
];

export const archiveRoutes: readonly Route<MediaRouteContext>[] = [
  { methods: ['GET'], path: /^\/cycles\/([^/]+)\/premiere$/, handle: handlePremiere },
  { methods: ['GET'], path: '/archive', handle: handleArchive },
];
