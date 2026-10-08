-- Closed own-software ladder recipe1. Not a static input or single-output proof.
-- Mixed binaries remain fail-closed: old Workers cannot claim this logical queue,
-- old readers cannot deliver marked sessions, and v2/3/v4 are unchanged.
LOCK TABLE media_jobs IN ACCESS EXCLUSIVE MODE NOWAIT;
ALTER TABLE media_jobs DROP CONSTRAINT media_jobs_logical_queue_check;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_logical_queue_check CHECK
    (logical_queue IS NULL OR logical_queue IN ('static_hls_v1','advanced_local_v1','local_hls_ladder_v1'));

CREATE FUNCTION local_hls_ladder_job_spec_valid(spec jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE rung jsonb; prior text; audio text; n numeric;
BEGIN
    IF jsonb_typeof(spec) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(spec))<>16
        OR NOT spec ?& ARRAY['kind','recipe_version','root','resource','source_kind','input_ticket','start_seconds','transcode','audio_index','estimated_output_bytes','negotiated_mode','source_version','duration_ms','source_generation','plan_generation','renditions']
        OR spec->>'kind' IS DISTINCT FROM 'local_hls_ladder_transcode_v1'
        OR spec->'recipe_version' IS DISTINCT FROM '1'::jsonb OR spec->>'source_kind' IS DISTINCT FROM 'local'
        OR spec->>'negotiated_mode' IS DISTINCT FROM 'transcode' OR spec->'transcode' IS DISTINCT FROM 'true'::jsonb
        OR jsonb_typeof(spec->'root') IS DISTINCT FROM 'string' OR length(spec->>'root') NOT BETWEEN 1 AND 65536
        OR jsonb_typeof(spec->'resource') IS DISTINCT FROM 'string' OR length(spec->>'resource') NOT BETWEEN 1 AND 65536
        OR jsonb_typeof(spec->'input_ticket') IS DISTINCT FROM 'string' OR length(spec->>'input_ticket') NOT BETWEEN 1 AND 65536
        OR NOT COALESCE(spec->>'source_version' ~ '^stat-v1:[0-9a-f]{64}$',false)
        OR jsonb_typeof(spec->'start_seconds') IS DISTINCT FROM 'number'
        OR jsonb_typeof(spec->'duration_ms') IS DISTINCT FROM 'number'
        OR (spec->>'start_seconds')::numeric<0 OR (spec->>'duration_ms')::numeric NOT BETWEEN 1 AND 86400000
        OR (spec->>'start_seconds')::numeric*1000 >= (spec->>'duration_ms')::numeric
        OR (spec->>'duration_ms')::numeric-(spec->>'start_seconds')::numeric*1000>26188000
        OR jsonb_typeof(spec->'source_generation') IS DISTINCT FROM 'number' OR NOT COALESCE(spec->>'source_generation' ~ '^[0-9]+$',false)
        OR (spec->>'source_generation')::numeric NOT BETWEEN 0 AND 4294967295
        OR jsonb_typeof(spec->'plan_generation') IS DISTINCT FROM 'number' OR NOT COALESCE(spec->>'plan_generation' ~ '^[0-9]+$',false)
        OR (spec->>'plan_generation')::numeric NOT BETWEEN 1 AND 4294967295
        OR jsonb_typeof(spec->'estimated_output_bytes') IS DISTINCT FROM 'number' OR NOT COALESCE(spec->>'estimated_output_bytes' ~ '^[0-9]+$',false)
        OR (spec->>'estimated_output_bytes')::numeric NOT BETWEEN 1 AND 9223372036854775807
        OR jsonb_typeof(spec->'renditions') IS DISTINCT FROM 'array' OR jsonb_array_length(spec->'renditions') NOT BETWEEN 1 AND 3 THEN RETURN false; END IF;
    IF spec->'audio_index' IS DISTINCT FROM 'null'::jsonb THEN
        audio=spec->>'audio_index';
        IF jsonb_typeof(spec->'audio_index') IS DISTINCT FROM 'number' OR NOT COALESCE(audio ~ '^[0-9]+$',false)
            OR audio::numeric>4294967295 THEN RETURN false; END IF;
    END IF;
    FOR rung IN SELECT value FROM jsonb_array_elements(spec->'renditions') LOOP
        IF jsonb_typeof(rung) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(rung))<>9
            OR NOT rung ?& ARRAY['id','width','height','video_bitrate','video_maxrate','bandwidth','average_bandwidth','avc_codec','audio_bitrate']
            OR NOT COALESCE(rung->>'id' IN ('low','medium','high'),false)
            OR (prior IS NOT NULL AND array_position(ARRAY['low','medium','high'],rung->>'id')<=array_position(ARRAY['low','medium','high'],prior)) THEN RETURN false; END IF;
        prior=rung->>'id';
        IF jsonb_typeof(rung->'width') IS DISTINCT FROM 'number' OR jsonb_typeof(rung->'height') IS DISTINCT FROM 'number'
            OR (rung->>'width')::numeric NOT BETWEEN 2 AND (CASE prior WHEN 'low' THEN 640 WHEN 'medium' THEN 1280 ELSE 1920 END)
            OR (rung->>'height')::numeric NOT BETWEEN 2 AND (CASE prior WHEN 'low' THEN 360 WHEN 'medium' THEN 720 ELSE 1080 END)
            OR mod((rung->>'width')::numeric,2)<>0 OR mod((rung->>'height')::numeric,2)<>0
            OR rung->'video_bitrate' IS DISTINCT FROM (CASE prior WHEN 'low' THEN '800000'::jsonb WHEN 'medium' THEN '2500000'::jsonb ELSE '5000000'::jsonb END)
            OR rung->'video_maxrate' IS DISTINCT FROM (CASE prior WHEN 'low' THEN '1000000'::jsonb WHEN 'medium' THEN '3000000'::jsonb ELSE '6000000'::jsonb END)
            OR rung->>'avc_codec' IS DISTINCT FROM (CASE prior WHEN 'high' THEN 'avc1.640028' ELSE 'avc1.64001F' END)
            OR rung->'audio_bitrate' IS DISTINCT FROM (CASE WHEN spec->'audio_index'='null'::jsonb THEN 'null'::jsonb ELSE '128000'::jsonb END)
            OR (rung->>'average_bandwidth')::numeric IS DISTINCT FROM (rung->>'video_bitrate')::numeric+COALESCE((rung->>'audio_bitrate')::numeric,0)
            OR (rung->>'bandwidth')::numeric IS DISTINCT FROM ((rung->>'video_maxrate')::numeric+COALESCE((rung->>'audio_bitrate')::numeric,0))*5/4 THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;

CREATE FUNCTION local_hls_ladder_session_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM playback_sessions p JOIN rooms r ON r.id=p.room_id
        JOIN room_snapshots s ON s.room_id=p.room_id JOIN media_jobs j ON j.id=p.id AND j.session_id=p.id
        WHERE p.id=$1 AND p.resource->'local_hls_ladder_version'='1'::jsonb
        AND p.static_hls_capture_id IS NULL AND j.logical_queue='local_hls_ladder_v1'
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

ALTER FUNCTION playback_source_allowed(uuid,jsonb) RENAME TO playback_source_allowed_pre_ladder_v1;
CREATE FUNCTION playback_source_allowed(media uuid, resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT playback_source_allowed_pre_ladder_v1($1,$2)
        AND CASE WHEN $2 ? 'local_hls_ladder_version' THEN
            $2->'local_hls_ladder_version'='1'::jsonb
            AND COALESCE(current_setting('rainsync.local_hls_ladder_reader',true)='1',false)
        ELSE true END
$$;

-- Preserve the existing static guard body and every static/child exclusion.
DROP TRIGGER static_hls_job_guard_insert ON media_jobs;
DROP TRIGGER static_hls_job_guard ON media_jobs;
DROP TRIGGER static_hls_job_guard_delete ON media_jobs;
CREATE TRIGGER static_hls_job_guard_insert BEFORE INSERT ON media_jobs
    FOR EACH ROW WHEN (NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND NEW.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1'
        AND NOT static_hls_is_child_session(NEW.session_id) AND NOT static_hls_child_identity_reserved(NEW.id)
        AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard BEFORE UPDATE ON media_jobs
    FOR EACH ROW WHEN (OLD.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1'
        AND OLD.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1'
        AND NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_is_child_session(NEW.session_id)
        AND NOT static_hls_child_identity_reserved(OLD.id) AND NOT static_hls_child_identity_reserved(NEW.id)
        AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child' AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child')
        EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard_delete BEFORE DELETE ON media_jobs
    FOR EACH ROW WHEN (OLD.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND OLD.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1'
        AND NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_child_identity_reserved(OLD.id)
        AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();
CREATE FUNCTION protect_local_hls_ladder_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ladder boolean;
BEGIN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    ladder=NEW.logical_queue='local_hls_ladder_v1' OR left(COALESCE(NEW.spec->>'kind',''),16)='local_hls_ladder';
    IF TG_OP='UPDATE' AND OLD.logical_queue='local_hls_ladder_v1' THEN
        ladder=true;
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.spec IS DISTINCT FROM OLD.spec
            OR NEW.logical_queue IS DISTINCT FROM OLD.logical_queue THEN RAISE EXCEPTION 'local_hls_ladder_queue_immutable'; END IF;
    ELSIF TG_OP='UPDATE' AND NEW.logical_queue='local_hls_ladder_v1' THEN RAISE EXCEPTION 'local_hls_ladder_no_reclassification'; END IF;
    IF NOT COALESCE(ladder,false) THEN RETURN NEW; END IF;
    IF NEW.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' OR NOT local_hls_ladder_job_spec_valid(NEW.spec)
        OR static_hls_is_child_session(NEW.session_id) OR static_hls_child_identity_reserved(NEW.id)
        OR NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=NEW.session_id AND p.id=NEW.id
            AND p.resource->'local_hls_ladder_version'='1'::jsonb AND p.static_hls_capture_id IS NULL
            AND p.viewer_id IS NOT NULL AND p.auth_login_hash IS NOT NULL
            AND p.generation=(NEW.spec->>'source_generation')::bigint AND p.plan_generation=(NEW.spec->>'plan_generation')::bigint)
        THEN RAISE EXCEPTION 'local_hls_ladder_queue_contract_required'; END IF;
    IF TG_OP='INSERT' AND (NEW.status<>'queued' OR NEW.attempt<>0 OR NEW.owner_id IS NOT NULL OR NEW.lease_until IS NOT NULL)
        THEN RAISE EXCEPTION 'local_hls_ladder_initial_shape_required'; END IF;
    IF TG_OP='UPDATE' AND NEW.status='running' AND (OLD.status<>'running' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.attempt IS DISTINCT FROM OLD.attempt)
        AND current_setting('rainsync.local_hls_ladder_recipe',true) IS DISTINCT FROM '1'
        THEN RAISE EXCEPTION 'local_hls_ladder_worker_recipe_required'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER local_hls_ladder_job_guard BEFORE INSERT OR UPDATE OR DELETE ON media_jobs
    FOR EACH ROW EXECUTE FUNCTION protect_local_hls_ladder_job();

CREATE TABLE local_hls_ladder_manifests (
    job_id uuid NOT NULL, attempt bigint NOT NULL, rendition text NOT NULL CHECK(rendition IN ('low','medium','high')),
    manifest text NOT NULL CHECK(octet_length(manifest) BETWEEN 1 AND 262144),
    manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
    ready_segments integer NOT NULL CHECK(ready_segments BETWEEN 1 AND 20000),
    duration_us bigint NOT NULL CHECK(duration_us BETWEEN 1 AND 86400000000),
    PRIMARY KEY(job_id,attempt,rendition), FOREIGN KEY(job_id,attempt) REFERENCES media_outputs(job_id,attempt) ON DELETE CASCADE
);
CREATE TABLE local_hls_ladder_files (
    job_id uuid NOT NULL, attempt bigint NOT NULL, rendition text NOT NULL CHECK(rendition IN ('low','medium','high')),
    segment_index integer NOT NULL CHECK(segment_index BETWEEN -1 AND 19999),
    size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 16777216),
    sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY(job_id,attempt,rendition,segment_index), FOREIGN KEY(job_id,attempt) REFERENCES media_outputs(job_id,attempt) ON DELETE CASCADE
);
CREATE FUNCTION protect_local_hls_ladder_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'published_output_changed'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER local_hls_ladder_file_immutable BEFORE UPDATE ON local_hls_ladder_files
    FOR EACH ROW EXECUTE FUNCTION protect_local_hls_ladder_file();

CREATE FUNCTION protect_local_hls_ladder_session() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NOT marked THEN RETURN NEW; END IF;
    IF NEW.resource->'local_hls_ladder_version' IS DISTINCT FROM '1'::jsonb OR NEW.static_hls_capture_id IS NOT NULL
        OR NEW.viewer_id IS NULL OR NEW.plan_generation IS NULL OR NEW.plan_generation<=0 OR NEW.auth_login_hash IS NULL
        OR NEW.resource ?| ARRAY['static_hls_capture_id','native_platform_context','http_file_context'] THEN RAISE EXCEPTION 'local_hls_ladder_session_contract_required'; END IF;
    IF TG_OP='INSERT' AND current_setting('rainsync.local_hls_ladder_reader',true) IS DISTINCT FROM '1'
        THEN RAISE EXCEPTION 'local_hls_ladder_reader_required'; END IF;
    RETURN NEW;
END $$;
-- Runs after playback_session_origin populates immutable login/membership fields.
CREATE TRIGGER zz_local_hls_ladder_session_guard BEFORE INSERT OR UPDATE ON playback_sessions
    FOR EACH ROW EXECUTE FUNCTION protect_local_hls_ladder_session();
CREATE FUNCTION protect_local_hls_ladder_output() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ladder boolean;
BEGIN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    ladder=EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=NEW.job_id AND j.logical_queue='local_hls_ladder_v1');
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
CREATE TRIGGER local_hls_ladder_output_guard BEFORE INSERT OR UPDATE ON media_outputs
    FOR EACH ROW EXECUTE FUNCTION protect_local_hls_ladder_output();
CREATE FUNCTION protect_local_hls_ladder_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM media_outputs o JOIN media_jobs j ON j.id=o.job_id
        WHERE o.job_id=NEW.job_id AND o.attempt=NEW.attempt AND o.validation_version=5 AND j.logical_queue='local_hls_ladder_v1'
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(j.spec->'renditions') r WHERE r->>'id'=NEW.rendition))
        THEN RAISE EXCEPTION 'local_hls_ladder_output_contract_required'; END IF;
    IF TG_OP='UPDATE' AND (NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.attempt IS DISTINCT FROM OLD.attempt
        OR NEW.rendition IS DISTINCT FROM OLD.rendition OR NEW.ready_segments<OLD.ready_segments OR NEW.duration_us<OLD.duration_us
        OR left(NEW.manifest,length(OLD.manifest))<>OLD.manifest) THEN RAISE EXCEPTION 'local_hls_ladder_snapshot_regressed'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER local_hls_ladder_manifest_guard BEFORE INSERT OR UPDATE ON local_hls_ladder_manifests
    FOR EACH ROW EXECUTE FUNCTION protect_local_hls_ladder_manifest();
