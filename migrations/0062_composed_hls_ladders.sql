-- Purpose-separated finite native and advanced-local software ladders.
-- No source authority, deadline or publication proof is weakened by composition.
LOCK TABLE media_jobs IN ACCESS EXCLUSIVE MODE NOWAIT;
ALTER TABLE media_jobs DROP CONSTRAINT media_jobs_logical_queue_check;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_logical_queue_check CHECK
(logical_queue IS NULL OR logical_queue IN ('static_hls_v1','advanced_local_v1','local_hls_ladder_v1','native_platform_transcode_v1','native_platform_hls_ladder_v1','advanced_hls_ladder_v1'));
ALTER FUNCTION local_hls_ladder_job_spec_valid(jsonb) RENAME TO local_hls_ladder_job_spec_valid_sdr;
CREATE FUNCTION local_hls_ladder_job_spec_valid(spec jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE request jsonb;
BEGIN
 IF spec->>'kind'='local_hls_ladder_transcode_v1' THEN RETURN local_hls_ladder_job_spec_valid_sdr(spec); END IF;
 request=spec->'advanced_media';
 IF spec->>'kind' IS DISTINCT FROM 'advanced_hls_ladder_transcode_v1' OR jsonb_typeof(request) IS DISTINCT FROM 'object'
 OR (SELECT count(*) FROM jsonb_object_keys(request))<>3 OR NOT request ?& ARRAY['schema_version','tone_map_hdr','subtitle_stream_index']
 OR request->'schema_version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(request->'tone_map_hdr') IS DISTINCT FROM 'boolean'
 OR NOT (request->'tone_map_hdr'='true'::jsonb OR request->'subtitle_stream_index'<>'null'::jsonb) THEN RETURN false; END IF;
 IF request->'subtitle_stream_index'<>'null'::jsonb AND (jsonb_typeof(request->'subtitle_stream_index') IS DISTINCT FROM 'number'
 OR NOT COALESCE(request->>'subtitle_stream_index' ~ '^[0-9]+$',false) OR (request->>'subtitle_stream_index')::numeric>4294967295) THEN RETURN false; END IF;
 RETURN local_hls_ladder_job_spec_valid_sdr((spec-'advanced_media')||jsonb_build_object('kind','local_hls_ladder_transcode_v1'));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION native_platform_ladder_job_spec_valid(spec jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE native jsonb; local jsonb;
BEGIN
 IF jsonb_typeof(spec) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(spec))<>13
 OR NOT spec ?& ARRAY['source_generation','plan_generation','renditions'] OR spec->>'kind' IS DISTINCT FROM 'native_platform_clear_ladder_v1' THEN RETURN false; END IF;
 native=(spec-ARRAY['source_generation','plan_generation','renditions'])||jsonb_build_object('kind','native_platform_clear_transcode_v1');
 IF NOT native_platform_transcode_job_spec_valid(native) THEN RETURN false; END IF;
 local=jsonb_build_object('kind','local_hls_ladder_transcode_v1','recipe_version',1,'root','/sealed','resource','opaque','source_kind','local','input_ticket','opaque','start_seconds',spec->'start_seconds','transcode',true,'audio_index',1,'estimated_output_bytes',spec->'estimated_output_bytes','negotiated_mode','transcode','source_version','stat-v1:'||repeat('0',64),'duration_ms',(spec->>'duration_seconds')::numeric*1000,'source_generation',spec->'source_generation','plan_generation',spec->'plan_generation','renditions',spec->'renditions');
 RETURN local_hls_ladder_job_spec_valid_sdr(local);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE OR REPLACE FUNCTION local_hls_ladder_session_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM playback_sessions p JOIN rooms r ON r.id=p.room_id
        JOIN room_snapshots s ON s.room_id=p.room_id JOIN media_jobs j ON j.id=p.id AND j.session_id=p.id
        WHERE p.id=$1 AND p.resource->'local_hls_ladder_version'='1'::jsonb
        AND p.static_hls_capture_id IS NULL AND ((j.logical_queue='local_hls_ladder_v1' AND j.spec->>'kind'='local_hls_ladder_transcode_v1' AND NOT (p.resource ? 'advanced_hls_ladder_version')) OR (j.logical_queue='advanced_hls_ladder_v1' AND j.spec->>'kind'='advanced_hls_ladder_transcode_v1' AND p.resource->'advanced_hls_ladder_version'='1'::jsonb))
        AND local_hls_ladder_job_spec_valid(j.spec)
        AND p.generation=(j.spec->>'source_generation')::bigint
        AND p.plan_generation=(j.spec->>'plan_generation')::bigint
        AND p.viewer_id IS NOT NULL AND p.auth_login_hash IS NOT NULL
        AND NOT p.stopped AND p.expires_at>clock_timestamp()
        AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch
        AND (s.state->>'media_generation')::bigint=p.generation AND (s.state->>'media_id')::uuid=p.media_id
        AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch)
        AND playback_source_authority_allowed(p.media_id,p.resource)
        AND EXISTS(SELECT 1 FROM playback_viewer_plans v WHERE v.user_id=p.user_id AND v.room_id=p.room_id
            AND v.viewer_id=p.viewer_id AND v.plan_generation=p.plan_generation AND v.auth_login_hash=p.auth_login_hash))
$$;
CREATE OR REPLACE FUNCTION native_platform_transcode_session_allowed(session uuid)
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
        AND p.static_hls_capture_id IS NULL AND ((j.logical_queue='native_platform_transcode_v1' AND native_platform_transcode_job_spec_valid(j.spec) AND NOT (p.resource ? 'native_platform_hls_ladder_version')) OR (j.logical_queue='native_platform_hls_ladder_v1' AND native_platform_ladder_job_spec_valid(j.spec) AND p.resource->'native_platform_hls_ladder_version'='1'::jsonb AND p.generation=(j.spec->>'source_generation')::bigint AND p.plan_generation=(j.spec->>'plan_generation')::bigint))
        AND (j.spec->>'deadline_ms')::bigint=n.deadline_ms
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
CREATE FUNCTION hls_ladder_job_allowed(job uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=$1 AND
 ((j.logical_queue IN ('local_hls_ladder_v1','advanced_hls_ladder_v1') AND local_hls_ladder_job_spec_valid(j.spec) AND local_hls_ladder_session_allowed(j.session_id))
 OR (j.logical_queue='native_platform_hls_ladder_v1' AND native_platform_ladder_job_spec_valid(j.spec) AND native_platform_transcode_session_allowed(j.session_id))))
$$;
ALTER FUNCTION playback_source_allowed(uuid,jsonb) RENAME TO playback_source_allowed_pre_composed_ladder;
CREATE FUNCTION playback_source_allowed(media uuid,resource jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT playback_source_allowed_pre_composed_ladder($1,$2)
 AND CASE WHEN $2 ? 'native_platform_hls_ladder_version' THEN $2->'native_platform_hls_ladder_version'='1'::jsonb
 AND COALESCE(current_setting('rainsync.native_platform_ladder_reader',true)='1',false) ELSE true END
 AND CASE WHEN $2 ? 'advanced_hls_ladder_version' THEN $2->'advanced_hls_ladder_version'='1'::jsonb
 AND COALESCE(current_setting('rainsync.advanced_hls_ladder_reader',true)='1',false) ELSE true END
$$;
CREATE OR REPLACE FUNCTION protect_local_hls_ladder_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ladder boolean;
BEGIN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    ladder=NEW.logical_queue IN ('local_hls_ladder_v1','advanced_hls_ladder_v1') OR left(COALESCE(NEW.spec->>'kind',''),16)='local_hls_ladder' OR NEW.spec->>'kind'='advanced_hls_ladder_transcode_v1';
    IF TG_OP='UPDATE' AND OLD.logical_queue IN ('local_hls_ladder_v1','advanced_hls_ladder_v1') THEN
        ladder=true;
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.spec IS DISTINCT FROM OLD.spec
            OR NEW.logical_queue IS DISTINCT FROM OLD.logical_queue THEN RAISE EXCEPTION 'local_hls_ladder_queue_immutable'; END IF;
    ELSIF TG_OP='UPDATE' AND NEW.logical_queue IN ('local_hls_ladder_v1','advanced_hls_ladder_v1') THEN RAISE EXCEPTION 'local_hls_ladder_no_reclassification'; END IF;
    IF NOT COALESCE(ladder,false) THEN RETURN NEW; END IF;
    IF (NEW.logical_queue='advanced_hls_ladder_v1') IS DISTINCT FROM (NEW.spec->>'kind'='advanced_hls_ladder_transcode_v1') THEN RAISE EXCEPTION 'advanced_hls_ladder_queue_contract_required'; END IF;
    IF (NEW.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1') OR NOT local_hls_ladder_job_spec_valid(NEW.spec)
        OR static_hls_is_child_session(NEW.session_id) OR static_hls_child_identity_reserved(NEW.id)
        OR NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=NEW.session_id AND p.id=NEW.id
            AND p.resource->'local_hls_ladder_version'='1'::jsonb AND p.static_hls_capture_id IS NULL
            AND ((NEW.logical_queue='advanced_hls_ladder_v1' AND p.resource->'advanced_hls_ladder_version'='1'::jsonb) OR (NEW.logical_queue='local_hls_ladder_v1' AND NOT (p.resource ? 'advanced_hls_ladder_version')))
            AND p.viewer_id IS NOT NULL AND p.auth_login_hash IS NOT NULL
            AND p.generation=(NEW.spec->>'source_generation')::bigint AND p.plan_generation=(NEW.spec->>'plan_generation')::bigint)
        THEN RAISE EXCEPTION 'local_hls_ladder_queue_contract_required'; END IF;
    IF TG_OP='INSERT' AND (NEW.status<>'queued' OR NEW.attempt<>0 OR NEW.owner_id IS NOT NULL OR NEW.lease_until IS NOT NULL)
        THEN RAISE EXCEPTION 'local_hls_ladder_initial_shape_required'; END IF;
    IF TG_OP='UPDATE' AND NEW.status='running' AND (OLD.status<>'running' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.attempt IS DISTINCT FROM OLD.attempt)
        AND (CASE WHEN NEW.logical_queue='advanced_hls_ladder_v1' THEN current_setting('rainsync.advanced_hls_ladder_recipe',true) ELSE current_setting('rainsync.local_hls_ladder_recipe',true) END) IS DISTINCT FROM '1'
        THEN RAISE EXCEPTION 'local_hls_ladder_worker_recipe_required'; END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION protect_native_platform_transcode_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native boolean;
BEGIN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    native=NEW.logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1') OR left(COALESCE(NEW.spec->>'kind',''),15)='native_platform';
    IF TG_OP='UPDATE' AND OLD.logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1') THEN
        native=true;
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.session_id IS DISTINCT FROM OLD.session_id
            OR NEW.logical_queue IS DISTINCT FROM OLD.logical_queue OR NEW.spec IS DISTINCT FROM OLD.spec THEN RAISE EXCEPTION 'native_platform_job_immutable'; END IF;
    ELSIF TG_OP='UPDATE' AND NEW.logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1') THEN RAISE EXCEPTION 'native_platform_no_reclassification'; END IF;
    IF NOT COALESCE(native,false) THEN RETURN NEW; END IF;
    IF (NEW.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1') OR NEW.id<>NEW.session_id
        OR NOT (CASE WHEN NEW.logical_queue='native_platform_hls_ladder_v1' THEN native_platform_ladder_job_spec_valid(NEW.spec) ELSE native_platform_transcode_job_spec_valid(NEW.spec) END) OR static_hls_is_child_session(NEW.session_id)
        OR static_hls_child_identity_reserved(NEW.id) OR NOT EXISTS(SELECT 1 FROM native_platform_transcodes n
            JOIN playback_sessions p ON p.id=n.session_id JOIN room_platform_media e ON e.media_id=p.media_id AND e.room_id=p.room_id
            WHERE n.session_id=NEW.session_id AND e.resource_kind<>'live' AND p.resource=n.frozen_resource
            AND ((NEW.logical_queue='native_platform_hls_ladder_v1' AND p.resource->'native_platform_hls_ladder_version'='1'::jsonb AND p.generation=(NEW.spec->>'source_generation')::bigint AND p.plan_generation=(NEW.spec->>'plan_generation')::bigint) OR (NEW.logical_queue='native_platform_transcode_v1' AND NOT (p.resource ? 'native_platform_hls_ladder_version')))
            AND p.resource->'native_platform_compatibility_version'='1'::jsonb
            AND p.resource->'native_platform_context'->'version' IN ('1'::jsonb,'2'::jsonb,'4'::jsonb)
            AND n.deadline_ms=(NEW.spec->>'deadline_ms')::bigint) THEN RAISE EXCEPTION 'native_platform_contract_required'; END IF;
    IF TG_OP='INSERT' AND (NEW.status<>'queued' OR NEW.attempt<>0 OR NEW.owner_id IS NOT NULL OR NEW.lease_until IS NOT NULL) THEN RAISE EXCEPTION 'native_platform_initial_shape_required'; END IF;
    IF TG_OP='UPDATE' AND NEW.status='running' AND (OLD.status<>'running' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.attempt IS DISTINCT FROM OLD.attempt)
        AND (CASE WHEN NEW.logical_queue='native_platform_hls_ladder_v1' THEN current_setting('rainsync.native_platform_ladder_recipe',true) ELSE current_setting('rainsync.native_platform_recipe',true) END) IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'native_platform_worker_recipe_required'; END IF;
    IF TG_OP='UPDATE' AND (NEW.status='succeeded' OR (NEW.status='running' AND NEW.lease_until IS DISTINCT FROM OLD.lease_until))
        AND NOT native_platform_transcode_session_allowed(NEW.session_id) THEN RAISE EXCEPTION 'native_platform_authority_revoked'; END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION protect_local_hls_ladder_output() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ladder boolean;
BEGIN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    ladder=EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=NEW.job_id AND j.logical_queue IN ('local_hls_ladder_v1','advanced_hls_ladder_v1','native_platform_hls_ladder_v1'));
    IF TG_OP='UPDATE' AND OLD.validation_version=5 AND (NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.attempt IS DISTINCT FROM OLD.attempt
        OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.relative_dir IS DISTINCT FROM OLD.relative_dir OR NEW.validation_version IS DISTINCT FROM OLD.validation_version)
        THEN RAISE EXCEPTION 'local_hls_ladder_output_immutable'; END IF;
    IF ladder IS DISTINCT FROM (NEW.validation_version=5) THEN RAISE EXCEPTION 'local_hls_ladder_output_contract_required'; END IF;
    IF NOT ladder THEN RETURN NEW; END IF;
    IF TG_OP='INSERT' AND (NEW.status<>'writing' OR NEW.ready_segments<>0 OR NEW.visible_manifest IS NOT NULL
        OR NEW.manifest_sha256 IS NOT NULL OR NEW.segment_count IS NOT NULL OR NEW.published_at IS NOT NULL)
        THEN RAISE EXCEPTION 'local_hls_ladder_initial_output_required'; END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION protect_local_hls_ladder_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM media_outputs o JOIN media_jobs j ON j.id=o.job_id
        WHERE o.job_id=NEW.job_id AND o.attempt=NEW.attempt AND o.validation_version=5 AND j.logical_queue IN ('local_hls_ladder_v1','advanced_hls_ladder_v1','native_platform_hls_ladder_v1') AND hls_ladder_job_allowed(j.id) AND j.attempt=NEW.attempt AND j.status='running' AND j.lease_until>clock_timestamp()
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(j.spec->'renditions') r WHERE r->>'id'=NEW.rendition))
        THEN RAISE EXCEPTION 'local_hls_ladder_output_contract_required'; END IF;
    IF TG_OP='UPDATE' AND (NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.attempt IS DISTINCT FROM OLD.attempt
        OR NEW.rendition IS DISTINCT FROM OLD.rendition OR NEW.ready_segments<OLD.ready_segments OR NEW.duration_us<OLD.duration_us
        OR left(NEW.manifest,length(OLD.manifest))<>OLD.manifest) THEN RAISE EXCEPTION 'local_hls_ladder_snapshot_regressed'; END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION protect_native_platform_transcode_output() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j media_jobs%ROWTYPE;
BEGIN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM media_jobs old_job WHERE old_job.id=OLD.job_id AND old_job.logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1'))
        AND (NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.attempt IS DISTINCT FROM OLD.attempt
            OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.validation_version IS DISTINCT FROM OLD.validation_version
            OR NEW.relative_dir IS DISTINCT FROM OLD.relative_dir OR NEW.ready_segments<OLD.ready_segments) THEN
        RAISE EXCEPTION 'native_platform_output_identity_immutable'; END IF;
    SELECT * INTO j FROM media_jobs WHERE id=NEW.job_id;
    IF (j.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND j.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1') THEN RETURN NEW; END IF;
    IF NEW.validation_version<>(CASE WHEN j.logical_queue='native_platform_hls_ladder_v1' THEN 5 ELSE 3 END) OR NEW.relative_dir<>NEW.job_id::text||'/'||NEW.attempt::text THEN RAISE EXCEPTION 'native_platform_output_recipe_required'; END IF;
    IF TG_OP='UPDATE' AND (NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.attempt IS DISTINCT FROM OLD.attempt
        OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.validation_version IS DISTINCT FROM OLD.validation_version
        OR NEW.relative_dir IS DISTINCT FROM OLD.relative_dir) THEN RAISE EXCEPTION 'native_platform_output_identity_immutable'; END IF;
    IF NEW.status IN ('writing','published') AND (NEW.attempt<>j.attempt OR NEW.owner_id IS DISTINCT FROM j.owner_id
        OR NOT native_platform_transcode_session_allowed(j.session_id)
        OR NOT ((j.status='running' AND j.lease_until>clock_timestamp()) OR (NEW.status='published' AND j.status='succeeded'))) THEN
        RAISE EXCEPTION 'native_platform_output_authority_revoked'; END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION protect_local_hls_ladder_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked boolean;
BEGIN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    marked=NEW.resource ? 'local_hls_ladder_version';
    IF TG_OP='UPDATE' AND OLD.resource ? 'local_hls_ladder_version' THEN
        marked=true;
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
            OR NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.media_id IS DISTINCT FROM OLD.media_id
            OR NEW.generation IS DISTINCT FROM OLD.generation OR NEW.lifecycle_epoch IS DISTINCT FROM OLD.lifecycle_epoch
            OR NEW.viewer_id IS DISTINCT FROM OLD.viewer_id OR NEW.plan_generation IS DISTINCT FROM OLD.plan_generation
            OR NEW.auth_login_hash IS DISTINCT FROM OLD.auth_login_hash OR NEW.auth_membership_epoch IS DISTINCT FROM OLD.auth_membership_epoch
            OR NEW.delivery_token_hash IS DISTINCT FROM OLD.delivery_token_hash OR NEW.resource IS DISTINCT FROM OLD.resource
            OR NEW.static_hls_capture_id IS DISTINCT FROM OLD.static_hls_capture_id THEN RAISE EXCEPTION 'local_hls_ladder_session_immutable'; END IF;
        IF current_setting('rainsync.local_hls_ladder_reader',true) IS DISTINCT FROM '1'
            AND NOT (NEW.stopped AND (to_jsonb(NEW)-'stopped')=(to_jsonb(OLD)-'stopped')) THEN RETURN NULL; END IF;
    ELSIF TG_OP='UPDATE' AND marked THEN RAISE EXCEPTION 'local_hls_ladder_session_no_reclassification'; END IF;
    IF NEW.resource ? 'advanced_hls_ladder_version' AND NOT marked THEN RAISE EXCEPTION 'advanced_hls_ladder_contract_required'; END IF;
    IF NOT marked THEN RETURN NEW; END IF;
    IF NEW.resource ? 'advanced_hls_ladder_version' AND (NEW.resource->'advanced_hls_ladder_version' IS DISTINCT FROM '1'::jsonb OR (current_setting('rainsync.advanced_hls_ladder_reader',true) IS DISTINCT FROM '1' AND NOT (TG_OP='UPDATE' AND NEW.stopped AND (to_jsonb(NEW)-'stopped')=(to_jsonb(OLD)-'stopped')))) THEN RAISE EXCEPTION 'advanced_hls_ladder_reader_required'; END IF;
    IF NEW.resource->'local_hls_ladder_version' IS DISTINCT FROM '1'::jsonb OR NEW.static_hls_capture_id IS NOT NULL
        OR NEW.viewer_id IS NULL OR NEW.plan_generation IS NULL OR NEW.plan_generation<=0 OR NEW.auth_login_hash IS NULL
        OR NEW.resource ?| ARRAY['static_hls_capture_id','native_platform_context','http_file_context'] THEN RAISE EXCEPTION 'local_hls_ladder_session_contract_required'; END IF;
    IF TG_OP='INSERT' AND current_setting('rainsync.local_hls_ladder_reader',true) IS DISTINCT FROM '1'
        THEN RAISE EXCEPTION 'local_hls_ladder_reader_required'; END IF;
    RETURN NEW;
END $$;
CREATE FUNCTION protect_composed_ladder_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'published_output_changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM media_jobs j JOIN media_outputs o ON o.job_id=j.id AND o.attempt=j.attempt AND o.owner_id=j.owner_id
 WHERE j.id=NEW.job_id AND j.attempt=NEW.attempt AND j.status='running' AND j.lease_until>clock_timestamp()
 AND hls_ladder_job_allowed(j.id) AND o.validation_version=5 AND o.status='writing'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(j.spec->'renditions') r WHERE r->>'id'=NEW.rendition)) THEN RAISE EXCEPTION 'hls_ladder_output_file_authority_revoked'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER composed_ladder_file_guard BEFORE INSERT OR UPDATE OR DELETE ON local_hls_ladder_files FOR EACH ROW EXECUTE FUNCTION protect_composed_ladder_file();
CREATE FUNCTION protect_native_ladder_marker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (OLD.resource ? 'native_platform_hls_ladder_version') IS DISTINCT FROM (NEW.resource ? 'native_platform_hls_ladder_version') THEN RAISE EXCEPTION 'native_platform_ladder_no_reclassification'; END IF;
 IF NEW.resource ? 'native_platform_hls_ladder_version' AND (NEW.resource->'native_platform_hls_ladder_version' IS DISTINCT FROM '1'::jsonb
 OR NEW.resource->'native_platform_compatibility_version' IS DISTINCT FROM '1'::jsonb OR (current_setting('rainsync.native_platform_ladder_reader',true) IS DISTINCT FROM '1' AND NOT (TG_OP='UPDATE' AND NEW.stopped AND (to_jsonb(NEW)-'stopped')=(to_jsonb(OLD)-'stopped')))
 OR NEW.static_hls_capture_id IS NOT NULL OR NEW.viewer_id IS NULL OR NEW.auth_login_hash IS NULL
 OR NEW.resource ?| ARRAY['local_hls_ladder_version','advanced_hls_ladder_version','http_file_context','static_hls_capture_id']) THEN RAISE EXCEPTION 'native_platform_ladder_contract_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_native_ladder_marker_guard BEFORE INSERT OR UPDATE ON playback_sessions FOR EACH ROW EXECUTE FUNCTION protect_native_ladder_marker();
-- Retain static/child predicates verbatim and exclude only the new queue.
DROP TRIGGER static_hls_job_guard_insert ON media_jobs;
DROP TRIGGER static_hls_job_guard ON media_jobs;
DROP TRIGGER static_hls_job_guard_delete ON media_jobs;
CREATE TRIGGER static_hls_job_guard_insert BEFORE INSERT ON media_jobs
    FOR EACH ROW WHEN (NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND NEW.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1'
        AND NOT static_hls_is_child_session(NEW.session_id) AND NOT static_hls_child_identity_reserved(NEW.id)
        AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard BEFORE UPDATE ON media_jobs
    FOR EACH ROW WHEN (OLD.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1'
        AND OLD.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1'
        AND NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_is_child_session(NEW.session_id)
        AND NOT static_hls_child_identity_reserved(OLD.id) AND NOT static_hls_child_identity_reserved(NEW.id)
        AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child' AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child')
        EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard_delete BEFORE DELETE ON media_jobs
    FOR EACH ROW WHEN (OLD.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND OLD.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1'
        AND NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_child_identity_reserved(OLD.id)
        AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();

