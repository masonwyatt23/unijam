-- Upgrade databases created by the pre-pilot connector schema. Fresh installs use
-- the equivalent definitions in 0001_connector.sql.
CREATE TABLE IF NOT EXISTS connector_connection_fences (
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('spotify', 'apple_music')),
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(account_id, connection_id, provider)
);

-- These ALTERs are intentionally kept in a separate migration so both fresh
-- databases (0001 then 0002) and databases with the original 0001 can upgrade.
ALTER TABLE connector_connections ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE connector_oauth_attempts ADD COLUMN connection_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE connector_publish_jobs ADD COLUMN connection_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE connector_publish_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connector_publish_jobs ADD COLUMN mutation_token TEXT;
ALTER TABLE connector_publish_jobs ADD COLUMN mutation_stage TEXT;
ALTER TABLE connector_publish_jobs ADD COLUMN mutation_acquired_at_ms INTEGER;
ALTER TABLE connector_publish_jobs ADD COLUMN mutation_expires_at_ms INTEGER;
ALTER TABLE connector_publish_jobs ADD COLUMN mutation_marker TEXT;
ALTER TABLE connector_publish_jobs ADD COLUMN recovery_code TEXT;
ALTER TABLE connector_publish_jobs ADD COLUMN recovery_marker TEXT;
ALTER TABLE connector_publish_jobs ADD COLUMN recovery_detected_at_ms INTEGER;

INSERT INTO connector_connection_fences
  (account_id, connection_id, provider, generation, status, updated_at_ms)
SELECT account_id, connection_id, provider, generation, 'active', updated_at_ms
FROM connector_connections
WHERE 1
ON CONFLICT(account_id, connection_id, provider) DO NOTHING;
