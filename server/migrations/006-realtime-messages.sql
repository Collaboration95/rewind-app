-- Every delivered chat message is an append-only event. Keeping the event
-- identity separate from the message UUID gives SSE clients a monotonic
-- Last-Event-ID that can be replayed after a process restart.
CREATE TABLE IF NOT EXISTS realtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type = 'message'),
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS realtime_events_group_idx
  ON realtime_events (group_id, id);

-- Databases created before the realtime transport had message rows but no
-- event rows. Backfill those rows so the first subscription after an upgrade
-- can replay the complete persisted timeline.
INSERT INTO realtime_events (group_id, message_id, event_type, occurred_at)
SELECT m.group_id, m.id, 'message', m.created_at
FROM messages m
WHERE NOT EXISTS (
  SELECT 1 FROM realtime_events e WHERE e.message_id = m.id
);
