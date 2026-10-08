-- Closed advanced-local recipe1 queue. No existing/static queue is reclassified.
-- Old Workers select NULL/static_hls_v1 only, so never consume these attempts.
LOCK TABLE media_jobs IN ACCESS EXCLUSIVE MODE NOWAIT;
ALTER TABLE media_jobs DROP CONSTRAINT media_jobs_logical_queue_check;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_logical_queue_check
    CHECK(logical_queue IS NULL OR logical_queue IN ('static_hls_v1','advanced_local_v1'));

CREATE FUNCTION advanced_local_job_spec_valid(spec jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE intent jsonb; stream_index text; audio_index text;
BEGIN
    IF jsonb_typeof(spec) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(spec) k WHERE k NOT IN
        ('kind','recipe_version','advanced_media','root','resource','source_kind','input_ticket',
         'start_seconds','transcode','audio_index','estimated_output_bytes','negotiated_mode','source_version'))
        OR spec->>'kind' IS DISTINCT FROM 'advanced_local_transcode_v1'
        OR jsonb_typeof(spec->'recipe_version') IS DISTINCT FROM 'number' OR spec->>'recipe_version' IS DISTINCT FROM '1'
        OR spec->>'source_kind' IS DISTINCT FROM 'local' OR spec->>'negotiated_mode' IS DISTINCT FROM 'transcode'
        OR spec->'transcode' IS DISTINCT FROM 'true'::jsonb
        OR jsonb_typeof(spec->'root') IS DISTINCT FROM 'string' OR jsonb_typeof(spec->'resource') IS DISTINCT FROM 'string'
        OR jsonb_typeof(spec->'input_ticket') IS DISTINCT FROM 'string'
        OR NOT COALESCE(spec->>'source_version' ~ '^stat-v1:[0-9a-f]{64}$',false)
        OR jsonb_typeof(spec->'start_seconds') IS DISTINCT FROM 'number' THEN RETURN false;
    END IF;
    IF (spec->>'start_seconds')::numeric NOT BETWEEN 0 AND 9007199254740 THEN RETURN false; END IF;
    IF spec->'audio_index' IS DISTINCT FROM 'null'::jsonb THEN
        audio_index=spec->>'audio_index';
        IF jsonb_typeof(spec->'audio_index') IS DISTINCT FROM 'number'
            OR NOT COALESCE(audio_index ~ '^[0-9]+$',false) THEN RETURN false; END IF;
        IF audio_index::numeric>4294967295 THEN RETURN false; END IF;
    END IF;
    intent=spec->'advanced_media';
    IF jsonb_typeof(intent) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(intent) k WHERE k NOT IN ('schema_version','tone_map_hdr','subtitle_stream_index'))
        OR jsonb_typeof(intent->'schema_version') IS DISTINCT FROM 'number' OR intent->>'schema_version' IS DISTINCT FROM '1'
        OR jsonb_typeof(intent->'tone_map_hdr') IS DISTINCT FROM 'boolean' THEN RETURN false;
    END IF;
    IF intent->'subtitle_stream_index' IS DISTINCT FROM 'null'::jsonb THEN
        stream_index=intent->>'subtitle_stream_index';
        IF jsonb_typeof(intent->'subtitle_stream_index') IS DISTINCT FROM 'number'
            OR NOT COALESCE(stream_index ~ '^[0-9]+$',false) THEN RETURN false; END IF;
        IF stream_index::numeric>4294967295 THEN RETURN false; END IF;
    END IF;
    RETURN intent->'tone_map_hdr'='true'::jsonb OR intent->'subtitle_stream_index'<>'null'::jsonb;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;

-- Preserve every original static/child guard condition, excluding only rows
-- governed by the separate advanced guard below. No static guard body changes.
DROP TRIGGER static_hls_job_guard_insert ON media_jobs;
DROP TRIGGER static_hls_job_guard ON media_jobs;
DROP TRIGGER static_hls_job_guard_delete ON media_jobs;
CREATE TRIGGER static_hls_job_guard_insert BEFORE INSERT ON media_jobs
    FOR EACH ROW WHEN (NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1'
        AND NOT static_hls_is_child_session(NEW.session_id) AND NOT static_hls_child_identity_reserved(NEW.id)
        AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard BEFORE UPDATE ON media_jobs
    FOR EACH ROW WHEN (OLD.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1'
        AND NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_is_child_session(NEW.session_id)
        AND NOT static_hls_child_identity_reserved(OLD.id) AND NOT static_hls_child_identity_reserved(NEW.id)
        AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child' AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child')
        EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard_delete BEFORE DELETE ON media_jobs
    FOR EACH ROW WHEN (OLD.logical_queue IS DISTINCT FROM 'advanced_local_v1'
        AND NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_child_identity_reserved(OLD.id)
        AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();

CREATE FUNCTION protect_advanced_local_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE advanced boolean;
BEGIN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    advanced=NEW.logical_queue='advanced_local_v1' OR NEW.spec ? 'advanced_media'
        OR left(COALESCE(NEW.spec->>'kind',''),14)='advanced_local';
    IF TG_OP='UPDATE' AND OLD.logical_queue='advanced_local_v1' THEN
        advanced=true;
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.session_id IS DISTINCT FROM OLD.session_id
            OR NEW.logical_queue IS DISTINCT FROM OLD.logical_queue OR NEW.spec IS DISTINCT FROM OLD.spec THEN
            RAISE EXCEPTION 'advanced_local_queue_immutable';
        END IF;
    ELSIF TG_OP='UPDATE' AND NEW.logical_queue='advanced_local_v1' THEN
        RAISE EXCEPTION 'advanced_local_queue_no_reclassification';
    END IF;
    IF NOT COALESCE(advanced,false) THEN RETURN NEW; END IF;
    IF NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1' OR NOT advanced_local_job_spec_valid(NEW.spec)
        OR static_hls_is_child_session(NEW.session_id) OR static_hls_child_identity_reserved(NEW.id)
        OR EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=NEW.session_id AND p.static_hls_capture_id IS NOT NULL) THEN
        RAISE EXCEPTION 'advanced_local_queue_contract_required';
    END IF;
    IF TG_OP='INSERT' AND (NEW.status<>'queued' OR NEW.attempt<>0 OR NEW.owner_id IS NOT NULL OR NEW.lease_until IS NOT NULL) THEN
        RAISE EXCEPTION 'advanced_local_queue_initial_shape_required';
    END IF;
    IF TG_OP='UPDATE' AND NEW.status='running'
        AND (OLD.status<>'running' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.attempt IS DISTINCT FROM OLD.attempt)
        AND current_setting('rainsync.advanced_local_recipe',true) IS DISTINCT FROM '1' THEN
        RAISE EXCEPTION 'advanced_local_worker_recipe_required';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER advanced_local_job_guard BEFORE INSERT OR UPDATE OR DELETE ON media_jobs
    FOR EACH ROW EXECUTE FUNCTION protect_advanced_local_job();
