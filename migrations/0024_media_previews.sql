ALTER TABLE media_items ADD COLUMN preview_generation bigint NOT NULL DEFAULT 1 CHECK (preview_generation > 0);
CREATE TABLE media_previews (
  media_id uuid PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  source_generation bigint NOT NULL CHECK (source_generation > 0),
  recipe_version integer NOT NULL DEFAULT 1 CHECK (recipe_version > 0),
  result_revision uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('queued','running','ready','unavailable')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  attempt_id uuid, owner_id uuid, lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  accessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  generated_at timestamptz,
  image bytea CHECK (image IS NULL OR octet_length(image) BETWEEN 1 AND 262144),
  image_sha256 text, error_code text,
  CHECK (status <> 'ready' OR (image IS NOT NULL AND image_sha256 ~ '^[0-9a-f]{64}$' AND generated_at IS NOT NULL)),
  CHECK (status <> 'running' OR (owner_id IS NOT NULL AND attempt_id IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX media_previews_claim ON media_previews(status,next_attempt_at,requested_at);

-- Source changes invalidate all published and in-flight work. Display aliases
-- are deliberately absent: renaming cannot cause another decode.
CREATE FUNCTION invalidate_media_preview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.resource IS DISTINCT FROM OLD.resource
    OR NEW.source_version IS DISTINCT FROM OLD.source_version OR NEW.metadata IS DISTINCT FROM OLD.metadata
    OR NEW.available IS DISTINCT FROM OLD.available THEN
    NEW.preview_generation := OLD.preview_generation + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_preview_source_change BEFORE UPDATE ON media_items FOR EACH ROW EXECUTE FUNCTION invalidate_media_preview();
CREATE FUNCTION invalidate_source_previews() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.config_encrypted IS DISTINCT FROM OLD.config_encrypted OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    UPDATE media_items SET preview_generation=preview_generation+1 WHERE source_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_preview_config_change AFTER UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION invalidate_source_previews();
