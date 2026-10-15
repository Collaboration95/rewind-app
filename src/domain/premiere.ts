/** A premiere intentionally has no media URL until the server has published it. */
export type Premiere =
  | { state: 'locked' | 'processing' | 'delayed' | 'failed'; cycleId: string }
  | {
      state: 'ready';
      cycleId: string;
      filmId: string;
      playbackUrl: string;
      /** The moments in the film, in order. Real accounts only. */
      segments?: FilmSegment[];
    };

/** One moment in a compiled film. Hidden ones are skipped for this viewer:
 * a blocked author, a moment they reported, or one the owner removed. */
export interface FilmSegment {
  contributionId: string;
  startSeconds: number;
  durationSeconds: number;
  hidden: boolean;
  mine: boolean;
}

export function parseFilmSegments(value: unknown): FilmSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const segments: FilmSegment[] = [];
  for (const item of value) {
    const entry = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    if (
      !entry ||
      typeof entry.contributionId !== 'string' ||
      typeof entry.startSeconds !== 'number' ||
      typeof entry.durationSeconds !== 'number' ||
      !Number.isFinite(entry.startSeconds) ||
      !Number.isFinite(entry.durationSeconds) ||
      entry.durationSeconds <= 0
    )
      return undefined;
    segments.push({
      contributionId: entry.contributionId,
      startSeconds: entry.startSeconds,
      durationSeconds: entry.durationSeconds,
      hidden: entry.hidden === true,
      mine: entry.mine === true,
    });
  }
  return segments;
}
