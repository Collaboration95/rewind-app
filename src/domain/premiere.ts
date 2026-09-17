/** A premiere intentionally has no media URL until the server has published it. */
export type Premiere =
  | { state: 'locked' | 'processing' | 'delayed'; cycleId: string }
  | { state: 'ready'; cycleId: string; filmId: string; playbackUrl: string };
