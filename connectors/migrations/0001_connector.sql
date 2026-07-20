CREATE TABLE IF NOT EXISTS connector_oauth_attempts (
  state_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
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
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(account_id, connection_id, provider)
);

CREATE TABLE IF NOT EXISTS connector_publish_jobs (
  operation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('spotify', 'apple_music')),
  destination_playlist_id TEXT,
  reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
  reconciliation_not_before_ms INTEGER,
  last_observed_ids_json TEXT,
  state_json TEXT NOT NULL,
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
