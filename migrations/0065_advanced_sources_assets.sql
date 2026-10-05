-- Extended descriptor/font work has distinct queue generations. Older
-- Workers cannot select these rows; original advanced-local/ladder validators
-- retain their published grammar and behavior.
LOCK TABLE media_jobs IN ACCESS EXCLUSIVE MODE NOWAIT;
ALTER TABLE media_jobs DROP CONSTRAINT media_jobs_logical_queue_check;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_logical_queue_check CHECK
(logical_queue IS NULL OR logical_queue IN ('static_hls_v1','advanced_local_v1','local_hls_ladder_v1','native_platform_transcode_v1','native_platform_hls_ladder_v1','advanced_hls_ladder_v1','advanced_owned_v1','advanced_owned_hls_ladder_v1'));
CREATE FUNCTION advanced_asset_catalog_valid(c jsonb, source text, version text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE a jsonb; f jsonb; total numeric=0; ext text; directory text;
BEGIN
    IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(c))<>5
        OR NOT c ?& ARRAY['schema_version','source_resource','source_version','subtitles','fonts']
        OR c->'schema_version' IS DISTINCT FROM '1'::jsonb OR c->>'source_resource' IS DISTINCT FROM source
        OR c->>'source_version' IS DISTINCT FROM version
        OR NOT COALESCE(version ~ '^stat-v1:[0-9a-f]{64}$',false)
        OR source IS NULL OR source='' OR source LIKE '/%' OR source ~ '(^|/)\.\.?(/|$)' OR source ~ '[\\\n\r]'
        OR jsonb_typeof(c->'subtitles') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'subtitles')>3
        OR jsonb_typeof(c->'fonts') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'fonts')>64 THEN RETURN false; END IF;
    directory=regexp_replace(source,'\.[^/.]*$','')||'.fonts/';
    FOR a IN SELECT value FROM jsonb_array_elements(c->'subtitles') LOOP
        IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(a))<>3 OR NOT a ?& ARRAY['index','kind','file'] THEN RETURN false; END IF;
        ext=CASE WHEN a->'index'='100002'::jsonb AND a->>'kind'='ass' THEN 'ass'
            WHEN a->'index'='100003'::jsonb AND a->>'kind'='ssa' THEN 'ssa'
            WHEN a->'index'='100004'::jsonb AND a->>'kind'='pgs' THEN 'sup' END;
        IF ext IS NULL OR a->'file'->>'resource' IS DISTINCT FROM regexp_replace(source,'\.[^/.]*$','')||'.'||ext THEN RETURN false; END IF;
    END LOOP;
    FOR f IN SELECT value->'file' FROM jsonb_array_elements(c->'subtitles') UNION ALL SELECT value FROM jsonb_array_elements(c->'fonts') LOOP
        IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(f))<>3 OR NOT f ?& ARRAY['resource','source_version','bytes']
            OR jsonb_typeof(f->'resource') IS DISTINCT FROM 'string' OR length(f->>'resource') NOT BETWEEN 1 AND 4096
            OR NOT COALESCE(f->>'source_version' ~ '^stat-v1:[0-9a-f]{64}$',false)
            OR jsonb_typeof(f->'bytes') IS DISTINCT FROM 'number' OR NOT COALESCE(f->>'bytes' ~ '^[0-9]+$',false)
            OR (f->>'bytes')::numeric NOT BETWEEN 1 AND 16777216 THEN RETURN false; END IF;
        total=total+(f->>'bytes')::numeric;
    END LOOP;
    IF total>67108864 OR (SELECT count(*) FROM (SELECT value->'file'->>'resource' AS r FROM jsonb_array_elements(c->'subtitles') UNION ALL SELECT value->>'resource' FROM jsonb_array_elements(c->'fonts')) q)<>(SELECT count(DISTINCT r) FROM (SELECT value->'file'->>'resource' AS r FROM jsonb_array_elements(c->'subtitles') UNION ALL SELECT value->>'resource' FROM jsonb_array_elements(c->'fonts')) q) THEN RETURN false; END IF;
    FOR f IN SELECT value FROM jsonb_array_elements(c->'fonts') LOOP
        IF left(f->>'resource',length(directory))<>directory OR substr(f->>'resource',length(directory)+1) ~ '[/\\\n\r]'
            OR substr(f->>'resource',length(directory)+1) IN ('','.','..') OR lower(f->>'resource') !~ '\.(ttf|otf|ttc)$' THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION advanced_owned_job_spec_valid(spec jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE base jsonb;
BEGIN
    IF jsonb_typeof(spec) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF spec->>'kind'='advanced_owned_local_transcode_v1' THEN
        IF NOT (spec ? 'advanced_assets') OR spec ? 'held_input_bytes' OR spec ? 'remote_duration_seconds' THEN RETURN false; END IF;
        IF spec ? 'advanced_assets' AND NOT advanced_asset_catalog_valid(spec->'advanced_assets',spec->>'resource',spec->>'source_version') THEN RETURN false; END IF;
        RETURN advanced_local_job_spec_valid((spec-'advanced_assets')||jsonb_build_object('kind','advanced_local_transcode_v1'));
    END IF;
    IF spec->>'kind' IS DISTINCT FROM 'advanced_owned_remote_transcode_v1' OR jsonb_typeof(spec->'source_kind') IS DISTINCT FROM 'string' OR spec->>'source_kind' NOT IN ('http','agent')
        OR spec ? 'advanced_assets' OR jsonb_typeof(spec->'held_input_bytes') IS DISTINCT FROM 'number'
        OR NOT COALESCE(spec->>'held_input_bytes' ~ '^[0-9]+$',false) OR (spec->>'held_input_bytes')::numeric NOT BETWEEN 1 AND 2147483648
        OR jsonb_typeof(spec->'remote_duration_seconds') IS DISTINCT FROM 'number' OR (spec->>'remote_duration_seconds')::numeric NOT BETWEEN 0.001 AND 21600
        OR (spec->>'start_seconds')::numeric >= (spec->>'remote_duration_seconds')::numeric THEN RETURN false; END IF;
    IF spec->>'source_kind'='agent' AND NOT COALESCE(spec->>'source_version' ~ '^stat-v1:[0-9a-f]{64}$',false) THEN RETURN false; END IF;
    IF spec->>'source_kind'='http' AND spec->'source_version' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
    base=spec-'held_input_bytes'-'remote_duration_seconds';
    base=jsonb_set(jsonb_set(base,'{kind}','"advanced_local_transcode_v1"'),'{source_kind}','"local"');
    IF spec->>'source_kind'='http' THEN base=jsonb_set(base,'{source_version}',to_jsonb('stat-v1:'||repeat('0',64))); END IF;
    RETURN advanced_local_job_spec_valid(base);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE TABLE advanced_media_bindings (
    session_id uuid PRIMARY KEY REFERENCES playback_sessions(id) ON DELETE CASCADE,
    frozen_spec jsonb NOT NULL CHECK(advanced_owned_job_spec_valid(frozen_spec)),
    frozen_resource jsonb NOT NULL,deadline_ms bigint NOT NULL CHECK(deadline_ms>0)
);
CREATE FUNCTION advanced_media_job_allowed(job uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id
        JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id
        LEFT JOIN advanced_media_bindings b ON b.session_id=p.id
        WHERE j.id=$1 AND ((j.logical_queue='advanced_local_v1' AND advanced_local_job_spec_valid(j.spec)) OR (j.logical_queue='advanced_owned_v1' AND advanced_owned_job_spec_valid(j.spec)))
        AND NOT p.stopped AND p.expires_at>clock_timestamp() AND p.static_hls_capture_id IS NULL
        AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch
        AND s.state->>'media_id'=p.media_id::text AND (s.state->>'media_generation')::bigint=p.generation
        AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch)
        AND playback_source_allowed(p.media_id,p.resource)
        AND (j.logical_queue='advanced_local_v1' OR
            (b.frozen_spec=j.spec AND b.frozen_resource=p.resource AND b.deadline_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint)))
$$;
CREATE FUNCTION protect_advanced_media_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'advanced_media_binding_immutable'; END IF;
    IF NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=NEW.session_id AND p.resource=NEW.frozen_resource AND NOT p.stopped
        AND p.expires_at>clock_timestamp() AND NEW.deadline_ms=floor(extract(epoch FROM p.expires_at)*1000)::bigint
        AND p.static_hls_capture_id IS NULL AND p.resource->>'advanced_owned_session_id'=p.id::text AND playback_source_allowed(p.media_id,p.resource)) THEN RAISE EXCEPTION 'advanced_media_source_binding_required'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER advanced_media_binding_guard BEFORE INSERT OR UPDATE ON advanced_media_bindings FOR EACH ROW EXECUTE FUNCTION protect_advanced_media_binding();
CREATE FUNCTION protect_advanced_media_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM advanced_media_bindings b WHERE b.session_id=OLD.id) AND
        (NEW.id IS DISTINCT FROM OLD.id OR NEW.resource IS DISTINCT FROM OLD.resource OR NEW.media_id IS DISTINCT FROM OLD.media_id
        OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.generation IS DISTINCT FROM OLD.generation
        OR NEW.viewer_id IS DISTINCT FROM OLD.viewer_id OR NEW.plan_generation IS DISTINCT FROM OLD.plan_generation
        OR NEW.auth_login_hash IS DISTINCT FROM OLD.auth_login_hash OR NEW.lifecycle_epoch IS DISTINCT FROM OLD.lifecycle_epoch) THEN
        RAISE EXCEPTION 'advanced_media_source_binding_immutable'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER advanced_media_session_guard BEFORE UPDATE ON playback_sessions FOR EACH ROW EXECUTE FUNCTION protect_advanced_media_session();
CREATE FUNCTION protect_advanced_media_job_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IN ('queued','running') AND NEW.logical_queue='advanced_owned_v1'
        AND NOT EXISTS(SELECT 1 FROM advanced_media_bindings b JOIN playback_sessions p ON p.id=b.session_id WHERE b.session_id=NEW.session_id
            AND b.frozen_spec=NEW.spec AND b.frozen_resource=p.resource AND b.deadline_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
        THEN RAISE EXCEPTION 'advanced_media_source_binding_required'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER advanced_media_job_binding_guard BEFORE INSERT OR UPDATE ON media_jobs FOR EACH ROW EXECUTE FUNCTION protect_advanced_media_job_binding();
-- A distinct asset-bearing ladder grammar. Old advanced-ladder Workers never
-- claim the new queue or accept the new kind through the old validator.
CREATE FUNCTION advanced_owned_ladder_job_spec_valid(spec jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF spec->>'kind' IS DISTINCT FROM 'advanced_owned_hls_ladder_transcode_v1'
        OR NOT (spec ? 'advanced_assets')
        OR NOT advanced_asset_catalog_valid(spec->'advanced_assets',spec->>'resource',spec->>'source_version') THEN RETURN false; END IF;
    RETURN local_hls_ladder_job_spec_valid((spec-'advanced_assets')||jsonb_build_object('kind','advanced_hls_ladder_transcode_v1'));
END $$;

-- Every old/new reader uses this existing source gate. A later session
-- keepalive cannot lengthen the original bounded input/source grant.
CREATE FUNCTION playback_source_allowed_pre_advanced_owned(media uuid,resource jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT playback_source_allowed_pre_composed_ladder($1,$2)
 AND CASE WHEN $2 ? 'native_platform_hls_ladder_version' THEN $2->'native_platform_hls_ladder_version'='1'::jsonb
 AND COALESCE(current_setting('rainsync.native_platform_ladder_reader',true)='1',false) ELSE true END
 AND CASE WHEN $2 ? 'advanced_hls_ladder_version' THEN $2->'advanced_hls_ladder_version'='1'::jsonb
 AND COALESCE(current_setting('rainsync.advanced_hls_ladder_reader',true)='1',false) ELSE true END
$$;
CREATE OR REPLACE FUNCTION playback_source_allowed(media uuid,resource jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT playback_source_allowed_pre_advanced_owned($1,$2) AND NOT EXISTS(
        SELECT 1 FROM advanced_media_bindings b JOIN playback_sessions p ON p.id=b.session_id
        WHERE p.id::text=$2->>'advanced_owned_session_id' AND p.media_id=$1 AND b.frozen_resource=$2 AND b.deadline_ms<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
$$;
CREATE FUNCTION protect_advanced_media_output() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IN ('writing','published') AND EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=NEW.job_id AND j.logical_queue IN ('advanced_local_v1','advanced_owned_v1'))
        AND NOT advanced_media_job_allowed(NEW.job_id) THEN RAISE EXCEPTION 'advanced_media_output_authority_required'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER advanced_media_output_guard BEFORE INSERT OR UPDATE ON media_outputs FOR EACH ROW EXECUTE FUNCTION protect_advanced_media_output();

CREATE OR REPLACE FUNCTION protect_advanced_local_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE advanced boolean; owned boolean;
BEGIN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    -- These closed ladders have their own generation-specific guard below.
    IF NEW.logical_queue IN ('advanced_hls_ladder_v1','advanced_owned_hls_ladder_v1') THEN RETURN NEW; END IF;
    advanced=NEW.logical_queue IN ('advanced_local_v1','advanced_owned_v1') OR NEW.spec ? 'advanced_media'
        OR left(COALESCE(NEW.spec->>'kind',''),14)='advanced_local' OR left(COALESCE(NEW.spec->>'kind',''),14)='advanced_owned';
    IF TG_OP='UPDATE' AND OLD.logical_queue IN ('advanced_local_v1','advanced_owned_v1') THEN
        advanced=true;
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.session_id IS DISTINCT FROM OLD.session_id
            OR NEW.logical_queue IS DISTINCT FROM OLD.logical_queue OR NEW.spec IS DISTINCT FROM OLD.spec THEN RAISE EXCEPTION 'advanced_local_queue_immutable'; END IF;
    ELSIF TG_OP='UPDATE' AND NEW.logical_queue IN ('advanced_local_v1','advanced_owned_v1') THEN RAISE EXCEPTION 'advanced_local_queue_no_reclassification'; END IF;
    IF NOT COALESCE(advanced,false) THEN RETURN NEW; END IF;
    owned=COALESCE(NEW.logical_queue='advanced_owned_v1',false);
    IF (NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND NOT owned)
        OR NOT (CASE WHEN owned THEN advanced_owned_job_spec_valid(NEW.spec) ELSE advanced_local_job_spec_valid(NEW.spec) END)
        OR static_hls_is_child_session(NEW.session_id) OR static_hls_child_identity_reserved(NEW.id)
        OR EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=NEW.session_id AND p.static_hls_capture_id IS NOT NULL)
        THEN RAISE EXCEPTION 'advanced_local_queue_contract_required'; END IF;
    IF TG_OP='INSERT' AND (NEW.status<>'queued' OR NEW.attempt<>0 OR NEW.owner_id IS NOT NULL OR NEW.lease_until IS NOT NULL)
        THEN RAISE EXCEPTION 'advanced_local_queue_initial_shape_required'; END IF;
    IF TG_OP='UPDATE' AND NEW.status='running' AND (OLD.status<>'running' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.attempt IS DISTINCT FROM OLD.attempt)
        AND (CASE WHEN owned THEN current_setting('rainsync.advanced_owned_recipe',true) ELSE current_setting('rainsync.advanced_local_recipe',true) END) IS DISTINCT FROM '1'
        THEN RAISE EXCEPTION 'advanced_local_worker_recipe_required'; END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION local_hls_ladder_session_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM playback_sessions p JOIN rooms r ON r.id=p.room_id
        JOIN room_snapshots s ON s.room_id=p.room_id JOIN media_jobs j ON j.id=p.id AND j.session_id=p.id
        WHERE p.id=$1 AND p.resource->'local_hls_ladder_version'='1'::jsonb
        AND p.static_hls_capture_id IS NULL AND ((j.logical_queue='local_hls_ladder_v1' AND j.spec->>'kind'='local_hls_ladder_transcode_v1' AND NOT (p.resource ? 'advanced_hls_ladder_version')) OR (j.logical_queue='advanced_hls_ladder_v1' AND j.spec->>'kind'='advanced_hls_ladder_transcode_v1' AND p.resource->'advanced_hls_ladder_version'='1'::jsonb) OR (j.logical_queue='advanced_owned_hls_ladder_v1' AND j.spec->>'kind'='advanced_owned_hls_ladder_transcode_v1' AND p.resource->'advanced_hls_ladder_version'='1'::jsonb))
        AND (CASE WHEN j.logical_queue='advanced_owned_hls_ladder_v1' THEN advanced_owned_ladder_job_spec_valid(j.spec) ELSE local_hls_ladder_job_spec_valid(j.spec) END)
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

CREATE OR REPLACE FUNCTION hls_ladder_job_allowed(job uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=$1 AND
 ((j.logical_queue IN ('local_hls_ladder_v1','advanced_hls_ladder_v1') AND local_hls_ladder_job_spec_valid(j.spec) AND local_hls_ladder_session_allowed(j.session_id))
 OR (j.logical_queue='advanced_owned_hls_ladder_v1' AND advanced_owned_ladder_job_spec_valid(j.spec) AND local_hls_ladder_session_allowed(j.session_id))
 OR (j.logical_queue='native_platform_hls_ladder_v1' AND native_platform_ladder_job_spec_valid(j.spec) AND native_platform_transcode_session_allowed(j.session_id))))
$$;

CREATE OR REPLACE FUNCTION protect_local_hls_ladder_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ladder boolean;
BEGIN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    ladder=NEW.logical_queue IN ('local_hls_ladder_v1','advanced_hls_ladder_v1','advanced_owned_hls_ladder_v1') OR left(COALESCE(NEW.spec->>'kind',''),16)='local_hls_ladder' OR NEW.spec->>'kind' IN ('advanced_hls_ladder_transcode_v1','advanced_owned_hls_ladder_transcode_v1');
    IF TG_OP='UPDATE' AND OLD.logical_queue IN ('local_hls_ladder_v1','advanced_hls_ladder_v1','advanced_owned_hls_ladder_v1') THEN
        ladder=true;
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.spec IS DISTINCT FROM OLD.spec
            OR NEW.logical_queue IS DISTINCT FROM OLD.logical_queue THEN RAISE EXCEPTION 'local_hls_ladder_queue_immutable'; END IF;
    ELSIF TG_OP='UPDATE' AND NEW.logical_queue IN ('local_hls_ladder_v1','advanced_hls_ladder_v1','advanced_owned_hls_ladder_v1') THEN RAISE EXCEPTION 'local_hls_ladder_no_reclassification'; END IF;
    IF NOT COALESCE(ladder,false) THEN RETURN NEW; END IF;
    IF (NEW.logical_queue='advanced_owned_hls_ladder_v1') IS DISTINCT FROM (NEW.spec->>'kind'='advanced_owned_hls_ladder_transcode_v1') THEN RAISE EXCEPTION 'advanced_owned_ladder_queue_contract_required'; END IF;
    IF (NEW.logical_queue='advanced_hls_ladder_v1') IS DISTINCT FROM (NEW.spec->>'kind'='advanced_hls_ladder_transcode_v1') THEN RAISE EXCEPTION 'advanced_hls_ladder_queue_contract_required'; END IF;
    IF (NEW.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_owned_hls_ladder_v1') OR NOT (CASE WHEN NEW.logical_queue='advanced_owned_hls_ladder_v1' THEN advanced_owned_ladder_job_spec_valid(NEW.spec) ELSE local_hls_ladder_job_spec_valid(NEW.spec) END)
        OR static_hls_is_child_session(NEW.session_id) OR static_hls_child_identity_reserved(NEW.id)
        OR NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=NEW.session_id AND p.id=NEW.id
            AND p.resource->'local_hls_ladder_version'='1'::jsonb AND p.static_hls_capture_id IS NULL
            AND ((NEW.logical_queue IN ('advanced_hls_ladder_v1','advanced_owned_hls_ladder_v1') AND p.resource->'advanced_hls_ladder_version'='1'::jsonb) OR (NEW.logical_queue='local_hls_ladder_v1' AND NOT (p.resource ? 'advanced_hls_ladder_version')))
            AND p.viewer_id IS NOT NULL AND p.auth_login_hash IS NOT NULL
            AND p.generation=(NEW.spec->>'source_generation')::bigint AND p.plan_generation=(NEW.spec->>'plan_generation')::bigint)
        THEN RAISE EXCEPTION 'local_hls_ladder_queue_contract_required'; END IF;
    IF TG_OP='INSERT' AND (NEW.status<>'queued' OR NEW.attempt<>0 OR NEW.owner_id IS NOT NULL OR NEW.lease_until IS NOT NULL)
        THEN RAISE EXCEPTION 'local_hls_ladder_initial_shape_required'; END IF;
    IF TG_OP='UPDATE' AND NEW.status='running' AND (OLD.status<>'running' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.attempt IS DISTINCT FROM OLD.attempt)
        AND (CASE WHEN NEW.logical_queue='advanced_owned_hls_ladder_v1' THEN current_setting('rainsync.advanced_owned_ladder_recipe',true) WHEN NEW.logical_queue='advanced_hls_ladder_v1' THEN current_setting('rainsync.advanced_hls_ladder_recipe',true) ELSE current_setting('rainsync.local_hls_ladder_recipe',true) END) IS DISTINCT FROM '1'
        THEN RAISE EXCEPTION 'local_hls_ladder_worker_recipe_required'; END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_local_hls_ladder_output() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ladder boolean;
BEGIN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    ladder=EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=NEW.job_id AND j.logical_queue IN ('local_hls_ladder_v1','advanced_hls_ladder_v1','advanced_owned_hls_ladder_v1','native_platform_hls_ladder_v1'));
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
        WHERE o.job_id=NEW.job_id AND o.attempt=NEW.attempt AND o.validation_version=5 AND j.logical_queue IN ('local_hls_ladder_v1','advanced_hls_ladder_v1','advanced_owned_hls_ladder_v1','native_platform_hls_ladder_v1') AND hls_ladder_job_allowed(j.id) AND j.attempt=NEW.attempt AND j.status='running' AND j.lease_until>clock_timestamp()
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(j.spec->'renditions') r WHERE r->>'id'=NEW.rendition))
        THEN RAISE EXCEPTION 'local_hls_ladder_output_contract_required'; END IF;
    IF TG_OP='UPDATE' AND (NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.attempt IS DISTINCT FROM OLD.attempt
        OR NEW.rendition IS DISTINCT FROM OLD.rendition OR NEW.ready_segments<OLD.ready_segments OR NEW.duration_us<OLD.duration_us
        OR left(NEW.manifest,length(OLD.manifest))<>OLD.manifest) THEN RAISE EXCEPTION 'local_hls_ladder_snapshot_regressed'; END IF;
    RETURN NEW;
END $$;

-- Retain static/child predicates verbatim and exclude only the new queue.
DROP TRIGGER static_hls_job_guard_insert ON media_jobs;
DROP TRIGGER static_hls_job_guard ON media_jobs;
DROP TRIGGER static_hls_job_guard_delete ON media_jobs;
CREATE TRIGGER static_hls_job_guard_insert BEFORE INSERT ON media_jobs
    FOR EACH ROW WHEN (NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND NEW.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_owned_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_owned_hls_ladder_v1'
        AND NOT static_hls_is_child_session(NEW.session_id) AND NOT static_hls_child_identity_reserved(NEW.id)
        AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard BEFORE UPDATE ON media_jobs
    FOR EACH ROW WHEN (OLD.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1'
        AND OLD.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_owned_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_owned_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_owned_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_owned_hls_ladder_v1'
        AND NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_is_child_session(NEW.session_id)
        AND NOT static_hls_child_identity_reserved(OLD.id) AND NOT static_hls_child_identity_reserved(NEW.id)
        AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child' AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child')
        EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard_delete BEFORE DELETE ON media_jobs
    FOR EACH ROW WHEN (OLD.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND OLD.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_owned_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_owned_hls_ladder_v1'
        AND NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_child_identity_reserved(OLD.id)
        AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();

-- Private extended platform configuration expectations remain an omitted
-- additive field for old AVC/Main8 jobs. The mandatory native session gate
-- excludes old Workers/readers before claim, not after ownership.
CREATE FUNCTION native_source_video_expectation_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(v)) NOT IN (12,13)
        OR NOT v ?& ARRAY['schema_version','codec','profile','pixel_format','width','height','sample_aspect_ratio','level','color_transfer','color_primaries','color_space','color_range']
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE k NOT IN ('schema_version','codec','profile','pixel_format','width','height','sample_aspect_ratio','level','color_transfer','color_primaries','color_space','color_range','chroma_location'))
        OR v->'schema_version' IS DISTINCT FROM '1'::jsonb OR v->>'sample_aspect_ratio' IS DISTINCT FROM '1:1'
        OR jsonb_typeof(v->'width') IS DISTINCT FROM 'number' OR NOT COALESCE(v->>'width' ~ '^[0-9]+$',false) OR (v->>'width')::numeric NOT BETWEEN 1 AND 8192
        OR jsonb_typeof(v->'height') IS DISTINCT FROM 'number' OR NOT COALESCE(v->>'height' ~ '^[0-9]+$',false) OR (v->>'height')::numeric NOT BETWEEN 1 AND 4320
        OR jsonb_typeof(v->'level') IS DISTINCT FROM 'number' OR NOT COALESCE(v->>'level' ~ '^[0-9]+$',false)
        OR NOT COALESCE(v->>'color_range' IN ('tv','pc'),false)
        OR NOT COALESCE(((v->>'color_primaries',v->>'color_transfer',v->>'color_space')=('bt709','bt709','bt709'))
            OR (v->>'pixel_format'='yuv420p10le' AND v->>'color_primaries'='bt2020' AND v->>'color_transfer' IN ('smpte2084','arib-std-b67') AND v->>'color_space' IN ('bt2020nc','bt2020c')),false)
        OR (v ? 'chroma_location' AND (jsonb_typeof(v->'chroma_location') IS DISTINCT FROM 'string' OR NOT COALESCE(v->>'chroma_location' IN ('left','topleft'),false))) THEN RETURN false; END IF;
    IF NOT COALESCE(CASE v->>'codec' WHEN 'av1' THEN (v->>'level')::numeric BETWEEN 0 AND 23 WHEN 'vp9' THEN (v->>'level')::numeric IN (10,11,20,21,30,31,40,41,50,51,52,60,61,62)
        WHEN 'hevc' THEN (v->>'level')::numeric IN (30,60,63,90,93,120,123,150,153,156,180,183,186) ELSE false END,false) THEN RETURN false; END IF;
    RETURN COALESCE((v->>'codec',v->>'profile',v->>'pixel_format') IN
        (('av1','Main','yuv420p'),('av1','Main','yuv420p10le'),('vp9','Profile 0','yuv420p'),('vp9','Profile 2','yuv420p10le'),('hevc','Main','yuv420p'),('hevc','Main 10','yuv420p10le')),false);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
ALTER FUNCTION native_platform_transcode_job_spec_valid(jsonb) RENAME TO native_platform_transcode_job_spec_valid_pre_extended;
CREATE FUNCTION native_platform_transcode_job_spec_valid(spec jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN spec ? 'source_video' THEN native_source_video_expectation_valid(spec->'source_video') AND native_platform_transcode_job_spec_valid_pre_extended(spec-'source_video')
        ELSE native_platform_transcode_job_spec_valid_pre_extended(spec) END
$$;
ALTER FUNCTION native_platform_ladder_job_spec_valid(jsonb) RENAME TO native_platform_ladder_job_spec_valid_pre_extended;
CREATE FUNCTION native_platform_ladder_job_spec_valid(spec jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN spec ? 'source_video' THEN native_source_video_expectation_valid(spec->'source_video') AND native_platform_ladder_job_spec_valid_pre_extended(spec-'source_video')
        ELSE native_platform_ladder_job_spec_valid_pre_extended(spec) END
$$;
CREATE FUNCTION native_platform_transcode_session_allowed_pre_extended(session uuid)
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
CREATE OR REPLACE FUNCTION native_platform_transcode_session_allowed(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT native_platform_transcode_session_allowed_pre_extended($1) AND EXISTS(SELECT 1 FROM media_jobs j WHERE j.session_id=$1
        AND (NOT (j.spec ? 'source_video') OR (native_source_video_expectation_valid(j.spec->'source_video') AND current_setting('rainsync.native_extended_reader',true)='1')))
$$;
CREATE FUNCTION protect_native_extended_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Legacy normalization treats decoder-generation refusal as authority
    -- revocation. Skip only that false cancellation while original independent
    -- session/source/account authority is still positively valid. Genuine
    -- Stop/expiry/revocation never passes this helper and still cancels.
    IF TG_OP='UPDATE' AND OLD.logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1') AND OLD.spec ? 'source_video'
        AND NEW.status='cancelled' AND NEW.error='native_platform_authority_revoked'
        AND current_setting('rainsync.native_extended_reader',true) IS DISTINCT FROM '1'
        AND native_platform_transcode_session_allowed_pre_extended(OLD.session_id) THEN RETURN NULL; END IF;
    IF NEW.spec ? 'source_video' THEN
        IF (NEW.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1') OR NOT native_source_video_expectation_valid(NEW.spec->'source_video') THEN RAISE EXCEPTION 'native_platform_extended_source_contract_required'; END IF;
        IF TG_OP='UPDATE' AND NEW.status='running' AND (OLD.status<>'running' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.attempt IS DISTINCT FROM OLD.attempt)
            AND current_setting('rainsync.native_extended_recipe',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'native_platform_extended_worker_recipe_required'; END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER native_extended_job_guard BEFORE INSERT OR UPDATE ON media_jobs FOR EACH ROW EXECUTE FUNCTION protect_native_extended_job();

CREATE OR REPLACE FUNCTION hls_ladder_job_allowed(job uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=$1 AND
 ((j.logical_queue IN ('local_hls_ladder_v1','advanced_hls_ladder_v1') AND local_hls_ladder_job_spec_valid(j.spec) AND local_hls_ladder_session_allowed(j.session_id))
 OR (j.logical_queue='advanced_owned_hls_ladder_v1' AND advanced_owned_ladder_job_spec_valid(j.spec) AND local_hls_ladder_session_allowed(j.session_id))
 OR (j.logical_queue='native_platform_hls_ladder_v1' AND native_platform_ladder_job_spec_valid(j.spec) AND native_platform_transcode_session_allowed(j.session_id))))
$$;
