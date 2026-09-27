export interface ReleasedFilm {
  id: string;
  cycleId: string;
  publishedAt: string;
  downloadUrl: string;
}

export interface ReleasedClip {
  id: string;
  contributionId: string;
  cycleId: string;
  createdAt: string;
  downloadUrl: string;
}

export interface ReleasedArchive {
  films: ReleasedFilm[];
  clips: ReleasedClip[];
}

export interface ReleasedArchivePage {
  archive: ReleasedArchive;
  filmCursor: string | null;
  clipCursor: string | null;
  hasMoreFilms: boolean;
  hasMoreClips: boolean;
}

export type ReleasedArchiveMedia = ReleasedFilm | ReleasedClip;

function filenamePart(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9]+/g, '-');
  return normalized.replace(/^-+|-+$/g, '').slice(0, 64) || 'unknown';
}

function archiveDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 'undated' : new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Archive files are stored in a shared cache directory on native platforms.
 * Include the cycle, media date, and server id so every released item gets a
 * stable path without relying on a single mutable "latest download" name.
 */
export function getReleasedArchiveFilename(media: ReleasedArchiveMedia): string {
  const isClip = 'contributionId' in media;
  const prefix = isClip ? 'rewind-personal-clip' : 'rewind-group-film';
  const date = archiveDate(isClip ? media.createdAt : media.publishedAt);
  return `${prefix}-${filenamePart(media.cycleId)}-${date}-${filenamePart(media.id)}.mp4`;
}
