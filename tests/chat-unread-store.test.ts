import {
  INITIAL_CHAT_UNREAD,
  chatScopeKey,
  markChatScopeRead,
  projectChatUnreadEvent,
  recordChatUnreadEvent,
  type ChatUnreadScope,
  type ChatUnreadSnapshot,
} from '../src/chat/unread';

const scope: ChatUnreadScope = {
  sessionId: 'session-a',
  groupId: 'demo-group',
  memberId: 'demo-1',
};

function incoming(eventId: number, memberId = 'demo-2') {
  return { eventId, groupId: 'demo-group', memberId };
}

describe('chat unread store', () => {
  it('scopes unread state by session and group rather than a bare group id', () => {
    expect(chatScopeKey(scope)).toBe('session-a:demo-group');
    expect(chatScopeKey({ ...scope, sessionId: 'session-b' })).toBe('session-b:demo-group');
    expect(chatScopeKey(null)).toBeNull();
  });

  it('counts an off-tab message from another member', () => {
    const first = recordChatUnreadEvent(INITIAL_CHAT_UNREAD, incoming(7), {
      scope,
      chatActive: false,
    });
    expect(first.applied).toBe('counted');
    expect(first.snapshot).toEqual({ unreadCount: 1, lastEventId: 7 });

    const second = recordChatUnreadEvent(first.snapshot, incoming(8), {
      scope,
      chatActive: false,
    });
    expect(second.snapshot).toEqual({ unreadCount: 2, lastEventId: 8 });
  });

  it('does not double count a replayed event after a reconnect', () => {
    const counted = recordChatUnreadEvent(INITIAL_CHAT_UNREAD, incoming(7), {
      scope,
      chatActive: false,
    }).snapshot;
    // A reconnect replays the same persisted id before delivering anything new.
    const replay = recordChatUnreadEvent(counted, incoming(7), { scope, chatActive: false });
    expect(replay.applied).toBe('ignored_duplicate');
    expect(replay.snapshot).toBe(counted);

    // Ids below the watermark are equally stale.
    const older = recordChatUnreadEvent(counted, incoming(3), { scope, chatActive: false });
    expect(older.applied).toBe('ignored_duplicate');
    expect(older.snapshot).toBe(counted);
  });

  it("does not count the acting member's own message but still advances the watermark", () => {
    const own = recordChatUnreadEvent(INITIAL_CHAT_UNREAD, incoming(4, 'demo-1'), {
      scope,
      chatActive: false,
    });
    expect(own.applied).toBe('ignored_own');
    expect(own.snapshot).toEqual({ unreadCount: 0, lastEventId: 4 });

    // The advanced watermark stops this event counting if it is replayed.
    const replay = recordChatUnreadEvent(own.snapshot, incoming(4, 'demo-1'), {
      scope,
      chatActive: false,
    });
    expect(replay.applied).toBe('ignored_duplicate');
  });

  it('ignores events for another group and malformed ids', () => {
    const foreign = recordChatUnreadEvent(
      INITIAL_CHAT_UNREAD,
      { eventId: 9, groupId: 'other-group', memberId: 'demo-2' },
      { scope, chatActive: false },
    );
    expect(foreign.applied).toBe('ignored_foreign');
    expect(foreign.snapshot).toBe(INITIAL_CHAT_UNREAD);

    const zero = recordChatUnreadEvent(INITIAL_CHAT_UNREAD, incoming(0), {
      scope,
      chatActive: false,
    });
    expect(zero.applied).toBe('ignored_invalid');

    const fractional: ChatUnreadSnapshot = INITIAL_CHAT_UNREAD;
    const bad = recordChatUnreadEvent(
      fractional,
      { eventId: 1.5, groupId: 'demo-group', memberId: 'demo-2' },
      { scope, chatActive: false },
    );
    expect(bad.applied).toBe('ignored_invalid');
    expect(bad.snapshot).toBe(fractional);
  });

  it('treats an event as read, not unread, while the chat is visible', () => {
    const visible = recordChatUnreadEvent(INITIAL_CHAT_UNREAD, incoming(5), {
      scope,
      chatActive: true,
    });
    expect(visible.applied).toBe('read');
    expect(visible.snapshot).toEqual({ unreadCount: 0, lastEventId: 5 });

    const accumulated = recordChatUnreadEvent(INITIAL_CHAT_UNREAD, incoming(5), {
      scope,
      chatActive: false,
    }).snapshot;
    const readWhileVisible = recordChatUnreadEvent(accumulated, incoming(6), {
      scope,
      chatActive: true,
    });
    expect(readWhileVisible.snapshot).toEqual({ unreadCount: 0, lastEventId: 6 });
  });

  it('clears the count when the group is opened but keeps the watermark', () => {
    const counted = recordChatUnreadEvent(INITIAL_CHAT_UNREAD, incoming(11), {
      scope,
      chatActive: false,
    }).snapshot;
    const read = markChatScopeRead(counted);
    expect(read).toEqual({ unreadCount: 0, lastEventId: 11 });

    // Opening the chat must not resurrect a replay of the already-seen event.
    const replay = recordChatUnreadEvent(read, incoming(11), { scope, chatActive: false });
    expect(replay.applied).toBe('ignored_duplicate');

    // An already-read snapshot is returned unchanged.
    expect(markChatScopeRead(read)).toBe(read);
    expect(markChatScopeRead(INITIAL_CHAT_UNREAD)).toBe(INITIAL_CHAT_UNREAD);
  });

  it('projects a raw payload onto metadata only, never retaining the body', () => {
    const projected = projectChatUnreadEvent({
      eventId: 12,
      type: 'message',
      occurredAt: '2026-09-13T10:00:00.000Z',
      message: {
        id: 'message-12',
        groupId: 'demo-group',
        memberId: 'demo-2',
        body: 'Sensitive locked text',
        createdAt: '2026-09-13T10:00:00.000Z',
      },
    });
    expect(projected).toEqual({ eventId: 12, groupId: 'demo-group', memberId: 'demo-2' });
    expect(JSON.stringify(projected)).not.toContain('Sensitive locked text');
    expect(Object.keys(projected ?? {})).toEqual(['eventId', 'groupId', 'memberId']);
  });

  it('rejects payloads without the identity or event fields it needs', () => {
    expect(projectChatUnreadEvent(null)).toBeNull();
    expect(projectChatUnreadEvent('not-an-event')).toBeNull();
    expect(projectChatUnreadEvent({ eventId: 1 })).toBeNull();
    expect(projectChatUnreadEvent({ eventId: 1, message: { groupId: 'demo-group' } })).toBeNull();
    expect(projectChatUnreadEvent({ eventId: 1, message: { memberId: 'demo-2' } })).toBeNull();
  });

  it('counts a projected event end to end without message text', () => {
    const projected = projectChatUnreadEvent({
      eventId: 21,
      message: { groupId: 'demo-group', memberId: 'demo-2', body: 'Secret' },
    });
    expect(projected).not.toBeNull();
    const result = recordChatUnreadEvent(INITIAL_CHAT_UNREAD, projected!, {
      scope,
      chatActive: false,
    });
    expect(result.applied).toBe('counted');
    expect(result.snapshot).toEqual({ unreadCount: 1, lastEventId: 21 });
    expect(JSON.stringify(result.snapshot)).not.toContain('Secret');
  });
});
