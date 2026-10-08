-- Tombstones retain private scope, immutable playback/compute bindings and
-- audit/history foreign keys. Removing configuration never removes media bytes.
ALTER TABLE private_libraries ADD COLUMN deleted_at timestamptz;
ALTER TABLE private_libraries ADD CONSTRAINT shared_library_not_deleted CHECK(visibility<>'instance_shared' OR deleted_at IS NULL);
ALTER TABLE sources ADD COLUMN deleted_at timestamptz;
CREATE INDEX private_libraries_live_owner ON private_libraries(owner_id) WHERE deleted_at IS NULL;
CREATE INDEX sources_live_library ON sources(library_id) WHERE deleted_at IS NULL;

ALTER FUNCTION library_allowed(uuid,uuid,text) RENAME TO library_allowed_before_library_deletion;
CREATE FUNCTION library_allowed(principal uuid,library uuid,action text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM private_libraries WHERE id=$2 AND deleted_at IS NULL)
 AND library_allowed_before_library_deletion($1,$2,$3)
$$;
ALTER FUNCTION library_media_allowed(uuid,uuid,text,uuid) RENAME TO library_media_allowed_before_source_deletion;
CREATE FUNCTION library_media_allowed(principal uuid,media uuid,action text,room uuid DEFAULT NULL) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$2 AND s.deleted_at IS NOT NULL)
 AND library_media_allowed_before_source_deletion($1,$2,$3,$4)
$$;

CREATE FUNCTION preserve_library_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'library_deleted' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER library_tombstone_immutable BEFORE UPDATE ON private_libraries FOR EACH ROW EXECUTE FUNCTION preserve_library_tombstone();

CREATE FUNCTION preserve_source_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'source_deleted' USING ERRCODE='42501';
 END IF;
 IF NEW.deleted_at IS NULL AND EXISTS(SELECT 1 FROM private_libraries WHERE id=NEW.library_id AND deleted_at IS NOT NULL) THEN
  RAISE EXCEPTION 'library_deleted' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_tombstone_immutable BEFORE INSERT OR UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION preserve_source_tombstone();

-- A scan started before removal cannot make retained historical rows visible.
CREATE FUNCTION reject_deleted_source_media() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.available AND EXISTS(SELECT 1 FROM sources s JOIN private_libraries l ON l.id=s.library_id WHERE s.id=NEW.source_id AND (s.deleted_at IS NOT NULL OR l.deleted_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'source_deleted' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER deleted_source_media BEFORE INSERT OR UPDATE OF source_id,available ON media_items FOR EACH ROW EXECUTE FUNCTION reject_deleted_source_media();
