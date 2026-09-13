-- Replies are intentionally one level deep. The application validates the
-- parent before insert so a message can never become a reply to a reply.
ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_reply_to_idx
  ON messages (reply_to_message_id);
