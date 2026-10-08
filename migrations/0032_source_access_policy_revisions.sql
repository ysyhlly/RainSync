-- Append-only legacy epoch 0: no historical policy or cleanup receipts invented.
ALTER TABLE sources ADD COLUMN access_policy_revision bigint NOT NULL DEFAULT 0 CHECK (access_policy_revision >= 0);
ALTER TABLE upstream_reservations ADD COLUMN source_policy_revision bigint NOT NULL DEFAULT 0 CHECK (source_policy_revision >= 0);

-- Current destination authority survives source removal for bounded cleanup.
-- No FK: deleting mutable configuration must never restore an older permission.
CREATE TABLE source_access_policy_snapshots (
    source_id uuid PRIMARY KEY,
    revision bigint NOT NULL CHECK (revision >= 0),
    config_encrypted text NOT NULL
);
INSERT INTO source_access_policy_snapshots(source_id,revision,config_encrypted)
    SELECT id,access_policy_revision,config_encrypted FROM sources;
CREATE FUNCTION fence_source_access_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.config_encrypted IS DISTINCT FROM OLD.config_encrypted OR NEW.kind IS DISTINCT FROM OLD.kind THEN
        IF OLD.access_policy_revision = 9223372036854775807 THEN
            RAISE EXCEPTION 'source policy revision exhausted';
        END IF;
        IF NEW.access_policy_revision = OLD.access_policy_revision THEN
            NEW.access_policy_revision := OLD.access_policy_revision + 1;
        ELSIF NEW.access_policy_revision <> OLD.access_policy_revision + 1 THEN
            RAISE EXCEPTION 'invalid source policy revision';
        END IF;
    ELSIF NEW.access_policy_revision <> OLD.access_policy_revision THEN
        RAISE EXCEPTION 'source policy revision without configuration change';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER source_access_revision BEFORE UPDATE ON sources
    FOR EACH ROW EXECUTE FUNCTION fence_source_access_revision();
CREATE FUNCTION retain_source_access_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO source_access_policy_snapshots(source_id,revision,config_encrypted)
        VALUES(NEW.id,NEW.access_policy_revision,NEW.config_encrypted)
        ON CONFLICT(source_id) DO UPDATE SET revision=EXCLUDED.revision,config_encrypted=EXCLUDED.config_encrypted
        WHERE source_access_policy_snapshots.revision < EXCLUDED.revision;
    RETURN NEW;
END $$;
CREATE TRIGGER source_access_policy_snapshot AFTER INSERT OR UPDATE ON sources
    FOR EACH ROW EXECUTE FUNCTION retain_source_access_policy();
