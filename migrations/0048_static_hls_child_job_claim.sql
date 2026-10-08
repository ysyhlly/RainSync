-- Original-local-owner child scheduling only. No output writer, output success,
-- read authority, recursive fallback, retry, reownership or public activation.
-- SQL is the cooperative mixed-binary fence. The actual nonserializable local
-- capture/publication/attempt owners are additionally required by Rust.
-- Keep all parent/Stage A guard bodies and every output/cache/reservation guard.
LOCK TABLE media_jobs IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE media_executions IN ACCESS EXCLUSIVE MODE NOWAIT;

-- Affinity is tested before a queued candidate can consume an attempt or turn.
-- Owner GUCs are installed only by the typed consumer from its original witness.
-- They are not proof that a declared startup has any local sealed files.
CREATE FUNCTION static_hls_child_job_worker_authority_allowed(job uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT static_hls_pending_reader_supported() AND EXISTS(
        SELECT 1 FROM media_jobs j JOIN playback_requests r ON r.session_id=j.session_id
        JOIN static_hls_captures c ON c.session_id=r.session_id
        JOIN static_hls_database_binding db ON db.singleton
        WHERE j.id=$1 AND r.static_hls_parent_capture_id IS NOT NULL
        AND j.logical_queue='static_hls_v1' AND j.spec->>'kind'='static_hls_child'
        AND static_hls_child_job_matches(j,r,c)
        AND c.worker_instance::text=current_setting('rainsync.static_hls_worker_instance',true)
        AND c.database_id=db.id AND r.static_hls_database_id=db.id
        AND static_hls_child_queue_authority_allowed(r.session_id))
$$;
CREATE FUNCTION static_hls_child_job_claim_authority_allowed(job uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT static_hls_child_job_worker_authority_allowed($1) AND EXISTS(
        SELECT 1 FROM media_jobs j JOIN static_hls_captures c ON c.session_id=j.session_id
        WHERE j.id=$1 AND c.owner_id::text=current_setting('rainsync.static_hls_child_capture_owner',true)
        AND c.state='verified' AND c.disposed_at IS NULL)
$$;
CREATE FUNCTION static_hls_child_job_attempt_authority_allowed(job uuid, owner uuid, number bigint)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT static_hls_child_job_claim_authority_allowed($1) AND EXISTS(
        SELECT 1 FROM media_jobs j JOIN media_executions e ON e.job_id=j.id AND e.attempt=j.attempt
        JOIN playback_requests r ON r.session_id=j.session_id
        JOIN playback_sessions p ON p.id=j.session_id
        WHERE j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.attempt=1 AND j.status='running'
        AND j.owner_id::text=current_setting('rainsync.static_hls_child_job_owner',true)
        AND e.id::text=current_setting('rainsync.static_hls_child_execution_id',true)
        AND e.session_id=j.session_id AND e.kind='job' AND e.owner_id=j.owner_id AND e.reaped_at IS NULL
        AND j.timing_version=1 AND j.timing_attempt=j.attempt AND j.queue_entered_at IS NULL
        AND j.run_started_at IS NOT NULL AND j.run_started_at<=clock_timestamp()
        AND j.lease_until>clock_timestamp() AND j.lease_until<=j.run_started_at+interval '20 seconds'
        AND j.lease_until<=r.lease_until AND j.lease_until<=r.static_hls_prepare_expires_at
        AND j.lease_until<=r.static_hls_root_expires_at AND j.lease_until<=p.expires_at)
$$;

-- Only these transition classes leave the unchanged 0047 queued-only guard.
-- The second trigger below applies their complete exact checks. Non-child rows
-- and unrecognized changes still execute the original child guard unchanged.
CREATE FUNCTION static_hls_child_job_claim_transition(old_job media_jobs, new_job media_jobs)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT COALESCE((static_hls_is_child_session(($1).session_id)
        OR static_hls_child_identity_reserved(($1).id) OR ($1).spec->>'kind'='static_hls_child')
        AND (($1).status='queued' AND ($2).status='running'
            OR ($1).status='running' AND ($2).status='running'
            OR ($1).status IN ('queued','running') AND ($2).status IN ('failed','cancelled')),false)
$$;
DROP TRIGGER static_hls_child_job_guard ON media_jobs;
CREATE TRIGGER static_hls_child_job_guard_insert BEFORE INSERT ON media_jobs
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_job();
CREATE TRIGGER static_hls_child_job_guard BEFORE UPDATE ON media_jobs
    FOR EACH ROW WHEN (NOT static_hls_child_job_claim_transition(OLD,NEW))
    EXECUTE FUNCTION protect_static_hls_child_job();
CREATE TRIGGER static_hls_child_job_guard_delete BEFORE DELETE ON media_jobs
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_job();

CREATE FUNCTION protect_static_hls_child_job_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r playback_requests; c static_hls_captures; p playback_sessions;
BEGIN
    IF NOT static_hls_child_job_claim_transition(OLD,NEW) THEN RETURN NEW; END IF;
    SELECT * INTO r FROM playback_requests WHERE session_id=OLD.session_id;
    SELECT * INTO c FROM static_hls_captures WHERE session_id=OLD.session_id AND publication_phase='published_child';
    SELECT * INTO p FROM playback_sessions WHERE id=OLD.session_id;
    IF r.static_hls_parent_capture_id IS NULL OR c.id IS NULL OR p.id IS NULL
        OR NOT static_hls_child_job_matches(NEW,r,c)
        OR NEW.id IS DISTINCT FROM OLD.id OR NEW.session_id IS DISTINCT FROM OLD.session_id
        OR NEW.logical_queue IS DISTINCT FROM OLD.logical_queue OR NEW.spec IS DISTINCT FROM OLD.spec THEN
        RAISE EXCEPTION 'static_hls_child_queue_immutable';
    END IF;
    -- Existing server revocation paths may stop running work even without the
    -- typed owner's GUCs. Independently revoked grant, closed terminal shape and
    -- unchanged attempt are mandatory; compatibility alone is not revocation.
    IF NEW.status='cancelled' AND NOT static_hls_child_grant_authority_allowed(OLD.session_id)
        AND NEW.attempt=OLD.attempt AND (NEW.owner_id IS NULL OR NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id)
        AND (NEW.lease_until IS NULL OR NEW.lease_until IS NOT DISTINCT FROM OLD.lease_until)
        AND (NEW.error IS NOT DISTINCT FROM OLD.error OR NEW.error IN ('playback_session_stopped','playback_session_expired'))
        AND ((NEW.timing_version,NEW.timing_attempt,NEW.queue_entered_at,NEW.run_started_at)
            IS NOT DISTINCT FROM (OLD.timing_version,OLD.timing_attempt,OLD.queue_entered_at,OLD.run_started_at)
            OR (NEW.timing_version IS NULL AND NEW.timing_attempt IS NULL AND NEW.queue_entered_at IS NULL AND NEW.run_started_at IS NULL))
        AND (to_jsonb(NEW)-ARRAY['status','owner_id','lease_until','error','timing_version','timing_attempt','queue_entered_at','run_started_at',
            'metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt'])
            IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','owner_id','lease_until','error','timing_version','timing_attempt','queue_entered_at','run_started_at',
            'metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt']) THEN
        IF NOT static_hls_pending_reader_supported() AND NOT static_hls_reader_supported() THEN
            RAISE EXCEPTION 'static_hls_pending_reader_required';
        END IF;
        RETURN NEW;
    END IF;
    IF NOT static_hls_pending_reader_supported()
        OR c.worker_instance::text IS DISTINCT FROM current_setting('rainsync.static_hls_worker_instance',true)
        OR c.owner_id::text IS DISTINCT FROM current_setting('rainsync.static_hls_child_capture_owner',true) THEN
        RAISE EXCEPTION 'static_hls_original_child_owner_required';
    END IF;
    IF NEW.status='running' THEN
        IF NOT static_hls_child_job_claim_authority_allowed(OLD.id)
            OR NEW.owner_id IS NULL OR NEW.owner_id::text IS DISTINCT FROM current_setting('rainsync.static_hls_child_job_owner',true)
            OR NEW.lease_until IS NULL OR NOT isfinite(NEW.lease_until) OR NEW.lease_until<=clock_timestamp()
            OR NEW.run_started_at IS NULL OR NOT isfinite(NEW.run_started_at) OR NEW.run_started_at>clock_timestamp()
            OR NEW.lease_until>clock_timestamp()+interval '1 second'
            OR NEW.lease_until>NEW.run_started_at+interval '20 seconds'
            OR NEW.lease_until>r.lease_until OR NEW.lease_until>r.static_hls_prepare_expires_at
            OR NEW.lease_until>r.static_hls_root_expires_at OR NEW.lease_until>p.expires_at
            OR NEW.timing_version IS DISTINCT FROM 1 OR NEW.timing_attempt IS DISTINCT FROM NEW.attempt
            OR NEW.queue_entered_at IS NOT NULL THEN
            RAISE EXCEPTION 'static_hls_child_job_claim_authority_required';
        END IF;
        IF OLD.status='queued' THEN
            IF NOT (OLD.attempt=0 AND NEW.attempt=1) OR OLD.attempt>=OLD.max_attempts
                OR OLD.owner_id IS NOT NULL OR OLD.lease_until IS NOT NULL
                OR OLD.available_at>clock_timestamp() OR NEW.run_started_at<OLD.queue_entered_at
                OR EXISTS(SELECT 1 FROM media_executions WHERE job_id=OLD.id)
                OR (to_jsonb(NEW)-ARRAY['status','owner_id','attempt','lease_until','timing_version','timing_attempt','queue_entered_at','run_started_at',
                    'metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt'])
                    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','owner_id','attempt','lease_until','timing_version','timing_attempt','queue_entered_at','run_started_at',
                    'metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt']) THEN
                RAISE EXCEPTION 'static_hls_child_job_attempt_required';
            END IF;
        ELSE
            IF NOT static_hls_child_job_attempt_authority_allowed(OLD.id,OLD.owner_id,OLD.attempt)
                OR (to_jsonb(NEW)-ARRAY['lease_until','metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt'])
                    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['lease_until','metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt']) THEN
                RAISE EXCEPTION 'static_hls_child_job_renewal_required';
            END IF;
        END IF;
        RETURN NEW;
    END IF;
    -- Same-original-owner terminalization remains possible after its lease/root
    -- expires. No final state is a positive drain or input-disposal receipt.
    IF OLD.status<>'running' OR OLD.owner_id IS NULL
        OR OLD.owner_id::text IS DISTINCT FROM current_setting('rainsync.static_hls_child_job_owner',true)
        OR NEW.attempt IS DISTINCT FROM OLD.attempt OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
        OR NEW.lease_until IS NOT NULL OR NEW.error IS NULL OR NEW.error NOT IN ('static_hls_child_cancelled','static_hls_child_failed')
        OR (NEW.timing_version,NEW.timing_attempt,NEW.queue_entered_at,NEW.run_started_at)
            IS DISTINCT FROM (NULL::smallint,NULL::bigint,NULL::timestamptz,NULL::timestamptz)
        OR (to_jsonb(NEW)-ARRAY['status','lease_until','error','timing_version','timing_attempt','queue_entered_at','run_started_at',
            'metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt'])
            IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','lease_until','error','timing_version','timing_attempt','queue_entered_at','run_started_at',
            'metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt']) THEN
        RAISE EXCEPTION 'static_hls_child_job_terminal_owner_required';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_child_01_job_claim_guard BEFORE UPDATE ON media_jobs
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_job_claim();

-- Change routing only for child job receipts. The original parent/Stage A
-- artifact guard is unchanged and still runs for all non-child execution rows.
DROP TRIGGER static_hls_00_child_execution_guard ON media_executions;
DROP TRIGGER static_hls_execution_guard ON media_executions;
CREATE TRIGGER static_hls_execution_guard_insert BEFORE INSERT ON media_executions
    FOR EACH ROW WHEN (NOT static_hls_is_child_session(NEW.session_id) AND NOT static_hls_is_child_job(NEW.job_id)
        AND NOT static_hls_child_identity_reserved(NEW.job_id)) EXECUTE FUNCTION protect_static_hls_job_artifact();
CREATE TRIGGER static_hls_execution_guard BEFORE UPDATE ON media_executions
    FOR EACH ROW WHEN (NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_is_child_session(NEW.session_id)
        AND NOT static_hls_is_child_job(OLD.job_id) AND NOT static_hls_is_child_job(NEW.job_id)
        AND NOT static_hls_child_identity_reserved(OLD.job_id) AND NOT static_hls_child_identity_reserved(NEW.job_id))
    EXECUTE FUNCTION protect_static_hls_job_artifact();
CREATE TRIGGER static_hls_execution_guard_delete BEFORE DELETE ON media_executions
    FOR EACH ROW WHEN (NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_is_child_job(OLD.job_id)
        AND NOT static_hls_child_identity_reserved(OLD.job_id)) EXECUTE FUNCTION protect_static_hls_job_artifact();
CREATE FUNCTION protect_static_hls_child_job_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked boolean=false; j media_jobs; r playback_requests; c static_hls_captures;
BEGIN
    IF TG_OP<>'INSERT' THEN marked=static_hls_is_child_session(OLD.session_id) OR static_hls_is_child_job(OLD.job_id)
        OR static_hls_child_identity_reserved(OLD.job_id); END IF;
    IF TG_OP<>'DELETE' THEN marked=marked OR static_hls_is_child_session(NEW.session_id) OR static_hls_is_child_job(NEW.job_id)
        OR static_hls_child_identity_reserved(NEW.job_id); END IF;
    IF NOT marked THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'static_hls_child_execution_retained'; END IF;
    SELECT * INTO j FROM media_jobs WHERE id=NEW.job_id;
    SELECT * INTO r FROM playback_requests WHERE session_id=j.session_id;
    SELECT * INTO c FROM static_hls_captures WHERE session_id=j.session_id AND publication_phase='published_child';
    IF NOT static_hls_pending_reader_supported() OR c.id IS NULL OR j.id IS NULL
        OR NOT static_hls_child_job_matches(j,r,c)
        OR c.worker_instance::text IS DISTINCT FROM current_setting('rainsync.static_hls_worker_instance',true)
        OR c.owner_id::text IS DISTINCT FROM current_setting('rainsync.static_hls_child_capture_owner',true)
        OR NEW.owner_id::text IS DISTINCT FROM current_setting('rainsync.static_hls_child_job_owner',true)
        OR NEW.id::text IS DISTINCT FROM current_setting('rainsync.static_hls_child_execution_id',true)
        OR NEW.kind<>'job' OR NEW.session_id IS DISTINCT FROM j.session_id OR NEW.attempt IS DISTINCT FROM j.attempt
        OR NEW.attempt IS DISTINCT FROM 1::bigint OR NEW.metrics_entry_candidate IS NOT NULL THEN
        RAISE EXCEPTION 'static_hls_child_job_execution_owner_required';
    END IF;
    IF TG_OP='INSERT' THEN
        IF NOT static_hls_child_job_claim_authority_allowed(j.id) OR j.status<>'running'
            OR j.owner_id IS DISTINCT FROM NEW.owner_id OR j.lease_until<=clock_timestamp()
            OR NEW.reaped_at IS NOT NULL OR NEW.created_at<j.run_started_at OR NEW.created_at>clock_timestamp() THEN
            RAISE EXCEPTION 'static_hls_child_job_execution_admission_required';
        END IF;
    ELSE
        -- Original receipt can be positively acknowledged after logical stop,
        -- expiry or cleared scheduling owner; its immutable tuple is retained.
        IF (to_jsonb(NEW)-'reaped_at') IS DISTINCT FROM (to_jsonb(OLD)-'reaped_at')
            OR (OLD.reaped_at IS NOT NULL AND NEW.reaped_at IS DISTINCT FROM OLD.reaped_at)
            OR NEW.reaped_at IS NULL OR NEW.reaped_at<NEW.created_at OR NEW.reaped_at>clock_timestamp()
            OR j.status='running' THEN
            RAISE EXCEPTION 'static_hls_child_job_execution_immutable';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_00_child_execution_guard BEFORE INSERT OR UPDATE OR DELETE ON media_executions
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_job_execution();

-- A running claim must commit with exactly its compulsory unreaped execution
-- receipt. It cannot advance attempt/fairness then omit or swap that receipt.
CREATE FUNCTION check_static_hls_child_job_attempt_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job uuid; j media_jobs;
BEGIN
    IF TG_TABLE_NAME='media_jobs' THEN job=NEW.id; ELSE job=NEW.job_id; END IF;
    SELECT * INTO j FROM media_jobs WHERE id=job;
    IF NOT static_hls_is_child_job(job) THEN RETURN NULL; END IF;
    IF j.status='running' AND NOT static_hls_child_job_attempt_authority_allowed(j.id,j.owner_id,j.attempt) THEN
        RAISE EXCEPTION 'static_hls_child_job_attempt_receipt_required';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER static_hls_child_job_attempt_receipt AFTER INSERT OR UPDATE ON media_jobs
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_child_job_attempt_receipt();
CREATE CONSTRAINT TRIGGER static_hls_child_execution_attempt_receipt AFTER INSERT OR UPDATE ON media_executions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_child_job_attempt_receipt();
