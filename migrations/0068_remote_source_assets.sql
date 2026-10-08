-- Owner-declared HTTP and adjacent stat-bound NAS subtitles/fonts. This new
-- queue is never visible to an old ordinary/owned recipe claimant.
LOCK TABLE media_jobs IN ACCESS EXCLUSIVE MODE NOWAIT;
ALTER TABLE agents ADD COLUMN advanced_assets_version smallint NOT NULL DEFAULT 0 CHECK(advanced_assets_version IN (0,1));
ALTER TABLE agents ADD COLUMN advanced_assets_connection uuid;
ALTER TABLE media_jobs DROP CONSTRAINT media_jobs_logical_queue_check;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_logical_queue_check CHECK(logical_queue IS NULL OR logical_queue IN ('static_hls_v1','advanced_local_v1','local_hls_ladder_v1','native_platform_transcode_v1','native_platform_hls_ladder_v1','advanced_hls_ladder_v1','advanced_owned_v1','advanced_owned_hls_ladder_v1','owned_http_v1','remote_assets_v1'));
CREATE FUNCTION remote_asset_catalog_valid(a jsonb,kind text,source text,version text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c jsonb; legacy jsonb; f jsonb; p jsonb; subtitles jsonb='[]'; fonts jsonb='[]'; n integer=0; all_files jsonb='[]';
BEGIN
 IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(a))<>7
 OR NOT a ?& ARRAY['schema_version','source_kind','source_resource','source_version','catalog','source_http','http_files']
 OR a->'schema_version' IS DISTINCT FROM '1'::jsonb OR a->>'source_kind' IS DISTINCT FROM kind OR a->>'source_resource' IS DISTINCT FROM source
 OR kind NOT IN ('http','agent') OR jsonb_typeof(a->'http_files') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 c=a->'catalog';
 IF kind='agent' THEN RETURN a->'source_http'='null'::jsonb AND a->'http_files'='[]'::jsonb AND a->>'source_version'=version AND advanced_asset_catalog_valid(c,source,version); END IF;
 IF version IS NOT NULL OR source IS NULL THEN RETURN false; END IF;
 IF source !~ '^https?://' OR source ~ '[\n\r]' OR source ~ '^https?://[^/]*@' OR source ~ '#' THEN RETURN false; END IF;
 IF c->'schema_version' IS DISTINCT FROM '2'::jsonb OR c->>'source_resource' IS DISTINCT FROM 'http-source.mkv'
 OR c->>'source_version' IS DISTINCT FROM a->>'source_version' OR NOT COALESCE(a->>'source_version' ~ '^http-v1:[0-9a-f]{64}$',false)
 OR jsonb_typeof(c->'subtitles') IS DISTINCT FROM 'array' OR jsonb_typeof(c->'fonts') IS DISTINCT FROM 'array'
 OR jsonb_typeof(a->'source_http') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(a->'source_http'))<>2
 OR NOT a->'source_http' ?& ARRAY['etag','bytes'] OR jsonb_typeof(a->'source_http'->'etag') IS DISTINCT FROM 'string'
 OR length(a->'source_http'->>'etag') NOT BETWEEN 2 AND 1024 OR left(a->'source_http'->>'etag',1)<>'"' OR right(a->'source_http'->>'etag',1)<>'"'
 OR a->'source_http'->>'etag' ~ '[\n\r]' OR jsonb_typeof(a->'source_http'->'bytes') IS DISTINCT FROM 'number'
 OR NOT COALESCE(a->'source_http'->>'bytes' ~ '^[0-9]+$',false) OR (a->'source_http'->>'bytes')::numeric NOT BETWEEN 1 AND 2147483648 THEN RETURN false; END IF;
 -- Project only validation grammar, never write invented stat identities.
 FOR f IN SELECT value FROM jsonb_array_elements(c->'subtitles') LOOP
  IF NOT COALESCE(f->'file'->>'source_version' ~ '^http-v1:[0-9a-f]{64}$',false) THEN RETURN false; END IF;
  all_files=all_files||jsonb_build_array(f->'file');
  subtitles=subtitles||jsonb_build_array(jsonb_set(f,'{file,source_version}',to_jsonb(replace(f->'file'->>'source_version','http-v1:','stat-v1:'))));
 END LOOP;
 FOR f IN SELECT value FROM jsonb_array_elements(c->'fonts') LOOP
  IF NOT COALESCE(f->>'source_version' ~ '^http-v1:[0-9a-f]{64}$',false) OR lower(f->>'resource') !~ '^http-source\.fonts/[a-z0-9_-][a-z0-9_.-]*\.(ttf|otf|ttc)$' THEN RETURN false; END IF;
  all_files=all_files||jsonb_build_array(f);
  fonts=fonts||jsonb_build_array(jsonb_set(f,'{source_version}',to_jsonb(replace(f->>'source_version','http-v1:','stat-v1:'))));
 END LOOP;
 legacy=jsonb_set(jsonb_set(jsonb_set(jsonb_set(c,'{schema_version}','1'),'{source_version}',to_jsonb(replace(c->>'source_version','http-v1:','stat-v1:'))),'{subtitles}',subtitles),'{fonts}',fonts);
 IF NOT advanced_asset_catalog_valid(legacy,'http-source.mkv',legacy->>'source_version') OR jsonb_array_length(all_files)<>jsonb_array_length(a->'http_files') THEN RETURN false; END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(all_files) LOOP
  p=a->'http_files'->n;n=n+1;
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>4 OR NOT p ?& ARRAY['resource','etag','bytes','content_sha256']
   OR p->>'resource' IS DISTINCT FROM f->>'resource' OR p->'bytes' IS DISTINCT FROM f->'bytes'
   OR NOT COALESCE(p->>'content_sha256' ~ '^[0-9a-f]{64}$',false) OR f->>'source_version' IS DISTINCT FROM 'http-v1:'||(p->>'content_sha256')
   OR jsonb_typeof(p->'etag') IS DISTINCT FROM 'string' OR length(p->>'etag') NOT BETWEEN 2 AND 1024 OR left(p->>'etag',1)<>'"' OR right(p->>'etag',1)<>'"' OR p->>'etag' ~ '[\n\r]' THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION remote_asset_job_spec_valid(spec jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE base jsonb;
BEGIN
 IF spec->>'kind' IS DISTINCT FROM 'remote_asset_transcode_v1' OR NOT (spec ?& ARRAY['advanced_assets','advanced_remote_assets'])
 OR spec->'advanced_assets' IS DISTINCT FROM spec->'advanced_remote_assets'->'catalog'
 OR NOT remote_asset_catalog_valid(spec->'advanced_remote_assets',spec->>'source_kind',spec->>'resource',spec->>'source_version') THEN RETURN false; END IF;
 IF spec->>'source_kind'='http' AND spec->'held_input_bytes' IS DISTINCT FROM spec->'advanced_remote_assets'->'source_http'->'bytes' THEN RETURN false; END IF;
 base=(spec-'advanced_assets'-'advanced_remote_assets')||jsonb_build_object('kind','advanced_owned_remote_transcode_v1');
 RETURN advanced_owned_job_spec_valid(base);
END $$;
ALTER TABLE advanced_media_bindings DROP CONSTRAINT advanced_media_bindings_frozen_spec_check;
ALTER TABLE advanced_media_bindings ADD CONSTRAINT advanced_media_bindings_frozen_spec_check CHECK(advanced_owned_job_spec_valid(frozen_spec) OR remote_asset_job_spec_valid(frozen_spec));
CREATE FUNCTION remote_asset_job_allowed(job uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id JOIN advanced_media_bindings b ON b.session_id=p.id
 JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id
 WHERE j.id=$1 AND j.logical_queue='remote_assets_v1' AND remote_asset_job_spec_valid(j.spec)
 AND current_setting('rainsync.remote_assets_reader',true)='1' AND b.frozen_spec=j.spec AND b.frozen_resource=p.resource
 AND p.resource->'advanced_remote_assets_version'='1'::jsonb AND b.deadline_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint
 AND NOT p.stopped AND p.expires_at>clock_timestamp() AND p.static_hls_capture_id IS NULL
 AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch AND s.state->>'media_id'=p.media_id::text AND (s.state->>'media_generation')::bigint=p.generation
 AND p.auth_login_hash IS NOT NULL AND p.auth_membership_epoch IS NOT NULL
 AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch) AND playback_source_allowed(p.media_id,p.resource)
 AND (p.viewer_id IS NULL OR EXISTS(SELECT 1 FROM playback_viewer_plans v WHERE v.user_id=p.user_id AND v.room_id=p.room_id AND v.viewer_id=p.viewer_id AND v.plan_generation=p.plan_generation AND v.auth_login_hash=p.auth_login_hash)))
$$;
ALTER FUNCTION advanced_media_job_allowed(uuid) RENAME TO advanced_media_job_allowed_pre_remote_assets;
CREATE FUNCTION advanced_media_job_allowed(job uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$SELECT advanced_media_job_allowed_pre_remote_assets($1) OR remote_asset_job_allowed($1)$$;
ALTER FUNCTION playback_source_allowed(uuid,jsonb) RENAME TO playback_source_allowed_pre_remote_assets;
CREATE FUNCTION playback_source_allowed(media uuid,resource jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT playback_source_allowed_pre_remote_assets($1,$2) AND CASE WHEN $2 ? 'advanced_remote_assets_version' THEN $2->'advanced_remote_assets_version'='1'::jsonb AND current_setting('rainsync.remote_assets_reader',true)='1' ELSE true END
$$;
CREATE FUNCTION protect_remote_asset_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.logical_queue='remote_assets_v1' THEN
  IF ROW(NEW.id,NEW.session_id,NEW.logical_queue,NEW.spec) IS DISTINCT FROM ROW(OLD.id,OLD.session_id,OLD.logical_queue,OLD.spec) THEN RAISE EXCEPTION 'remote_asset_queue_immutable'; END IF;
 ELSIF TG_OP='UPDATE' AND NEW.logical_queue='remote_assets_v1' THEN RAISE EXCEPTION 'remote_asset_no_reclassification'; END IF;
 IF NEW.logical_queue IS DISTINCT FROM 'remote_assets_v1' OR NOT remote_asset_job_spec_valid(NEW.spec)
 OR static_hls_is_child_session(NEW.session_id) OR static_hls_child_identity_reserved(NEW.id) THEN RAISE EXCEPTION 'remote_asset_contract_required'; END IF;
 IF TG_OP='INSERT' AND (NEW.status<>'queued' OR NEW.attempt<>0 OR NEW.owner_id IS NOT NULL OR NEW.lease_until IS NOT NULL) THEN RAISE EXCEPTION 'remote_asset_initial_shape_required'; END IF;
 IF NEW.status IN ('queued','running') AND NOT remote_asset_job_allowed(NEW.id) AND TG_OP<>'INSERT' THEN RAISE EXCEPTION 'remote_asset_authority_required'; END IF;
 IF NEW.status IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM advanced_media_bindings b JOIN playback_sessions p ON p.id=b.session_id JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id
 WHERE b.session_id=NEW.session_id AND b.frozen_spec=NEW.spec AND b.frozen_resource=p.resource AND NOT p.stopped AND p.expires_at>clock_timestamp()
 AND b.deadline_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint AND p.resource->'advanced_remote_assets_version'='1'::jsonb AND playback_source_allowed(p.media_id,p.resource) AND p.auth_login_hash IS NOT NULL AND p.auth_membership_epoch IS NOT NULL AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch) AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch AND s.state->>'media_id'=p.media_id::text AND (s.state->>'media_generation')::bigint=p.generation) THEN RAISE EXCEPTION 'remote_asset_source_binding_required'; END IF;
 IF TG_OP='UPDATE' AND NEW.status='running' AND (OLD.status<>'running' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.attempt IS DISTINCT FROM OLD.attempt)
 AND current_setting('rainsync.remote_assets_recipe',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'remote_asset_worker_recipe_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER remote_asset_job_insert BEFORE INSERT ON media_jobs FOR EACH ROW WHEN (NEW.logical_queue='remote_assets_v1' OR NEW.spec->>'kind'='remote_asset_transcode_v1' OR NEW.spec ? 'advanced_remote_assets') EXECUTE FUNCTION protect_remote_asset_job();
CREATE TRIGGER remote_asset_job_update BEFORE UPDATE ON media_jobs FOR EACH ROW WHEN (OLD.logical_queue='remote_assets_v1' OR NEW.logical_queue='remote_assets_v1' OR NEW.spec->>'kind'='remote_asset_transcode_v1' OR NEW.spec ? 'advanced_remote_assets') EXECUTE FUNCTION protect_remote_asset_job();
CREATE FUNCTION protect_remote_asset_output() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IN ('writing','published') AND EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=NEW.job_id AND j.logical_queue='remote_assets_v1') AND NOT remote_asset_job_allowed(NEW.job_id) THEN RAISE EXCEPTION 'remote_asset_output_authority_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER remote_asset_output_guard BEFORE INSERT OR UPDATE ON media_outputs FOR EACH ROW EXECUTE FUNCTION protect_remote_asset_output();

CREATE OR REPLACE FUNCTION protect_advanced_local_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE advanced boolean; owned boolean;
BEGIN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    -- These closed ladders have their own generation-specific guard below.
    IF NEW.logical_queue IN ('advanced_hls_ladder_v1','advanced_owned_hls_ladder_v1','remote_assets_v1') THEN RETURN NEW; END IF;
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


DROP TRIGGER static_hls_job_guard_insert ON media_jobs;
DROP TRIGGER static_hls_job_guard ON media_jobs;
DROP TRIGGER static_hls_job_guard_delete ON media_jobs;
CREATE TRIGGER static_hls_job_guard_insert BEFORE INSERT ON media_jobs
    FOR EACH ROW WHEN (NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND NEW.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_owned_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_owned_hls_ladder_v1'
        AND NEW.logical_queue IS DISTINCT FROM 'owned_http_v1' AND NEW.logical_queue IS DISTINCT FROM 'remote_assets_v1'
        AND NOT static_hls_is_child_session(NEW.session_id) AND NOT static_hls_child_identity_reserved(NEW.id)
        AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard BEFORE UPDATE ON media_jobs
    FOR EACH ROW WHEN (OLD.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1'
        AND OLD.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_owned_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_owned_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_owned_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_owned_hls_ladder_v1'
        AND OLD.logical_queue IS DISTINCT FROM 'owned_http_v1' AND OLD.logical_queue IS DISTINCT FROM 'remote_assets_v1' AND NEW.logical_queue IS DISTINCT FROM 'owned_http_v1' AND NEW.logical_queue IS DISTINCT FROM 'remote_assets_v1'
        AND NOT static_hls_is_child_session(OLD.session_id)
        AND NOT static_hls_is_child_session(NEW.session_id)
        AND NOT static_hls_child_identity_reserved(OLD.id) AND NOT static_hls_child_identity_reserved(NEW.id)
        AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child' AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child')
        EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard_delete BEFORE DELETE ON media_jobs
    FOR EACH ROW WHEN (OLD.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND OLD.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_owned_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_owned_hls_ladder_v1'
        AND OLD.logical_queue IS DISTINCT FROM 'owned_http_v1' AND OLD.logical_queue IS DISTINCT FROM 'remote_assets_v1'
        AND NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_child_identity_reserved(OLD.id)
        AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();



-- A grant cannot be rebound to a later membership/login/viewer epoch while
-- preserving the original files. Expiry changes never renew the frozen deadline.
CREATE FUNCTION protect_remote_asset_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.resource ? 'advanced_remote_assets_version' AND ROW(NEW.id,NEW.user_id,NEW.room_id,NEW.media_id,NEW.generation,NEW.resource,NEW.auth_login_hash,NEW.auth_membership_epoch,NEW.viewer_id,NEW.plan_generation,NEW.lifecycle_epoch,NEW.delivery_token_hash)
 IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.room_id,OLD.media_id,OLD.generation,OLD.resource,OLD.auth_login_hash,OLD.auth_membership_epoch,OLD.viewer_id,OLD.plan_generation,OLD.lifecycle_epoch,OLD.delivery_token_hash) THEN RAISE EXCEPTION 'remote_asset_source_binding_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER remote_asset_session_guard BEFORE UPDATE ON playback_sessions FOR EACH ROW EXECUTE FUNCTION protect_remote_asset_session();
