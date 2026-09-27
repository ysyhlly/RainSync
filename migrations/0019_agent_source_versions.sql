-- NULL preserves old indexes but is not sufficient for a version-bound grant.
-- A capable Agent fills this field on its next complete index snapshot.
ALTER TABLE media_items ADD COLUMN source_version text;
