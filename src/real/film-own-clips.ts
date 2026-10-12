import type { RealAccountArchiveClient, RealArchiveClip } from '../auth/real-account-client';

/** A safety bound: 100 pages of 50 is far beyond one member's released clips. */
const MAX_PAGES = 100;

/**
 * Every own released clip of one cycle. The archive lists own clips newest-first
 * across all released cycles, so an older cycle can sit entirely behind page one:
 * follow the clip cursor on its own (metadata only; each download still asks for
 * fresh media), keep each clip once and stop on an exhausted or repeated cursor.
 * A failed page rejects, so a partial list is never mistaken for a complete one.
 * `isCurrent` lets the caller abandon the walk once its context has changed.
 */
export async function discoverOwnClips(
  client: RealAccountArchiveClient,
  groupId: string,
  cycleId: string,
  isCurrent: () => boolean = () => true,
): Promise<RealArchiveClip[]> {
  const found = new Map<string, RealArchiveClip>();
  const seenCursors = new Set<string>();
  let clipCursor: string | null = null;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = await client.getArchivePage(groupId, { clipCursor, limit: 50 });
    if (!isCurrent()) return [];
    for (const clip of page.archive.clips) {
      if (clip.cycleId === cycleId) found.set(`${clip.id}\u0000${clip.contributionId}`, clip);
    }
    const next = page.pagination.clipCursor;
    if (!page.pagination.hasMoreClips || !next || seenCursors.has(next)) break;
    seenCursors.add(next);
    clipCursor = next;
  }
  return [...found.values()];
}
