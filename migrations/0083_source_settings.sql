-- Display-only edits need concurrency checks without revoking playback.
ALTER TABLE sources ADD COLUMN settings_revision bigint NOT NULL DEFAULT 1 CHECK(settings_revision>0);
CREATE FUNCTION advance_source_settings_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.name,NEW.kind,NEW.library_id,NEW.config_encrypted) IS DISTINCT FROM ROW(OLD.name,OLD.kind,OLD.library_id,OLD.config_encrypted) THEN
  IF OLD.settings_revision=9223372036854775807 THEN RAISE EXCEPTION 'source settings revision exhausted'; END IF;
  NEW.settings_revision=OLD.settings_revision+1;
 ELSE NEW.settings_revision=OLD.settings_revision;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_settings_revision BEFORE UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION advance_source_settings_revision();
-- Provider I/O occurs outside transactions. Invalidate late scan publication.
CREATE FUNCTION fence_source_configuration_scan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.config_encrypted IS DISTINCT FROM OLD.config_encrypted OR NEW.kind IS DISTINCT FROM OLD.kind THEN
  UPDATE source_scans SET generation=gen_random_uuid() WHERE source_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_configuration_scan AFTER UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION fence_source_configuration_scan();
