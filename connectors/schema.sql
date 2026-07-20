CREATE TABLE IF NOT EXISTS connector_oauth_attempts (
  state_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_generation INTEGER NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS connector_oauth_attempt_expiry
  ON connector_oauth_attempts(expires_at_ms);

CREATE TABLE IF NOT EXISTS connector_connections (
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('spotify', 'apple_music')),
  envelope_json TEXT NOT NULL,
  storefront TEXT NOT NULL CHECK(storefront = 'US'),
  generation INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(account_id, connection_id, provider)
);

CREATE TABLE IF NOT EXISTS connector_connection_fences (
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('spotify', 'apple_music')),
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(account_id, connection_id, provider)
);

CREATE TABLE IF NOT EXISTS connector_publish_jobs (
  operation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('spotify', 'apple_music')),
  connection_generation INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  destination_playlist_id TEXT,
  reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
  reconciliation_not_before_ms INTEGER,
  last_observed_ids_json TEXT,
  state_json TEXT NOT NULL,
  mutation_token TEXT,
  mutation_stage TEXT CHECK(mutation_stage IN ('create_playlist', 'append_items')),
  mutation_acquired_at_ms INTEGER,
  mutation_expires_at_ms INTEGER,
  mutation_marker TEXT,
  recovery_code TEXT CHECK(recovery_code IN ('PLAYLIST_CREATION_OUTCOME_UNKNOWN')),
  recovery_marker TEXT,
  recovery_detected_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS connector_publish_previews (
  preview_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS connector_publish_preview_expiry
  ON connector_publish_previews(expires_at_ms);

CREATE INDEX IF NOT EXISTS connector_publish_destination
  ON connector_publish_jobs(account_id, connection_id, provider, cancelled);
