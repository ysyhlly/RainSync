-- A clear finite WebM video + MP4 AAC pair is private compatibility input.
-- The original native queues and authority remain compulsory. Unknown/older
-- readers are excluded before claim; the decoder-generation marker is scoped
-- to this additional grammar and cannot silently authorize source access.
CREATE FUNCTION native_webm_source_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text;
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(v))<>10
 OR NOT v ?& ARRAY['schema_version','codec','width','height','profile','bit_depth','color_primaries','color_transfer','color_space','color_range']
 OR v->'schema_version' IS DISTINCT FROM '1'::jsonb OR NOT COALESCE(v->>'codec' IN ('vp9','av1'),false)
 OR jsonb_typeof(v->'width') IS DISTINCT FROM 'number' OR NOT COALESCE(v->>'width' ~ '^[0-9]+$',false) OR (v->>'width')::numeric NOT BETWEEN 1 AND 8192
 OR jsonb_typeof(v->'height') IS DISTINCT FROM 'number' OR NOT COALESCE(v->>'height' ~ '^[0-9]+$',false) OR (v->>'height')::numeric NOT BETWEEN 1 AND 4320 THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['profile','bit_depth','color_primaries','color_transfer','color_space','color_range'] LOOP
  IF v->k IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(v->k) IS DISTINCT FROM 'number' OR NOT COALESCE(v->>k ~ '^[0-9]+$',false)) THEN RETURN false; END IF;
 END LOOP;
 IF (v->'profile'<>'null'::jsonb AND NOT COALESCE(CASE WHEN v->>'codec'='vp9' THEN v->>'profile' IN ('0','2') ELSE v->>'profile'='0' END,false))
 OR (v->'bit_depth'<>'null'::jsonb AND NOT COALESCE(v->>'bit_depth' IN ('8','10'),false))
 OR (v->'color_primaries'<>'null'::jsonb AND NOT COALESCE(v->>'color_primaries' IN ('1','9'),false))
 OR (v->'color_transfer'<>'null'::jsonb AND NOT COALESCE(v->>'color_transfer' IN ('1','16','18'),false))
 OR (v->'color_space'<>'null'::jsonb AND NOT COALESCE(v->>'color_space' IN ('1','9','10'),false))
 OR (v->'color_range'<>'null'::jsonb AND NOT COALESCE(v->>'color_range' IN ('1','2'),false))
 OR (v->>'codec'='vp9' AND v->'profile'<>'null'::jsonb AND v->'bit_depth'<>'null'::jsonb AND (v->>'profile',v->>'bit_depth') NOT IN (('0','8'),('2','10'))) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION native_webm_normalized_spec(spec jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v jsonb; a jsonb;
BEGIN
 IF NOT native_webm_source_valid(spec->'source_webm') OR spec ? 'source_video'
 OR jsonb_typeof(spec->'tracks') IS DISTINCT FROM 'array' OR jsonb_array_length(spec->'tracks')<>2 THEN RETURN NULL; END IF;
 v=spec->'tracks'->0; a=spec->'tracks'->1;
 IF v->>'key' IS DISTINCT FROM 'video' OR v->'container' IS DISTINCT FROM '"webm"'::jsonb OR a->>'key' IS DISTINCT FROM 'audio' OR a ? 'container' THEN RETURN NULL; END IF;
 RETURN jsonb_set(spec-'source_webm','{tracks}',jsonb_build_array(v-'container',a));
END $$;
ALTER FUNCTION native_platform_transcode_job_spec_valid(jsonb) RENAME TO native_platform_transcode_job_spec_valid_pre_webm;
CREATE FUNCTION native_platform_transcode_job_spec_valid(spec jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN spec ? 'source_webm' THEN COALESCE(native_platform_transcode_job_spec_valid_pre_webm(native_webm_normalized_spec(spec)),false)
 ELSE native_platform_transcode_job_spec_valid_pre_webm(spec) END
$$;
ALTER FUNCTION native_platform_ladder_job_spec_valid(jsonb) RENAME TO native_platform_ladder_job_spec_valid_pre_webm;
CREATE FUNCTION native_platform_ladder_job_spec_valid(spec jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN spec ? 'source_webm' THEN COALESCE(native_platform_ladder_job_spec_valid_pre_webm(native_webm_normalized_spec(spec)),false)
 ELSE native_platform_ladder_job_spec_valid_pre_webm(spec) END
$$;
ALTER FUNCTION native_platform_transcode_session_allowed(uuid) RENAME TO native_platform_transcode_session_allowed_pre_webm;
CREATE FUNCTION native_platform_transcode_session_allowed(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT native_platform_transcode_session_allowed_pre_webm($1) AND EXISTS(SELECT 1 FROM media_jobs j WHERE j.session_id=$1
 AND (NOT(j.spec ? 'source_webm') OR COALESCE(current_setting('rainsync.native_webm_reader',true)='1',false)))
$$;
CREATE FUNCTION protect_native_webm_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1') AND OLD.spec ? 'source_webm'
 AND NEW.status='cancelled' AND NEW.error='native_platform_authority_revoked'
 AND current_setting('rainsync.native_webm_reader',true) IS DISTINCT FROM '1'
 AND native_platform_transcode_session_allowed_pre_extended(OLD.session_id) THEN RETURN NULL; END IF;
 IF NEW.spec ? 'source_webm' THEN
  IF NEW.logical_queue NOT IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1') OR native_webm_normalized_spec(NEW.spec) IS NULL
  THEN RAISE EXCEPTION 'native_platform_webm_source_contract_required'; END IF;
  IF TG_OP='UPDATE' AND NEW.status='running' AND (OLD.status<>'running' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.attempt IS DISTINCT FROM OLD.attempt)
  AND current_setting('rainsync.native_webm_recipe',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'native_platform_webm_worker_recipe_required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aa_native_webm_job_guard BEFORE INSERT OR UPDATE ON media_jobs FOR EACH ROW EXECUTE FUNCTION protect_native_webm_job();

-- A separately qualified complete-response class for larger finite HTTP
-- binaries. Weak/unknown-length responses retain the original128MiB/25s cap.
-- Larger bodies require a known complete length and an actual strong ETag;
-- reservation is resized under the cache-budget lock before the first write.
ALTER TABLE owned_http_representations ADD COLUMN capture_class text NOT NULL DEFAULT 'complete_small_v1';
ALTER TABLE owned_http_representations ADD COLUMN capture_limit bigint NOT NULL DEFAULT 134217728;
ALTER TABLE owned_http_representations ADD COLUMN capture_etag text;
ALTER TABLE owned_http_representations DROP CONSTRAINT owned_http_representations_bytes_check;
ALTER TABLE owned_http_representations ADD CONSTRAINT owned_http_bytes_bound CHECK(bytes>0 AND bytes<=capture_limit);
ALTER TABLE owned_http_representations ADD CONSTRAINT owned_http_capture_class_shape CHECK(
 (capture_class='complete_small_v1' AND capture_limit=134217728 AND capture_etag IS NULL)
 OR (capture_class='strong_known_large_v1' AND capture_limit BETWEEN 134217729 AND 2147483648
 AND capture_etag IS NOT NULL AND length(capture_etag) BETWEEN 2 AND 1024 AND capture_etag ~ '^"[^"[:cntrl:] ]*"$'
 AND (bytes IS NULL OR bytes=capture_limit)));
ALTER TABLE cache_write_reservations DROP CONSTRAINT owned_http_reservation_shape;
ALTER TABLE cache_write_reservations ADD CONSTRAINT owned_http_reservation_shape
 CHECK(purpose<>'owned_http_representation' OR (attempt=1 AND bytes BETWEEN 134217728 AND 2147483648));
ALTER FUNCTION owned_http_representation_authority_allowed(uuid) RENAME TO owned_http_representation_authority_allowed_pre_large;
CREATE FUNCTION owned_http_representation_authority_allowed(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT owned_http_representation_authority_allowed_pre_large($1) AND EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=$1
 AND (NOT(p.resource ? 'http_owned_large_response_version') OR
  (p.resource->'http_owned_large_response_version'='1'::jsonb AND COALESCE(current_setting('rainsync.owned_http_large_reader',true)='1',false))))
$$;
ALTER FUNCTION playback_source_allowed(uuid,jsonb) RENAME TO playback_source_allowed_pre_large_http;
CREATE FUNCTION playback_source_allowed(media uuid,resource jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT playback_source_allowed_pre_large_http($1,$2)
 AND (NOT($2 ? 'http_owned_large_response_version') OR
  ($2->'http_owned_response_version'='1'::jsonb AND $2->'http_owned_large_response_version'='1'::jsonb
   AND COALESCE(current_setting('rainsync.owned_http_large_reader',true)='1',false)))
$$;
CREATE FUNCTION protect_owned_http_capture_class() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.capture_class,NEW.capture_limit,NEW.capture_etag) IS DISTINCT FROM ROW(OLD.capture_class,OLD.capture_limit,OLD.capture_etag) THEN
  IF OLD.capture_class<>'complete_small_v1' OR NEW.capture_class<>'strong_known_large_v1'
  OR OLD.state<>'capturing' OR NEW.state<>'capturing' OR OLD.bytes IS NOT NULL OR NEW.bytes IS NOT NULL
  OR OLD.frozen_spec IS NOT NULL OR NEW.frozen_spec IS NOT NULL
  OR current_setting('rainsync.owned_http_large_reader',true) IS DISTINCT FROM '1'
  OR NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=OLD.session_id AND p.resource->'http_owned_large_response_version'='1'::jsonb)
  OR clock_timestamp()>=OLD.created_at+interval '25 seconds' THEN RAISE EXCEPTION 'owned_http_capture_class_frozen'; END IF;
 END IF;
 IF NEW.state='ready' AND OLD.state='capturing' AND clock_timestamp()>=(OLD.created_at+
  CASE WHEN NEW.capture_class='strong_known_large_v1' THEN interval '5 minutes' ELSE interval '25 seconds' END)
 THEN RAISE EXCEPTION 'owned_http_capture_deadline'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aa_owned_http_capture_class_guard BEFORE UPDATE ON owned_http_representations FOR EACH ROW EXECUTE FUNCTION protect_owned_http_capture_class();
