-- Pending-parent custody only. No publication, jobs, RPC or reader rollout.
-- Historical capture provenance is a prerequisite; never fabricate it.
-- Block mutation before validation, in request-before-capture order. An owned
-- migration backend must still validate lock behavior and mixed-writer waits.
LOCK TABLE playback_requests IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE static_hls_captures IN ACCESS EXCLUSIVE MODE NOWAIT;
-- Trigger creation later in this migration must not wait while an old writer
-- holds one of these tables and reads the already-locked custody relations.
LOCK TABLE playback_sessions IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE media_jobs IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE cache_write_reservations IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE playback_preparations IN ACCESS EXCLUSIVE MODE NOWAIT;
DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM static_hls_captures c LEFT JOIN playback_requests r
        ON r.session_id=c.session_id WHERE r.session_id IS NULL
        OR r.user_id IS DISTINCT FROM c.user_id
        OR r.owner_epoch IS DISTINCT FROM c.request_owner_epoch) THEN
        RAISE EXCEPTION 'static_hls_historical_request_required';
    END IF;
END $$;
ALTER TABLE static_hls_captures DROP CONSTRAINT static_hls_captures_session_id_fkey;
ALTER TABLE static_hls_captures ADD CONSTRAINT static_hls_capture_request_fk
    FOREIGN KEY(session_id) REFERENCES playback_requests(session_id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE playback_requests
    ADD COLUMN static_hls_input_version smallint,
    ADD COLUMN static_hls_input_encrypted text,
    ADD COLUMN static_hls_input_sha256 text,
    ADD COLUMN static_hls_operation_id uuid,
    ADD COLUMN static_hls_root_expires_at timestamptz,
    ADD COLUMN static_hls_prepare_expires_at timestamptz,
    ADD COLUMN static_hls_media_id uuid,
    ADD COLUMN static_hls_media_generation bigint,
    ADD COLUMN static_hls_source_id uuid,
    ADD COLUMN static_hls_source_revision bigint,
    ADD COLUMN static_hls_source_generation bigint,
    ADD COLUMN static_hls_worker_instance uuid,
    ADD COLUMN static_hls_database_id uuid,
    ADD CONSTRAINT static_hls_pending_request_shape CHECK(
      num_nonnulls(static_hls_input_version,static_hls_input_encrypted,static_hls_input_sha256,
        static_hls_operation_id,static_hls_root_expires_at,static_hls_prepare_expires_at,
        static_hls_media_id,static_hls_media_generation,static_hls_source_id,static_hls_source_revision,
        static_hls_source_generation,static_hls_worker_instance,static_hls_database_id)=0
      OR (num_nonnulls(static_hls_input_version,static_hls_input_encrypted,static_hls_input_sha256,
        static_hls_operation_id,static_hls_root_expires_at,static_hls_prepare_expires_at,
        static_hls_media_id,static_hls_media_generation,static_hls_source_id,static_hls_source_revision,
        static_hls_source_generation,static_hls_worker_instance,static_hls_database_id)=13
        AND static_hls_input_version=1 AND octet_length(static_hls_input_encrypted) BETWEEN 1 AND 65536
        AND static_hls_input_sha256 ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'
        AND auth_login_hash IS NOT NULL AND auth_login_hash ~ '^[0-9a-f]{64}$' AND auth_membership_epoch IS NOT NULL
        AND room_id IS NOT NULL AND lifecycle_epoch IS NOT NULL AND lifecycle_epoch BETWEEN 0 AND 9007199254740991
        AND viewer_id IS NOT NULL AND plan_generation IS NOT NULL AND plan_generation BETWEEN 1 AND 9007199254740991
        AND static_hls_operation_id<>session_id AND status IN ('pending','failed')
        AND response_encrypted IS NULL AND http_file_context_encrypted IS NULL AND http_file_parent IS NULL
        AND static_hls_media_generation BETWEEN 0 AND 9007199254740991
        AND static_hls_source_revision BETWEEN 1 AND 9007199254740991 AND static_hls_source_generation BETWEEN 1 AND 9007199254740991
        AND created_at=date_trunc('milliseconds',created_at)
        AND static_hls_root_expires_at=date_trunc('milliseconds',static_hls_root_expires_at)
        AND static_hls_prepare_expires_at=date_trunc('milliseconds',static_hls_prepare_expires_at)
        AND static_hls_root_expires_at>created_at AND static_hls_root_expires_at<=created_at+interval '30 minutes'
        AND static_hls_prepare_expires_at>created_at AND static_hls_prepare_expires_at<=created_at+interval '45 seconds'
        AND static_hls_prepare_expires_at<=static_hls_root_expires_at
        AND lease_until>created_at AND lease_until<=static_hls_prepare_expires_at AND lease_until<=static_hls_root_expires_at));
CREATE UNIQUE INDEX static_hls_pending_operation ON playback_requests(static_hls_operation_id)
    WHERE static_hls_operation_id IS NOT NULL;
ALTER TABLE static_hls_captures
    ADD COLUMN publication_phase text NOT NULL DEFAULT 'stage_a' CHECK(publication_phase IN ('stage_a','pending_parent')),
    ADD COLUMN input_sha256 text,
    ADD COLUMN worker_instance uuid,
    ADD COLUMN database_id uuid,
    ADD COLUMN reader_version smallint,
    ADD COLUMN recipe_version smallint,
    ADD COLUMN root_digest text,
    ADD CONSTRAINT static_hls_pending_capture_shape CHECK(
      (publication_phase='stage_a' AND num_nonnulls(input_sha256,worker_instance,database_id,reader_version,recipe_version,root_digest)=0)
      OR (publication_phase='pending_parent' AND input_sha256 ~ '^[0-9a-f]{64}$'
        AND input_sha256 IS NOT NULL AND worker_instance IS NOT NULL AND database_id IS NOT NULL
        AND reader_version=2 AND recipe_version=1 AND reader_version IS NOT NULL AND recipe_version IS NOT NULL
        AND (root_digest IS NULL OR root_digest ~ '^[0-9a-f]{64}$')
        AND ((root_digest IS NULL)=(inventory_encrypted IS NULL))
        AND (state<>'verified' OR root_digest IS NOT NULL)));
CREATE UNIQUE INDEX static_hls_pending_capture_request ON static_hls_captures(session_id)
    WHERE publication_phase='pending_parent';

-- A transaction-local storage fence, deliberately separate from production
-- static_hls_reader_supported() (which continues to accept reader1 only).
CREATE FUNCTION static_hls_pending_reader_supported() RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT COALESCE(current_setting('rainsync.static_hls_reader',true)='2'
        AND current_setting('rainsync.static_hls_pending_recipe',true)='1',false)
$$;
CREATE FUNCTION static_hls_pending_request_authority_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM playback_requests r
        JOIN rooms room ON room.id=r.room_id JOIN room_snapshots snap ON snap.room_id=r.room_id
        JOIN sources s ON s.id=r.static_hls_source_id JOIN media_items m ON m.id=r.static_hls_media_id
        JOIN static_hls_database_binding db ON db.singleton
        JOIN playback_preparations prep ON prep.session_id=r.session_id
        WHERE r.session_id=$1 AND r.static_hls_input_version=1 AND r.status='pending'
        AND r.lease_until>clock_timestamp() AND r.static_hls_prepare_expires_at>clock_timestamp()
        AND r.static_hls_root_expires_at>clock_timestamp() AND r.preparation_drained_at IS NULL
        AND prep.drained_at IS NULL AND prep.owner_epoch=r.owner_epoch AND prep.room_id=r.room_id
        AND prep.user_id=r.user_id AND prep.lifecycle_epoch=r.lifecycle_epoch AND prep.created_at=r.created_at
        AND room.lifecycle='active' AND room.lifecycle_epoch=r.lifecycle_epoch
        AND playback_origin_allowed(r.user_id,r.room_id,r.auth_login_hash,r.auth_membership_epoch)
        AND EXISTS(SELECT 1 FROM sessions login WHERE login.user_id=r.user_id AND login.token_hash=r.auth_login_hash
            AND login.expires_at>=r.static_hls_root_expires_at)
        AND (snap.state->>'media_id')::uuid=m.id
        AND (snap.state->>'media_generation')::bigint=r.static_hls_media_generation
        AND m.available AND m.source_id=s.id AND s.kind='http'
        AND s.access_policy_revision=r.static_hls_source_revision
        AND m.preview_generation=r.static_hls_source_generation AND db.id=r.static_hls_database_id
        AND EXISTS(SELECT 1 FROM playback_viewer_plans v WHERE v.user_id=r.user_id
            AND v.room_id=r.room_id AND v.viewer_id=r.viewer_id AND v.auth_login_hash=r.auth_login_hash
            AND v.plan_generation=r.plan_generation))
$$;
CREATE FUNCTION static_hls_pending_capture_authority_allowed(capture uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM static_hls_captures c JOIN playback_requests r ON r.session_id=c.session_id
        WHERE c.id=$1 AND c.publication_phase='pending_parent' AND c.state IN ('capturing','verified')
        AND c.disposed_at IS NULL AND c.expires_at>clock_timestamp()
        AND c.id=r.static_hls_operation_id AND c.user_id=r.user_id AND c.request_owner_epoch=r.owner_epoch
        AND c.input_sha256=r.static_hls_input_sha256 AND c.worker_instance=r.static_hls_worker_instance
        AND c.database_id=r.static_hls_database_id AND c.expires_at=r.static_hls_root_expires_at
        AND c.reader_version=2 AND c.recipe_version=1
        AND static_hls_pending_request_authority_allowed(r.session_id))
$$;

-- Absence checks are shared by every pending pruning boundary. A historical
-- session-key cache/read/output owner is a dependency too, even though this
-- slice cannot create it. No reference is reclaimed by these checks.
CREATE FUNCTION static_hls_pending_prune_dependencies_absent(session uuid, operation uuid, room uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT NOT EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id IN ($1,$2))
        AND NOT EXISTS(SELECT 1 FROM playback_sessions WHERE id=$1 OR static_hls_capture_id=$2)
        AND NOT EXISTS(SELECT 1 FROM media_jobs WHERE id IN ($1,$2) OR session_id=$1)
        AND NOT EXISTS(SELECT 1 FROM media_executions WHERE session_id=$1)
        AND NOT EXISTS(SELECT 1 FROM upstream_reservations WHERE id=$1)
        AND NOT EXISTS(SELECT 1 FROM playback_observations WHERE session_id=$1)
        AND NOT EXISTS(SELECT 1 FROM playback_http_representations WHERE session_id=$1)
        AND NOT EXISTS(SELECT 1 FROM agent_transfer_runs WHERE session_id=$1)
        AND NOT EXISTS(SELECT 1 FROM cache_entries WHERE id IN ($1,$2) OR cache_key IN ($1::text,$2::text))
        AND NOT EXISTS(SELECT 1 FROM cache_read_leases WHERE cache_id IN ($1,$2))
        AND NOT EXISTS(SELECT 1 FROM media_outputs WHERE job_id IN ($1,$2))
        AND NOT EXISTS(SELECT 1 FROM media_output_files WHERE job_id IN ($1,$2))
        AND NOT EXISTS(SELECT 1 FROM room_cleanup_tasks WHERE room_id=$3 AND completed_at IS NULL)
$$;

-- Retargeting the capture FK must preserve protection of every Stage A
-- session, including unmarked/capturing and disposed custody.
CREATE FUNCTION protect_static_hls_stage_a_session_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id) AND EXISTS(
        SELECT 1 FROM static_hls_captures WHERE publication_phase='stage_a' AND session_id=OLD.id) THEN
        RAISE EXCEPTION 'static_hls_stage_a_session_retained';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_stage_a_session_identity_guard BEFORE DELETE OR UPDATE OF id ON playback_sessions
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_stage_a_session_identity();
CREATE FUNCTION protect_static_hls_pending_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session uuid;
BEGIN
    IF TG_TABLE_NAME='playback_sessions' THEN session=NEW.id; ELSE session=NEW.session_id; END IF;
    IF EXISTS(SELECT 1 FROM playback_requests WHERE session_id=session AND static_hls_input_version IS NOT NULL) THEN
        RAISE EXCEPTION 'static_hls_pending_publication_forbidden';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_pending_session_guard BEFORE INSERT OR UPDATE ON playback_sessions
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_pending_side_effect();
CREATE TRIGGER static_hls_pending_job_guard BEFORE INSERT OR UPDATE ON media_jobs
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_pending_side_effect();

CREATE OR REPLACE FUNCTION protect_static_hls_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p playback_sessions; r playback_requests;
BEGIN
    IF (TG_OP='INSERT' AND NEW.publication_phase='pending_parent')
        OR (TG_OP<>'INSERT' AND OLD.publication_phase='pending_parent') THEN
        IF TG_OP='DELETE' THEN
            IF NOT static_hls_pending_reader_supported()
                OR current_setting('rainsync.static_hls_pending_prune',true) IS DISTINCT FROM '1'
                OR OLD.disposed_at IS NULL OR OLD.streams_closed_at IS NULL OR OLD.process_closed_at IS NULL
                OR OLD.files_removed_at IS NULL OR EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id=OLD.id)
                OR EXISTS(SELECT 1 FROM playback_sessions WHERE id=OLD.session_id OR static_hls_capture_id=OLD.id)
                OR EXISTS(SELECT 1 FROM media_jobs WHERE id=OLD.id OR session_id=OLD.session_id)
                OR NOT static_hls_pending_prune_dependencies_absent(OLD.session_id,OLD.id,(SELECT room_id FROM playback_requests WHERE session_id=OLD.session_id))
                OR NOT EXISTS(SELECT 1 FROM playback_requests request JOIN playback_preparations prep ON prep.session_id=request.session_id
                    WHERE request.session_id=OLD.session_id AND request.status='failed' AND request.expires_at<clock_timestamp()
                    AND request.preparation_drained_at IS NOT NULL AND prep.drained_at IS NOT NULL
                    AND NOT EXISTS(SELECT 1 FROM room_cleanup_tasks WHERE room_id=request.room_id AND completed_at IS NULL)) THEN
                RAISE EXCEPTION 'static_hls_pending_prune_unconfirmed';
            END IF;
            RETURN OLD;
        END IF;
        IF TG_OP='INSERT' THEN
            IF NOT static_hls_pending_reader_supported() THEN RAISE EXCEPTION 'static_hls_pending_reader_required'; END IF;
            -- Caller has already locked the request before this budget suffix.
            PERFORM revision FROM cache_budget WHERE singleton FOR UPDATE;
            IF (SELECT count(*) FROM static_hls_captures WHERE disposed_at IS NULL)>=2 THEN
                RAISE EXCEPTION 'static_hls_capture_capacity';
            END IF;
            SELECT * INTO r FROM playback_requests WHERE session_id=NEW.session_id;
            IF r.static_hls_input_version IS DISTINCT FROM 1 OR NEW.id IS DISTINCT FROM r.static_hls_operation_id
                OR NEW.user_id IS DISTINCT FROM r.user_id OR NEW.request_owner_epoch IS DISTINCT FROM r.owner_epoch
                OR NEW.input_sha256 IS DISTINCT FROM r.static_hls_input_sha256
                OR NEW.worker_instance IS DISTINCT FROM r.static_hls_worker_instance OR NEW.database_id IS DISTINCT FROM r.static_hls_database_id
                OR NEW.expires_at IS DISTINCT FROM r.static_hls_root_expires_at
                OR NEW.resource_authority IS DISTINCT FROM jsonb_build_object('media_id',r.static_hls_media_id,'source_id',r.static_hls_source_id,
                    'source_policy_revision',r.static_hls_source_revision,'media_source_generation',r.static_hls_source_generation)
                OR NOT static_hls_pending_request_authority_allowed(NEW.session_id)
                OR NEW.state<>'capturing' OR NEW.inventory_encrypted IS NOT NULL OR NEW.root_digest IS NOT NULL
                OR NEW.streams_closed_at IS NOT NULL OR NEW.process_closed_at IS NOT NULL OR NEW.process_disposition IS NOT NULL
                OR NEW.files_removed_at IS NOT NULL OR NEW.disposed_at IS NOT NULL THEN
                RAISE EXCEPTION 'static_hls_pending_capture_authority_required';
            END IF;
        ELSE
            -- Verify/cancel do not acquire the budget, including trigger paths.
            IF (to_jsonb(NEW)-ARRAY['state','inventory_encrypted','root_digest','streams_closed_at','process_closed_at','process_disposition','files_removed_at','disposed_at'])
                IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','inventory_encrypted','root_digest','streams_closed_at','process_closed_at','process_disposition','files_removed_at','disposed_at'])
                OR (OLD.inventory_encrypted IS NOT NULL AND NEW.inventory_encrypted IS DISTINCT FROM OLD.inventory_encrypted)
                OR (OLD.root_digest IS NOT NULL AND NEW.root_digest IS DISTINCT FROM OLD.root_digest)
                OR (OLD.streams_closed_at IS NOT NULL AND NEW.streams_closed_at IS DISTINCT FROM OLD.streams_closed_at)
                OR (OLD.process_closed_at IS NOT NULL AND NEW.process_closed_at IS DISTINCT FROM OLD.process_closed_at)
                OR (OLD.process_disposition IS NOT NULL AND NEW.process_disposition IS DISTINCT FROM OLD.process_disposition)
                OR (OLD.files_removed_at IS NOT NULL AND NEW.files_removed_at IS DISTINCT FROM OLD.files_removed_at)
                OR (OLD.disposed_at IS NOT NULL AND NEW.disposed_at IS DISTINCT FROM OLD.disposed_at)
                OR ((NEW.inventory_encrypted IS DISTINCT FROM OLD.inventory_encrypted OR NEW.root_digest IS DISTINCT FROM OLD.root_digest) AND NEW.state<>'verified')
                OR ((NEW.streams_closed_at IS DISTINCT FROM OLD.streams_closed_at OR NEW.process_closed_at IS DISTINCT FROM OLD.process_closed_at
                    OR NEW.process_disposition IS DISTINCT FROM OLD.process_disposition OR NEW.files_removed_at IS DISTINCT FROM OLD.files_removed_at
                    OR NEW.disposed_at IS DISTINCT FROM OLD.disposed_at) AND NEW.state<>'disposed')
                OR (OLD.state='verified' AND NEW.state='capturing') OR (OLD.state='disposed' AND NEW.state<>'disposed')
                OR (OLD.state='cancelled' AND NEW.state NOT IN ('cancelled','disposed')) THEN
                RAISE EXCEPTION 'static_hls_pending_capture_immutable';
            END IF;
            IF NEW.state='cancelled' AND NEW.inventory_encrypted IS NOT DISTINCT FROM OLD.inventory_encrypted
                AND NEW.root_digest IS NOT DISTINCT FROM OLD.root_digest
                AND NEW.streams_closed_at IS NOT DISTINCT FROM OLD.streams_closed_at
                AND NEW.process_closed_at IS NOT DISTINCT FROM OLD.process_closed_at
                AND NEW.process_disposition IS NOT DISTINCT FROM OLD.process_disposition
                AND NEW.files_removed_at IS NOT DISTINCT FROM OLD.files_removed_at AND NEW.disposed_at IS NOT DISTINCT FROM OLD.disposed_at THEN
                IF NOT static_hls_pending_reader_supported() AND NOT static_hls_reader_supported() THEN
                    RAISE EXCEPTION 'static_hls_pending_reader_required';
                END IF;
                RETURN NEW;
            END IF;
            IF NOT static_hls_pending_reader_supported() THEN RAISE EXCEPTION 'static_hls_pending_reader_required'; END IF;
            IF NEW.state='verified' AND (OLD.state NOT IN ('capturing','verified')
                OR NOT static_hls_pending_capture_authority_allowed(OLD.id)) THEN
                RAISE EXCEPTION 'static_hls_pending_capture_authority_required';
            END IF;
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP='UPDATE' AND NEW.publication_phase IS DISTINCT FROM OLD.publication_phase THEN
        RAISE EXCEPTION 'static_hls_capture_phase_immutable';
    END IF;
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

CREATE OR REPLACE FUNCTION protect_static_hls_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        IF NEW.static_hls_input_version IS NOT NULL AND NOT static_hls_pending_reader_supported() THEN
            RAISE EXCEPTION 'static_hls_pending_reader_required';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP='DELETE' THEN
        IF EXISTS(SELECT 1 FROM static_hls_captures WHERE session_id=OLD.session_id) THEN RETURN NULL; END IF;
        IF OLD.static_hls_input_version IS NOT NULL AND (
            NOT static_hls_pending_reader_supported() OR current_setting('rainsync.static_hls_pending_prune',true) IS DISTINCT FROM '1'
            OR OLD.status<>'failed' OR OLD.expires_at>=clock_timestamp() OR OLD.preparation_drained_at IS NULL
            OR EXISTS(SELECT 1 FROM playback_preparations WHERE session_id=OLD.session_id)
            OR NOT static_hls_pending_prune_dependencies_absent(OLD.session_id,OLD.static_hls_operation_id,OLD.room_id)
            OR EXISTS(SELECT 1 FROM room_cleanup_tasks WHERE room_id=OLD.room_id AND completed_at IS NULL)) THEN
            RAISE EXCEPTION 'static_hls_pending_request_retained';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.static_hls_input_version IS NOT NULL THEN
        IF (to_jsonb(NEW)-ARRAY['status','error_status','error_code','preparation_drained_at'])
            IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','error_status','error_code','preparation_drained_at'])
            OR (OLD.status='failed' AND (NEW.status,NEW.error_status,NEW.error_code) IS DISTINCT FROM (OLD.status,OLD.error_status,OLD.error_code))
            OR NEW.status NOT IN ('pending','failed')
            OR (OLD.preparation_drained_at IS NOT NULL AND NEW.preparation_drained_at IS DISTINCT FROM OLD.preparation_drained_at) THEN
            RAISE EXCEPTION 'static_hls_pending_request_immutable';
        END IF;
        -- A precise monotonic revocation or original-owner drain is safe for
        -- reader1; incompatible readers cannot silently claim successful skip.
        IF NOT static_hls_pending_reader_supported() AND NOT static_hls_reader_supported() THEN
            RAISE EXCEPTION 'static_hls_pending_reader_required';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.static_hls_input_version IS NOT NULL THEN RAISE EXCEPTION 'static_hls_pending_request_immutable'; END IF;
    IF EXISTS(SELECT 1 FROM static_hls_captures WHERE session_id=OLD.session_id AND disposed_at IS NULL) THEN
        IF NOT static_hls_reader_supported() THEN RETURN NULL; END IF;
        IF NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.owner_epoch IS DISTINCT FROM OLD.owner_epoch
            OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.status IS DISTINCT FROM OLD.status
            OR NEW.response_encrypted IS DISTINCT FROM OLD.response_encrypted THEN
            RAISE EXCEPTION 'static_hls_request_immutable';
        END IF;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER static_hls_request_guard ON playback_requests;
CREATE TRIGGER static_hls_request_guard BEFORE INSERT OR UPDATE OR DELETE ON playback_requests
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_request();

CREATE OR REPLACE FUNCTION protect_static_hls_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
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
        SELECT * INTO c FROM static_hls_captures WHERE id=NEW.job_id;
        IF (c.publication_phase='pending_parent' AND NOT static_hls_pending_reader_supported())
            OR (c.publication_phase='stage_a' AND NOT static_hls_reader_supported()) THEN
            RAISE EXCEPTION 'static_hls_reader_required';
        END IF;
        IF c.id IS NULL OR c.owner_id<>NEW.owner_id OR c.disposed_at IS NOT NULL
            OR NEW.attempt<>0 OR NEW.bytes<>134217728 THEN RAISE EXCEPTION 'static_hls_reservation_required'; END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_static_hls_room_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (TG_OP='DELETE' OR NEW.lifecycle IN ('closed','archived')) AND EXISTS(
        SELECT 1 FROM static_hls_captures c JOIN playback_requests request ON request.session_id=c.session_id
        LEFT JOIN playback_sessions p ON p.id=c.session_id
        WHERE (CASE WHEN c.publication_phase='pending_parent' THEN request.room_id ELSE p.room_id END)=OLD.id AND c.disposed_at IS NULL) THEN
        RAISE EXCEPTION 'static_hls_capture_drain_unconfirmed';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;

-- The pending capture and exact reservation must commit together. Disposal is
-- the only operation that may remove the reservation; pruning never removes it.
CREATE FUNCTION check_static_hls_pending_linkage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r playback_requests; c static_hls_captures;
BEGIN
    IF TG_TABLE_NAME='playback_requests' THEN
        SELECT * INTO r FROM playback_requests WHERE session_id=NEW.session_id;
        IF r.static_hls_input_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM playback_preparations p
            WHERE p.session_id=r.session_id AND p.user_id=r.user_id AND p.room_id=r.room_id
            AND p.lifecycle_epoch=r.lifecycle_epoch AND p.owner_epoch=r.owner_epoch AND p.created_at=r.created_at
            AND p.drained_at IS NOT DISTINCT FROM r.preparation_drained_at) THEN
            RAISE EXCEPTION 'static_hls_pending_preparation_required';
        END IF;
    ELSE
        SELECT * INTO c FROM static_hls_captures WHERE id=NEW.id;
        IF c.publication_phase='pending_parent' AND ((c.disposed_at IS NULL AND NOT EXISTS(
            SELECT 1 FROM cache_write_reservations WHERE job_id=c.id AND owner_id=c.owner_id AND attempt=0
            AND purpose='static_hls_capture' AND bytes=134217728)) OR (c.disposed_at IS NOT NULL AND EXISTS(
            SELECT 1 FROM cache_write_reservations WHERE job_id=c.id))) THEN
            RAISE EXCEPTION 'static_hls_pending_reservation_required';
        END IF;
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER static_hls_pending_request_linkage AFTER INSERT OR UPDATE ON playback_requests
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_pending_linkage();
CREATE CONSTRAINT TRIGGER static_hls_pending_capture_linkage AFTER INSERT OR UPDATE ON static_hls_captures
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_pending_linkage();
CREATE FUNCTION protect_static_hls_pending_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM playback_requests WHERE session_id=OLD.session_id AND static_hls_input_version IS NOT NULL) THEN
        IF TG_OP='DELETE' THEN
            IF NOT static_hls_pending_reader_supported() OR current_setting('rainsync.static_hls_pending_prune',true) IS DISTINCT FROM '1'
                OR OLD.drained_at IS NULL OR EXISTS(SELECT 1 FROM static_hls_captures WHERE session_id=OLD.session_id)
                OR NOT EXISTS(SELECT 1 FROM playback_requests r WHERE r.session_id=OLD.session_id AND r.status='failed'
                    AND r.expires_at<clock_timestamp() AND r.preparation_drained_at=OLD.drained_at AND r.owner_epoch=OLD.owner_epoch
                    AND static_hls_pending_prune_dependencies_absent(r.session_id,r.static_hls_operation_id,r.room_id)) THEN
                RAISE EXCEPTION 'static_hls_pending_preparation_retained';
            END IF;
            RETURN OLD;
        END IF;
        IF (to_jsonb(NEW)-'drained_at') IS DISTINCT FROM (to_jsonb(OLD)-'drained_at')
            OR (OLD.drained_at IS NOT NULL AND NEW.drained_at IS DISTINCT FROM OLD.drained_at) THEN
            RAISE EXCEPTION 'static_hls_pending_preparation_immutable';
        END IF;
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_pending_preparation_guard BEFORE UPDATE OR DELETE ON playback_preparations
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_pending_preparation();
