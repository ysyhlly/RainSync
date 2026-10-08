-- Original typed claimed-child OUTPUT WRITE admission only. No file proofs,
-- successful validation, output-ready/publication, cache/read or grant opening.
-- SQL GUCs are the cooperative mixed-binary fence, never filesystem custody.
-- The actual Rust claim and its same-capture EncoderInputLease are compulsory.
--
-- Reservation admission uses authority/source prefix -> cache_budget -> capture
-- and session groups (UUID order) -> job/output/reservation. Physical IO is
-- outside these locks. Failure bookkeeping is budget-first and takes no current
-- authority prefix; it retains both reservations and all original owner tuples.
LOCK TABLE cache_write_reservations IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE media_outputs IN ACCESS EXCLUSIVE MODE NOWAIT;

-- Do not retag, migrate or release any preexisting obligation. The existing
-- snapshot/release helpers delete ONLY purpose='media_job'; all budget sums
-- continue counting this new purpose alongside the full 128 MiB capture input.
ALTER TABLE cache_write_reservations DROP CONSTRAINT cache_write_reservations_purpose_check;
ALTER TABLE cache_write_reservations ADD CONSTRAINT cache_write_reservations_purpose_check
    CHECK(purpose IN ('media_job','static_hls_capture','static_hls_child_output'));
ALTER TABLE cache_write_reservations ADD CONSTRAINT static_hls_child_output_reservation_shape
    CHECK(purpose<>'static_hls_child_output' OR (attempt=1 AND bytes=33554432));

-- Separate owner identity from live write authority: only the former permits
-- terminal bookkeeping after cancellation/expiry. Neither predicate grants
-- positive process drainage, output-file disposal or reservation release.
CREATE FUNCTION static_hls_child_output_write_owner_allowed(job uuid, owner uuid, number bigint)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT static_hls_pending_reader_supported() AND EXISTS(
        SELECT 1 FROM media_jobs j JOIN playback_requests r ON r.session_id=j.session_id
        JOIN static_hls_captures c ON c.session_id=r.session_id
        JOIN static_hls_database_binding db ON db.singleton
        JOIN media_executions e ON e.job_id=j.id AND e.attempt=j.attempt
        WHERE j.id=$1 AND j.attempt=$3 AND $3=1 AND $2 IS NOT NULL
        AND j.status IN ('running','failed','cancelled')
        AND (j.owner_id=$2 OR (j.status<>'running' AND j.owner_id IS NULL))
        AND r.static_hls_parent_capture_id IS NOT NULL AND c.publication_phase='published_child'
        AND static_hls_child_job_matches(j,r,c)
        AND c.worker_instance::text=current_setting('rainsync.static_hls_worker_instance',true)
        AND c.owner_id::text=current_setting('rainsync.static_hls_child_capture_owner',true)
        AND c.database_id=db.id AND r.static_hls_database_id=db.id
        AND $2::text=current_setting('rainsync.static_hls_child_job_owner',true)
        AND e.id::text=current_setting('rainsync.static_hls_child_execution_id',true)
        AND e.session_id=j.session_id AND e.kind='job' AND e.owner_id=$2)
$$;
CREATE FUNCTION static_hls_child_output_write_authority_allowed(job uuid, owner uuid, number bigint)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT static_hls_child_output_write_owner_allowed($1,$2,$3)
        AND static_hls_child_job_attempt_authority_allowed($1,$2,$3)
$$;

-- Preserve the 0047 capture-reservation guard body, including exact input
-- disposal. Only the distinct child session/job slot is routed away from it.
-- A reserved child operation without a real capture remains fail-closed too.
CREATE FUNCTION static_hls_child_output_reservation_identity(identity uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT static_hls_is_child_job($1) OR static_hls_is_child_session($1)
        OR (static_hls_child_identity_reserved($1) AND NOT EXISTS(
            SELECT 1 FROM static_hls_captures WHERE id=$1
                AND publication_phase IN ('pending_child','published_child')))
$$;
DROP TRIGGER static_hls_00_child_reservation_guard ON cache_write_reservations;
CREATE TRIGGER static_hls_00_child_reservation_guard_insert BEFORE INSERT ON cache_write_reservations
    FOR EACH ROW WHEN (NOT static_hls_child_output_reservation_identity(NEW.job_id))
    EXECUTE FUNCTION protect_static_hls_child_reservation();
CREATE TRIGGER static_hls_00_child_reservation_guard BEFORE UPDATE ON cache_write_reservations
    FOR EACH ROW WHEN (NOT static_hls_child_output_reservation_identity(OLD.job_id)
        AND NOT static_hls_child_output_reservation_identity(NEW.job_id))
    EXECUTE FUNCTION protect_static_hls_child_reservation();
CREATE TRIGGER static_hls_00_child_reservation_guard_delete BEFORE DELETE ON cache_write_reservations
    FOR EACH ROW WHEN (NOT static_hls_child_output_reservation_identity(OLD.job_id))
    EXECUTE FUNCTION protect_static_hls_child_reservation();

CREATE FUNCTION protect_static_hls_child_output_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked boolean=false;
BEGIN
    IF TG_OP<>'INSERT' THEN marked=OLD.purpose='static_hls_child_output'
        OR static_hls_child_output_reservation_identity(OLD.job_id); END IF;
    IF TG_OP<>'DELETE' THEN marked=marked OR NEW.purpose='static_hls_child_output'
        OR static_hls_child_output_reservation_identity(NEW.job_id); END IF;
    IF NOT marked THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
    -- There is deliberately no released state in this slice. Input/encoder
    -- reaped_at, any deadline, scheduling stop or missing local registry cannot
    -- release the independent output directory's accounting obligation.
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'static_hls_child_output_reservation_retained'; END IF;
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'static_hls_child_output_reservation_immutable'; END IF;
    IF NEW.purpose<>'static_hls_child_output' OR NEW.attempt<>1 OR NEW.bytes<>33554432
        OR NOT static_hls_child_output_write_authority_allowed(NEW.job_id,NEW.owner_id,NEW.attempt) THEN
        RAISE EXCEPTION 'static_hls_child_output_reservation_required';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_01_child_output_reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON cache_write_reservations
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_output_reservation();

-- Keep the original Stage A/parent output guard body and its semantics. Its
-- legacy reader-1 early RETURN NULL must not skip a typed child INSERT; route
-- retained child identities to the stricter dedicated write-only guard below.
DROP TRIGGER static_hls_output_guard ON media_outputs;
CREATE TRIGGER static_hls_output_guard_insert BEFORE INSERT ON media_outputs
    FOR EACH ROW WHEN (NOT static_hls_is_child_job(NEW.job_id)
        AND NOT static_hls_child_identity_reserved(NEW.job_id))
    EXECUTE FUNCTION protect_static_hls_job_artifact();
CREATE TRIGGER static_hls_output_guard BEFORE UPDATE ON media_outputs
    FOR EACH ROW WHEN (NOT static_hls_is_child_job(OLD.job_id)
        AND NOT static_hls_child_identity_reserved(OLD.job_id)
        AND NOT static_hls_is_child_job(NEW.job_id)
        AND NOT static_hls_child_identity_reserved(NEW.job_id))
    EXECUTE FUNCTION protect_static_hls_job_artifact();
CREATE TRIGGER static_hls_output_guard_delete BEFORE DELETE ON media_outputs
    FOR EACH ROW WHEN (NOT static_hls_is_child_job(OLD.job_id)
        AND NOT static_hls_child_identity_reserved(OLD.job_id))
    EXECUTE FUNCTION protect_static_hls_job_artifact();
DROP TRIGGER static_hls_00_child_output_guard ON media_outputs;
CREATE FUNCTION protect_static_hls_child_output_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked boolean=false; e media_executions;
BEGIN
    IF TG_OP<>'INSERT' THEN marked=static_hls_is_child_job(OLD.job_id)
        OR static_hls_child_identity_reserved(OLD.job_id); END IF;
    IF TG_OP<>'DELETE' THEN marked=marked OR static_hls_is_child_job(NEW.job_id)
        OR static_hls_child_identity_reserved(NEW.job_id); END IF;
    IF NOT marked THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'static_hls_child_output_write_retained'; END IF;
    IF NOT static_hls_child_output_write_owner_allowed(NEW.job_id,NEW.owner_id,NEW.attempt)
        OR NEW.attempt<>1 OR NEW.relative_dir IS DISTINCT FROM NEW.job_id::text||'/1'
        OR NEW.validation_version IS DISTINCT FROM 0
        OR NEW.visible_manifest IS NOT NULL OR NEW.ready_segments<>0
        OR NEW.manifest_sha256 IS NOT NULL OR NEW.segment_count IS NOT NULL OR NEW.published_at IS NOT NULL
        OR NEW.cleanup_owner IS NOT NULL OR NEW.cleanup_until IS NOT NULL
        OR NOT isfinite(NEW.created_at) OR NOT isfinite(NEW.cleanup_after)
        OR NEW.created_at>clock_timestamp()
        OR EXISTS(SELECT 1 FROM media_output_files WHERE job_id=NEW.job_id)
        OR EXISTS(SELECT 1 FROM cache_entries WHERE id=NEW.job_id)
        OR EXISTS(SELECT 1 FROM cache_read_leases WHERE cache_id=NEW.job_id)
        OR NOT EXISTS(SELECT 1 FROM cache_write_reservations reservation WHERE reservation.job_id=NEW.job_id
            AND reservation.owner_id=NEW.owner_id AND reservation.attempt=NEW.attempt
            AND reservation.bytes=33554432 AND reservation.purpose='static_hls_child_output') THEN
        RAISE EXCEPTION 'static_hls_child_output_write_shape_required';
    END IF;
    SELECT * INTO e FROM media_executions WHERE job_id=NEW.job_id AND attempt=NEW.attempt
        AND owner_id=NEW.owner_id AND id::text=current_setting('rainsync.static_hls_child_execution_id',true);
    IF e.id IS NULL OR NEW.created_at<e.created_at THEN
        RAISE EXCEPTION 'static_hls_child_output_execution_required';
    END IF;
    IF TG_OP='INSERT' THEN
        IF NEW.status<>'writing' OR NOT static_hls_child_output_write_authority_allowed(NEW.job_id,NEW.owner_id,NEW.attempt) THEN
            RAISE EXCEPTION 'static_hls_child_output_write_authority_required';
        END IF;
    ELSE
        -- Original owner can record failure after lease/root/authority expiry.
        -- Identity and every other field remain unchanged; no successful state,
        -- visible fragment, validation marker or cleanup owner may be introduced.
        IF OLD.status NOT IN ('writing','failed') OR NEW.status<>'failed'
            OR (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN
            RAISE EXCEPTION 'static_hls_child_output_write_immutable';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_00_child_output_guard BEFORE INSERT OR UPDATE OR DELETE ON media_outputs
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_output_write();

-- Admission is atomic even if a caller omitted either INSERT or its final Rust
-- recheck. The original 0047 input-publication linkage and 0048 compulsory job
-- receipt triggers remain installed unchanged. No public read predicate changes.
CREATE FUNCTION check_static_hls_child_output_write_linkage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job uuid; o media_outputs; reservation cache_write_reservations;
    admission boolean=false;
BEGIN
    IF TG_OP='DELETE' THEN job=OLD.job_id; ELSE job=NEW.job_id; END IF;
    IF NOT static_hls_is_child_job(job) AND NOT static_hls_child_identity_reserved(job) THEN RETURN NULL; END IF;
    -- Input capture reservation rows are checked by unchanged 0047 constraints.
    IF TG_TABLE_NAME='cache_write_reservations' THEN
        IF TG_OP='DELETE' THEN
            IF OLD.purpose<>'static_hls_child_output' THEN RETURN NULL; END IF;
        ELSIF NEW.purpose<>'static_hls_child_output' THEN RETURN NULL;
        END IF;
    END IF;
    SELECT * INTO reservation FROM cache_write_reservations WHERE job_id=job;
    SELECT * INTO o FROM media_outputs WHERE job_id=job AND attempt=1;
    IF reservation.job_id IS NULL OR o.job_id IS NULL
        OR reservation.purpose<>'static_hls_child_output' OR reservation.bytes<>33554432
        OR reservation.attempt IS DISTINCT FROM o.attempt OR reservation.owner_id IS DISTINCT FROM o.owner_id
        OR o.status NOT IN ('writing','failed') OR o.validation_version<>0
        OR NOT static_hls_child_output_write_owner_allowed(job,o.owner_id,o.attempt) THEN
        RAISE EXCEPTION 'static_hls_child_output_write_atomicity_required';
    END IF;
    admission=TG_OP='INSERT';
    IF admission AND (o.status<>'writing'
        OR NOT static_hls_child_output_write_authority_allowed(job,o.owner_id,o.attempt)) THEN
        RAISE EXCEPTION 'static_hls_child_output_write_authority_required';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER static_hls_child_output_write_linkage AFTER INSERT OR UPDATE OR DELETE ON media_outputs
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_child_output_write_linkage();
CREATE CONSTRAINT TRIGGER static_hls_child_output_reservation_linkage AFTER INSERT OR UPDATE OR DELETE ON cache_write_reservations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_child_output_write_linkage();

-- Intentionally leave static_hls_child_output_authority_allowed(session)=false,
-- every output-file/cache/read-lease guard, successful-job guard and existing
-- Stage A/parent/capture protection intact. No validation_version=4 is invented.
