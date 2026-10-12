import type { ChatMessage, ChatMessageEvent } from './realtime-client';

export interface ChatRow {
  eventId: number;
  message: ChatMessage;
  /** Revision of the newest reaction state applied to this row. */
  reactionRevision?: number;
}

export interface ReactionPatch {
  messageId: string;
  reactionCounts: ChatMessage['reactionCounts'];
  /** Undefined for a legacy response without revisions: applied, never ordered. */
  revision?: number;
}

const sameCounts = (left: ChatMessage['reactionCounts'], right: ChatMessage['reactionCounts']) =>
  (left?.['✨'] ?? 0) === (right?.['✨'] ?? 0);

/**
 * Patch only the reaction counts of rows that are already loaded. Equal or
 * newer revisions win, so a repeated or delayed update cannot undo newer state,
 * and an update for an unknown (hidden, reported or not yet loaded) message is
 * dropped instead of inserting content.
 */
export function applyReactionPatches(rows: ChatRow[], patches: ReactionPatch[]): ChatRow[] {
  if (patches.length === 0) return rows;
  const byId = new Map<string, ReactionPatch>();
  for (const patch of patches) {
    const known = byId.get(patch.messageId);
    if (!known || (patch.revision ?? 0) >= (known.revision ?? 0)) byId.set(patch.messageId, patch);
  }
  let changed = false;
  const next = rows.map((row) => {
    const patch = byId.get(row.message.id);
    if (!patch) return row;
    const known = row.reactionRevision ?? 0;
    if (patch.revision !== undefined && patch.revision < known) return row;
    const revision = patch.revision ?? row.reactionRevision;
    if (
      sameCounts(row.message.reactionCounts, patch.reactionCounts) &&
      revision === row.reactionRevision
    )
      return row;
    changed = true;
    return {
      ...row,
      message: { ...row.message, reactionCounts: patch.reactionCounts },
      ...(revision === undefined ? {} : { reactionRevision: revision }),
    };
  });
  return changed ? next : rows;
}

/**
 * Merge loaded history or live rows by message id. An existing row keeps its
 * identity, order and content; only its reaction counts may move forward, and
 * only when the incoming row carries a revision that is not older.
 */
export function mergeRows(current: ChatRow[], incoming: ChatRow[]): ChatRow[] {
  const merged = new Map(current.map((row) => [row.message.id, row]));
  const patches: ReactionPatch[] = [];
  for (const row of incoming) {
    if (!merged.has(row.message.id)) merged.set(row.message.id, row);
    else if (row.reactionRevision !== undefined)
      patches.push({
        messageId: row.message.id,
        reactionCounts: row.message.reactionCounts,
        revision: row.reactionRevision,
      });
  }
  const rows = [...merged.values()].sort((left, right) => left.eventId - right.eventId);
  return applyReactionPatches(rows, patches);
}

export function appendMessage(rows: ChatRow[], event: ChatMessageEvent): ChatRow[] {
  return mergeRows(rows, [{ eventId: event.eventId, message: event.message }]);
}

/** History rows stamped with the revision the server read before the page. */
export function historyRows(events: ChatMessageEvent[], reactionRevision?: number): ChatRow[] {
  return events.map(({ eventId, message }) => ({
    eventId,
    message,
    ...(reactionRevision === undefined ? {} : { reactionRevision }),
  }));
}
