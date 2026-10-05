-- Full sequential child-output publication, exclusively from the original
-- opaque local validator/owner. GUCs are cooperative mixed-binary fences, not
-- filesystem, decoder, process-drain or disposal proofs. Production operation
-- creation stays default-closed; retention is separate from delivery authority.
LOCK TABLE media_jobs IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE media_executions IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE media_outputs IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE cache_write_reservations IN ACCESS EXCLUSIVE MODE NOWAIT;

-- Version 4 is a DIFFERENT semantic contract from generic first-fragment v3.
-- Never infer compatibility by comparing versions numerically. All child
-- names/hashes (including s000.m4s) live in this dedicated full evidence record;
-- generic media_output_files/indexN, caches and read leases remain forbidden.
CREATE TABLE static_hls_child_output_publications (
    job_id uuid NOT NULL REFERENCES media_jobs(id),
    attempt bigint NOT NULL CHECK(attempt=1),
    owner_id uuid NOT NULL,
    execution_id uuid NOT NULL REFERENCES media_executions(id),
    capture_id uuid NOT NULL REFERENCES static_hls_captures(id),
    input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[0-9a-f]{64}$'),
    root_digest text NOT NULL CHECK(root_digest ~ '^[0-9a-f]{64}$'),
    root_expires_at timestamptz NOT NULL CHECK(isfinite(root_expires_at)),
    relative_dir text NOT NULL,
    validation_kind text NOT NULL CHECK(validation_kind='static_hls_full_child_snapshot_v1'),
    validation_version integer NOT NULL CHECK(validation_version=1),
    manifest text NOT NULL CHECK(octet_length(manifest) BETWEEN 1 AND 131072),
    manifest_sha256 text NOT NULL CHECK(manifest_sha256=encode(sha256(convert_to(manifest,'UTF8')),'hex')),
    segment_count integer NOT NULL CHECK(segment_count BETWEEN 1 AND 5),
    resources jsonb NOT NULL CHECK(jsonb_typeof(resources)='array'),
    total_bytes bigint NOT NULL CHECK(total_bytes BETWEEN 1 AND 33554432),
    evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
    evidence_plaintext text NOT NULL CHECK(COALESCE(octet_length(evidence_plaintext) BETWEEN 1 AND 1048576
        AND evidence_plaintext::jsonb=evidence
        AND evidence ?& ARRAY['version','validation_kind','source_identity','resources','encoder_input_scope_reaped','decoder','requested_position_ms']
        AND jsonb_typeof(evidence->'source_identity')='object' AND jsonb_typeof(evidence->'decoder')='object'
        AND evidence->'decoder' ?& ARRAY['process_tree_reaped','exit_code','manifest_sha256']
        AND evidence->>'version'='1'
        AND evidence->>'validation_kind'='complete_owned_child_v1'
        AND evidence->'encoder_input_scope_reaped'='true'::jsonb
        AND evidence->'resources'=resources
        AND evidence->'decoder'->'process_tree_reaped'='true'::jsonb
        AND evidence->'decoder'->>'exit_code'='0'
        AND evidence->'decoder'->>'manifest_sha256'=manifest_sha256,false)),
    evidence_sha256 text NOT NULL CHECK(evidence_sha256=encode(sha256(convert_to(evidence_plaintext,'UTF8')),'hex')),
    published_at timestamptz NOT NULL CHECK(isfinite(published_at)),
    PRIMARY KEY(job_id,attempt),
    UNIQUE(execution_id),
    CHECK(relative_dir=job_id::text||'/1')
);

-- Immutable history survives deletion of output rows. Only the same retained
-- Rust operation/proof may reconcile an unknown commit, never a row-built owner.
CREATE TABLE static_hls_child_output_disposals (
    id uuid PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES media_jobs(id),
    attempt bigint NOT NULL CHECK(attempt=1),
    owner_id uuid NOT NULL,
    execution_id uuid NOT NULL REFERENCES media_executions(id),
    capture_id uuid NOT NULL REFERENCES static_hls_captures(id),
    input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[0-9a-f]{64}$'),
    root_digest text NOT NULL CHECK(root_digest ~ '^[0-9a-f]{64}$'),
    relative_dir text NOT NULL CHECK(relative_dir=job_id::text||'/1'),
    process_disposition text NOT NULL CHECK(process_disposition IN ('never_started','reaped')),
    directory_device numeric NOT NULL CHECK(directory_device>=0 AND directory_device=trunc(directory_device)),
    directory_inode numeric NOT NULL CHECK(directory_inode>=0 AND directory_inode=trunc(directory_inode)),
    disposed_at timestamptz NOT NULL CHECK(isfinite(disposed_at)),
    UNIQUE(job_id,attempt,owner_id)
);

CREATE FUNCTION static_hls_child_output_resources_match(resources jsonb, segments integer, bytes bigint)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_typeof($1)='array' AND jsonb_array_length($1)=$2+2
        AND (SELECT count(DISTINCT x->>'name') FROM jsonb_array_elements($1) x)=$2+2
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($1) x
            WHERE jsonb_typeof(x)<>'object' OR x-ARRAY['name','bytes','sha256']<>'{}'::jsonb
            OR NOT (x ?& ARRAY['name','bytes','sha256']) OR jsonb_typeof(x->'bytes')<>'number'
            OR (x->>'bytes')::numeric NOT BETWEEN 1 AND 8388608
            OR (x->>'bytes')::numeric<>trunc((x->>'bytes')::numeric)
            OR COALESCE(x->>'sha256','')!~'^[0-9a-f]{64}$'
            OR (x->>'name' NOT IN ('index.m3u8','init.mp4') AND NOT EXISTS(
                SELECT 1 FROM generate_series(0,$2-1) n WHERE x->>'name'='s'||lpad(n::text,3,'0')||'.m4s')))
        AND (SELECT sum((x->>'bytes')::bigint) FROM jsonb_array_elements($1) x)=$3
        AND EXISTS(SELECT 1 FROM jsonb_array_elements($1) x WHERE x->>'name'='index.m3u8')
        AND EXISTS(SELECT 1 FROM jsonb_array_elements($1) x WHERE x->>'name'='init.mp4')
$$;

-- Historical original identity only; terminal disposal need not possess live
-- root/grant/encode authority. It never proves actual process/file removal.
CREATE FUNCTION static_hls_child_output_disposal_owner_allowed(job uuid, owner uuid, number bigint)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT static_hls_pending_reader_supported() AND EXISTS(
        SELECT 1 FROM media_jobs j JOIN playback_requests r ON r.session_id=j.session_id
        JOIN static_hls_captures c ON c.session_id=j.session_id
        JOIN static_hls_database_binding db ON db.singleton
        JOIN media_executions e ON e.job_id=j.id AND e.attempt=j.attempt
        WHERE j.id=$1 AND j.attempt=$3 AND $3=1 AND $2 IS NOT NULL
        AND j.status IN ('running','failed','cancelled','succeeded')
        AND (j.owner_id=$2 OR (j.status<>'running' AND j.owner_id IS NULL))
        AND static_hls_child_job_matches(j,r,c) AND c.publication_phase='published_child'
        AND c.database_id=db.id AND r.static_hls_database_id=db.id
        AND c.worker_instance::text=current_setting('rainsync.static_hls_worker_instance',true)
        AND c.owner_id::text=current_setting('rainsync.static_hls_child_capture_owner',true)
        AND $2::text=current_setting('rainsync.static_hls_child_job_owner',true)
        AND e.id::text=current_setting('rainsync.static_hls_child_execution_id',true)
        AND e.session_id=j.session_id AND e.owner_id=$2 AND e.kind='job')
$$;
CREATE FUNCTION static_hls_child_output_disposal_allowed(job uuid, owner uuid, number bigint)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT static_hls_child_output_disposal_owner_allowed($1,$2,$3) AND EXISTS(
        SELECT 1 FROM static_hls_child_output_disposals d JOIN media_executions e ON e.id=d.execution_id
        JOIN static_hls_captures c ON c.id=d.capture_id JOIN media_jobs j ON j.id=d.job_id
        WHERE d.job_id=$1 AND d.owner_id=$2 AND d.attempt=$3
        AND d.id::text=current_setting('rainsync.static_hls_child_output_disposal_operation',true)
        AND e.job_id=d.job_id AND e.attempt=d.attempt AND e.owner_id=d.owner_id
        AND e.id::text=current_setting('rainsync.static_hls_child_execution_id',true)
        AND c.session_id=j.session_id AND c.input_sha256=d.input_sha256 AND c.root_digest=d.root_digest
        AND c.owner_id::text=current_setting('rainsync.static_hls_child_capture_owner',true)
        AND d.relative_dir=d.job_id::text||'/1' AND d.disposed_at<=clock_timestamp())
$$;
CREATE FUNCTION protect_static_hls_child_output_disposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'static_hls_child_output_disposal_immutable'; END IF;
    IF NEW.id::text IS DISTINCT FROM current_setting('rainsync.static_hls_child_output_disposal_operation',true)
        OR NOT static_hls_child_output_disposal_owner_allowed(NEW.job_id,NEW.owner_id,NEW.attempt)
        OR NEW.execution_id::text IS DISTINCT FROM current_setting('rainsync.static_hls_child_execution_id',true)
        OR NEW.disposed_at>clock_timestamp()
        OR NOT EXISTS(SELECT 1 FROM media_jobs j JOIN static_hls_captures c ON c.session_id=j.session_id
            JOIN media_executions e ON e.id=NEW.execution_id
            WHERE j.id=NEW.job_id AND c.id=NEW.capture_id AND c.input_sha256=NEW.input_sha256
            AND c.root_digest=NEW.root_digest AND e.job_id=NEW.job_id AND e.owner_id=NEW.owner_id AND e.attempt=NEW.attempt)
        OR EXISTS(SELECT 1 FROM cache_read_leases WHERE cache_id=NEW.job_id)
        OR EXISTS(SELECT 1 FROM media_executions WHERE session_id=NEW.job_id AND kind='delivery' AND reaped_at IS NULL) THEN
        RAISE EXCEPTION 'static_hls_child_output_original_disposal_required';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_child_output_disposal_guard BEFORE INSERT OR UPDATE OR DELETE
    ON static_hls_child_output_disposals FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_output_disposal();

CREATE FUNCTION protect_static_hls_child_output_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'static_hls_child_output_publication_immutable'; END IF;
    IF current_setting('rainsync.static_hls_child_output_publication',true) IS DISTINCT FROM 'full_child_snapshot_v1'
        OR NOT static_hls_child_output_write_authority_allowed(NEW.job_id,NEW.owner_id,NEW.attempt)
        OR NEW.execution_id::text IS DISTINCT FROM current_setting('rainsync.static_hls_child_execution_id',true)
        OR NEW.published_at>clock_timestamp() OR NEW.root_expires_at<=clock_timestamp()
        OR NOT static_hls_child_output_resources_match(NEW.resources,NEW.segment_count,NEW.total_bytes)
        OR NOT EXISTS(SELECT 1 FROM media_outputs o JOIN media_jobs j ON j.id=o.job_id
            JOIN static_hls_captures c ON c.session_id=j.session_id
            JOIN media_executions e ON e.id=NEW.execution_id
            JOIN cache_write_reservations reservation ON reservation.job_id=o.job_id
            WHERE o.job_id=NEW.job_id AND o.attempt=NEW.attempt AND o.owner_id=NEW.owner_id
            AND o.status='writing' AND o.validation_version=0 AND o.visible_manifest IS NULL
            AND o.ready_segments=0 AND o.manifest_sha256 IS NULL AND o.segment_count IS NULL AND o.published_at IS NULL
            AND o.relative_dir=NEW.relative_dir AND c.id=NEW.capture_id AND c.input_sha256=NEW.input_sha256
            AND c.root_digest=NEW.root_digest AND c.expires_at=NEW.root_expires_at
            AND NEW.evidence->'source_identity'->>'capture_id'=c.id::text
            AND NEW.evidence->'source_identity'->>'owner_id'=c.owner_id::text
            AND NEW.evidence->'source_identity'->>'relative_key'='static-hls/'||c.id::text
            AND (NEW.evidence->>'requested_position_ms')::numeric=(j.spec->>'position_ms')::numeric
            AND e.job_id=o.job_id AND e.owner_id=o.owner_id AND e.attempt=o.attempt AND e.reaped_at IS NULL
            AND reservation.owner_id=o.owner_id AND reservation.attempt=o.attempt
            AND reservation.purpose='static_hls_child_output' AND reservation.bytes=33554432)
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.resources) x WHERE x->>'name'='index.m3u8'
            AND x->>'sha256'=NEW.manifest_sha256 AND (x->>'bytes')::bigint=octet_length(NEW.manifest)) THEN
        RAISE EXCEPTION 'static_hls_child_full_output_proof_required';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_child_output_publication_guard BEFORE INSERT OR UPDATE OR DELETE
    ON static_hls_child_output_publications FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_output_publication();

CREATE FUNCTION static_hls_child_output_publication_matches(job uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM static_hls_child_output_publications proof
        JOIN media_outputs o ON o.job_id=proof.job_id AND o.attempt=proof.attempt
        JOIN media_jobs j ON j.id=o.job_id JOIN playback_requests r ON r.session_id=j.session_id
        JOIN static_hls_captures c ON c.id=proof.capture_id
        JOIN media_executions e ON e.id=proof.execution_id
        JOIN cache_write_reservations reservation ON reservation.job_id=o.job_id
        WHERE j.id=$1 AND j.status='succeeded' AND j.attempt=1 AND j.owner_id=proof.owner_id
        AND j.lease_until IS NULL AND j.error IS NULL AND j.timing_version IS NULL AND j.timing_attempt IS NULL
        AND j.queue_entered_at IS NULL AND j.run_started_at IS NULL AND static_hls_child_job_matches(j,r,c)
        AND c.session_id=j.session_id AND c.input_sha256=proof.input_sha256 AND c.root_digest=proof.root_digest
        AND c.expires_at=proof.root_expires_at AND o.owner_id=proof.owner_id AND o.status='published'
        AND o.validation_version=4 AND o.relative_dir=proof.relative_dir AND o.visible_manifest=proof.manifest
        AND o.manifest_sha256=proof.manifest_sha256 AND o.segment_count=proof.segment_count
        AND o.ready_segments=proof.segment_count AND o.published_at=proof.published_at
        AND o.cleanup_after=proof.root_expires_at AND o.cleanup_owner IS NULL AND o.cleanup_until IS NULL
        AND proof.validation_kind='static_hls_full_child_snapshot_v1' AND proof.validation_version=1
        AND static_hls_child_output_resources_match(proof.resources,proof.segment_count,proof.total_bytes)
        AND e.job_id=j.id AND e.session_id=j.session_id AND e.attempt=j.attempt AND e.owner_id=j.owner_id
        AND e.kind='job' AND e.reaped_at IS NOT NULL AND e.reaped_at>=e.created_at AND e.reaped_at<=proof.published_at
        AND reservation.owner_id=o.owner_id AND reservation.attempt=o.attempt
        AND reservation.purpose='static_hls_child_output' AND reservation.bytes=33554432
        AND NOT EXISTS(SELECT 1 FROM media_output_files WHERE job_id=j.id)
        AND NOT EXISTS(SELECT 1 FROM cache_entries WHERE id=j.id)
        AND NOT EXISTS(SELECT 1 FROM cache_read_leases WHERE cache_id=j.id))
$$;
CREATE FUNCTION static_hls_child_output_retention_authority_allowed(job uuid, owner uuid, number bigint)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT static_hls_child_output_disposal_owner_allowed($1,$2,$3)
        AND static_hls_child_output_publication_matches($1)
        AND static_hls_child_grant_authority_allowed($1)
        AND NOT EXISTS(SELECT 1 FROM static_hls_child_output_disposals WHERE job_id=$1)
$$;
-- Full positive input disposal is compulsory for delivery, independently of
-- published retention. SQL evidence is still not a physical local owner.
CREATE FUNCTION static_hls_child_output_input_disposed(job uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM static_hls_child_output_publications proof
        JOIN static_hls_captures c ON c.id=proof.capture_id
        WHERE proof.job_id=$1 AND c.state='disposed' AND c.disposed_at IS NOT NULL
        AND c.streams_closed_at IS NOT NULL AND c.process_closed_at IS NOT NULL
        AND c.files_removed_at IS NOT NULL AND c.process_disposition IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id=c.id))
$$;

-- A current delivery statement, not an activation flag or file/path owner.
-- Worker still requires the actual original PublishedChildOutput+receipt Arc.
-- Creating/dispatching production child operations remains default-closed.
CREATE FUNCTION static_hls_child_output_reader_supported()
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT static_hls_pending_reader_supported()
        AND COALESCE(current_setting('rainsync.static_hls_child_reader',true)='original_published_child_v1',false)
$$;
CREATE OR REPLACE FUNCTION static_hls_child_output_authority_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT static_hls_child_output_reader_supported()
        AND static_hls_child_output_publication_matches($1)
        AND static_hls_child_output_input_disposed($1)
        AND static_hls_child_grant_authority_allowed($1)
        AND NOT EXISTS(SELECT 1 FROM static_hls_child_output_disposals WHERE job_id=$1)
$$;

-- Exact child delivery has independent execution custody; never borrow the job
-- owner GUC or create filesystem custody from a SQL row. Preserve the complete
-- 0048 original-job guard body for every non-delivery execution transition.
CREATE FUNCTION static_hls_child_delivery_execution(row_value media_executions)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT COALESCE(($1).kind='delivery' AND static_hls_is_child_session(($1).session_id),false)
$$;
DROP TRIGGER static_hls_00_child_execution_guard ON media_executions;
CREATE TRIGGER static_hls_00_child_execution_guard_insert BEFORE INSERT ON media_executions
    FOR EACH ROW WHEN (NOT static_hls_child_delivery_execution(NEW))
    EXECUTE FUNCTION protect_static_hls_child_job_execution();
CREATE TRIGGER static_hls_00_child_execution_guard BEFORE UPDATE ON media_executions
    FOR EACH ROW WHEN (NOT static_hls_child_delivery_execution(OLD) AND NOT static_hls_child_delivery_execution(NEW))
    EXECUTE FUNCTION protect_static_hls_child_job_execution();
CREATE TRIGGER static_hls_00_child_execution_guard_delete BEFORE DELETE ON media_executions
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_job_execution();
CREATE FUNCTION protect_static_hls_child_delivery_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT static_hls_pending_reader_supported()
        OR current_setting('rainsync.static_hls_child_reader',true) IS DISTINCT FROM 'original_published_child_v1'
        OR NEW.kind<>'delivery' OR NEW.job_id IS NOT NULL OR NEW.attempt IS NOT NULL
        OR NEW.id::text IS DISTINCT FROM current_setting('rainsync.static_hls_child_delivery_execution',true)
        OR NEW.owner_id::text IS DISTINCT FROM current_setting('rainsync.static_hls_child_delivery_owner',true)
        OR NEW.metrics_entry_candidate IS DISTINCT FROM false
        OR NOT isfinite(NEW.created_at) OR NEW.created_at>clock_timestamp()
        OR NOT EXISTS(SELECT 1 FROM static_hls_captures c JOIN playback_requests r ON r.session_id=c.session_id
            JOIN media_jobs j ON j.id=r.session_id JOIN static_hls_child_output_publications proof ON proof.job_id=j.id
            WHERE c.session_id=NEW.session_id AND c.id=proof.capture_id AND c.publication_phase='published_child'
            AND static_hls_child_job_matches(j,r,c) AND NEW.created_at>=proof.published_at
            AND c.worker_instance::text=current_setting('rainsync.static_hls_worker_instance',true)) THEN
        RAISE EXCEPTION 'static_hls_child_original_delivery_required';
    END IF;
    IF TG_OP='INSERT' THEN
        IF NEW.reaped_at IS NOT NULL OR NOT static_hls_child_output_authority_allowed(NEW.session_id) THEN
            RAISE EXCEPTION 'static_hls_child_full_output_delivery_required';
        END IF;
    ELSE
        -- The SAME body owner can acknowledge its actual body/guard drain after
        -- grant revocation, expiry or logical stop. No deadline/status implies it.
        IF (to_jsonb(NEW)-'reaped_at') IS DISTINCT FROM (to_jsonb(OLD)-'reaped_at')
            OR NEW.reaped_at IS NULL OR NOT isfinite(NEW.reaped_at)
            OR NEW.reaped_at<NEW.created_at OR NEW.reaped_at>clock_timestamp()
            OR (OLD.reaped_at IS NOT NULL AND NEW.reaped_at IS DISTINCT FROM OLD.reaped_at) THEN
            RAISE EXCEPTION 'static_hls_child_delivery_execution_immutable';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_01_child_delivery_execution_guard_insert BEFORE INSERT ON media_executions
    FOR EACH ROW WHEN (static_hls_child_delivery_execution(NEW))
    EXECUTE FUNCTION protect_static_hls_child_delivery_execution();
CREATE TRIGGER static_hls_01_child_delivery_execution_guard BEFORE UPDATE ON media_executions
    FOR EACH ROW WHEN (static_hls_child_delivery_execution(OLD) OR static_hls_child_delivery_execution(NEW))
    EXECUTE FUNCTION protect_static_hls_child_delivery_execution();
CREATE FUNCTION check_static_hls_child_delivery_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF static_hls_child_delivery_execution(NEW) AND TG_OP='INSERT'
        AND NOT static_hls_child_output_authority_allowed(NEW.session_id) THEN
        RAISE EXCEPTION 'static_hls_child_delivery_authority_required';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER static_hls_child_delivery_execution_linkage AFTER INSERT ON media_executions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_child_delivery_execution();

-- Route precisely the one success transition around the unchanged 0047/0048
-- guard bodies. Everything else still executes its original guard.
CREATE FUNCTION static_hls_child_job_output_success_transition(old_job media_jobs, new_job media_jobs)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT COALESCE((static_hls_is_child_job(($1).id) OR static_hls_child_identity_reserved(($1).id))
        AND ($1).status='running' AND ($2).status='succeeded',false)
$$;
DROP TRIGGER static_hls_child_job_guard ON media_jobs;
CREATE TRIGGER static_hls_child_job_guard BEFORE UPDATE ON media_jobs
    FOR EACH ROW WHEN (NOT static_hls_child_job_claim_transition(OLD,NEW)
        AND NOT static_hls_child_job_output_success_transition(OLD,NEW))
    EXECUTE FUNCTION protect_static_hls_child_job();
CREATE FUNCTION protect_static_hls_child_job_output_success() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('rainsync.static_hls_child_output_publication',true) IS DISTINCT FROM 'full_child_snapshot_v1'
        OR NOT static_hls_child_job_attempt_authority_allowed(OLD.id,OLD.owner_id,OLD.attempt)
        OR NEW.lease_until IS NOT NULL OR NEW.error IS NOT NULL
        OR NEW.timing_version IS NOT NULL OR NEW.timing_attempt IS NOT NULL
        OR NEW.queue_entered_at IS NOT NULL OR NEW.run_started_at IS NOT NULL
        OR (to_jsonb(NEW)-ARRAY['status','lease_until','error','timing_version','timing_attempt','queue_entered_at','run_started_at',
            'metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt']) IS DISTINCT FROM
            (to_jsonb(OLD)-ARRAY['status','lease_until','error','timing_version','timing_attempt','queue_entered_at','run_started_at',
            'metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt'])
        OR NOT EXISTS(SELECT 1 FROM static_hls_child_output_publications proof JOIN media_outputs o
            ON o.job_id=proof.job_id AND o.attempt=proof.attempt WHERE proof.job_id=OLD.id
            AND proof.owner_id=OLD.owner_id AND proof.attempt=OLD.attempt AND o.status='published'
            AND o.validation_version=4 AND o.owner_id=proof.owner_id AND o.manifest_sha256=proof.manifest_sha256
            AND o.visible_manifest=proof.manifest AND o.segment_count=proof.segment_count AND o.published_at=proof.published_at) THEN
        RAISE EXCEPTION 'static_hls_child_output_success_required';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_child_02_job_output_success_guard BEFORE UPDATE ON media_jobs
    FOR EACH ROW WHEN (static_hls_child_job_output_success_transition(OLD,NEW))
    EXECUTE FUNCTION protect_static_hls_child_job_output_success();

-- Writing admission/failure retain their prior guard without any broad bypass.
-- Only exact published transition and consumed actual disposal use this wrapper.
ALTER FUNCTION protect_static_hls_child_output_write() RENAME TO protect_static_hls_child_output_write_0049;
CREATE FUNCTION protect_static_hls_child_output_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' AND (static_hls_is_child_job(OLD.job_id) OR static_hls_child_identity_reserved(OLD.job_id)) THEN
        IF NOT static_hls_child_output_disposal_allowed(OLD.job_id,OLD.owner_id,OLD.attempt) THEN
            RAISE EXCEPTION 'static_hls_child_output_write_retained';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP='UPDATE' AND OLD.status='writing' AND NEW.status='published'
        AND (static_hls_is_child_job(OLD.job_id) OR static_hls_child_identity_reserved(OLD.job_id)) THEN
        IF current_setting('rainsync.static_hls_child_output_publication',true) IS DISTINCT FROM 'full_child_snapshot_v1'
            OR NOT static_hls_child_output_write_authority_allowed(OLD.job_id,OLD.owner_id,OLD.attempt)
            OR OLD.validation_version<>0 OR NEW.validation_version<>4
            OR (to_jsonb(NEW)-ARRAY['status','validation_version','visible_manifest','ready_segments','manifest_sha256','segment_count','published_at','cleanup_after'])
                IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','validation_version','visible_manifest','ready_segments','manifest_sha256','segment_count','published_at','cleanup_after'])
            OR NOT EXISTS(SELECT 1 FROM static_hls_child_output_publications proof WHERE proof.job_id=NEW.job_id
                AND proof.attempt=NEW.attempt AND proof.owner_id=NEW.owner_id AND proof.relative_dir=NEW.relative_dir
                AND NEW.visible_manifest=proof.manifest AND NEW.ready_segments=proof.segment_count
                AND NEW.manifest_sha256=proof.manifest_sha256 AND NEW.segment_count=proof.segment_count
                AND NEW.published_at=proof.published_at AND NEW.cleanup_after=proof.root_expires_at)
            OR EXISTS(SELECT 1 FROM media_output_files WHERE job_id=NEW.job_id)
            OR EXISTS(SELECT 1 FROM cache_entries WHERE id=NEW.job_id)
            OR EXISTS(SELECT 1 FROM cache_read_leases WHERE cache_id=NEW.job_id) THEN
            RAISE EXCEPTION 'static_hls_child_full_output_proof_required';
        END IF;
        RETURN NEW;
    END IF;
    -- The old function is a trigger function, so preserve its invocation through
    -- the original routed trigger below instead of attempting a direct call.
    RAISE EXCEPTION 'static_hls_child_output_publication_route_required';
END $$;
DROP TRIGGER static_hls_00_child_output_guard ON media_outputs;
CREATE FUNCTION static_hls_child_output_special_transition(old_output media_outputs, new_output media_outputs)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT COALESCE((static_hls_is_child_job(($1).job_id) OR static_hls_child_identity_reserved(($1).job_id))
        AND ($1).status='writing' AND ($2).status='published',false)
$$;
CREATE TRIGGER static_hls_00_child_output_guard_insert BEFORE INSERT ON media_outputs
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_output_write_0049();
CREATE TRIGGER static_hls_00_child_output_guard BEFORE UPDATE ON media_outputs
    FOR EACH ROW WHEN (NOT static_hls_child_output_special_transition(OLD,NEW))
    EXECUTE FUNCTION protect_static_hls_child_output_write_0049();
CREATE TRIGGER static_hls_00_child_output_guard_delete BEFORE DELETE ON media_outputs
    FOR EACH ROW WHEN (static_hls_is_child_job(OLD.job_id) OR static_hls_child_identity_reserved(OLD.job_id))
    EXECUTE FUNCTION protect_static_hls_child_output_write();
CREATE TRIGGER static_hls_01_child_output_publication_guard BEFORE UPDATE ON media_outputs
    FOR EACH ROW WHEN (static_hls_child_output_special_transition(OLD,NEW))
    EXECUTE FUNCTION protect_static_hls_child_output_write();

CREATE OR REPLACE FUNCTION protect_static_hls_child_output_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked boolean=false;
BEGIN
    IF TG_OP<>'INSERT' THEN marked=OLD.purpose='static_hls_child_output' OR static_hls_child_output_reservation_identity(OLD.job_id); END IF;
    IF TG_OP<>'DELETE' THEN marked=marked OR NEW.purpose='static_hls_child_output' OR static_hls_child_output_reservation_identity(NEW.job_id); END IF;
    IF NOT marked THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
    IF TG_OP='DELETE' THEN
        IF NOT static_hls_child_output_disposal_allowed(OLD.job_id,OLD.owner_id,OLD.attempt)
            OR OLD.purpose<>'static_hls_child_output' OR OLD.bytes<>33554432 THEN
            RAISE EXCEPTION 'static_hls_child_output_reservation_retained';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'static_hls_child_output_reservation_immutable'; END IF;
    IF NEW.purpose<>'static_hls_child_output' OR NEW.attempt<>1 OR NEW.bytes<>33554432
        OR NOT static_hls_child_output_write_authority_allowed(NEW.job_id,NEW.owner_id,NEW.attempt) THEN
        RAISE EXCEPTION 'static_hls_child_output_reservation_required';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION check_static_hls_child_output_write_linkage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job uuid; o media_outputs; reservation cache_write_reservations; d static_hls_child_output_disposals;
BEGIN
    -- NEW has the trigger table's concrete row type. PL/pgSQL resolves record
    -- fields while preparing an expression, before boolean short-circuiting.
    IF TG_TABLE_NAME='media_executions' THEN
        IF NEW.kind='delivery' THEN RETURN NULL; END IF;
    END IF;
    IF TG_TABLE_NAME='static_hls_child_output_publications' OR TG_TABLE_NAME='static_hls_child_output_disposals' THEN job=NEW.job_id;
    ELSIF TG_TABLE_NAME='media_jobs' THEN job=NEW.id;
    ELSIF TG_OP='DELETE' THEN job=OLD.job_id; ELSE job=NEW.job_id; END IF;
    IF NOT static_hls_is_child_job(job) AND NOT static_hls_child_identity_reserved(job) THEN RETURN NULL; END IF;
    IF TG_TABLE_NAME='cache_write_reservations' THEN
        IF TG_OP='DELETE' THEN IF OLD.purpose<>'static_hls_child_output' THEN RETURN NULL; END IF;
        ELSIF NEW.purpose<>'static_hls_child_output' THEN RETURN NULL; END IF;
    END IF;
    SELECT * INTO d FROM static_hls_child_output_disposals WHERE job_id=job;
    IF d.id IS NOT NULL THEN
        IF NOT static_hls_child_output_disposal_allowed(d.job_id,d.owner_id,d.attempt)
            OR EXISTS(SELECT 1 FROM media_outputs WHERE job_id=job)
            OR EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id=job)
            OR EXISTS(SELECT 1 FROM media_output_files WHERE job_id=job)
            OR EXISTS(SELECT 1 FROM cache_entries WHERE id=job OR cache_key=job::text)
            OR EXISTS(SELECT 1 FROM cache_read_leases WHERE cache_id=job)
            OR EXISTS(SELECT 1 FROM media_executions WHERE session_id=job AND kind='delivery' AND reaped_at IS NULL) THEN
            RAISE EXCEPTION 'static_hls_child_output_disposal_atomicity_required';
        END IF;
        RETURN NULL;
    END IF;
    IF EXISTS(SELECT 1 FROM static_hls_child_output_publications WHERE job_id=job) THEN
        IF NOT static_hls_child_output_publication_matches(job) THEN
            RAISE EXCEPTION 'static_hls_child_output_publication_atomicity_required';
        END IF;
        RETURN NULL;
    END IF;
    -- Jobs/executions have no output obligation until output admission begins.
    IF TG_TABLE_NAME IN ('media_jobs','media_executions') THEN
        IF NOT EXISTS(SELECT 1 FROM media_outputs WHERE job_id=job) AND
            NOT EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id=job) THEN RETURN NULL; END IF;
    END IF;
    SELECT * INTO reservation FROM cache_write_reservations WHERE job_id=job;
    SELECT * INTO o FROM media_outputs WHERE job_id=job AND attempt=1;
    IF reservation.job_id IS NULL OR o.job_id IS NULL OR reservation.purpose<>'static_hls_child_output'
        OR reservation.bytes<>33554432 OR reservation.attempt IS DISTINCT FROM o.attempt OR reservation.owner_id IS DISTINCT FROM o.owner_id
        OR o.status NOT IN ('writing','failed') OR o.validation_version<>0
        OR NOT static_hls_child_output_write_owner_allowed(job,o.owner_id,o.attempt) THEN
        RAISE EXCEPTION 'static_hls_child_output_write_atomicity_required';
    END IF;
    IF TG_OP='INSERT' AND TG_TABLE_NAME IN ('media_outputs','cache_write_reservations') AND
        (o.status<>'writing' OR NOT static_hls_child_output_write_authority_allowed(job,o.owner_id,o.attempt)) THEN
        RAISE EXCEPTION 'static_hls_child_output_write_authority_required';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER static_hls_child_output_publication_linkage AFTER INSERT ON static_hls_child_output_publications
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_child_output_write_linkage();
CREATE CONSTRAINT TRIGGER static_hls_child_output_disposal_linkage AFTER INSERT ON static_hls_child_output_disposals
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_child_output_write_linkage();
CREATE CONSTRAINT TRIGGER static_hls_child_output_job_linkage AFTER UPDATE ON media_jobs
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_child_output_write_linkage();
CREATE CONSTRAINT TRIGGER static_hls_child_output_execution_linkage AFTER UPDATE ON media_executions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_child_output_write_linkage();
