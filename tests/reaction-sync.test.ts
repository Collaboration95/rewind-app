import {
  appendMessage,
  applyReactionPatches,
  historyRows,
  mergeRows,
  type ChatRow,
} from '../src/chat/reaction-sync';
import type { ChatMessage, ChatMessageEvent } from '../src/chat';

const message = (id: string, sparks = 0, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  groupId: 'group',
  memberId: 'member',
  body: `Body ${id}`,
  createdAt: '2026-09-29T00:00:00.000Z',
  replyTo: null,
  reactionCounts: sparks ? { '✨': sparks } : {},
  ...extra,
});
const row = (eventId: number, id: string, sparks = 0, reactionRevision?: number): ChatRow => ({
  eventId,
  message: message(id, sparks),
  ...(reactionRevision === undefined ? {} : { reactionRevision }),
});
const sparks = (rows: ChatRow[], id: string) =>
  rows.find((entry) => entry.message.id === id)?.message.reactionCounts?.['✨'] ?? 0;

describe('reaction patches', () => {
  it('patches only counts and keeps the row identity, order and content', () => {
    const rows = [
      row(1, 'a', 0, 5),
      { ...row(2, 'b', 0, 5), message: message('b', 0, { replyTo: null, body: 'kept' }) },
    ];
    const next = applyReactionPatches(rows, [
      { messageId: 'b', reactionCounts: { '✨': 3 }, revision: 6 },
    ]);
    expect(next.map((entry) => entry.message.id)).toEqual(['a', 'b']);
    expect(next[0]).toBe(rows[0]);
    expect(next[1].message).toMatchObject({ body: 'kept', reactionCounts: { '✨': 3 } });
    expect(next[1].reactionRevision).toBe(6);
  });

  it('is idempotent and returns the same array for a repeated update', () => {
    const rows = [row(1, 'a', 2, 7)];
    expect(
      applyReactionPatches(rows, [{ messageId: 'a', reactionCounts: { '✨': 2 }, revision: 7 }]),
    ).toBe(rows);
  });

  it('ignores stale and out-of-order updates', () => {
    let rows = [row(1, 'a', 0, 1)];
    rows = applyReactionPatches(rows, [
      { messageId: 'a', reactionCounts: { '✨': 4 }, revision: 9 },
    ]);
    rows = applyReactionPatches(rows, [
      { messageId: 'a', reactionCounts: { '✨': 1 }, revision: 8 },
    ]);
    expect(sparks(rows, 'a')).toBe(4);
    // Within one batch the newest revision wins regardless of order.
    rows = applyReactionPatches(rows, [
      { messageId: 'a', reactionCounts: {}, revision: 12 },
      { messageId: 'a', reactionCounts: { '✨': 9 }, revision: 11 },
    ]);
    expect(sparks(rows, 'a')).toBe(0);
    expect(rows[0].reactionRevision).toBe(12);
  });

  it('never inserts a row for an unknown, hidden or reported message', () => {
    const rows = [row(1, 'a')];
    const next = applyReactionPatches(rows, [
      { messageId: 'reported', reactionCounts: { '✨': 1 }, revision: 3 },
    ]);
    expect(next).toBe(rows);
  });

  it('applies a legacy response without a revision but keeps the stored revision', () => {
    const next = applyReactionPatches(
      [row(1, 'a', 0, 5)],
      [{ messageId: 'a', reactionCounts: { '✨': 1 } }],
    );
    expect(sparks(next, 'a')).toBe(1);
    expect(next[0].reactionRevision).toBe(5);
  });
});

describe('history merge with reactions', () => {
  it('lets a newer history snapshot update an existing row but not a delayed one', () => {
    const current = [row(1, 'a', 3, 10)];
    const delayed = mergeRows(current, historyRows([event(1, 'a', 0)], 9));
    expect(sparks(delayed, 'a')).toBe(3);
    const fresh = mergeRows(current, historyRows([event(1, 'a', 5)], 11));
    expect(sparks(fresh, 'a')).toBe(5);
    expect(fresh).toHaveLength(1);
  });

  it('keeps ordering and adds older paginated rows with the page revision', () => {
    const current = [row(5, 'e', 0, 10)];
    const merged = mergeRows(current, historyRows([event(2, 'b', 2), event(3, 'c', 0)], 10));
    expect(merged.map((entry) => entry.eventId)).toEqual([2, 3, 5]);
    expect(merged[0].reactionRevision).toBe(10);
  });

  it('live message events never carry a reaction revision or change existing counts', () => {
    const current = [row(1, 'a', 4, 10)];
    const appended = appendMessage(current, event(1, 'a', 0));
    expect(sparks(appended, 'a')).toBe(4);
    expect(appendMessage(appended, event(2, 'b', 0)).map((entry) => entry.eventId)).toEqual([1, 2]);
  });
});

function event(eventId: number, id: string, count: number): ChatMessageEvent {
  return {
    eventId,
    type: 'message',
    occurredAt: '2026-09-29T00:00:00.000Z',
    message: message(id, count),
  };
}
