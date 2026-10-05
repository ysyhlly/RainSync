-- Stage B child custody, atomic publication and QUEUED admission only.
-- No public activation, child encoder dispatch, output publication or output
-- read authority is enabled here. The original local owner/witness is required
-- by the Rust consumers; SQL proves relations, not stream/process/file custody.
--
-- Runtime order (all physical work is outside the transaction): the shared
-- child_claim authority prefix locks room/snapshot/member/login/user, requests
-- in UUID order, viewer, source then media. Admission takes cache_budget before
-- capture/session/reservation suffixes; disposal retains budget->capture->
-- reservation order. Verification/publication/queue never acquire budget after
-- capture locks. Their capture and session groups are each UUID-ordered, then
-- queue advisory lock 72614932 and job rows. Trigger predicates are read-only
-- and never acquire an authority-prefix lock while holding a suffix row.
LOCK TABLE playback_requests IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE static_hls_captures IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE playback_sessions IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE media_jobs IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE cache_write_reservations IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE playback_preparations IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE media_executions IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE media_outputs IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE media_output_files IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE cache_entries IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE cache_read_leases IN ACCESS EXCLUSIVE MODE NOWAIT;

ALTER TABLE static_hls_captures
    ADD COLUMN child_position_ms double precision,
    ADD COLUMN child_selected_audio jsonb;
ALTER TABLE static_hls_captures DROP CONSTRAINT static_hls_captures_publication_phase_check;
ALTER TABLE static_hls_captures ADD CONSTRAINT static_hls_captures_publication_phase_check
    CHECK(publication_phase IN ('stage_a','pending_parent','published_parent','pending_child','published_child'));
ALTER TABLE static_hls_captures DROP CONSTRAINT static_hls_pending_capture_shape;
ALTER TABLE static_hls_captures ADD CONSTRAINT static_hls_pending_capture_shape CHECK(
    (publication_phase='stage_a' AND num_nonnulls(input_sha256,worker_instance,database_id,reader_version,recipe_version,root_digest)=0)
    OR (publication_phase IN ('pending_parent','published_parent','pending_child','published_child')
        AND input_sha256 IS NOT NULL AND input_sha256 ~ '^[0-9a-f]{64}$'
        AND worker_instance IS NOT NULL AND database_id IS NOT NULL
        AND reader_version IS NOT NULL AND reader_version=2 AND recipe_version IS NOT NULL AND recipe_version=1
        AND (root_digest IS NULL OR root_digest ~ '^[0-9a-f]{64}$')
        AND ((root_digest IS NULL)=(inventory_encrypted IS NULL))
        AND (state<>'verified' OR root_digest IS NOT NULL)));
ALTER TABLE static_hls_captures ADD CONSTRAINT static_hls_child_recipe_shape CHECK(
    (publication_phase NOT IN ('pending_child','published_child')
        AND child_position_ms IS NULL AND child_selected_audio IS NULL)
    OR (publication_phase IN ('pending_child','published_child')
        AND child_position_ms IS NOT NULL AND child_position_ms>=0 AND child_position_ms<=9007199254740991
        AND child_selected_audio IS NOT NULL AND jsonb_typeof(child_selected_audio)='object'
        AND child_selected_audio ?& ARRAY['kind','stream_index']
        AND child_selected_audio-ARRAY['kind','stream_index']='{}'::jsonb
        AND child_selected_audio->'kind'='"single"'::jsonb
        AND jsonb_typeof(child_selected_audio->'stream_index')='number'
        AND child_selected_audio->>'stream_index' ~ '^[0-9]+$'
        AND (child_selected_audio->>'stream_index')::numeric<=4294967295));
ALTER TABLE static_hls_captures DROP CONSTRAINT static_hls_parent_publication_shape;
ALTER TABLE static_hls_captures ADD CONSTRAINT static_hls_parent_publication_shape CHECK(
    (publication_phase NOT IN ('published_parent','published_child') AND published_resource IS NULL AND published_at IS NULL)
    OR (publication_phase IN ('published_parent','published_child') AND published_resource IS NOT NULL AND published_at IS NOT NULL
        AND jsonb_typeof(published_resource)='object' AND octet_length(published_resource::text)<=262144
        AND root_digest IS NOT NULL AND inventory_encrypted IS NOT NULL
        AND state IN ('verified','cancelled','disposed') AND published_at>=created_at AND published_at<expires_at));
DROP INDEX static_hls_pending_capture_request;
CREATE UNIQUE INDEX static_hls_pending_capture_request ON static_hls_captures(session_id)
    WHERE publication_phase IN ('pending_parent','published_parent','pending_child','published_child');

CREATE FUNCTION static_hls_is_child_session(session uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS(SELECT 1 FROM playback_requests r WHERE r.session_id=$1 AND r.static_hls_parent_capture_id IS NOT NULL)
$$;
CREATE FUNCTION static_hls_is_child_job(job uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS(SELECT 1 FROM media_jobs j JOIN playback_requests r ON r.session_id=j.session_id
        WHERE j.id=$1 AND r.static_hls_parent_capture_id IS NOT NULL)
$$;

-- Reserve both child operation and session identities against generic jobs,
-- including a NULL or unrelated session_id and a downgraded generic spec.
CREATE FUNCTION static_hls_child_identity_reserved(identity uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS(SELECT 1 FROM playback_requests r WHERE r.static_hls_parent_capture_id IS NOT NULL
        AND $1 IN (r.session_id,r.static_hls_operation_id))
$$;

-- Historical parent binding intentionally does not require a deliverable parent.
-- Stop/failure/expiry never substitute for the positive original disposal row.
CREATE FUNCTION static_hls_child_parent_binding_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM playback_requests child
        JOIN static_hls_captures parent ON parent.id=child.static_hls_parent_capture_id
        JOIN playback_requests original ON original.session_id=parent.session_id
        JOIN playback_sessions retired ON retired.id=parent.session_id
        JOIN static_hls_database_binding db ON db.singleton
        WHERE child.session_id=$1 AND child.static_hls_input_version=1
        AND original.static_hls_input_version=1 AND original.static_hls_parent_capture_id IS NULL
        AND original.status='failed' AND original.response_encrypted IS NULL
        AND original.error_status=409 AND original.error_code='static_hls_parent_claimed'
        AND parent.publication_phase='published_parent' AND parent.state='disposed'
        AND parent.disposed_at IS NOT NULL AND parent.streams_closed_at IS NOT NULL
        AND parent.process_closed_at IS NOT NULL AND parent.files_removed_at IS NOT NULL
        AND parent.process_disposition IN ('never_started','reaped')
        AND parent.disposed_at>=parent.created_at AND parent.disposed_at<=clock_timestamp()
        AND parent.streams_closed_at>=parent.created_at AND parent.streams_closed_at<=parent.disposed_at
        AND parent.process_closed_at>=parent.created_at AND parent.process_closed_at<=parent.disposed_at
        AND parent.files_removed_at>=parent.created_at AND parent.files_removed_at<=parent.disposed_at
        AND parent.id=original.static_hls_operation_id AND parent.user_id=original.user_id
        AND parent.request_owner_epoch=original.owner_epoch AND parent.input_sha256=original.static_hls_input_sha256
        AND parent.worker_instance=original.static_hls_worker_instance AND parent.database_id=original.static_hls_database_id
        AND parent.reader_version=2 AND parent.recipe_version=1
        AND parent.root_digest IS NOT NULL AND parent.inventory_encrypted IS NOT NULL
        AND parent.published_at IS NOT NULL AND static_hls_parent_resource_matches(parent.published_resource,original)
        AND retired.stopped AND retired.static_hls_capture_id=parent.id
        AND retired.resource=parent.published_resource||jsonb_build_object('static_hls_capture_id',parent.id)
        AND ROW(retired.user_id,retired.room_id,retired.media_id,retired.generation,retired.lifecycle_epoch,
                retired.viewer_id,retired.plan_generation,retired.auth_login_hash,retired.auth_membership_epoch)
            IS NOT DISTINCT FROM
            ROW(original.user_id,original.room_id,original.static_hls_media_id,original.static_hls_media_generation,
                original.lifecycle_epoch,original.viewer_id,original.plan_generation,original.auth_login_hash,original.auth_membership_epoch)
        AND retired.expires_at<=parent.expires_at
        AND ROW(child.user_id,child.room_id,child.lifecycle_epoch,child.auth_login_hash,child.auth_membership_epoch,
                child.viewer_id,child.static_hls_media_id,child.static_hls_media_generation,child.static_hls_source_id,
                child.static_hls_source_revision,child.static_hls_source_generation,child.static_hls_worker_instance,child.static_hls_database_id)
            IS NOT DISTINCT FROM
            ROW(original.user_id,original.room_id,original.lifecycle_epoch,original.auth_login_hash,original.auth_membership_epoch,
                original.viewer_id,original.static_hls_media_id,original.static_hls_media_generation,original.static_hls_source_id,
                original.static_hls_source_revision,original.static_hls_source_generation,parent.worker_instance,parent.database_id)
        AND child.static_hls_database_id=db.id AND child.plan_generation>original.plan_generation
        AND child.static_hls_root_expires_at=original.static_hls_root_expires_at
        AND child.static_hls_root_expires_at=parent.expires_at AND child.created_at>=parent.published_at
        AND child.session_id NOT IN (parent.id,parent.session_id)
        AND child.static_hls_operation_id NOT IN (parent.id,parent.session_id)
        AND NOT EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id IN (parent.id,parent.session_id))
        AND NOT EXISTS(SELECT 1 FROM cache_read_leases WHERE cache_id IN (parent.id,parent.session_id))
        AND NOT EXISTS(SELECT 1 FROM upstream_reservations WHERE id=parent.session_id AND closed_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM media_executions WHERE session_id=parent.session_id AND reaped_at IS NULL))
$$;
CREATE FUNCTION static_hls_pending_child_request_authority_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT static_hls_pending_request_authority_allowed($1) AND static_hls_child_parent_binding_allowed($1)
$$;
CREATE FUNCTION static_hls_child_capture_matches(capture static_hls_captures, request playback_requests)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT COALESCE(($2).static_hls_parent_capture_id IS NOT NULL
        AND ($1).publication_phase IN ('pending_child','published_child')
        AND ($1).session_id=($2).session_id AND ($1).id=($2).static_hls_operation_id
        AND ($1).user_id=($2).user_id AND ($1).request_owner_epoch=($2).owner_epoch
        AND ($1).input_sha256=($2).static_hls_input_sha256 AND ($1).worker_instance=($2).static_hls_worker_instance
        AND ($1).database_id=($2).static_hls_database_id AND ($1).expires_at=($2).static_hls_root_expires_at
        AND ($1).reader_version=2 AND ($1).recipe_version=1
        AND ($1).resource_authority=jsonb_build_object('media_id',($2).static_hls_media_id,'source_id',($2).static_hls_source_id,
            'source_policy_revision',($2).static_hls_source_revision,'media_source_generation',($2).static_hls_source_generation),false)
$$;
CREATE FUNCTION static_hls_pending_child_capture_authority_allowed(capture uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM static_hls_captures c JOIN playback_requests r ON r.session_id=c.session_id
        JOIN static_hls_captures parent ON parent.id=r.static_hls_parent_capture_id
        WHERE c.id=$1 AND c.publication_phase='pending_child' AND c.state IN ('capturing','verified')
        AND c.disposed_at IS NULL AND c.expires_at>clock_timestamp()
        AND static_hls_child_capture_matches(c,r)
        AND (c.root_digest IS NULL OR c.root_digest=parent.root_digest)
        AND static_hls_pending_child_request_authority_allowed(r.session_id))
$$;
CREATE FUNCTION static_hls_child_resource_matches(resource jsonb, request playback_requests, capture static_hls_captures)
RETURNS boolean LANGUAGE sql STABLE AS $$
    -- Reuse only the closed encrypted-wrapper shape, never parent authority.
    SELECT static_hls_child_capture_matches($3,$2) AND static_hls_parent_resource_matches($1,$2)
$$;

-- Current child grant facts are separate from input custody and preparation.
-- This predicate alone NEVER grants an output read after input disposal.
CREATE FUNCTION static_hls_child_grant_authority_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM playback_requests r JOIN static_hls_captures c ON c.session_id=r.session_id
        JOIN static_hls_captures parent ON parent.id=r.static_hls_parent_capture_id
        JOIN playback_sessions p ON p.id=r.session_id
        JOIN rooms room ON room.id=r.room_id JOIN room_snapshots snap ON snap.room_id=r.room_id
        JOIN sources source ON source.id=r.static_hls_source_id JOIN media_items m ON m.id=r.static_hls_media_id
        JOIN static_hls_database_binding db ON db.singleton
        WHERE r.session_id=$1 AND r.status='completed' AND r.response_encrypted IS NOT NULL
        AND r.static_hls_input_version=1 AND r.static_hls_database_id=db.id
        AND c.publication_phase='published_child' AND c.state IN ('verified','disposed')
        AND c.root_digest=parent.root_digest AND c.inventory_encrypted IS NOT NULL
        AND c.published_at IS NOT NULL AND c.published_at>=r.created_at
        AND static_hls_child_capture_matches(c,r) AND static_hls_child_resource_matches(c.published_resource,r,c)
        AND static_hls_child_parent_binding_allowed(r.session_id)
        AND p.static_hls_capture_id=c.id AND p.resource=c.published_resource||jsonb_build_object('static_hls_capture_id',c.id)
        AND ROW(p.user_id,p.room_id,p.media_id,p.generation,p.lifecycle_epoch,p.viewer_id,p.plan_generation,p.auth_login_hash,p.auth_membership_epoch)
            IS NOT DISTINCT FROM ROW(r.user_id,r.room_id,r.static_hls_media_id,r.static_hls_media_generation,r.lifecycle_epoch,
                r.viewer_id,r.plan_generation,r.auth_login_hash,r.auth_membership_epoch)
        AND NOT p.stopped AND p.expires_at>clock_timestamp() AND p.expires_at<=c.expires_at
        AND c.expires_at>clock_timestamp() AND room.lifecycle='active' AND room.lifecycle_epoch=r.lifecycle_epoch
        AND (snap.state->>'media_id')::uuid=m.id AND (snap.state->>'media_generation')::bigint=r.static_hls_media_generation
        AND m.available AND m.source_id=source.id AND source.kind='http'
        AND source.access_policy_revision=r.static_hls_source_revision AND m.preview_generation=r.static_hls_source_generation
        AND playback_origin_allowed(r.user_id,r.room_id,r.auth_login_hash,r.auth_membership_epoch)
        AND EXISTS(SELECT 1 FROM sessions login WHERE login.user_id=r.user_id AND login.token_hash=r.auth_login_hash
            AND login.expires_at>=r.static_hls_root_expires_at)
        AND playback_source_authority_allowed(m.id,c.published_resource)
        AND EXISTS(SELECT 1 FROM playback_viewer_plans v WHERE v.user_id=r.user_id AND v.room_id=r.room_id
            AND v.viewer_id=r.viewer_id AND v.auth_login_hash=r.auth_login_hash AND v.plan_generation=r.plan_generation))
$$;
CREATE FUNCTION static_hls_published_child_capture_authority_allowed(capture uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM static_hls_captures c WHERE c.id=$1 AND c.publication_phase='published_child'
        AND c.state='verified' AND c.disposed_at IS NULL AND static_hls_child_grant_authority_allowed(c.session_id)
        AND EXISTS(SELECT 1 FROM cache_write_reservations reservation WHERE reservation.job_id=c.id
            AND reservation.owner_id=c.owner_id AND reservation.attempt=0 AND reservation.bytes=134217728
            AND reservation.purpose='static_hls_capture'))
$$;
CREATE FUNCTION static_hls_child_queue_authority_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    -- Deliberately no media_jobs dependency: called before the only INSERT.
    SELECT static_hls_pending_reader_supported() AND static_hls_child_grant_authority_allowed($1)
        AND EXISTS(SELECT 1 FROM playback_requests r JOIN static_hls_captures c ON c.session_id=r.session_id
            JOIN playback_preparations prep ON prep.session_id=r.session_id
            WHERE r.session_id=$1 AND r.lease_until>clock_timestamp() AND r.static_hls_prepare_expires_at>clock_timestamp()
            AND r.preparation_drained_at IS NULL AND prep.drained_at IS NULL
            AND ROW(prep.owner_epoch,prep.user_id,prep.room_id,prep.lifecycle_epoch,prep.created_at)
                IS NOT DISTINCT FROM ROW(r.owner_epoch,r.user_id,r.room_id,r.lifecycle_epoch,r.created_at)
            AND static_hls_published_child_capture_authority_allowed(c.id))
$$;
CREATE FUNCTION static_hls_child_job_matches(job media_jobs, request playback_requests, capture static_hls_captures)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT COALESCE(($1).id=($2).session_id AND ($1).session_id=($2).session_id AND ($1).logical_queue='static_hls_v1'
        AND static_hls_child_capture_matches($3,$2) AND ($3).root_digest IS NOT NULL
        AND octet_length(($1).spec::text)<=4096
        AND ($1).spec=jsonb_build_object('kind','static_hls_child','reader_version',2,'recipe_version',1,'input_version',1,'graph_version',1,
            'capture_id',($3).id,'input_sha256',($3).input_sha256,'root_digest',($3).root_digest,
            'worker_instance',($3).worker_instance,'position_ms',($3).child_position_ms,
            'selected_audio',($3).child_selected_audio,'estimated_output_bytes',33554432),false)
$$;
CREATE FUNCTION static_hls_child_output_authority_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    -- Reserved independent OUTPUT lifetime gate. The current generic output
    -- validation_version does not attest sequential full-snapshot child decode,
    -- absolute trim, child recipe or the original encode supervisor's reaping.
    -- No such output receipt/publisher is implemented in this slice. Positive
    -- input disposal and a live root grant therefore remain INSUFFICIENT.
    -- A future migration must bind that explicit output proof, exact job/attempt,
    -- owner, files/manifest, cache/read custody and current grant before opening
    -- this predicate. Do not replace this with capture.state='disposed'.
    SELECT false
$$;

-- Keep every existing parent/Stage A trigger body. Route only retained child
-- rows to their own guards; both OLD and NEW identities participate on UPDATE,
-- so a generic row cannot escape by changing its session/phase.
DROP TRIGGER static_hls_capture_guard ON static_hls_captures;
CREATE TRIGGER static_hls_capture_guard_insert BEFORE INSERT ON static_hls_captures
    FOR EACH ROW WHEN (NEW.publication_phase NOT IN ('pending_child','published_child')) EXECUTE FUNCTION protect_static_hls_capture();
CREATE TRIGGER static_hls_capture_guard BEFORE UPDATE ON static_hls_captures
    FOR EACH ROW WHEN (OLD.publication_phase NOT IN ('pending_child','published_child') AND NEW.publication_phase NOT IN ('pending_child','published_child')) EXECUTE FUNCTION protect_static_hls_capture();
CREATE TRIGGER static_hls_capture_guard_delete BEFORE DELETE ON static_hls_captures
    FOR EACH ROW WHEN (OLD.publication_phase NOT IN ('pending_child','published_child')) EXECUTE FUNCTION protect_static_hls_capture();
DROP TRIGGER static_hls_request_guard ON playback_requests;
CREATE TRIGGER static_hls_request_guard_insert BEFORE INSERT ON playback_requests
    FOR EACH ROW WHEN (NEW.static_hls_parent_capture_id IS NULL) EXECUTE FUNCTION protect_static_hls_request();
CREATE TRIGGER static_hls_request_guard BEFORE UPDATE ON playback_requests
    FOR EACH ROW WHEN (OLD.static_hls_parent_capture_id IS NULL AND NEW.static_hls_parent_capture_id IS NULL) EXECUTE FUNCTION protect_static_hls_request();
CREATE TRIGGER static_hls_request_guard_delete BEFORE DELETE ON playback_requests
    FOR EACH ROW WHEN (OLD.static_hls_parent_capture_id IS NULL) EXECUTE FUNCTION protect_static_hls_request();
DROP TRIGGER static_hls_session_guard ON playback_sessions;
CREATE TRIGGER static_hls_session_guard_insert BEFORE INSERT ON playback_sessions
    FOR EACH ROW WHEN (NOT static_hls_is_child_session(NEW.id)) EXECUTE FUNCTION protect_static_hls_session();
CREATE TRIGGER static_hls_session_guard BEFORE UPDATE ON playback_sessions
    FOR EACH ROW WHEN (NOT static_hls_is_child_session(OLD.id) AND NOT static_hls_is_child_session(NEW.id)) EXECUTE FUNCTION protect_static_hls_session();
CREATE TRIGGER static_hls_session_guard_delete BEFORE DELETE ON playback_sessions
    FOR EACH ROW WHEN (NOT static_hls_is_child_session(OLD.id)) EXECUTE FUNCTION protect_static_hls_session();
DROP TRIGGER static_hls_job_guard ON media_jobs;
CREATE TRIGGER static_hls_job_guard_insert BEFORE INSERT ON media_jobs
    FOR EACH ROW WHEN (NOT static_hls_is_child_session(NEW.session_id) AND NOT static_hls_child_identity_reserved(NEW.id) AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard BEFORE UPDATE ON media_jobs
    FOR EACH ROW WHEN (NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_is_child_session(NEW.session_id) AND NOT static_hls_child_identity_reserved(OLD.id) AND NOT static_hls_child_identity_reserved(NEW.id) AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child' AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard_delete BEFORE DELETE ON media_jobs
    FOR EACH ROW WHEN (NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_child_identity_reserved(OLD.id) AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();

CREATE FUNCTION static_hls_pending_child_publication_authority_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT static_hls_pending_child_request_authority_allowed($1) AND EXISTS(
        SELECT 1 FROM playback_requests r JOIN static_hls_captures c ON c.session_id=r.session_id
        JOIN static_hls_captures parent ON parent.id=r.static_hls_parent_capture_id
        JOIN playback_sessions p ON p.id=r.session_id
        WHERE r.session_id=$1 AND c.publication_phase='published_child' AND c.state='verified' AND c.disposed_at IS NULL
        AND static_hls_child_capture_matches(c,r) AND c.root_digest=parent.root_digest
        AND static_hls_child_resource_matches(c.published_resource,r,c)
        AND p.static_hls_capture_id=c.id AND p.resource=c.published_resource||jsonb_build_object('static_hls_capture_id',c.id)
        AND ROW(p.user_id,p.room_id,p.media_id,p.generation,p.lifecycle_epoch,p.viewer_id,p.plan_generation,p.auth_login_hash,p.auth_membership_epoch)
            IS NOT DISTINCT FROM ROW(r.user_id,r.room_id,r.static_hls_media_id,r.static_hls_media_generation,r.lifecycle_epoch,
                r.viewer_id,r.plan_generation,r.auth_login_hash,r.auth_membership_epoch)
        AND NOT p.stopped AND p.expires_at>clock_timestamp() AND p.expires_at<=c.expires_at
        AND EXISTS(SELECT 1 FROM cache_write_reservations reservation WHERE reservation.job_id=c.id
            AND reservation.owner_id=c.owner_id AND reservation.attempt=0 AND reservation.bytes=134217728
            AND reservation.purpose='static_hls_capture'))
$$;

CREATE OR REPLACE FUNCTION protect_static_hls_child_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent static_hls_captures; original playback_requests;
BEGIN
    IF TG_OP='DELETE' THEN
        IF OLD.static_hls_parent_capture_id IS NOT NULL THEN RAISE EXCEPTION 'static_hls_child_claim_retained'; END IF;
        RETURN OLD;
    END IF;
    IF TG_OP='UPDATE' THEN
        IF NEW.static_hls_parent_capture_id IS DISTINCT FROM OLD.static_hls_parent_capture_id THEN
            RAISE EXCEPTION 'static_hls_child_claim_immutable';
        END IF;
        IF OLD.static_hls_parent_capture_id IS NULL THEN RETURN NEW; END IF;
        IF (to_jsonb(NEW)-ARRAY['status','response_encrypted','error_status','error_code','preparation_drained_at'])
            IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','response_encrypted','error_status','error_code','preparation_drained_at'])
            OR (OLD.preparation_drained_at IS NOT NULL AND NEW.preparation_drained_at IS DISTINCT FROM OLD.preparation_drained_at)
            OR (OLD.status='failed' AND (NEW.status,NEW.error_status,NEW.error_code,NEW.response_encrypted)
                IS DISTINCT FROM (OLD.status,OLD.error_status,OLD.error_code,OLD.response_encrypted))
            OR (OLD.status='completed' AND NEW.status NOT IN ('completed','failed'))
            OR (OLD.status=NEW.status AND (NEW.response_encrypted,NEW.error_status,NEW.error_code)
                IS DISTINCT FROM (OLD.response_encrypted,OLD.error_status,OLD.error_code))
            OR (NEW.status='pending' AND NEW.response_encrypted IS NOT NULL)
            OR (NEW.status='failed' AND (NEW.response_encrypted IS NOT NULL OR NEW.error_status IS NULL
                OR NEW.error_status NOT BETWEEN 400 AND 599 OR NEW.error_code IS NULL OR octet_length(NEW.error_code) NOT BETWEEN 1 AND 128))
            OR (NEW.status='completed' AND (NEW.response_encrypted IS NULL OR NEW.error_status IS NOT NULL OR NEW.error_code IS NOT NULL)) THEN
            RAISE EXCEPTION 'static_hls_child_request_immutable';
        END IF;
        IF OLD.status='pending' AND NEW.status='completed' THEN
            IF NOT static_hls_pending_reader_supported()
                OR NOT static_hls_pending_child_publication_authority_allowed(OLD.session_id) THEN
                RAISE EXCEPTION 'static_hls_child_publication_required';
            END IF;
        ELSIF NOT static_hls_pending_reader_supported() AND NOT static_hls_reader_supported() THEN
            RAISE EXCEPTION 'static_hls_pending_reader_required';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.static_hls_parent_capture_id IS NULL THEN RETURN NEW; END IF;
    IF NOT static_hls_pending_reader_supported() THEN RAISE EXCEPTION 'static_hls_pending_reader_required'; END IF;
    SELECT * INTO parent FROM static_hls_captures WHERE id=NEW.static_hls_parent_capture_id;
    SELECT * INTO original FROM playback_requests WHERE session_id=parent.session_id;
    IF parent.id IS NULL OR original.session_id IS NULL OR parent.publication_phase<>'published_parent'
        OR NOT static_hls_published_parent_authority_allowed(parent.id)
        OR NEW.status<>'pending' OR NEW.response_encrypted IS NOT NULL OR NEW.error_status IS NOT NULL OR NEW.error_code IS NOT NULL
        OR NEW.session_id IN (parent.id,parent.session_id) OR NEW.static_hls_operation_id IN (parent.id,parent.session_id)
        OR original.static_hls_parent_capture_id IS NOT NULL OR NEW.created_at>clock_timestamp()
        OR NEW.static_hls_prepare_expires_at<=clock_timestamp() OR NEW.static_hls_root_expires_at<=clock_timestamp()
        OR NEW.static_hls_root_expires_at IS DISTINCT FROM parent.expires_at
        OR NEW.static_hls_worker_instance IS DISTINCT FROM parent.worker_instance OR NEW.static_hls_database_id IS DISTINCT FROM parent.database_id
        OR ROW(NEW.user_id,NEW.room_id,NEW.lifecycle_epoch,NEW.auth_login_hash,NEW.auth_membership_epoch,NEW.viewer_id,
                NEW.static_hls_media_id,NEW.static_hls_media_generation,NEW.static_hls_source_id,NEW.static_hls_source_revision,NEW.static_hls_source_generation)
            IS DISTINCT FROM ROW(original.user_id,original.room_id,original.lifecycle_epoch,original.auth_login_hash,original.auth_membership_epoch,original.viewer_id,
                original.static_hls_media_id,original.static_hls_media_generation,original.static_hls_source_id,original.static_hls_source_revision,original.static_hls_source_generation)
        OR NEW.plan_generation<=original.plan_generation OR NEW.created_at<parent.published_at
        OR EXISTS(SELECT 1 FROM playback_sessions WHERE id IN (NEW.session_id,NEW.static_hls_operation_id))
        OR EXISTS(SELECT 1 FROM static_hls_captures WHERE id IN (NEW.session_id,NEW.static_hls_operation_id) OR session_id=NEW.session_id)
        OR EXISTS(SELECT 1 FROM media_jobs WHERE id IN (NEW.session_id,NEW.static_hls_operation_id) OR session_id=NEW.session_id)
        OR EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id IN (NEW.session_id,NEW.static_hls_operation_id))
        OR EXISTS(SELECT 1 FROM cache_entries WHERE id IN (NEW.session_id,NEW.static_hls_operation_id)
            OR cache_key IN (NEW.session_id::text,NEW.static_hls_operation_id::text)) THEN
        RAISE EXCEPTION 'static_hls_child_parent_authority_required';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_static_hls_child_capture_phase() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r playback_requests; p playback_sessions; parent static_hls_captures;
BEGIN
    IF TG_OP='DELETE' THEN
        IF OLD.publication_phase IN ('pending_child','published_child') THEN RAISE EXCEPTION 'static_hls_child_capture_retained'; END IF;
        RETURN OLD;
    END IF;
    SELECT * INTO r FROM playback_requests WHERE session_id=NEW.session_id;
    IF r.static_hls_parent_capture_id IS NULL THEN
        IF NEW.publication_phase IN ('pending_child','published_child')
            OR (TG_OP='UPDATE' AND OLD.publication_phase IN ('pending_child','published_child')) THEN
            RAISE EXCEPTION 'static_hls_child_capture_linkage_required';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.publication_phase NOT IN ('pending_child','published_child') THEN
        RAISE EXCEPTION 'static_hls_child_capture_linkage_required';
    END IF;
    SELECT * INTO parent FROM static_hls_captures WHERE id=r.static_hls_parent_capture_id;
    IF TG_OP='INSERT' THEN
        IF NOT static_hls_pending_reader_supported() THEN RAISE EXCEPTION 'static_hls_pending_reader_required'; END IF;
        -- Caller already owns the request/authority prefix and budget lock.
        PERFORM revision FROM cache_budget WHERE singleton FOR UPDATE;
        IF (SELECT count(*) FROM static_hls_captures WHERE disposed_at IS NULL)>=2 THEN
            RAISE EXCEPTION 'static_hls_capture_capacity';
        END IF;
        IF NEW.publication_phase<>'pending_child' OR NOT static_hls_child_capture_matches(NEW,r)
            OR NOT static_hls_pending_child_request_authority_allowed(r.session_id)
            OR NEW.created_at<parent.disposed_at OR NEW.created_at>clock_timestamp()
            OR NEW.owner_id='00000000-0000-0000-0000-000000000000'::uuid
            OR NEW.state<>'capturing' OR NEW.inventory_encrypted IS NOT NULL OR NEW.root_digest IS NOT NULL
            OR NEW.published_resource IS NOT NULL OR NEW.published_at IS NOT NULL
            OR NEW.streams_closed_at IS NOT NULL OR NEW.process_closed_at IS NOT NULL OR NEW.process_disposition IS NOT NULL
            OR NEW.files_removed_at IS NOT NULL OR NEW.disposed_at IS NOT NULL
            OR EXISTS(SELECT 1 FROM playback_sessions WHERE id=NEW.session_id)
            OR EXISTS(SELECT 1 FROM media_jobs WHERE id IN (NEW.id,NEW.session_id) OR session_id=NEW.session_id) THEN
            RAISE EXCEPTION 'static_hls_child_capture_authority_required';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.publication_phase='pending_child' AND NEW.publication_phase='published_child' THEN
        IF NOT static_hls_pending_reader_supported()
            OR (to_jsonb(NEW)-ARRAY['publication_phase','published_resource','published_at'])
                IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['publication_phase','published_resource','published_at'])
            OR OLD.state<>'verified' OR OLD.disposed_at IS NOT NULL OR OLD.root_digest IS DISTINCT FROM parent.root_digest
            OR NOT static_hls_pending_child_capture_authority_allowed(OLD.id)
            OR NEW.published_at IS NULL OR NEW.published_at>clock_timestamp()
            OR NOT static_hls_child_resource_matches(NEW.published_resource,r,NEW) THEN
            RAISE EXCEPTION 'static_hls_child_publication_required';
        END IF;
        SELECT * INTO p FROM playback_sessions WHERE id=OLD.session_id;
        IF p.static_hls_capture_id IS DISTINCT FROM OLD.id
            OR p.resource IS DISTINCT FROM NEW.published_resource||jsonb_build_object('static_hls_capture_id',OLD.id) THEN
            RAISE EXCEPTION 'static_hls_child_publication_required';
        END IF;
        RETURN NEW;
    END IF;
    -- Every owner/input/recipe/root/publication fact is immutable. A verified
    -- complete graph cannot return to capturing or lose a known receipt.
    IF (to_jsonb(NEW)-ARRAY['state','inventory_encrypted','root_digest','streams_closed_at','process_closed_at','process_disposition','files_removed_at','disposed_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','inventory_encrypted','root_digest','streams_closed_at','process_closed_at','process_disposition','files_removed_at','disposed_at'])
        OR (OLD.inventory_encrypted IS NOT NULL AND NEW.inventory_encrypted IS DISTINCT FROM OLD.inventory_encrypted)
        OR (OLD.root_digest IS NOT NULL AND NEW.root_digest IS DISTINCT FROM OLD.root_digest)
        OR (OLD.streams_closed_at IS NOT NULL AND NEW.streams_closed_at IS DISTINCT FROM OLD.streams_closed_at)
        OR (OLD.process_closed_at IS NOT NULL AND NEW.process_closed_at IS DISTINCT FROM OLD.process_closed_at)
        OR (OLD.process_disposition IS NOT NULL AND NEW.process_disposition IS DISTINCT FROM OLD.process_disposition)
        OR (OLD.files_removed_at IS NOT NULL AND NEW.files_removed_at IS DISTINCT FROM OLD.files_removed_at)
        OR (OLD.disposed_at IS NOT NULL AND NEW.disposed_at IS DISTINCT FROM OLD.disposed_at)
        OR (OLD.state='verified' AND NEW.state='capturing') OR (OLD.state='disposed' AND NEW.state<>'disposed')
        OR (OLD.state='cancelled' AND NEW.state NOT IN ('cancelled','disposed'))
        OR ((NEW.inventory_encrypted IS DISTINCT FROM OLD.inventory_encrypted OR NEW.root_digest IS DISTINCT FROM OLD.root_digest)
            AND (NEW.state<>'verified' OR OLD.publication_phase<>'pending_child'))
        OR ((NEW.streams_closed_at IS DISTINCT FROM OLD.streams_closed_at OR NEW.process_closed_at IS DISTINCT FROM OLD.process_closed_at
            OR NEW.process_disposition IS DISTINCT FROM OLD.process_disposition OR NEW.files_removed_at IS DISTINCT FROM OLD.files_removed_at
            OR NEW.disposed_at IS DISTINCT FROM OLD.disposed_at) AND NEW.state<>'disposed') THEN
        RAISE EXCEPTION 'static_hls_child_capture_immutable';
    END IF;
    IF NEW.state='cancelled' AND (to_jsonb(NEW)-'state')=(to_jsonb(OLD)-'state') THEN
        IF NOT static_hls_pending_reader_supported() AND NOT static_hls_reader_supported() THEN
            RAISE EXCEPTION 'static_hls_pending_reader_required';
        END IF;
        RETURN NEW;
    END IF;
    IF NOT static_hls_pending_reader_supported() THEN RAISE EXCEPTION 'static_hls_pending_reader_required'; END IF;
    IF NEW.state='verified' AND OLD.publication_phase='pending_child' THEN
        IF OLD.state NOT IN ('capturing','verified') OR NOT static_hls_pending_child_capture_authority_allowed(OLD.id)
            OR NEW.root_digest IS DISTINCT FROM parent.root_digest OR NEW.inventory_encrypted IS NULL THEN
            RAISE EXCEPTION 'static_hls_child_recapture_required';
        END IF;
    END IF;
    IF NEW.state='disposed' THEN
        IF NEW.disposed_at IS NULL OR NEW.disposed_at<NEW.created_at OR NEW.disposed_at>clock_timestamp()
            OR NEW.streams_closed_at IS NULL OR NEW.streams_closed_at<NEW.created_at OR NEW.streams_closed_at>NEW.disposed_at
            OR NEW.process_closed_at IS NULL OR NEW.process_closed_at<NEW.created_at OR NEW.process_closed_at>NEW.disposed_at
            OR NEW.files_removed_at IS NULL OR NEW.files_removed_at<NEW.created_at OR NEW.files_removed_at>NEW.disposed_at
            OR NEW.process_disposition IS NULL OR NEW.process_disposition NOT IN ('never_started','reaped') THEN
            RAISE EXCEPTION 'static_hls_child_disposal_unconfirmed';
        END IF;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER static_hls_child_capture_phase_guard ON static_hls_captures;
CREATE TRIGGER static_hls_child_capture_phase_guard BEFORE INSERT OR UPDATE OR DELETE ON static_hls_captures
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_capture_phase();

CREATE FUNCTION protect_static_hls_child_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r playback_requests; c static_hls_captures;
BEGIN
    IF TG_OP='DELETE' THEN
        IF static_hls_is_child_session(OLD.id) THEN RAISE EXCEPTION 'static_hls_child_session_retained'; END IF;
        RETURN OLD;
    END IF;
    SELECT * INTO r FROM playback_requests WHERE session_id=NEW.id;
    IF r.static_hls_parent_capture_id IS NULL THEN
        IF TG_OP='UPDATE' AND static_hls_is_child_session(OLD.id) THEN RAISE EXCEPTION 'static_hls_child_session_immutable'; END IF;
        RETURN NEW;
    END IF;
    IF TG_OP='UPDATE' THEN
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.static_hls_capture_id IS DISTINCT FROM OLD.static_hls_capture_id
            OR NEW.resource IS DISTINCT FROM OLD.resource
            OR (to_jsonb(NEW)-ARRAY['stopped','expires_at','metrics_output_entry_availability','metrics_output_entry_completed','metrics_output_entry_queue_ms'])
                IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['stopped','expires_at','metrics_output_entry_availability','metrics_output_entry_completed','metrics_output_entry_queue_ms'])
            OR NEW.expires_at>OLD.expires_at OR (OLD.stopped AND NOT NEW.stopped) THEN
            RAISE EXCEPTION 'static_hls_child_session_immutable';
        END IF;
        IF NOT static_hls_pending_reader_supported() THEN
            IF NEW.stopped AND NOT static_hls_session_authority_allowed(OLD.id)
                AND (to_jsonb(NEW)-'stopped')=(to_jsonb(OLD)-'stopped') THEN RETURN NEW; END IF;
            RAISE EXCEPTION 'static_hls_pending_reader_required';
        END IF;
        RETURN NEW;
    END IF;
    SELECT * INTO c FROM static_hls_captures WHERE id=NEW.static_hls_capture_id;
    IF NOT static_hls_pending_reader_supported() OR r.status<>'pending'
        OR c.id IS NULL OR c.publication_phase IS DISTINCT FROM 'pending_child' OR c.state IS DISTINCT FROM 'verified'
        OR c.disposed_at IS NOT NULL OR c.session_id IS DISTINCT FROM NEW.id
        OR NOT static_hls_pending_child_capture_authority_allowed(c.id)
        OR NEW.resource->>'static_hls_capture_id' IS DISTINCT FROM c.id::text
        OR NOT static_hls_child_resource_matches(NEW.resource-'static_hls_capture_id',r,c)
        OR ROW(NEW.user_id,NEW.room_id,NEW.media_id,NEW.generation,NEW.lifecycle_epoch,NEW.viewer_id,NEW.plan_generation,NEW.auth_login_hash,NEW.auth_membership_epoch)
            IS DISTINCT FROM ROW(r.user_id,r.room_id,r.static_hls_media_id,r.static_hls_media_generation,r.lifecycle_epoch,
                r.viewer_id,r.plan_generation,r.auth_login_hash,r.auth_membership_epoch)
        OR NEW.stopped OR NEW.expires_at>c.expires_at OR NEW.expires_at<=clock_timestamp()
        OR EXISTS(SELECT 1 FROM media_jobs WHERE id=NEW.id OR session_id=NEW.id) THEN
        RAISE EXCEPTION 'static_hls_child_publication_required';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_child_session_guard BEFORE INSERT OR UPDATE OR DELETE ON playback_sessions
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_session();

CREATE FUNCTION protect_static_hls_child_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r playback_requests; c static_hls_captures; child boolean;
BEGIN
    IF TG_OP='DELETE' THEN
        IF static_hls_is_child_session(OLD.session_id) OR static_hls_child_identity_reserved(OLD.id) OR OLD.spec->>'kind'='static_hls_child' THEN
            RAISE EXCEPTION 'static_hls_child_job_retained';
        END IF;
        RETURN OLD;
    END IF;
    child=static_hls_is_child_session(NEW.session_id) OR static_hls_child_identity_reserved(NEW.id) OR NEW.spec->>'kind'='static_hls_child';
    IF TG_OP='UPDATE' THEN child=child OR static_hls_is_child_session(OLD.session_id) OR static_hls_child_identity_reserved(OLD.id) OR OLD.spec->>'kind'='static_hls_child'; END IF;
    IF NOT COALESCE(child,false) THEN RETURN NEW; END IF;
    SELECT * INTO r FROM playback_requests WHERE session_id=NEW.session_id;
    SELECT * INTO c FROM static_hls_captures WHERE session_id=NEW.session_id AND publication_phase IN ('pending_child','published_child');
    IF r.static_hls_parent_capture_id IS NULL OR c.id IS NULL OR NOT static_hls_child_job_matches(NEW,r,c) THEN
        RAISE EXCEPTION 'static_hls_child_queue_contract_required';
    END IF;
    IF TG_OP='INSERT' THEN
        IF NOT static_hls_child_queue_authority_allowed(NEW.session_id)
            OR NEW.status<>'queued' OR NEW.attempt<>0 OR NEW.owner_id IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.error IS NOT NULL
            OR NEW.timing_version IS DISTINCT FROM 1 OR NEW.timing_attempt IS DISTINCT FROM 0
            OR NEW.queue_entered_at IS NULL OR NEW.run_started_at IS NOT NULL
            OR NEW.metrics_queue_ms IS DISTINCT FROM 0 OR NEW.metrics_queue_complete IS DISTINCT FROM true
            OR NEW.metrics_queue_accounted_attempt IS DISTINCT FROM 0 THEN
            RAISE EXCEPTION 'static_hls_child_queue_authority_required';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.session_id IS DISTINCT FROM OLD.session_id
        OR NEW.logical_queue IS DISTINCT FROM OLD.logical_queue OR NEW.spec IS DISTINCT FROM OLD.spec THEN
        RAISE EXCEPTION 'static_hls_child_queue_immutable';
    END IF;
    -- Explicit revocation can cancel queued work with reader 1 or 2. Reader
    -- incompatibility by itself is not a revocation or a disposal receipt.
    IF OLD.status='queued' AND NEW.status='cancelled' AND NOT static_hls_child_grant_authority_allowed(OLD.session_id)
        AND NEW.owner_id IS NULL AND NEW.lease_until IS NULL
        AND NEW.error IN ('playback_session_stopped','playback_session_expired')
        AND (NEW.timing_version,NEW.timing_attempt,NEW.queue_entered_at,NEW.run_started_at)
            IS NOT DISTINCT FROM (NULL::smallint,NULL::bigint,NULL::timestamptz,NULL::timestamptz)
        AND (to_jsonb(NEW)-ARRAY['status','error','timing_version','timing_attempt','queue_entered_at','run_started_at',
                'metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt'])
            IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','error','timing_version','timing_attempt','queue_entered_at','run_started_at',
                'metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt']) THEN
        IF NOT static_hls_pending_reader_supported() AND NOT static_hls_reader_supported() THEN
            RAISE EXCEPTION 'static_hls_pending_reader_required';
        END IF;
        RETURN NEW;
    END IF;
    IF NOT static_hls_pending_reader_supported() THEN RAISE EXCEPTION 'static_hls_pending_reader_required'; END IF;
    -- No generic claim/retry/reset/renewal may enter child encoding before the
    -- dedicated original-local-owner encoder/supervisor contract exists.
    IF NEW.status IN ('running','succeeded') OR NEW.attempt IS DISTINCT FROM OLD.attempt
        OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.lease_until IS DISTINCT FROM OLD.lease_until THEN
        RAISE EXCEPTION 'static_hls_child_execution_unavailable';
    END IF;
    -- 0042's earlier prefix owns these accounting fields; attempted caller
    -- overrides have already been reset/derived before this trigger runs.
    IF (to_jsonb(NEW)-ARRAY['metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['metrics_queue_ms','metrics_queue_complete','metrics_queue_accounted_attempt']) THEN
        RAISE EXCEPTION 'static_hls_child_queue_immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_child_job_guard BEFORE INSERT OR UPDATE OR DELETE ON media_jobs
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_job();

CREATE OR REPLACE FUNCTION protect_static_hls_pending_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session uuid; r playback_requests;
BEGIN
    IF TG_TABLE_NAME='playback_sessions' THEN session=NEW.id; ELSE session=NEW.session_id; END IF;
    SELECT * INTO r FROM playback_requests WHERE session_id=session;
    IF r.static_hls_input_version IS NULL THEN RETURN NEW; END IF;
    IF r.static_hls_parent_capture_id IS NOT NULL THEN
        -- Child-specific session/job guards perform the immediate exact checks;
        -- final request/session/capture/job consistency is deferred below.
        IF TG_OP='INSERT' AND NOT static_hls_pending_reader_supported() THEN RAISE EXCEPTION 'static_hls_pending_reader_required'; END IF;
        RETURN NEW;
    END IF;
    IF TG_TABLE_NAME='media_jobs' THEN RAISE EXCEPTION 'static_hls_pending_publication_forbidden'; END IF;
    IF TG_OP='UPDATE' THEN RETURN NEW; END IF;
    IF NOT static_hls_pending_reader_supported() OR NOT static_hls_pending_request_authority_allowed(session) THEN
        RAISE EXCEPTION 'static_hls_parent_publication_required';
    END IF;
    IF NEW.static_hls_capture_id IS NULL AND EXISTS(
        SELECT 1 FROM static_hls_captures WHERE session_id=session AND disposed_at IS NULL) THEN
        RAISE EXCEPTION 'static_hls_parent_disposal_required';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION protect_static_hls_child_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c static_hls_captures;
BEGIN
    IF TG_OP='DELETE' THEN
        SELECT * INTO c FROM static_hls_captures WHERE id=OLD.job_id AND publication_phase IN ('pending_child','published_child');
        IF c.id IS NOT NULL AND NOT static_hls_pending_reader_supported() THEN
            RAISE EXCEPTION 'static_hls_pending_reader_required';
        END IF;
        IF c.id IS NOT NULL AND (OLD.purpose<>'static_hls_capture' OR OLD.owner_id IS DISTINCT FROM c.owner_id
            OR c.state<>'disposed' OR c.disposed_at IS NULL OR c.streams_closed_at IS NULL
            OR c.process_closed_at IS NULL OR c.files_removed_at IS NULL OR c.process_disposition IS NULL) THEN
            RAISE EXCEPTION 'static_hls_child_disposal_unconfirmed';
        END IF;
        RETURN OLD;
    END IF;
    SELECT * INTO c FROM static_hls_captures WHERE id=NEW.job_id AND publication_phase IN ('pending_child','published_child');
    IF c.id IS NOT NULL THEN
        IF NOT static_hls_pending_reader_supported() OR NEW.purpose<>'static_hls_capture'
            OR NEW.owner_id IS DISTINCT FROM c.owner_id OR NEW.attempt<>0 OR NEW.bytes<>134217728
            OR c.disposed_at IS NOT NULL THEN RAISE EXCEPTION 'static_hls_child_reservation_required'; END IF;
    END IF;
    IF static_hls_is_child_job(NEW.job_id) OR static_hls_is_child_session(NEW.job_id)
        OR (static_hls_child_identity_reserved(NEW.job_id) AND c.id IS NULL) THEN
        RAISE EXCEPTION 'static_hls_child_execution_unavailable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_00_child_reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON cache_write_reservations
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_reservation();

-- Fail by exception BEFORE old paths can return a filesystem deletion/claim
-- owner after a skipped row. No child output/cached bytes exist in this slice.
CREATE FUNCTION protect_static_hls_child_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked boolean=false;
BEGIN
    IF TG_TABLE_NAME='cache_entries' THEN
        IF TG_OP<>'INSERT' THEN marked=static_hls_is_child_job(OLD.id) OR static_hls_child_identity_reserved(OLD.id)
            OR EXISTS(SELECT 1 FROM playback_requests WHERE static_hls_parent_capture_id IS NOT NULL AND OLD.cache_key IN (session_id::text,static_hls_operation_id::text)); END IF;
        IF TG_OP<>'DELETE' THEN marked=marked OR static_hls_is_child_job(NEW.id) OR static_hls_child_identity_reserved(NEW.id)
            OR EXISTS(SELECT 1 FROM playback_requests WHERE static_hls_parent_capture_id IS NOT NULL AND NEW.cache_key IN (session_id::text,static_hls_operation_id::text)); END IF;
    ELSIF TG_TABLE_NAME='cache_read_leases' THEN
        IF TG_OP<>'INSERT' THEN marked=static_hls_is_child_job(OLD.cache_id) OR static_hls_child_identity_reserved(OLD.cache_id); END IF;
        IF TG_OP<>'DELETE' THEN marked=marked OR static_hls_is_child_job(NEW.cache_id) OR static_hls_child_identity_reserved(NEW.cache_id); END IF;
    ELSE
        IF TG_OP<>'INSERT' THEN
            marked=static_hls_is_child_job(OLD.job_id) OR static_hls_child_identity_reserved(OLD.job_id);
            IF TG_TABLE_NAME='media_executions' THEN marked=marked OR static_hls_is_child_session(OLD.session_id); END IF;
        END IF;
        IF TG_OP<>'DELETE' THEN
            marked=marked OR static_hls_is_child_job(NEW.job_id) OR static_hls_child_identity_reserved(NEW.job_id);
            IF TG_TABLE_NAME='media_executions' THEN marked=marked OR static_hls_is_child_session(NEW.session_id); END IF;
        END IF;
    END IF;
    IF marked THEN RAISE EXCEPTION 'static_hls_child_execution_unavailable'; END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_00_child_output_guard BEFORE INSERT OR UPDATE OR DELETE ON media_outputs
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_artifact();
CREATE TRIGGER static_hls_00_child_output_file_guard BEFORE INSERT OR UPDATE OR DELETE ON media_output_files
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_artifact();
CREATE TRIGGER static_hls_00_child_execution_guard BEFORE INSERT OR UPDATE OR DELETE ON media_executions
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_artifact();
CREATE TRIGGER static_hls_00_child_cache_guard BEFORE INSERT OR UPDATE OR DELETE ON cache_entries
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_artifact();
CREATE TRIGGER static_hls_00_child_read_lease_guard BEFORE INSERT OR UPDATE OR DELETE ON cache_read_leases
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_artifact();

CREATE OR REPLACE FUNCTION protect_static_hls_room_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (TG_OP='DELETE' OR NEW.lifecycle IN ('closed','archived')) AND EXISTS(
        SELECT 1 FROM static_hls_captures c JOIN playback_requests request ON request.session_id=c.session_id
        LEFT JOIN playback_sessions p ON p.id=c.session_id
        WHERE (CASE WHEN c.publication_phase='stage_a' THEN p.room_id ELSE request.room_id END)=OLD.id AND c.disposed_at IS NULL) THEN
        RAISE EXCEPTION 'static_hls_capture_drain_unconfirmed';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION static_hls_session_authority_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM playback_sessions p JOIN static_hls_captures c ON c.id=p.static_hls_capture_id
        WHERE p.id=$1 AND p.resource->>'static_hls_capture_id'=c.id::text
        AND CASE WHEN c.publication_phase='stage_a' THEN static_hls_capture_authority_allowed(c.id)
            WHEN c.publication_phase='published_parent' THEN static_hls_published_parent_authority_allowed(c.id)
            WHEN c.publication_phase='published_child' THEN static_hls_published_child_capture_authority_allowed(c.id)
                OR static_hls_child_output_authority_allowed(p.id)
            ELSE false END)
$$;
CREATE OR REPLACE FUNCTION static_hls_session_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT static_hls_session_authority_allowed($1) AND EXISTS(
        SELECT 1 FROM playback_sessions p JOIN static_hls_captures c ON c.id=p.static_hls_capture_id WHERE p.id=$1
        AND CASE WHEN c.publication_phase='stage_a' THEN static_hls_reader_supported()
            WHEN c.publication_phase='published_parent' THEN static_hls_pending_reader_supported()
            -- Child input is NOT a parent delivery route. Output permission is
            -- independent, closed until the child output receipt is implemented.
            WHEN c.publication_phase='published_child' THEN static_hls_pending_reader_supported()
                AND static_hls_child_output_authority_allowed(p.id)
            ELSE false END)
$$;
CREATE OR REPLACE FUNCTION playback_source_allowed(media uuid, resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT playback_source_authority_allowed($1,$2)
        AND CASE WHEN NOT ($2 ? 'static_hls_capture_id') THEN NOT ($2 ? 'static_hls_input')
            ELSE EXISTS(SELECT 1 FROM static_hls_captures c WHERE c.id::text=$2->>'static_hls_capture_id'
                AND CASE WHEN c.publication_phase='stage_a' THEN c.state='verified' AND static_hls_reader_supported()
                    AND c.resource_authority=$2-'static_hls_capture_id' AND static_hls_capture_authority_allowed(c.id)
                WHEN c.publication_phase='published_parent' THEN c.state='verified' AND static_hls_pending_reader_supported()
                    AND c.published_resource=$2-'static_hls_capture_id' AND static_hls_published_parent_authority_allowed(c.id)
                WHEN c.publication_phase='published_child' THEN static_hls_pending_reader_supported()
                    AND c.published_resource=$2-'static_hls_capture_id' AND static_hls_child_output_authority_allowed(c.session_id)
                ELSE false END) END
$$;

-- Parent publication's constraint function remains identical except that child
-- rows now have their own four-row constraint below. This retains every parent
-- and unmarked-native check, including preparation-time publication checks.
CREATE OR REPLACE FUNCTION check_static_hls_parent_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session uuid; r playback_requests; p playback_sessions; c static_hls_captures;
BEGIN
    IF TG_TABLE_NAME='playback_sessions' THEN
        IF TG_OP='DELETE' THEN session=OLD.id; ELSE session=NEW.id; END IF;
    ELSE
        IF TG_OP='DELETE' THEN session=OLD.session_id; ELSE session=NEW.session_id; END IF;
    END IF;
    SELECT * INTO r FROM playback_requests WHERE session_id=session;
    IF r.static_hls_input_version IS NULL OR r.static_hls_parent_capture_id IS NOT NULL THEN RETURN NULL; END IF;
    SELECT * INTO p FROM playback_sessions WHERE id=session;
    SELECT * INTO c FROM static_hls_captures WHERE session_id=session AND publication_phase IN ('pending_parent','published_parent');
    IF (r.status='pending' AND p.id IS NOT NULL) OR (r.status='completed' AND p.id IS NULL)
        OR (r.status='failed' AND p.id IS NOT NULL AND NOT p.stopped)
        OR (p.id IS NOT NULL AND (p.user_id IS DISTINCT FROM r.user_id OR p.room_id IS DISTINCT FROM r.room_id
            OR p.media_id IS DISTINCT FROM r.static_hls_media_id OR p.generation IS DISTINCT FROM r.static_hls_media_generation
            OR p.lifecycle_epoch IS DISTINCT FROM r.lifecycle_epoch OR p.viewer_id IS DISTINCT FROM r.viewer_id
            OR p.plan_generation IS DISTINCT FROM r.plan_generation OR p.auth_login_hash IS DISTINCT FROM r.auth_login_hash
            OR p.auth_membership_epoch IS DISTINCT FROM r.auth_membership_epoch OR p.expires_at>r.static_hls_root_expires_at))
        OR (p.static_hls_capture_id IS NOT NULL AND (c.id IS NULL OR c.publication_phase<>'published_parent'
            OR p.static_hls_capture_id IS DISTINCT FROM c.id
            OR p.resource IS DISTINCT FROM c.published_resource||jsonb_build_object('static_hls_capture_id',c.id)))
        OR (c.publication_phase='published_parent' AND (p.static_hls_capture_id IS DISTINCT FROM c.id
            OR r.status NOT IN ('completed','failed') OR NOT static_hls_parent_resource_matches(c.published_resource,r)))
        OR (r.status='completed' AND p.static_hls_capture_id IS NULL AND c.id IS NOT NULL AND c.disposed_at IS NULL) THEN
        RAISE EXCEPTION 'static_hls_parent_atomic_publication_required';
    END IF;
    IF TG_TABLE_NAME='static_hls_captures' AND TG_OP='UPDATE' THEN
        IF OLD.publication_phase='pending_parent' AND NEW.publication_phase='published_parent'
            AND (r.lease_until<=clock_timestamp() OR r.static_hls_prepare_expires_at<=clock_timestamp()
                OR NOT static_hls_published_parent_authority_allowed(c.id)) THEN
            RAISE EXCEPTION 'static_hls_parent_publication_authority_required';
        END IF;
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION check_static_hls_child_claim_linkage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE child playback_requests; parent static_hls_captures; original playback_requests;
BEGIN
    SELECT * INTO child FROM playback_requests WHERE session_id=NEW.session_id;
    IF child.static_hls_parent_capture_id IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO parent FROM static_hls_captures WHERE id=child.static_hls_parent_capture_id;
    SELECT * INTO original FROM playback_requests WHERE session_id=parent.session_id;
    IF parent.id IS NULL OR parent.publication_phase<>'published_parent'
        OR original.status IS DISTINCT FROM 'failed' OR original.error_code IS DISTINCT FROM 'static_hls_parent_claimed'
        OR original.response_encrypted IS NOT NULL
        OR NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=parent.session_id AND p.stopped AND p.static_hls_capture_id=parent.id)
        OR NOT EXISTS(SELECT 1 FROM playback_preparations p WHERE p.session_id=child.session_id
            AND p.owner_epoch=child.owner_epoch AND p.user_id=child.user_id AND p.room_id=child.room_id
            AND p.lifecycle_epoch=child.lifecycle_epoch AND p.created_at=child.created_at
            AND p.drained_at IS NOT DISTINCT FROM child.preparation_drained_at) THEN
        RAISE EXCEPTION 'static_hls_child_claim_atomicity_required';
    END IF;
    -- Only a fresh claim commits against its original pending clock. Late
    -- cancellation/disposal bookkeeping cannot be blocked just by lease expiry.
    IF TG_OP='INSERT' AND child.status='pending' AND NOT static_hls_pending_request_authority_allowed(child.session_id) THEN
        RAISE EXCEPTION 'static_hls_child_claim_atomicity_required';
    END IF;
    RETURN NULL;
END $$;

CREATE FUNCTION check_static_hls_child_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session uuid; r playback_requests; p playback_sessions; c static_hls_captures; j media_jobs;
    publication boolean=false; verification boolean=false; admission boolean=false;
BEGIN
    IF TG_TABLE_NAME='playback_sessions' THEN
        IF TG_OP='DELETE' THEN session=OLD.id; ELSE session=NEW.id; END IF;
    ELSIF TG_TABLE_NAME='media_jobs' THEN
        IF TG_OP='DELETE' THEN session=OLD.session_id; ELSE session=NEW.session_id; END IF;
        admission=TG_OP='INSERT';
    ELSIF TG_TABLE_NAME='cache_write_reservations' THEN
        IF TG_OP='DELETE' THEN SELECT c0.session_id INTO session FROM static_hls_captures c0 WHERE c0.id=OLD.job_id;
        ELSE SELECT c0.session_id INTO session FROM static_hls_captures c0 WHERE c0.id=NEW.job_id; END IF;
    ELSE
        IF TG_OP='DELETE' THEN session=OLD.session_id; ELSE session=NEW.session_id; END IF;
    END IF;
    SELECT * INTO r FROM playback_requests WHERE session_id=session;
    IF r.static_hls_parent_capture_id IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO p FROM playback_sessions WHERE id=session;
    SELECT * INTO c FROM static_hls_captures WHERE session_id=session AND publication_phase IN ('pending_child','published_child');
    SELECT * INTO j FROM media_jobs WHERE id=session;
    IF (r.status='pending' AND (p.id IS NOT NULL OR j.id IS NOT NULL))
        OR (r.status='completed' AND (p.id IS NULL OR c.id IS NULL OR j.id IS NULL OR r.response_encrypted IS NULL))
        OR (r.status='failed' AND (r.response_encrypted IS NOT NULL OR (p.id IS NOT NULL AND NOT p.stopped)))
        OR (p.id IS NOT NULL AND (p.static_hls_capture_id IS DISTINCT FROM c.id
            OR c.publication_phase IS DISTINCT FROM 'published_child'
            OR p.resource IS DISTINCT FROM c.published_resource||jsonb_build_object('static_hls_capture_id',c.id)
            OR ROW(p.user_id,p.room_id,p.media_id,p.generation,p.lifecycle_epoch,p.viewer_id,p.plan_generation,p.auth_login_hash,p.auth_membership_epoch)
                IS DISTINCT FROM ROW(r.user_id,r.room_id,r.static_hls_media_id,r.static_hls_media_generation,r.lifecycle_epoch,
                    r.viewer_id,r.plan_generation,r.auth_login_hash,r.auth_membership_epoch)
            OR p.expires_at>r.static_hls_root_expires_at))
        OR (c.id IS NOT NULL AND (NOT static_hls_child_capture_matches(c,r)
            OR NOT static_hls_child_parent_binding_allowed(r.session_id)
            OR (c.root_digest IS NOT NULL AND c.root_digest IS DISTINCT FROM (SELECT root_digest FROM static_hls_captures WHERE id=r.static_hls_parent_capture_id))
            OR (c.disposed_at IS NULL AND NOT EXISTS(SELECT 1 FROM cache_write_reservations reservation
                WHERE reservation.job_id=c.id AND reservation.owner_id=c.owner_id AND reservation.attempt=0
                AND reservation.bytes=134217728 AND reservation.purpose='static_hls_capture'))
            OR (c.disposed_at IS NOT NULL AND EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id=c.id))))
        OR (c.publication_phase='published_child' AND (p.id IS NULL OR j.id IS NULL OR r.status NOT IN ('completed','failed')
            OR NOT static_hls_child_resource_matches(c.published_resource,r,c)))
        OR (j.id IS NOT NULL AND (c.id IS NULL OR c.publication_phase<>'published_child' OR r.status NOT IN ('completed','failed')
            OR NOT static_hls_child_job_matches(j,r,c)))
        OR EXISTS(SELECT 1 FROM media_jobs other WHERE other.session_id=session AND other.id<>session) THEN
        RAISE EXCEPTION 'static_hls_child_atomic_publication_required';
    END IF;
    IF TG_TABLE_NAME='static_hls_captures' THEN
        IF TG_OP='INSERT' THEN admission=true;
        ELSIF TG_OP='UPDATE' THEN
            publication=OLD.publication_phase='pending_child' AND NEW.publication_phase='published_child';
            verification=OLD.state='capturing' AND NEW.state='verified';
        END IF;
    ELSIF TG_TABLE_NAME='playback_requests' AND TG_OP='UPDATE' THEN
        publication=OLD.status='pending' AND NEW.status='completed';
    ELSIF TG_TABLE_NAME='playback_sessions' AND TG_OP='INSERT' THEN
        publication=true;
    END IF;
    IF publication OR (admission AND j.id IS NOT NULL) THEN
        IF NOT static_hls_child_queue_authority_allowed(session) OR j.id IS NULL OR j.status<>'queued'
            OR j.attempt<>0 OR j.owner_id IS NOT NULL OR j.lease_until IS NOT NULL THEN
            RAISE EXCEPTION 'static_hls_child_publication_authority_required';
        END IF;
    ELSIF admission OR verification THEN
        IF NOT static_hls_pending_child_capture_authority_allowed(c.id) THEN
            RAISE EXCEPTION 'static_hls_child_capture_authority_required';
        END IF;
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER static_hls_child_request_publication AFTER INSERT OR UPDATE OR DELETE ON playback_requests
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_child_publication();
CREATE CONSTRAINT TRIGGER static_hls_child_capture_publication AFTER INSERT OR UPDATE OR DELETE ON static_hls_captures
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_child_publication();
CREATE CONSTRAINT TRIGGER static_hls_child_session_publication AFTER INSERT OR UPDATE OR DELETE ON playback_sessions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_child_publication();
CREATE CONSTRAINT TRIGGER static_hls_child_job_publication AFTER INSERT OR UPDATE OR DELETE ON media_jobs
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_child_publication();
CREATE CONSTRAINT TRIGGER static_hls_child_reservation_publication AFTER INSERT OR UPDATE OR DELETE ON cache_write_reservations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_child_publication();
