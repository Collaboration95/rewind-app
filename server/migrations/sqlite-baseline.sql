-- SQLite schema baseline: the schema migrations 1-31 produced, squashed on
-- 21 Oct 2026. A fresh database runs this file once and records versions
-- 1-31; a database already at version 31 is left untouched. Older databases
-- must first be upgraded by a release from before the squash (git tag
-- pre-migration-squash). Generated from sqlite_master; keep statements as-is
-- so the schema text matches databases built by the old chain.
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  current_cycle_id TEXT
);

CREATE TABLE memberships (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (group_id, member_id)
);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  invitee_member_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
, code TEXT, expires_at TEXT, used_at TEXT);

CREATE TABLE cycles (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL,
  lock_state TEXT NOT NULL,
  max_count INTEGER NOT NULL,
  max_seconds INTEGER NOT NULL,
  count_used INTEGER NOT NULL DEFAULT 0,
  seconds_used INTEGER NOT NULL DEFAULT 0
, release_status TEXT NOT NULL DEFAULT 'unpublished' CHECK (release_status IN ('unpublished', 'published')), release_published_at TEXT, previous_cycle_id TEXT REFERENCES cycles(id) ON DELETE SET NULL);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
, access_kind TEXT NOT NULL DEFAULT 'demo' CHECK (access_kind = 'demo'), expires_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z', invalidated_at TEXT);

CREATE TABLE contributions (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  media_job_id TEXT,
  duration_seconds INTEGER NOT NULL,
  created_at TEXT NOT NULL
, quota_window_start_at TEXT, deleted_at TEXT, replaced_by_contribution_id TEXT REFERENCES contributions(id) ON DELETE SET NULL, removed_at TEXT, removed_by_account_id TEXT
  REFERENCES real_accounts(id) ON DELETE SET NULL);

CREATE TABLE media_jobs (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  contribution_id TEXT REFERENCES contributions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('clip', 'film', 'download')),
  status TEXT NOT NULL,
  output_path TEXT,
  created_at TEXT NOT NULL
, idempotency_key TEXT, source_path TEXT, trim_start_seconds REAL, trim_end_seconds REAL, mode TEXT, error_code TEXT, processing_started_at TEXT, source_uri TEXT, source_generation INTEGER, cycle_id TEXT REFERENCES cycles(id) ON DELETE CASCADE, progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100), input_count INTEGER NOT NULL DEFAULT 0 CHECK (input_count >= 0), completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0), claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0), deleted_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0), updated_at TEXT, failed_at TEXT, output_sha256 TEXT, output_bytes INTEGER CHECK (output_bytes IS NULL OR output_bytes > 0), output_verified_at TEXT, media_type TEXT NOT NULL DEFAULT 'video'
       CHECK (media_type IN ('video', 'photo')));

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
, reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL);

CREATE TABLE reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (message_id, member_id, emoji)
);

CREATE TABLE cycle_control_events (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  actor_member_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  advance_seconds INTEGER NOT NULL CHECK (advance_seconds > 0),
  previous_starts_at TEXT NOT NULL,
  previous_ends_at TEXT NOT NULL,
  next_starts_at TEXT NOT NULL,
  next_ends_at TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE TABLE media_metadata (
      source_uri TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length > 0),
      duration_seconds REAL NOT NULL CHECK (duration_seconds > 0 AND duration_seconds <= 15),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      has_audio INTEGER NOT NULL CHECK (has_audio = 1),
      verified_at TEXT NOT NULL
    , media_type TEXT NOT NULL DEFAULT 'video'
       CHECK (media_type IN ('video', 'photo')));

CREATE TABLE staged_sources (
      source_id TEXT PRIMARY KEY,
      source_uri TEXT NOT NULL UNIQUE,
      idempotency_key_hash TEXT NOT NULL UNIQUE,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      source_path TEXT,
      byte_length INTEGER CHECK (byte_length IS NULL OR byte_length > 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'staged')),
      created_at TEXT NOT NULL,
      claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
      claim_expires_at TEXT
    );

CREATE TABLE contribution_quota_windows (
      id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      window_start_at TEXT NOT NULL,
      window_end_at TEXT NOT NULL,
      max_count INTEGER NOT NULL CHECK (max_count > 0 AND max_count <= 5),
      max_seconds INTEGER NOT NULL CHECK (max_seconds > 0 AND max_seconds <= 30),
      count_used INTEGER NOT NULL DEFAULT 0 CHECK (count_used >= 0),
      seconds_used INTEGER NOT NULL DEFAULT 0 CHECK (seconds_used >= 0), deletions_used INTEGER NOT NULL DEFAULT 0 CHECK (deletions_used >= 0 AND deletions_used <= 1),
      UNIQUE (cycle_id, member_id, window_start_at)
    );

CREATE TABLE cycle_lifecycle_events (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        transition TEXT NOT NULL CHECK (
          transition IN ('collecting_to_revealing', 'revealing_to_archived', 'next_cycle_created')
        ),
        occurred_at TEXT NOT NULL,
        UNIQUE (cycle_id, transition)
      );

CREATE TABLE compilation_job_inputs (
       job_id TEXT NOT NULL REFERENCES media_jobs(id) ON DELETE CASCADE,
       clip_job_id TEXT NOT NULL REFERENCES media_jobs(id) ON DELETE CASCADE,
       contribution_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
       position INTEGER NOT NULL CHECK (position >= 0),
       PRIMARY KEY (job_id, clip_job_id),
       UNIQUE (job_id, contribution_id)
     );

CREATE TABLE realtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type = 'message'),
  occurred_at TEXT NOT NULL
);

CREATE TABLE audit_events (
       id TEXT PRIMARY KEY,
       event_type TEXT NOT NULL CHECK (
         event_type IN (
           'session.created',
           'session.validated',
           'session.rejected',
           'session.expired',
           'session.invalidated',
           'job.started',
           'job.completed',
           'job.failed',
           'media.integrity_failed',
           'media.consistency_quarantined',
           'media.consistency_repaired',
           'media.consistency_repair_failed'
         )
       ),
       actor_member_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
       resource_id TEXT,
       occurred_at TEXT NOT NULL,
       result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'denied'))
     );

CREATE TABLE real_accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  normalized_username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_scrypt_n INTEGER NOT NULL,
  password_scrypt_r INTEGER NOT NULL,
  password_scrypt_p INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, cognito_sub TEXT);

CREATE TABLE real_account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE auth_login_throttles (
  scope TEXT NOT NULL CHECK (scope IN ('account', 'source')),
  subject_hash TEXT NOT NULL,
  failures INTEGER NOT NULL CHECK (failures >= 0),
  window_started_at TEXT NOT NULL,
  cooldown_until TEXT,
  cooldown_level INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_level >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, subject_hash)
);

CREATE TABLE real_profiles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES real_accounts(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (account_id, id)
);

CREATE TABLE real_group_metadata (
  group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL REFERENCES real_accounts(id),
  max_members INTEGER NOT NULL CHECK (max_members BETWEEN 2 AND 10),
  cycle_duration_ms INTEGER NOT NULL CHECK (cycle_duration_ms = 2419200000),
  created_at TEXT NOT NULL
, time_zone TEXT NOT NULL DEFAULT 'UTC');

CREATE TABLE real_group_memberships (
  group_id TEXT NOT NULL REFERENCES real_group_metadata(group_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (group_id, account_id),
  FOREIGN KEY (account_id, profile_id)
    REFERENCES real_profiles(account_id, id) ON DELETE CASCADE
);

CREATE TABLE real_account_group_selections (
  account_id TEXT PRIMARY KEY REFERENCES real_accounts(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  FOREIGN KEY (group_id, account_id)
    REFERENCES real_group_memberships(group_id, account_id) ON DELETE CASCADE
);

CREATE TABLE real_group_invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES real_group_metadata(group_id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'accepted', 'expired')), accepted_by_account_id TEXT REFERENCES real_accounts(id), accepted_at TEXT,
  CHECK (expires_at > created_at)
);

CREATE TABLE "profiles" (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        avatar_label TEXT NOT NULL,
        is_synthetic INTEGER NOT NULL DEFAULT 1 CHECK (is_synthetic IN (0, 1))
      );

CREATE TABLE real_invite_guess_throttles (
  scope TEXT NOT NULL CHECK (scope IN ('account', 'source')),
  subject_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  window_started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, subject_hash)
);

CREATE TABLE real_group_reminder_preferences (
  group_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  snoozed_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_id, account_id),
  FOREIGN KEY (group_id, account_id)
    REFERENCES real_group_memberships(group_id, account_id) ON DELETE CASCADE
);

CREATE TABLE upload_intents (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES real_group_metadata(group_id),
  account_id TEXT NOT NULL REFERENCES real_accounts(id),
  profile_id TEXT NOT NULL REFERENCES real_profiles(id),
  cycle_id TEXT NOT NULL REFERENCES cycles(id),
  quota_window_start_at TEXT NOT NULL,
  idempotency_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  reserved_seconds REAL NOT NULL CHECK (reserved_seconds > 0 AND reserved_seconds <= 15),
  state TEXT NOT NULL CHECK (state IN ('open','pinned','completed','expired')),
  pinned_ref TEXT,
  contribution_id TEXT UNIQUE REFERENCES contributions(id),
  job_id TEXT UNIQUE REFERENCES media_jobs(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cleanup_cursor TEXT,
  cleanup_complete INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_complete IN (0,1)),
  UNIQUE (environment, group_id, profile_id, idempotency_hash),
  CHECK ((state = 'open' AND pinned_ref IS NULL)
      OR state = 'expired'
      OR (state IN ('pinned','completed') AND pinned_ref IS NOT NULL)),
  CHECK ((state = 'completed' AND contribution_id IS NOT NULL AND job_id IS NOT NULL)
      OR (state <> 'completed' AND contribution_id IS NULL AND job_id IS NULL))
);

CREATE TABLE reminder_destinations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL REFERENCES real_account_sessions(token_hash) ON DELETE CASCADE,
  device_key TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('expo','webpush')),
  destination_hash TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id,device_key),
  UNIQUE(provider,destination_hash)
);

CREATE TABLE reminder_outbox (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  local_sunday TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  destination_id TEXT REFERENCES reminder_destinations(id) ON DELETE SET NULL,
  destination_generation INTEGER NOT NULL CHECK(destination_generation > 0),
  state TEXT NOT NULL CHECK(state IN ('pending','sending','retry','awaiting_receipt','accepted','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  receipt_attempts INTEGER NOT NULL DEFAULT 0 CHECK(receipt_attempts BETWEEN 0 AND 3),
  provider_receipt TEXT,
  response_category TEXT,
  next_attempt_at TEXT NOT NULL,
  lease_id TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(group_id,account_id,local_sunday),
  FOREIGN KEY(group_id,account_id) REFERENCES real_group_memberships(group_id,account_id) ON DELETE CASCADE,
  CHECK((lease_id IS NULL) = (lease_expires_at IS NULL))
);

CREATE TABLE account_blocks (
  blocker_account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  blocked_account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_account_id, blocked_account_id),
  CHECK (blocker_account_id <> blocked_account_id)
);

CREATE TABLE film_segments (
  film_job_id TEXT NOT NULL REFERENCES media_jobs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  contribution_id TEXT REFERENCES contributions(id) ON DELETE SET NULL,
  start_seconds REAL NOT NULL,
  duration_seconds REAL NOT NULL,
  PRIMARY KEY (film_job_id, position)
);

CREATE TABLE "member_reports" (
  id TEXT PRIMARY KEY,
  reporter_account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  reported_account_id TEXT REFERENCES real_accounts(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  created_at TEXT NOT NULL,
  CHECK (reporter_account_id <> reported_account_id),
  UNIQUE (reporter_account_id, group_id, reported_account_id)
);

CREATE TABLE "content_reports" (
  id TEXT PRIMARY KEY,
  reporter_account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  contribution_id TEXT REFERENCES contributions(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  created_at TEXT NOT NULL,
  -- After target deletion both may be null; both may never be non-null.
  CHECK (message_id IS NULL OR contribution_id IS NULL),
  UNIQUE (reporter_account_id, message_id),
  UNIQUE (reporter_account_id, contribution_id)
);

CREATE INDEX cycle_control_events_cycle_idx
  ON cycle_control_events (cycle_id, occurred_at DESC, id DESC);

CREATE UNIQUE INDEX invites_code_idx
  ON invites (code)
  WHERE code IS NOT NULL;

CREATE UNIQUE INDEX media_jobs_idempotency_idx
  ON media_jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX staged_sources_owner_idx
       ON staged_sources (group_id, member_id, created_at DESC);

CREATE INDEX contribution_quota_windows_member_idx
       ON contribution_quota_windows (cycle_id, member_id, window_start_at);

CREATE INDEX media_jobs_source_binding_idx
         ON media_jobs (source_uri, source_generation, source_path);

CREATE UNIQUE INDEX cycles_previous_cycle_idx ON cycles (previous_cycle_id) WHERE previous_cycle_id IS NOT NULL;

CREATE INDEX cycle_lifecycle_events_group_idx ON cycle_lifecycle_events (group_id, occurred_at, id);

CREATE UNIQUE INDEX cycle_lifecycle_events_receipt_idx ON cycle_lifecycle_events (cycle_id, transition);

CREATE INDEX "media_jobs_cycle_idx"
           ON "media_jobs" (cycle_id, kind, created_at);

CREATE UNIQUE INDEX "media_jobs_one_film_per_cycle_idx"
           ON "media_jobs" (cycle_id) WHERE kind = 'film' AND cycle_id IS NOT NULL;

CREATE INDEX "compilation_job_inputs_order_idx"
           ON "compilation_job_inputs" (job_id, position);

CREATE INDEX contributions_active_cycle_idx ON contributions (cycle_id, member_id, deleted_at, created_at);

CREATE INDEX realtime_events_group_idx
  ON realtime_events (group_id, id);

CREATE INDEX messages_reply_to_idx ON messages (reply_to_message_id);

CREATE INDEX "media_jobs_queue_group_idx" ON media_jobs (group_id, created_at, id);

CREATE INDEX "media_jobs_queue_group_kind_idx" ON media_jobs (group_id, kind, created_at, id);

CREATE INDEX "media_jobs_queue_group_status_idx" ON media_jobs (group_id, status, created_at, id);

CREATE INDEX "media_jobs_queue_group_kind_status_idx" ON media_jobs (group_id, kind, status, created_at, id);

CREATE INDEX audit_events_occurred_at_idx ON audit_events (occurred_at DESC, id DESC);

CREATE INDEX audit_events_resource_id_idx ON audit_events (resource_id);

CREATE INDEX contributions_ledger_member_idx ON contributions (cycle_id, member_id, created_at, id);

CREATE INDEX real_account_sessions_account_idx
  ON real_account_sessions (account_id, revoked_at);

CREATE INDEX real_group_memberships_account_idx
  ON real_group_memberships (account_id, accepted_at);

CREATE INDEX real_group_invites_group_created_idx
  ON real_group_invites (group_id, created_at);

CREATE INDEX real_group_invites_status_expiry_idx
  ON real_group_invites (status, expires_at);

CREATE INDEX real_invite_guess_throttles_window_idx
  ON real_invite_guess_throttles (window_started_at);

CREATE INDEX upload_intents_expiry_idx ON upload_intents(environment, cleanup_complete, expires_at, id);

CREATE INDEX upload_intents_quota_idx ON upload_intents(cycle_id, profile_id, quota_window_start_at, state, expires_at);

CREATE INDEX reminder_outbox_due_idx ON reminder_outbox(state,next_attempt_at,id);

CREATE INDEX reminder_destinations_account_idx ON reminder_destinations(account_id,enabled,updated_at);

CREATE INDEX member_reports_created_idx ON member_reports (created_at);

CREATE INDEX member_reports_reported_account_idx ON member_reports (reported_account_id);

CREATE INDEX member_reports_group_idx ON member_reports (group_id);

CREATE INDEX content_reports_created_idx ON content_reports (created_at);

CREATE INDEX content_reports_message_idx ON content_reports (message_id);

CREATE INDEX content_reports_contribution_idx ON content_reports (contribution_id);

CREATE INDEX content_reports_group_idx ON content_reports (group_id);

CREATE INDEX account_blocks_blocked_account_idx ON account_blocks (blocked_account_id);

CREATE INDEX film_segments_contribution_idx ON film_segments (contribution_id);

CREATE INDEX contributions_removed_by_account_idx ON contributions (removed_by_account_id);

CREATE UNIQUE INDEX real_accounts_cognito_sub_idx
  ON real_accounts (cognito_sub) WHERE cognito_sub IS NOT NULL;

CREATE TRIGGER real_profile_media_actor_insert
AFTER INSERT ON real_profiles
BEGIN
  INSERT OR IGNORE INTO profiles (id, display_name, avatar_label, is_synthetic)
  VALUES (NEW.id, NEW.display_name, 'REAL ACCOUNT', 0);
END;

CREATE TRIGGER real_profile_media_actor_update
AFTER UPDATE OF display_name ON real_profiles
BEGIN
  UPDATE profiles SET display_name = NEW.display_name
  WHERE id = NEW.id AND is_synthetic = 0;
END;

CREATE TRIGGER real_profile_media_actor_delete
AFTER DELETE ON real_profiles
BEGIN
  DELETE FROM profiles WHERE id = OLD.id AND is_synthetic = 0;
END;
