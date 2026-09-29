-- Media records share the durable processing pipeline while real account
-- membership and session authority remain in their dedicated tables. These
-- non-public profile keys satisfy media ownership foreign keys only.
INSERT INTO profiles (id, display_name, avatar_label, is_synthetic)
SELECT id, display_name, 'REAL ACCOUNT', 0 FROM real_profiles WHERE 1
ON CONFLICT(id) DO NOTHING;

CREATE TRIGGER IF NOT EXISTS real_profile_media_actor_insert
AFTER INSERT ON real_profiles
BEGIN
  INSERT OR IGNORE INTO profiles (id, display_name, avatar_label, is_synthetic)
  VALUES (NEW.id, NEW.display_name, 'REAL ACCOUNT', 0);
END;

CREATE TRIGGER IF NOT EXISTS real_profile_media_actor_update
AFTER UPDATE OF display_name ON real_profiles
BEGIN
  UPDATE profiles SET display_name = NEW.display_name
  WHERE id = NEW.id AND is_synthetic = 0;
END;

CREATE TRIGGER IF NOT EXISTS real_profile_media_actor_delete
AFTER DELETE ON real_profiles
BEGIN
  DELETE FROM profiles WHERE id = OLD.id AND is_synthetic = 0;
END;
