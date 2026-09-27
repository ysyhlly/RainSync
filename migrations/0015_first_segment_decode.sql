-- Existing version-2 snapshots prove integrity, not successful decoding.
-- New attempts are published only after the first fragment decode gate.
ALTER TABLE media_outputs ALTER COLUMN validation_version SET DEFAULT 3;
