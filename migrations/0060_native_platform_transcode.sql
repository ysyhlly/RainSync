-- Purpose-separated finite, clear native compatibility recipe. Live/DRM grants
-- and pre-wave Workers cannot enter or claim this queue. 0059 is reserved.
LOCK TABLE media_jobs IN ACCESS EXCLUSIVE MODE NOWAIT;
ALTER TABLE media_jobs DROP CONSTRAINT media_jobs_logical_queue_check;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_logical_queue_check CHECK
    (logical_queue IS NULL OR logical_queue IN ('static_hls_v1','advanced_local_v1','local_hls_ladder_v1','native_platform_transcode_v1'));
CREATE TABLE native_platform_transcodes (
    session_id uuid PRIMARY KEY REFERENCES playback_sessions(id) ON DELETE CASCADE,
    user_id uuid NOT NULL,room_id uuid NOT NULL,media_id uuid NOT NULL,generation bigint NOT NULL,
    viewer_id uuid NOT NULL,plan_generation bigint NOT NULL,auth_login_hash text NOT NULL,lifecycle_epoch bigint NOT NULL,
    frozen_resource jsonb NOT NULL,deadline_ms bigint NOT NULL CHECK(deadline_ms>0),
    byte_limit bigint NOT NULL CHECK(byte_limit BETWEEN 1 AND 4311744512),
    bytes_used bigint NOT NULL DEFAULT 0 CHECK(bytes_used BETWEEN 0 AND byte_limit)
);
CREATE FUNCTION native_platform_transcode_job_spec_valid(spec jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE t jsonb; k text; total numeric=0; tickets text[]='{}'; n integer;
BEGIN
    IF jsonb_typeof(spec) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(spec))<>10
        OR NOT spec ?& ARRAY['kind','recipe_version','source_kind','negotiated_mode','tracks','output_ticket','duration_seconds','start_seconds','deadline_ms','estimated_output_bytes']
        OR spec->>'kind' IS DISTINCT FROM 'native_platform_clear_transcode_v1' OR spec->'recipe_version' IS DISTINCT FROM '1'::jsonb
        OR spec->>'source_kind' IS DISTINCT FROM 'native_platform_private' OR spec->>'negotiated_mode' IS DISTINCT FROM 'transcode'
        OR NOT COALESCE(spec->>'output_ticket' ~ '^[0-9a-f]{64}$',false)
        OR jsonb_typeof(spec->'duration_seconds') IS DISTINCT FROM 'number' OR (spec->>'duration_seconds')::numeric NOT BETWEEN 0.001 AND 21600
        OR jsonb_typeof(spec->'start_seconds') IS DISTINCT FROM 'number' OR (spec->>'start_seconds')::numeric<0
        OR (spec->>'start_seconds')::numeric >= (spec->>'duration_seconds')::numeric
        OR jsonb_typeof(spec->'deadline_ms') IS DISTINCT FROM 'number' OR NOT COALESCE(spec->>'deadline_ms' ~ '^[0-9]+$',false)
        OR (spec->>'deadline_ms')::numeric NOT BETWEEN 1 AND 9223372036854775807
        OR jsonb_typeof(spec->'estimated_output_bytes') IS DISTINCT FROM 'number' OR NOT COALESCE(spec->>'estimated_output_bytes' ~ '^[0-9]+$',false)
        OR (spec->>'estimated_output_bytes')::numeric NOT BETWEEN 1 AND 34359738368
        OR jsonb_typeof(spec->'tracks') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    n=jsonb_array_length(spec->'tracks');
    IF n NOT IN (1,2) OR (n=1 AND spec->'tracks'->0->>'key' IS DISTINCT FROM 'progressive')
        OR (n=2 AND (spec->'tracks'->0->>'key' IS DISTINCT FROM 'video' OR spec->'tracks'->1->>'key' IS DISTINCT FROM 'audio')) THEN RETURN false; END IF;
    FOR t IN SELECT value FROM jsonb_array_elements(spec->'tracks') LOOP
        IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(t))<>4
            OR NOT t ?& ARRAY['key','ticket','total_bytes','strong_etag']
            OR NOT COALESCE(t->>'ticket' ~ '^[0-9a-f]{64}$',false) OR t->>'ticket'=spec->>'output_ticket' OR t->>'ticket'=ANY(tickets)
            OR jsonb_typeof(t->'total_bytes') IS DISTINCT FROM 'number' OR NOT COALESCE(t->>'total_bytes' ~ '^[0-9]+$',false)
            OR (t->>'total_bytes')::numeric NOT BETWEEN 1 AND 2147483648
            OR jsonb_typeof(t->'strong_etag') IS DISTINCT FROM 'string' OR length(t->>'strong_etag') NOT BETWEEN 2 AND 512
            OR NOT COALESCE(t->>'strong_etag' ~ '^"[^"[:cntrl:] ]*"$',false) THEN RETURN false; END IF;
        total=total+(t->>'total_bytes')::numeric;tickets=array_append(tickets,t->>'ticket');
    END LOOP;
    RETURN total<=2147483648;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION native_platform_transcode_session_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM native_platform_transcodes n JOIN playback_sessions p ON p.id=n.session_id
        JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id
        JOIN media_jobs j ON j.id=p.id AND j.session_id=p.id
        JOIN room_platform_media e ON e.media_id=p.media_id AND e.room_id=p.room_id
        WHERE p.id=$1 AND p.user_id=n.user_id AND p.room_id=n.room_id AND p.media_id=n.media_id AND p.generation=n.generation
        AND p.viewer_id=n.viewer_id AND p.plan_generation=n.plan_generation AND p.auth_login_hash=n.auth_login_hash
        AND p.lifecycle_epoch=n.lifecycle_epoch AND p.resource=n.frozen_resource
        AND p.resource->'native_platform_compatibility_version'='1'::jsonb
        AND p.resource->'native_platform_context'->'version' IN ('1'::jsonb,'2'::jsonb,'4'::jsonb) AND e.resource_kind<>'live'
        AND p.static_hls_capture_id IS NULL AND j.logical_queue='native_platform_transcode_v1'
        AND native_platform_transcode_job_spec_valid(j.spec) AND (j.spec->>'deadline_ms')::bigint=n.deadline_ms
        AND n.deadline_ms<=floor(extract(epoch FROM p.expires_at)*1000)::bigint
        AND n.deadline_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint
        AND NOT p.stopped AND p.expires_at>clock_timestamp() AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch
        AND s.state->>'media_id'=p.media_id::text AND (s.state->>'media_generation')::bigint=p.generation
        AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch)
        AND playback_source_allowed(p.media_id,p.resource)
        AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id)
        AND EXISTS(SELECT 1 FROM playback_viewer_plans v WHERE v.user_id=p.user_id AND v.room_id=p.room_id
            AND v.viewer_id=p.viewer_id AND v.plan_generation=p.plan_generation AND v.auth_login_hash=p.auth_login_hash))
$$;
CREATE FUNCTION protect_native_platform_transcode_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.media_id IS DISTINCT FROM OLD.media_id OR NEW.generation IS DISTINCT FROM OLD.generation
        OR NEW.viewer_id IS DISTINCT FROM OLD.viewer_id OR NEW.plan_generation IS DISTINCT FROM OLD.plan_generation
        OR NEW.auth_login_hash IS DISTINCT FROM OLD.auth_login_hash OR NEW.lifecycle_epoch IS DISTINCT FROM OLD.lifecycle_epoch
        OR NEW.frozen_resource IS DISTINCT FROM OLD.frozen_resource OR NEW.deadline_ms IS DISTINCT FROM OLD.deadline_ms
        OR NEW.byte_limit IS DISTINCT FROM OLD.byte_limit OR NEW.bytes_used<OLD.bytes_used THEN RAISE EXCEPTION 'native_platform_binding_immutable'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER native_platform_transcode_binding_guard BEFORE UPDATE ON native_platform_transcodes
    FOR EACH ROW EXECUTE FUNCTION protect_native_platform_transcode_binding();
CREATE FUNCTION protect_native_platform_transcode_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native boolean;
BEGIN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    native=NEW.logical_queue='native_platform_transcode_v1' OR left(COALESCE(NEW.spec->>'kind',''),15)='native_platform';
    IF TG_OP='UPDATE' AND OLD.logical_queue='native_platform_transcode_v1' THEN
        native=true;
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.session_id IS DISTINCT FROM OLD.session_id
            OR NEW.logical_queue IS DISTINCT FROM OLD.logical_queue OR NEW.spec IS DISTINCT FROM OLD.spec THEN RAISE EXCEPTION 'native_platform_job_immutable'; END IF;
    ELSIF TG_OP='UPDATE' AND NEW.logical_queue='native_platform_transcode_v1' THEN RAISE EXCEPTION 'native_platform_no_reclassification'; END IF;
    IF NOT COALESCE(native,false) THEN RETURN NEW; END IF;
    IF NEW.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' OR NEW.id<>NEW.session_id
        OR NOT native_platform_transcode_job_spec_valid(NEW.spec) OR static_hls_is_child_session(NEW.session_id)
        OR static_hls_child_identity_reserved(NEW.id) OR NOT EXISTS(SELECT 1 FROM native_platform_transcodes n
            JOIN playback_sessions p ON p.id=n.session_id JOIN room_platform_media e ON e.media_id=p.media_id AND e.room_id=p.room_id
            WHERE n.session_id=NEW.session_id AND e.resource_kind<>'live' AND p.resource=n.frozen_resource
            AND p.resource->'native_platform_compatibility_version'='1'::jsonb
            AND p.resource->'native_platform_context'->'version' IN ('1'::jsonb,'2'::jsonb,'4'::jsonb)
            AND n.deadline_ms=(NEW.spec->>'deadline_ms')::bigint) THEN RAISE EXCEPTION 'native_platform_contract_required'; END IF;
    IF TG_OP='INSERT' AND (NEW.status<>'queued' OR NEW.attempt<>0 OR NEW.owner_id IS NOT NULL OR NEW.lease_until IS NOT NULL) THEN RAISE EXCEPTION 'native_platform_initial_shape_required'; END IF;
    IF TG_OP='UPDATE' AND NEW.status='running' AND (OLD.status<>'running' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.attempt IS DISTINCT FROM OLD.attempt)
        AND current_setting('rainsync.native_platform_recipe',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'native_platform_worker_recipe_required'; END IF;
    IF TG_OP='UPDATE' AND (NEW.status='succeeded' OR (NEW.status='running' AND NEW.lease_until IS DISTINCT FROM OLD.lease_until))
        AND NOT native_platform_transcode_session_allowed(NEW.session_id) THEN RAISE EXCEPTION 'native_platform_authority_revoked'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER native_platform_transcode_job_guard BEFORE INSERT OR UPDATE OR DELETE ON media_jobs
    FOR EACH ROW EXECUTE FUNCTION protect_native_platform_transcode_job();

-- Retain static/child predicates verbatim and exclude only the new queue.
DROP TRIGGER static_hls_job_guard_insert ON media_jobs;
DROP TRIGGER static_hls_job_guard ON media_jobs;
DROP TRIGGER static_hls_job_guard_delete ON media_jobs;
CREATE TRIGGER static_hls_job_guard_insert BEFORE INSERT ON media_jobs
    FOR EACH ROW WHEN (NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND NEW.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1'
        AND NOT static_hls_is_child_session(NEW.session_id) AND NOT static_hls_child_identity_reserved(NEW.id)
        AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard BEFORE UPDATE ON media_jobs
    FOR EACH ROW WHEN (OLD.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1'
        AND OLD.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND NEW.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1'
        AND NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_is_child_session(NEW.session_id)
        AND NOT static_hls_child_identity_reserved(OLD.id) AND NOT static_hls_child_identity_reserved(NEW.id)
        AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child' AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child')
        EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard_delete BEFORE DELETE ON media_jobs
    FOR EACH ROW WHEN (OLD.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND OLD.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1'
        AND NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_child_identity_reserved(OLD.id)
        AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();

-- Native publication/file proofs may never bypass the original authority gate,
-- even through a generic SQL publication caller. Cleanup remains unfenced.
CREATE FUNCTION protect_native_platform_transcode_output() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j media_jobs%ROWTYPE;
BEGIN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM media_jobs old_job WHERE old_job.id=OLD.job_id AND old_job.logical_queue='native_platform_transcode_v1')
        AND (NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.attempt IS DISTINCT FROM OLD.attempt
            OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.validation_version IS DISTINCT FROM OLD.validation_version
            OR NEW.relative_dir IS DISTINCT FROM OLD.relative_dir OR NEW.ready_segments<OLD.ready_segments) THEN
        RAISE EXCEPTION 'native_platform_output_identity_immutable'; END IF;
    SELECT * INTO j FROM media_jobs WHERE id=NEW.job_id;
    IF j.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' THEN RETURN NEW; END IF;
    IF NEW.validation_version<>3 OR NEW.relative_dir<>NEW.job_id::text||'/'||NEW.attempt::text THEN RAISE EXCEPTION 'native_platform_output_recipe_required'; END IF;
    IF TG_OP='UPDATE' AND (NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.attempt IS DISTINCT FROM OLD.attempt
        OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.validation_version IS DISTINCT FROM OLD.validation_version
        OR NEW.relative_dir IS DISTINCT FROM OLD.relative_dir) THEN RAISE EXCEPTION 'native_platform_output_identity_immutable'; END IF;
    IF NEW.status IN ('writing','published') AND (NEW.attempt<>j.attempt OR NEW.owner_id IS DISTINCT FROM j.owner_id
        OR NOT native_platform_transcode_session_allowed(j.session_id)
        OR NOT ((j.status='running' AND j.lease_until>clock_timestamp()) OR (NEW.status='published' AND j.status='succeeded'))) THEN
        RAISE EXCEPTION 'native_platform_output_authority_revoked'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER native_platform_transcode_output_guard BEFORE INSERT OR UPDATE OR DELETE ON media_outputs
    FOR EACH ROW EXECUTE FUNCTION protect_native_platform_transcode_output();
CREATE FUNCTION protect_native_platform_transcode_output_file() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j media_jobs%ROWTYPE;
BEGIN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM media_jobs old_job WHERE old_job.id=OLD.job_id AND old_job.logical_queue='native_platform_transcode_v1')
        AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'native_platform_output_file_immutable'; END IF;
    SELECT * INTO j FROM media_jobs WHERE id=NEW.job_id;
    IF j.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'native_platform_output_file_immutable'; END IF;
    IF NEW.attempt<>j.attempt OR j.status<>'running' OR j.lease_until<=clock_timestamp()
        OR NOT native_platform_transcode_session_allowed(j.session_id) THEN RAISE EXCEPTION 'native_platform_output_file_authority_revoked'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER native_platform_transcode_output_file_guard BEFORE INSERT OR UPDATE OR DELETE ON media_output_files
    FOR EACH ROW EXECUTE FUNCTION protect_native_platform_transcode_output_file();
