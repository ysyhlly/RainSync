-- Published parent storage; no public route, queue or activation rollout.
-- The runtime publisher must consume the original full-graph PublicationLease.
-- SQL is a relational fence, never a scanner/stream/process/file ownership proof.
LOCK TABLE playback_requests IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE static_hls_captures IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE playback_sessions IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE media_jobs IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE cache_write_reservations IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE playback_preparations IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE media_executions IN ACCESS EXCLUSIVE MODE NOWAIT;

ALTER TABLE playback_requests DROP CONSTRAINT static_hls_pending_request_shape;
ALTER TABLE playback_requests
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
        AND static_hls_operation_id<>session_id AND status IN ('pending','completed','failed')
        AND (response_encrypted IS NULL OR octet_length(response_encrypted) BETWEEN 1 AND 262144) AND http_file_context_encrypted IS NULL AND http_file_parent IS NULL
        AND static_hls_media_generation BETWEEN 0 AND 9007199254740991
        AND static_hls_source_revision BETWEEN 1 AND 9007199254740991 AND static_hls_source_generation BETWEEN 1 AND 9007199254740991
        AND created_at=date_trunc('milliseconds',created_at)
        AND static_hls_root_expires_at=date_trunc('milliseconds',static_hls_root_expires_at)
        AND static_hls_prepare_expires_at=date_trunc('milliseconds',static_hls_prepare_expires_at)
        AND static_hls_root_expires_at>created_at AND static_hls_root_expires_at<=created_at+interval '30 minutes'
        AND static_hls_prepare_expires_at>created_at AND static_hls_prepare_expires_at<=created_at+interval '45 seconds'
        AND static_hls_prepare_expires_at<=static_hls_root_expires_at
        AND lease_until>created_at AND lease_until<=static_hls_prepare_expires_at AND lease_until<=static_hls_root_expires_at));
ALTER TABLE static_hls_captures DROP CONSTRAINT static_hls_captures_publication_phase_check;
ALTER TABLE static_hls_captures ADD CONSTRAINT static_hls_captures_publication_phase_check
    CHECK(publication_phase IN ('stage_a','pending_parent','published_parent'));
ALTER TABLE static_hls_captures DROP CONSTRAINT static_hls_pending_capture_shape;
ALTER TABLE static_hls_captures
ADD CONSTRAINT static_hls_pending_capture_shape CHECK(
      (publication_phase='stage_a' AND num_nonnulls(input_sha256,worker_instance,database_id,reader_version,recipe_version,root_digest)=0)
      OR (publication_phase IN ('pending_parent','published_parent') AND input_sha256 ~ '^[0-9a-f]{64}$'
        AND input_sha256 IS NOT NULL AND worker_instance IS NOT NULL AND database_id IS NOT NULL
        AND reader_version=2 AND recipe_version=1 AND reader_version IS NOT NULL AND recipe_version IS NOT NULL
        AND (root_digest IS NULL OR root_digest ~ '^[0-9a-f]{64}$')
        AND ((root_digest IS NULL)=(inventory_encrypted IS NULL))
        AND (state<>'verified' OR root_digest IS NOT NULL)));
ALTER TABLE static_hls_captures
    ADD COLUMN published_resource jsonb,
    ADD COLUMN published_at timestamptz,
    ADD CONSTRAINT static_hls_parent_publication_shape CHECK(
        (publication_phase<>'published_parent' AND published_resource IS NULL AND published_at IS NULL)
        OR (publication_phase='published_parent' AND published_resource IS NOT NULL AND published_at IS NOT NULL
            AND jsonb_typeof(published_resource)='object' AND octet_length(published_resource::text)<=262144
            AND root_digest IS NOT NULL AND inventory_encrypted IS NOT NULL
            AND state IN ('verified','cancelled','disposed')
            AND published_at>=created_at AND published_at<expires_at));
DROP INDEX static_hls_pending_capture_request;
CREATE UNIQUE INDEX static_hls_pending_capture_request ON static_hls_captures(session_id)
    WHERE publication_phase IN ('pending_parent','published_parent');

-- The original admission facts are not rewritten into a delivery descriptor.
-- This separately frozen wrapper carries no decrypted URL/configuration/token.
CREATE FUNCTION static_hls_parent_resource_matches(resource jsonb, request playback_requests)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT COALESCE(jsonb_typeof($1)='object'
        AND $1 ?& ARRAY['encrypted','source_policy_revision','account_policy_generation','auth_context','static_hls_input']
        AND $1-ARRAY['encrypted','source_policy_revision','account_policy_generation','auth_context','static_hls_input']='{}'::jsonb
        AND jsonb_typeof($1->'encrypted')='string' AND octet_length($1->>'encrypted') BETWEEN 1 AND 65536
        AND $1->'source_policy_revision'=to_jsonb(($2).static_hls_source_revision)
        AND $1->'account_policy_generation'='null'::jsonb
        AND $1->'auth_context'=jsonb_build_object('version',1,'user_id',($2).user_id,'room_id',($2).room_id,
            'membership_epoch',($2).auth_membership_epoch,'login_hash',($2).auth_login_hash)
        AND $1->'static_hls_input'=jsonb_build_object('input_version',1,'reader_version',2,'recipe_version',1,
            'source_id',($2).static_hls_source_id,'media_source_generation',($2).static_hls_source_generation,
            'input_sha256',($2).static_hls_input_sha256,'worker_instance',($2).static_hls_worker_instance,
            'root_hard_expires_at_ms',floor(extract(epoch FROM ($2).static_hls_root_expires_at)*1000)::bigint),false)
$$;

-- Authority is deliberately independent of reader compatibility. Publication
-- replaces the preparation fence with the original root/live grant fence.
CREATE FUNCTION static_hls_published_parent_authority_allowed(capture uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM static_hls_captures c
        JOIN playback_requests r ON r.session_id=c.session_id
        JOIN playback_sessions p ON p.id=c.session_id
        JOIN rooms room ON room.id=r.room_id JOIN room_snapshots snap ON snap.room_id=r.room_id
        JOIN media_items m ON m.id=r.static_hls_media_id JOIN sources source ON source.id=r.static_hls_source_id
        JOIN static_hls_database_binding db ON db.singleton
        WHERE c.id=$1 AND c.publication_phase='published_parent' AND c.state='verified' AND c.disposed_at IS NULL
        AND c.id=r.static_hls_operation_id AND c.user_id=r.user_id AND c.request_owner_epoch=r.owner_epoch
        AND c.input_sha256=r.static_hls_input_sha256 AND c.worker_instance=r.static_hls_worker_instance
        AND c.database_id=r.static_hls_database_id AND c.database_id=db.id
        AND c.expires_at=r.static_hls_root_expires_at AND c.expires_at>clock_timestamp()
        AND c.reader_version=2 AND c.recipe_version=1 AND r.status='completed'
        AND p.static_hls_capture_id=c.id AND p.resource=c.published_resource||jsonb_build_object('static_hls_capture_id',c.id)
        AND p.user_id=r.user_id AND p.room_id=r.room_id AND p.media_id=r.static_hls_media_id
        AND p.generation=r.static_hls_media_generation AND p.lifecycle_epoch=r.lifecycle_epoch
        AND p.viewer_id=r.viewer_id AND p.plan_generation=r.plan_generation
        AND p.auth_login_hash=r.auth_login_hash AND p.auth_membership_epoch=r.auth_membership_epoch
        AND NOT p.stopped AND p.expires_at>clock_timestamp() AND p.expires_at<=c.expires_at
        AND room.lifecycle='active' AND room.lifecycle_epoch=r.lifecycle_epoch
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
CREATE OR REPLACE FUNCTION static_hls_session_authority_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM playback_sessions p JOIN static_hls_captures c ON c.id=p.static_hls_capture_id
        WHERE p.id=$1 AND p.resource->>'static_hls_capture_id'=c.id::text
        AND CASE WHEN c.publication_phase='stage_a' THEN static_hls_capture_authority_allowed(c.id)
            WHEN c.publication_phase='published_parent' THEN static_hls_published_parent_authority_allowed(c.id)
            ELSE false END)
$$;
CREATE OR REPLACE FUNCTION static_hls_session_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT static_hls_session_authority_allowed($1) AND EXISTS(
        SELECT 1 FROM playback_sessions p JOIN static_hls_captures c ON c.id=p.static_hls_capture_id WHERE p.id=$1
        AND CASE WHEN c.publication_phase='stage_a' THEN static_hls_reader_supported()
            WHEN c.publication_phase='published_parent' THEN static_hls_pending_reader_supported() ELSE false END)
$$;
CREATE OR REPLACE FUNCTION playback_source_allowed(media uuid, resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT playback_source_authority_allowed($1,$2)
        AND CASE WHEN NOT ($2 ? 'static_hls_capture_id') THEN NOT ($2 ? 'static_hls_input')
            ELSE EXISTS(SELECT 1 FROM static_hls_captures c WHERE c.id::text=$2->>'static_hls_capture_id' AND c.state='verified'
                AND CASE WHEN c.publication_phase='stage_a' THEN static_hls_reader_supported()
                    AND c.resource_authority=$2-'static_hls_capture_id' AND static_hls_capture_authority_allowed(c.id)
                WHEN c.publication_phase='published_parent' THEN static_hls_pending_reader_supported()
                    AND c.published_resource=$2-'static_hls_capture_id' AND static_hls_published_parent_authority_allowed(c.id)
                ELSE false END) END
$$;

-- Parent delivery owns the existing execution receipt. Reader 1 must neither
-- admit nor acknowledge a reader 2 parent. A revoked grant still permits the
-- original reader 2 owner to acknowledge completed physical drainage.
CREATE OR REPLACE FUNCTION protect_static_hls_job_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked boolean=false; original static_hls_captures; target static_hls_captures;
BEGIN
    IF TG_TABLE_NAME='media_executions' THEN
        IF TG_OP<>'INSERT' THEN
            SELECT * INTO original FROM static_hls_captures
                WHERE session_id=OLD.session_id AND publication_phase='published_parent';
        END IF;
        IF TG_OP<>'DELETE' THEN
            SELECT * INTO target FROM static_hls_captures
                WHERE session_id=NEW.session_id AND publication_phase='published_parent';
        END IF;
        IF original.id IS NOT NULL OR target.id IS NOT NULL THEN
            IF NOT static_hls_pending_reader_supported() THEN RETURN NULL; END IF;
            IF TG_OP='DELETE' THEN RETURN NULL; END IF;
            IF TG_OP='INSERT' THEN
                IF target.id IS NULL OR NOT static_hls_published_parent_authority_allowed(target.id)
                    OR NEW.kind<>'delivery' OR NEW.job_id IS NOT NULL OR NEW.attempt IS NOT NULL
                    OR NEW.owner_id IS NULL OR NEW.reaped_at IS NOT NULL THEN
                    RAISE EXCEPTION 'static_hls_parent_delivery_authority_required';
                END IF;
            ELSE
                IF original.id IS NULL OR target.id IS DISTINCT FROM original.id
                    OR (to_jsonb(NEW)-'reaped_at') IS DISTINCT FROM (to_jsonb(OLD)-'reaped_at')
                    OR (OLD.reaped_at IS NOT NULL AND NEW.reaped_at IS DISTINCT FROM OLD.reaped_at)
                    OR (NEW.reaped_at IS NOT NULL AND (NEW.reaped_at<NEW.created_at OR NEW.reaped_at>clock_timestamp())) THEN
                    RAISE EXCEPTION 'static_hls_parent_delivery_immutable';
                END IF;
            END IF;
            RETURN NEW;
        END IF;
    END IF;
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

CREATE OR REPLACE FUNCTION protect_static_hls_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p playback_sessions; r playback_requests;
BEGIN
    IF TG_OP='UPDATE' AND OLD.publication_phase='pending_parent' AND NEW.publication_phase='published_parent' THEN
        IF NOT static_hls_pending_reader_supported() THEN RAISE EXCEPTION 'static_hls_pending_reader_required'; END IF;
        IF (to_jsonb(NEW)-ARRAY['publication_phase','published_resource','published_at'])
            IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['publication_phase','published_resource','published_at'])
            OR OLD.state<>'verified' OR OLD.disposed_at IS NOT NULL OR OLD.root_digest IS NULL
            OR OLD.inventory_encrypted IS NULL OR NEW.published_at IS NULL OR NEW.published_at>clock_timestamp()
            OR NOT static_hls_pending_capture_authority_allowed(OLD.id) THEN
            RAISE EXCEPTION 'static_hls_parent_publication_required';
        END IF;
        SELECT * INTO r FROM playback_requests WHERE session_id=OLD.session_id;
        SELECT * INTO p FROM playback_sessions WHERE id=OLD.session_id;
        IF NOT static_hls_parent_resource_matches(NEW.published_resource,r)
            OR p.static_hls_capture_id IS DISTINCT FROM OLD.id
            OR p.resource IS DISTINCT FROM NEW.published_resource||jsonb_build_object('static_hls_capture_id',OLD.id) THEN
            RAISE EXCEPTION 'static_hls_parent_publication_required';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP<>'INSERT' AND OLD.publication_phase='published_parent' THEN
        IF TG_OP='DELETE' THEN RETURN NULL; END IF;
        IF (to_jsonb(NEW)-ARRAY['state','streams_closed_at','process_closed_at','process_disposition','files_removed_at','disposed_at'])
            IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','streams_closed_at','process_closed_at','process_disposition','files_removed_at','disposed_at'])
            OR (OLD.streams_closed_at IS NOT NULL AND NEW.streams_closed_at IS DISTINCT FROM OLD.streams_closed_at)
            OR (OLD.process_closed_at IS NOT NULL AND NEW.process_closed_at IS DISTINCT FROM OLD.process_closed_at)
            OR (OLD.process_disposition IS NOT NULL AND NEW.process_disposition IS DISTINCT FROM OLD.process_disposition)
            OR (OLD.files_removed_at IS NOT NULL AND NEW.files_removed_at IS DISTINCT FROM OLD.files_removed_at)
            OR (OLD.disposed_at IS NOT NULL AND NEW.disposed_at IS DISTINCT FROM OLD.disposed_at)
            OR NEW.state='capturing' OR (OLD.state='disposed' AND NEW.state<>'disposed')
            OR (OLD.state='cancelled' AND NEW.state NOT IN ('cancelled','disposed'))
            OR ((NEW.streams_closed_at IS DISTINCT FROM OLD.streams_closed_at OR NEW.process_closed_at IS DISTINCT FROM OLD.process_closed_at
                OR NEW.process_disposition IS DISTINCT FROM OLD.process_disposition OR NEW.files_removed_at IS DISTINCT FROM OLD.files_removed_at
                OR NEW.disposed_at IS DISTINCT FROM OLD.disposed_at) AND NEW.state<>'disposed') THEN
            RAISE EXCEPTION 'static_hls_published_capture_immutable';
        END IF;
        IF NEW.state='cancelled' AND (to_jsonb(NEW)-'state')=(to_jsonb(OLD)-'state') THEN
            IF NOT static_hls_pending_reader_supported() AND NOT static_hls_reader_supported() THEN
                RAISE EXCEPTION 'static_hls_pending_reader_required';
            END IF;
            RETURN NEW;
        END IF;
        IF NOT static_hls_pending_reader_supported() THEN RAISE EXCEPTION 'static_hls_pending_reader_required'; END IF;
        RETURN NEW;
    END IF;
    IF TG_OP='INSERT' AND NEW.publication_phase='published_parent' THEN
        RAISE EXCEPTION 'static_hls_parent_publication_required';
    END IF;
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
    IF TG_OP='UPDATE' AND OLD.static_hls_input_version IS NOT NULL THEN
        IF (to_jsonb(NEW)-ARRAY['status','response_encrypted','error_status','error_code','preparation_drained_at'])
            IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','response_encrypted','error_status','error_code','preparation_drained_at'])
            OR (OLD.preparation_drained_at IS NOT NULL AND NEW.preparation_drained_at IS DISTINCT FROM OLD.preparation_drained_at)
            OR (OLD.status='failed' AND (NEW.status,NEW.error_status,NEW.error_code) IS DISTINCT FROM (OLD.status,OLD.error_status,OLD.error_code))
            OR (OLD.status='completed' AND NEW.status NOT IN ('completed','failed'))
            OR (OLD.status='completed' AND NEW.status='completed' AND NEW.response_encrypted IS DISTINCT FROM OLD.response_encrypted) THEN
            RAISE EXCEPTION 'static_hls_pending_request_immutable';
        END IF;
        IF NEW.status='completed' AND OLD.status='pending' THEN
            IF NOT static_hls_pending_reader_supported() OR NOT static_hls_pending_request_authority_allowed(OLD.session_id)
                OR NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=OLD.session_id AND NOT p.stopped
                    AND ((p.static_hls_capture_id IS NOT NULL AND EXISTS(SELECT 1 FROM static_hls_captures c
                        WHERE c.id=p.static_hls_capture_id AND c.publication_phase='published_parent' AND c.state='verified'
                        AND c.disposed_at IS NULL AND c.session_id=OLD.session_id
                        AND p.resource=c.published_resource||jsonb_build_object('static_hls_capture_id',c.id)))
                    OR (p.static_hls_capture_id IS NULL AND NOT (p.resource ? 'static_hls_capture_id')
                        AND NOT EXISTS(SELECT 1 FROM static_hls_captures c WHERE c.session_id=OLD.session_id AND c.disposed_at IS NULL)))) THEN
                RAISE EXCEPTION 'static_hls_parent_publication_required';
            END IF;
        ELSIF NOT static_hls_pending_reader_supported() AND NOT static_hls_reader_supported() THEN
            RAISE EXCEPTION 'static_hls_pending_reader_required';
        END IF;
        RETURN NEW;
    END IF;
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

CREATE OR REPLACE FUNCTION protect_static_hls_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked uuid; c static_hls_captures; r playback_requests;
BEGIN
    SELECT * INTO r FROM playback_requests WHERE session_id=CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END;
    IF r.static_hls_input_version IS NOT NULL THEN
        IF TG_OP='DELETE' THEN RETURN NULL; END IF;
        IF NEW.static_hls_capture_id IS NULL THEN
            IF NEW.resource ? 'static_hls_capture_id' OR NEW.resource ? 'static_hls_input'
                OR (TG_OP='UPDATE' AND OLD.static_hls_capture_id IS NOT NULL)
                OR NOT playback_source_authority_allowed(NEW.media_id,NEW.resource) THEN
                RAISE EXCEPTION 'static_hls_parent_publication_required';
            END IF;
            RETURN NEW;
        END IF;
        IF TG_OP='UPDATE' THEN
            IF NEW.static_hls_capture_id IS DISTINCT FROM OLD.static_hls_capture_id
                OR NEW.resource IS DISTINCT FROM OLD.resource
                OR (to_jsonb(NEW)-ARRAY['stopped','expires_at','metrics_output_entry_availability','metrics_output_entry_completed','metrics_output_entry_queue_ms'])
                    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['stopped','expires_at','metrics_output_entry_availability','metrics_output_entry_completed','metrics_output_entry_queue_ms'])
                OR NEW.expires_at>OLD.expires_at OR (OLD.stopped AND NOT NEW.stopped) THEN
                RAISE EXCEPTION 'static_hls_published_session_immutable';
            END IF;
            IF NOT static_hls_pending_reader_supported() THEN
                IF NEW.stopped AND NOT static_hls_session_authority_allowed(OLD.id)
                    AND (to_jsonb(NEW)-'stopped')=(to_jsonb(OLD)-'stopped') THEN RETURN NEW; END IF;
                RETURN NULL;
            END IF;
            RETURN NEW;
        END IF;
        SELECT * INTO c FROM static_hls_captures WHERE id=NEW.static_hls_capture_id;
        IF NOT static_hls_pending_reader_supported() OR r.status<>'pending'
            OR c.publication_phase IS DISTINCT FROM 'pending_parent' OR c.state IS DISTINCT FROM 'verified'
            OR c.disposed_at IS NOT NULL OR c.session_id IS DISTINCT FROM NEW.id
            OR NOT static_hls_pending_capture_authority_allowed(c.id)
            OR NEW.resource->>'static_hls_capture_id' IS DISTINCT FROM c.id::text
            OR NOT static_hls_parent_resource_matches(NEW.resource-'static_hls_capture_id',r)
            OR NEW.user_id IS DISTINCT FROM r.user_id OR NEW.room_id IS DISTINCT FROM r.room_id
            OR NEW.media_id IS DISTINCT FROM r.static_hls_media_id OR NEW.generation IS DISTINCT FROM r.static_hls_media_generation
            OR NEW.lifecycle_epoch IS DISTINCT FROM r.lifecycle_epoch OR NEW.viewer_id IS DISTINCT FROM r.viewer_id
            OR NEW.plan_generation IS DISTINCT FROM r.plan_generation OR NEW.stopped
            OR NEW.expires_at>c.expires_at OR NEW.expires_at<=clock_timestamp()
            OR EXISTS(SELECT 1 FROM media_jobs WHERE session_id=NEW.id) THEN
            RAISE EXCEPTION 'static_hls_parent_publication_required';
        END IF;
        RETURN NEW;
    END IF;
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

CREATE OR REPLACE FUNCTION protect_static_hls_pending_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session uuid; r playback_requests;
BEGIN
    IF TG_TABLE_NAME='playback_sessions' THEN session=NEW.id; ELSE session=NEW.session_id; END IF;
    SELECT * INTO r FROM playback_requests WHERE session_id=session;
    IF r.static_hls_input_version IS NULL THEN RETURN NEW; END IF;
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
        IF (c.publication_phase IN ('pending_parent','published_parent') AND NOT static_hls_pending_reader_supported())
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
        WHERE (CASE WHEN c.publication_phase IN ('pending_parent','published_parent') THEN request.room_id ELSE p.room_id END)=OLD.id AND c.disposed_at IS NULL) THEN
        RAISE EXCEPTION 'static_hls_capture_drain_unconfirmed';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION check_static_hls_pending_linkage() RETURNS trigger LANGUAGE plpgsql AS $$
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
        IF c.publication_phase IN ('pending_parent','published_parent') AND ((c.disposed_at IS NULL AND NOT EXISTS(
            SELECT 1 FROM cache_write_reservations WHERE job_id=c.id AND owner_id=c.owner_id AND attempt=0
            AND purpose='static_hls_capture' AND bytes=134217728)) OR (c.disposed_at IS NOT NULL AND EXISTS(
            SELECT 1 FROM cache_write_reservations WHERE job_id=c.id))) THEN
            RAISE EXCEPTION 'static_hls_pending_reservation_required';
        END IF;
    END IF;
    RETURN NULL;
END $$;

-- Relational identity/evidence is immediate. The three-row publication is
-- checked at COMMIT, after all conditional writes, never at an intermediate row.
CREATE FUNCTION check_static_hls_parent_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session uuid; r playback_requests; p playback_sessions; c static_hls_captures;
BEGIN
    IF TG_TABLE_NAME='playback_sessions' THEN
        IF TG_OP='DELETE' THEN session=OLD.id; ELSE session=NEW.id; END IF;
    ELSE
        IF TG_OP='DELETE' THEN session=OLD.session_id; ELSE session=NEW.session_id; END IF;
    END IF;
    SELECT * INTO r FROM playback_requests WHERE session_id=session;
    IF r.static_hls_input_version IS NULL THEN RETURN NULL; END IF;
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
CREATE CONSTRAINT TRIGGER static_hls_parent_request_linkage AFTER INSERT OR UPDATE OR DELETE ON playback_requests
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_parent_publication();
CREATE CONSTRAINT TRIGGER static_hls_parent_capture_linkage AFTER INSERT OR UPDATE OR DELETE ON static_hls_captures
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_parent_publication();
CREATE CONSTRAINT TRIGGER static_hls_parent_session_linkage AFTER INSERT OR UPDATE OR DELETE ON playback_sessions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_parent_publication();
