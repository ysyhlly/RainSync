-- Unknown on upgrade/restart: no historical positive account authorization.
CREATE TABLE source_account_policies (
    source_id uuid PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    source_revision bigint NOT NULL CHECK (source_revision >= 0),
    generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
    state text NOT NULL DEFAULT 'unknown' CHECK (state IN ('unknown','allowed','denied','unavailable')),
    reason text NOT NULL DEFAULT 'upstream_policy_unknown',
    observer_epoch uuid,
    observation_seq bigint NOT NULL DEFAULT 0 CHECK (observation_seq >= 0),
    valid_until timestamptz,
    observed_at timestamptz,
    claim uuid,
    demand_until timestamptz NOT NULL DEFAULT '-infinity',
    next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((state = 'allowed') = (valid_until IS NOT NULL))
);
INSERT INTO source_account_policies(source_id,source_revision)
    SELECT id,access_policy_revision FROM sources WHERE kind IN ('jellyfin','emby');
ALTER TABLE upstream_reservations ADD COLUMN account_policy_generation bigint;

CREATE FUNCTION reset_source_account_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind IN ('jellyfin','emby') THEN
        INSERT INTO source_account_policies(source_id,source_revision)
            VALUES(NEW.id,NEW.access_policy_revision)
            ON CONFLICT(source_id) DO UPDATE SET
                source_revision=EXCLUDED.source_revision,
                generation=source_account_policies.generation+1,
                state='unknown',reason='upstream_policy_unknown',valid_until=NULL,
                observer_epoch=NULL,claim=NULL,next_check_at=clock_timestamp()
            WHERE source_account_policies.source_revision<>EXCLUDED.source_revision;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER source_account_policy_reset AFTER INSERT OR UPDATE ON sources
    FOR EACH ROW EXECUTE FUNCTION reset_source_account_policy();

-- Existing source/configuration is mandatory, even for legacy non-upstream media.
-- Deadlines use the same database time authority as the other durable grants.
CREATE FUNCTION source_account_policy_allowed(source uuid, revision bigint, epoch bigint)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM sources s WHERE s.id=$1
        AND s.access_policy_revision=$2 AND
        (s.kind NOT IN ('jellyfin','emby') OR EXISTS(
            SELECT 1 FROM source_account_policies a WHERE a.source_id=s.id
            AND a.source_revision=$2 AND a.generation=$3
            AND a.state='allowed' AND a.valid_until>clock_timestamp())))
$$;

CREATE FUNCTION playback_source_allowed(media uuid, resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM media_items m WHERE m.id=$1 AND
        source_account_policy_allowed(m.source_id,
            COALESCE(($2->>'source_policy_revision')::bigint,0),
            ($2->>'account_policy_generation')::bigint))
$$;
