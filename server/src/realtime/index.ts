import type { ChatMessageEvent } from '../chat';

export type RealtimeEventWriter = (event: ChatMessageEvent) => void;

/**
 * Process-local fan-out for the local runtime. SQLite remains the source of
 * truth; this hub only delivers an event after the chat transaction commits.
 */
export class RealtimeHub {
  private readonly subscribers = new Map<string, Set<RealtimeEventWriter>>();

  subscribe(groupId: string, writer: RealtimeEventWriter): () => void {
    const writers = this.subscribers.get(groupId) ?? new Set<RealtimeEventWriter>();
    writers.add(writer);
    this.subscribers.set(groupId, writers);
    return () => {
      writers.delete(writer);
      if (writers.size === 0) this.subscribers.delete(groupId);
    };
  }

  publish(event: ChatMessageEvent): void {
    const writers = this.subscribers.get(event.message.groupId);
    if (!writers) return;
    for (const writer of [...writers]) {
      try {
        writer(event);
      } catch {
        // A disconnected HTTP stream is cleaned up by its close handler. A
        // writer failure must not stop another authorised session receiving
        // the same already-persisted event.
      }
    }
  }

  subscriberCount(groupId?: string): number {
    if (groupId) return this.subscribers.get(groupId)?.size ?? 0;
    return [...this.subscribers.values()].reduce((count, writers) => count + writers.size, 0);
  }
}

export function encodeSseEvent(event: ChatMessageEvent): string {
  return ['event: message', `id: ${event.eventId}`, `data: ${JSON.stringify(event)}`, '', ''].join(
    '\n',
  );
}
