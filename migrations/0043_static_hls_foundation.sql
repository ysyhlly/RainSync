-- Stage A only: no public fallback DTO, marker, route or activation endpoint.
-- NULL restrictions preserve legacy grants exactly. This is a mixed-binary
-- compatibility contract, not protection from malicious superuser SQL.
CREATE FUNCTION static_hls_reader_supported() RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT COALESCE(current_setting('rainsync.static_hls_reader',true)='1',false)
$$;

CREATE TABLE static_hls_database_binding (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    probe_challenge uuid,
    probe_sha256 text CHECK(probe_sha256 ~ '^[0-9a-f]{64}$'),
    probe_until timestamptz,
    CHECK((probe_challenge IS NULL AND probe_sha256 IS NULL AND probe_until IS NULL)
        OR (probe_challenge IS NOT NULL AND probe_sha256 IS NOT NULL AND probe_until IS NOT NULL))
);
INSERT INTO static_hls_database_binding(singleton) VALUES(true);

CREATE TABLE static_hls_captures (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES playback_sessions(id),
    user_id uuid NOT NULL REFERENCES users(id),
    owner_id uuid NOT NULL,
    resource_authority jsonb NOT NULL CHECK(jsonb_typeof(resource_authority)='object' AND octet_length(resource_authority::text)<=262144),
    request_owner_epoch uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    state text NOT NULL DEFAULT 'capturing' CHECK(state IN ('capturing','verified','cancelled','disposed')),
    inventory_encrypted text CHECK(octet_length(inventory_encrypted) BETWEEN 1 AND 262144),
    streams_closed_at timestamptz,
    process_closed_at timestamptz,
    process_disposition text CHECK(process_disposition IN ('never_started','reaped')),
    files_removed_at timestamptz,
    disposed_at timestamptz,
    CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 minutes'),
    CHECK(state<>'verified' OR inventory_encrypted IS NOT NULL),
    CHECK((state='disposed')=(disposed_at IS NOT NULL)),
    CHECK((process_closed_at IS NULL)=(process_disposition IS NULL)),
    CHECK(disposed_at IS NULL OR (streams_closed_at IS NOT NULL AND process_closed_at IS NOT NULL AND files_removed_at IS NOT NULL))
);
CREATE UNIQUE INDEX static_hls_capture_user_owner ON static_hls_captures(user_id) WHERE disposed_at IS NULL;
CREATE INDEX static_hls_capture_session ON static_hls_captures(session_id);
ALTER TABLE playback_sessions ADD COLUMN static_hls_capture_id uuid REFERENCES static_hls_captures(id);
ALTER TABLE media_jobs ADD COLUMN logical_queue text CHECK(logical_queue IS NULL OR logical_queue='static_hls_v1');
ALTER TABLE cache_write_reservations ADD COLUMN purpose text NOT NULL DEFAULT 'media_job' CHECK(purpose IN ('media_job','static_hls_capture'));

-- Actual authority intentionally excludes the new reader compatibility check.
-- Old normalization must never interpret an unsupported reader as revocation.
CREATE FUNCTION playback_source_authority_allowed(media uuid, resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT playback_http_file_context_allowed($2->'http_file_context')
        AND playback_http_file_context_allowed($2->'auth_context')
        AND EXISTS(SELECT 1 FROM media_items m WHERE m.id=$1 AND
            source_account_policy_allowed(m.source_id,
                COALESCE(($2->>'source_policy_revision')::bigint,0),
                ($2->>'account_policy_generation')::bigint))
$$;
CREATE FUNCTION static_hls_parent_authority_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM playback_sessions p
        JOIN playback_requests request ON request.session_id=p.id
        JOIN rooms room ON room.id=p.room_id
        JOIN room_snapshots snapshot ON snapshot.room_id=p.room_id
        WHERE p.id=$1 AND NOT p.stopped AND p.expires_at>clock_timestamp()
        AND request.status='completed' AND p.auth_login_hash IS NOT NULL
        AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch)
        AND room.lifecycle='active' AND room.lifecycle_epoch=p.lifecycle_epoch
        AND (snapshot.state->>'media_id')::uuid=p.media_id
        AND (snapshot.state->>'media_generation')::bigint=p.generation
        AND playback_source_authority_allowed(p.media_id,p.resource)
        AND (p.viewer_id IS NULL OR EXISTS(SELECT 1 FROM playback_viewer_plans plan
            WHERE plan.user_id=p.user_id AND plan.room_id=p.room_id AND plan.viewer_id=p.viewer_id
            AND plan.auth_login_hash=p.auth_login_hash AND plan.plan_generation=p.plan_generation)))
$$;
CREATE FUNCTION static_hls_capture_authority_allowed(capture uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM static_hls_captures c
        JOIN playback_sessions p ON p.id=c.session_id
        JOIN playback_requests request ON request.session_id=p.id
        JOIN rooms room ON room.id=p.room_id
        JOIN room_snapshots snapshot ON snapshot.room_id=p.room_id
        WHERE c.id=$1 AND c.state IN ('capturing','verified') AND c.expires_at>clock_timestamp()
        AND NOT p.stopped AND p.expires_at>clock_timestamp() AND p.user_id=c.user_id
        AND p.resource-'static_hls_capture_id'=c.resource_authority
        AND request.owner_epoch=c.request_owner_epoch AND request.status='completed'
        AND p.auth_login_hash IS NOT NULL
        AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch)
        AND room.lifecycle='active' AND room.lifecycle_epoch=p.lifecycle_epoch
        AND (snapshot.state->>'media_id')::uuid=p.media_id
        AND (snapshot.state->>'media_generation')::bigint=p.generation
        AND playback_source_authority_allowed(p.media_id,c.resource_authority)
        AND (p.viewer_id IS NULL OR EXISTS(SELECT 1 FROM playback_viewer_plans plan
            WHERE plan.user_id=p.user_id AND plan.room_id=p.room_id AND plan.viewer_id=p.viewer_id
            AND plan.auth_login_hash=p.auth_login_hash AND plan.plan_generation=p.plan_generation)))
$$;
CREATE FUNCTION static_hls_session_authority_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=$1
        AND p.static_hls_capture_id IS NOT NULL
        AND p.resource->>'static_hls_capture_id'=p.static_hls_capture_id::text
        AND static_hls_capture_authority_allowed(p.static_hls_capture_id))
$$;
CREATE FUNCTION static_hls_session_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT static_hls_reader_supported() AND static_hls_session_authority_allowed($1)
$$;
CREATE OR REPLACE FUNCTION playback_source_allowed(media uuid, resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT playback_source_authority_allowed($1,$2)
        AND CASE WHEN NOT ($2 ? 'static_hls_capture_id') THEN true
            WHEN NOT static_hls_reader_supported() THEN false
            ELSE EXISTS(SELECT 1 FROM static_hls_captures c
                WHERE c.id::text=$2->>'static_hls_capture_id' AND c.state='verified'
                AND c.resource_authority=$2-'static_hls_capture_id'
                AND static_hls_capture_authority_allowed(c.id)) END
$$;

CREATE FUNCTION protect_static_hls_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p playback_sessions; r playback_requests;
BEGIN
    IF TG_OP='DELETE' THEN RETURN NULL; END IF;
    IF NOT static_hls_reader_supported() THEN RAISE EXCEPTION 'static_hls_reader_required'; END IF;
    IF TG_OP='INSERT' THEN
        -- Same budget lock as real writer reservations serializes admission;
        -- every unresolved owner remains counted, including expired captures.
        PERFORM revision FROM cache_budget WHERE singleton FOR UPDATE;
        IF (SELECT count(*) FROM static_hls_captures WHERE disposed_at IS NULL)>=2 THEN
            RAISE EXCEPTION 'static_hls_capture_capacity';
        END IF;
        SELECT * INTO p FROM playback_sessions WHERE id=NEW.session_id;
        SELECT * INTO r FROM playback_requests WHERE session_id=NEW.session_id;
        IF p.id IS NULL OR p.user_id IS DISTINCT FROM NEW.user_id OR p.auth_login_hash IS NULL
            OR p.static_hls_capture_id IS NOT NULL OR p.resource ? 'static_hls_capture_id'
            OR NEW.resource_authority IS DISTINCT FROM p.resource OR NEW.request_owner_epoch IS DISTINCT FROM r.owner_epoch
            OR r.status IS DISTINCT FROM 'completed' OR NOT static_hls_parent_authority_allowed(NEW.session_id) OR NEW.expires_at>p.expires_at
            OR NEW.state<>'capturing' OR NEW.inventory_encrypted IS NOT NULL
            OR NEW.streams_closed_at IS NOT NULL OR NEW.process_closed_at IS NOT NULL
            OR NEW.process_disposition IS NOT NULL OR NEW.files_removed_at IS NOT NULL OR NEW.disposed_at IS NOT NULL
            OR EXISTS(SELECT 1 FROM media_jobs WHERE id=NEW.id) THEN
            RAISE EXCEPTION 'static_hls_capture_authority_required';
        END IF;
    ELSE
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.session_id IS DISTINCT FROM OLD.session_id
            OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
            OR NEW.resource_authority IS DISTINCT FROM OLD.resource_authority
            OR NEW.request_owner_epoch IS DISTINCT FROM OLD.request_owner_epoch
            OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
            OR (OLD.inventory_encrypted IS NOT NULL AND NEW.inventory_encrypted IS DISTINCT FROM OLD.inventory_encrypted)
            OR (OLD.streams_closed_at IS NOT NULL AND NEW.streams_closed_at IS DISTINCT FROM OLD.streams_closed_at)
            OR (OLD.process_closed_at IS NOT NULL AND NEW.process_closed_at IS DISTINCT FROM OLD.process_closed_at)
            OR (OLD.process_disposition IS NOT NULL AND NEW.process_disposition IS DISTINCT FROM OLD.process_disposition)
            OR (OLD.files_removed_at IS NOT NULL AND NEW.files_removed_at IS DISTINCT FROM OLD.files_removed_at)
            OR (OLD.disposed_at IS NOT NULL AND NEW.disposed_at IS DISTINCT FROM OLD.disposed_at)
            OR (OLD.state='disposed' AND NEW.state<>'disposed')
            OR (OLD.state='cancelled' AND NEW.state NOT IN ('cancelled','disposed')) THEN
            RAISE EXCEPTION 'static_hls_capture_immutable';
        END IF;
        IF NEW.state='verified' AND (OLD.state NOT IN ('capturing','verified') OR NOT static_hls_capture_authority_allowed(OLD.id)) THEN
            RAISE EXCEPTION 'static_hls_capture_authority_required';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_capture_guard BEFORE INSERT OR UPDATE OR DELETE ON static_hls_captures
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_capture();

CREATE FUNCTION protect_static_hls_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked uuid; c static_hls_captures;
BEGIN
    marked=CASE WHEN TG_OP='INSERT' THEN NEW.static_hls_capture_id ELSE OLD.static_hls_capture_id END;
    IF TG_OP='DELETE' THEN
        IF marked IS NOT NULL THEN RETURN NULL; END IF;
        RETURN OLD;
    END IF;
    IF TG_OP='UPDATE' AND OLD.static_hls_capture_id IS NOT NULL THEN
        IF NOT static_hls_reader_supported() THEN
            -- Explicit revocation remains possible; no publication/renewal is.
            IF NEW.stopped AND NOT static_hls_session_authority_allowed(OLD.id)
                AND (to_jsonb(NEW)-'stopped')=(to_jsonb(OLD)-'stopped') THEN RETURN NEW; END IF;
            RETURN NULL;
        END IF;
        IF NEW.static_hls_capture_id IS DISTINCT FROM OLD.static_hls_capture_id
            OR NEW.resource-'static_hls_capture_id' IS DISTINCT FROM OLD.resource-'static_hls_capture_id' THEN
            RAISE EXCEPTION 'static_hls_session_immutable';
        END IF;
    END IF;
    IF NEW.static_hls_capture_id IS NULL THEN
        IF NEW.resource ? 'static_hls_capture_id' THEN RAISE EXCEPTION 'static_hls_capture_required'; END IF;
        RETURN NEW;
    END IF;
    IF NOT static_hls_reader_supported() THEN RAISE EXCEPTION 'static_hls_reader_required'; END IF;
    IF (TG_OP='INSERT' OR OLD.static_hls_capture_id IS NULL) AND EXISTS(SELECT 1 FROM media_jobs WHERE session_id=NEW.id) THEN
        RAISE EXCEPTION 'static_hls_existing_work_cannot_be_marked';
    END IF;
    SELECT * INTO c FROM static_hls_captures WHERE id=NEW.static_hls_capture_id;
    IF c.id IS NULL OR c.session_id<>NEW.id OR c.state<>'verified'
        OR NEW.resource->>'static_hls_capture_id' IS DISTINCT FROM c.id::text
        OR NEW.resource-'static_hls_capture_id' IS DISTINCT FROM c.resource_authority THEN
        RAISE EXCEPTION 'static_hls_capture_required';
    END IF;
    IF NEW.expires_at>c.expires_at THEN RAISE EXCEPTION 'static_hls_capture_expiry_immutable'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_session_guard BEFORE INSERT OR UPDATE OR DELETE ON playback_sessions
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_session();

CREATE FUNCTION protect_static_hls_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM static_hls_captures WHERE session_id=OLD.session_id AND disposed_at IS NULL) THEN
        IF TG_OP='DELETE' OR NOT static_hls_reader_supported() THEN RETURN NULL; END IF;
        IF NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.owner_epoch IS DISTINCT FROM OLD.owner_epoch
            OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.status IS DISTINCT FROM OLD.status
            OR NEW.response_encrypted IS DISTINCT FROM OLD.response_encrypted THEN
            RAISE EXCEPTION 'static_hls_request_immutable';
        END IF;
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_request_guard BEFORE UPDATE OR DELETE ON playback_requests
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_request();

CREATE FUNCTION protect_static_hls_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked uuid; queue text;
BEGIN
    IF TG_OP='INSERT' THEN
        SELECT static_hls_capture_id INTO marked FROM playback_sessions WHERE id=NEW.session_id;
        IF NEW.logical_queue IS NULL AND marked IS NULL THEN RETURN NEW; END IF;
        IF NEW.logical_queue IS NULL OR marked IS NULL OR NOT static_hls_session_allowed(NEW.session_id) THEN
            RAISE EXCEPTION 'static_hls_queue_contract_required';
        END IF;
        RETURN NEW;
    END IF;
    queue=OLD.logical_queue;
    IF queue IS NULL THEN
        IF TG_OP='UPDATE' AND NEW.logical_queue IS NOT NULL THEN RAISE EXCEPTION 'static_hls_queue_immutable'; END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    IF TG_OP='DELETE' THEN RETURN NULL; END IF;
    IF NOT static_hls_reader_supported() THEN
        -- Retirement requires independently revoked authority. Compatibility
        -- failure alone cannot authorize cancellation or ownership changes.
        -- 0042 media_job_queue_prefix sorts before this trigger and wholly
        -- resets/derives the three metrics_queue_* fields. They are not caller
        -- writable exceptions: a caller's attempted overwrite was reset first.
        IF OLD.status IN ('queued','running') AND NEW.status='cancelled'
            AND NOT static_hls_session_authority_allowed(OLD.session_id)
            AND (NEW.owner_id IS NULL OR NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id)
            AND (NEW.lease_until IS NULL OR NEW.lease_until IS NOT DISTINCT FROM OLD.lease_until)
            AND (NEW.error IS NOT DISTINCT FROM OLD.error OR NEW.error IN ('playback_session_stopped','playback_session_expired'))
            AND ((NEW.timing_version,NEW.timing_attempt,NEW.queue_entered_at,NEW.run_started_at)
                IS NOT DISTINCT FROM (OLD.timing_version,OLD.timing_attempt,OLD.queue_entered_at,OLD.run_started_at)
                OR (NEW.timing_version IS NULL AND NEW.timing_attempt IS NULL AND NEW.queue_entered_at IS NULL AND NEW.run_started_at IS NULL))
            AND (to_jsonb(NEW)-ARRAY['status','owner_id','lease_until','error','timing_version','timing_attempt','queue_entered_at','run_started_at','metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt'])
                =(to_jsonb(OLD)-ARRAY['status','owner_id','lease_until','error','timing_version','timing_attempt','queue_entered_at','run_started_at','metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt'])
            THEN RETURN NEW; END IF;
        RETURN NULL;
    END IF;
    IF NEW.logical_queue IS DISTINCT FROM OLD.logical_queue OR NEW.session_id IS DISTINCT FROM OLD.session_id
        OR NEW.id IS DISTINCT FROM OLD.id OR NEW.spec IS DISTINCT FROM OLD.spec THEN
        RAISE EXCEPTION 'static_hls_queue_immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_job_guard BEFORE INSERT OR UPDATE OR DELETE ON media_jobs
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_job();

-- Protect the existing publication/file/read/receipt models, rather than a
-- competing output ledger. Unsupported binaries cannot publish or drain them.
CREATE FUNCTION protect_static_hls_job_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked boolean=false;
BEGIN
    IF TG_OP<>'INSERT' THEN
        marked=EXISTS(SELECT 1 FROM media_jobs WHERE id=OLD.job_id AND logical_queue='static_hls_v1');
        IF TG_TABLE_NAME='media_executions' THEN
            marked=marked OR EXISTS(SELECT 1 FROM playback_sessions WHERE id=OLD.session_id AND static_hls_capture_id IS NOT NULL);
        END IF;
    END IF;
    IF TG_OP<>'DELETE' THEN
        marked=marked OR EXISTS(SELECT 1 FROM media_jobs WHERE id=NEW.job_id AND logical_queue='static_hls_v1');
        IF TG_TABLE_NAME='media_executions' THEN
            marked=marked OR EXISTS(SELECT 1 FROM playback_sessions WHERE id=NEW.session_id AND static_hls_capture_id IS NOT NULL);
        END IF;
    END IF;
    IF marked AND NOT static_hls_reader_supported() THEN RETURN NULL; END IF;
    IF marked AND TG_OP='UPDATE' AND (NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.attempt IS DISTINCT FROM OLD.attempt) THEN
        RAISE EXCEPTION 'static_hls_artifact_immutable';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_output_guard BEFORE INSERT OR UPDATE OR DELETE ON media_outputs
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_job_artifact();
CREATE TRIGGER static_hls_output_file_guard BEFORE INSERT OR UPDATE OR DELETE ON media_output_files
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_job_artifact();
CREATE TRIGGER static_hls_execution_guard BEFORE INSERT OR UPDATE OR DELETE ON media_executions
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_job_artifact();
CREATE FUNCTION protect_static_hls_read_lease() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked boolean=false;
BEGIN
    IF TG_OP<>'INSERT' THEN
        marked=EXISTS(SELECT 1 FROM media_jobs WHERE id=OLD.cache_id AND logical_queue='static_hls_v1');
    END IF;
    IF TG_OP<>'DELETE' THEN
        marked=marked OR EXISTS(SELECT 1 FROM media_jobs WHERE id=NEW.cache_id AND logical_queue='static_hls_v1');
    END IF;
    IF marked AND NOT static_hls_reader_supported() THEN RETURN NULL; END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_read_lease_guard BEFORE INSERT OR UPDATE OR DELETE ON cache_read_leases
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_read_lease();

CREATE FUNCTION protect_static_hls_cache_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry uuid;
BEGIN
    entry=CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END;
    IF EXISTS(SELECT 1 FROM media_jobs WHERE id=entry AND logical_queue='static_hls_v1')
        AND NOT static_hls_reader_supported() THEN
        -- Frozen claim_eviction ignores UPDATE rows_affected. Skipping its row
        -- would still return an owner and permit filesystem deletion. Fail the
        -- caller transaction instead, before it can leave SQL for disk work.
        RAISE EXCEPTION 'static_hls_reader_required';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_cache_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON cache_entries
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_cache_entry();

CREATE FUNCTION protect_static_hls_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c static_hls_captures;
BEGIN
    IF TG_OP='UPDATE' AND (NEW.purpose IS DISTINCT FROM OLD.purpose
        OR (OLD.purpose='static_hls_capture' AND (NEW.job_id IS DISTINCT FROM OLD.job_id
            OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.attempt IS DISTINCT FROM OLD.attempt
            OR NEW.bytes IS DISTINCT FROM OLD.bytes))) THEN
        RAISE EXCEPTION 'static_hls_reservation_immutable';
    END IF;
    IF TG_OP='DELETE' THEN
        IF OLD.purpose='static_hls_capture' AND NOT EXISTS(SELECT 1 FROM static_hls_captures
            WHERE id=OLD.job_id AND owner_id=OLD.owner_id AND state='disposed'
            AND disposed_at IS NOT NULL AND streams_closed_at IS NOT NULL
            AND process_closed_at IS NOT NULL AND files_removed_at IS NOT NULL) THEN RETURN NULL; END IF;
        RETURN OLD;
    END IF;
    IF NEW.purpose='static_hls_capture' THEN
        IF NOT static_hls_reader_supported() THEN RAISE EXCEPTION 'static_hls_reader_required'; END IF;
        SELECT * INTO c FROM static_hls_captures WHERE id=NEW.job_id;
        IF c.id IS NULL OR c.owner_id<>NEW.owner_id OR c.disposed_at IS NOT NULL
            OR NEW.attempt<>0 OR NEW.bytes<>134217728 THEN RAISE EXCEPTION 'static_hls_reservation_required'; END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON cache_write_reservations
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_reservation();

-- Old closers do not know capture custody. The DB boundary prevents their final
-- closed/archived commit until every stream/process/file obligation is disposed.
-- Raise rather than skip, so their snapshot/event/task-completed writes roll back.
CREATE FUNCTION protect_static_hls_room_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (TG_OP='DELETE' OR NEW.lifecycle IN ('closed','archived')) AND EXISTS(
        SELECT 1 FROM static_hls_captures c JOIN playback_sessions p ON p.id=c.session_id
        WHERE p.room_id=OLD.id AND c.disposed_at IS NULL) THEN
        RAISE EXCEPTION 'static_hls_capture_drain_unconfirmed';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_room_close_guard BEFORE UPDATE OR DELETE ON rooms
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_room_close();
