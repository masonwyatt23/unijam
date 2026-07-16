ALTER TABLE connector_publish_jobs ADD COLUMN recovery_resolved_marker TEXT;
ALTER TABLE connector_publish_jobs ADD COLUMN recovery_playlist_hash TEXT;
ALTER TABLE connector_publish_jobs ADD COLUMN recovery_resolved_by TEXT;
ALTER TABLE connector_publish_jobs ADD COLUMN recovery_resolved_at_ms INTEGER;
ALTER TABLE connector_publish_jobs ADD COLUMN destination_url TEXT;
