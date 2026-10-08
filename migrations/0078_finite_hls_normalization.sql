-- Separate finite clear-TS normalization capability. Original source inventory
-- never becomes a normalized-output identity or a reusable source authorization.
ALTER TABLE owned_http_representations ADD COLUMN finite_hls_version smallint CHECK(finite_hls_version=1);
ALTER TABLE owned_http_representations ADD COLUMN finite_hls_evidence jsonb;
CREATE FUNCTION finite_hls_ts_evidence_valid(v jsonb,n bigint,digest text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; segment jsonb; segment_index integer=0; expected bigint=90000; source_total bigint=0; normalized_total bigint=0; inventory_count integer; segment_count integer;
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(v))<>11
 OR NOT v ?& ARRAY['version','scope','source_inventory','source_read_bytes','media_sequence','manifest_duration_ms','normalized_bytes','normalized_sha256','normalized_video_origin_ticks','clock_scale','segments']
 OR v->'version' IS DISTINCT FROM '1'::jsonb OR v->>'scope' IS DISTINCT FROM 'finite_clear_ts_normalization_v1'
 OR octet_length(v::text)>131072 OR v->>'normalized_sha256' IS DISTINCT FROM digest
 OR v->'clock_scale' IS DISTINCT FROM '90000'::jsonb OR v->'normalized_video_origin_ticks' IS DISTINCT FROM '90000'::jsonb
 OR jsonb_typeof(v->'source_inventory') IS DISTINCT FROM 'array' OR jsonb_typeof(v->'segments') IS DISTINCT FROM 'array'
 OR NOT COALESCE(v->>'normalized_bytes' ~ '^[0-9]+$',false) OR (v->>'normalized_bytes')::bigint IS DISTINCT FROM n
 OR NOT COALESCE(v->>'source_read_bytes' ~ '^[0-9]+$',false) OR (v->>'source_read_bytes')::bigint NOT BETWEEN 1 AND 134217728
 OR NOT COALESCE(v->>'media_sequence' ~ '^[0-9]+$',false) OR (v->>'media_sequence')::numeric>9007199254740991
 OR jsonb_typeof(v->'manifest_duration_ms') IS DISTINCT FROM 'number' OR (v->>'manifest_duration_ms')::numeric NOT BETWEEN 1 AND 300000
 THEN RETURN false; END IF;
 inventory_count=jsonb_array_length(v->'source_inventory'); segment_count=jsonb_array_length(v->'segments');
 IF segment_count NOT BETWEEN 1 AND 64 OR inventory_count-segment_count NOT BETWEEN 1 AND 2 THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(v->'source_inventory') LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>5
  OR NOT item ?& ARRAY['original_target_sha256','final_target_sha256','strong_etag','bytes','sha256']
  OR NOT COALESCE(item->>'original_target_sha256' ~ '^[0-9a-f]{64}$',false)
  OR NOT COALESCE(item->>'final_target_sha256' ~ '^[0-9a-f]{64}$',false)
  OR NOT COALESCE(item->>'sha256' ~ '^[0-9a-f]{64}$',false)
  OR NOT COALESCE(item->>'strong_etag' ~ '^"[^"[:cntrl:] ]*"$',false) OR length(item->>'strong_etag')>1024
  OR NOT COALESCE(item->>'bytes' ~ '^[0-9]+$',false) OR (item->>'bytes')::bigint NOT BETWEEN 1 AND 33554432
  THEN RETURN false; END IF;
  source_total=source_total+(item->>'bytes')::bigint;
 END LOOP;
 FOR segment IN SELECT value FROM jsonb_array_elements(v->'segments') LOOP
  IF jsonb_typeof(segment) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(segment))<>13
  OR NOT segment ?& ARRAY['index','discontinuity','original_bytes','original_sha256','normalized_sha256','original_video_first_pts','normalized_video_first_pts','video_frames','video_step_ticks','original_audio_first_pts','normalized_audio_first_pts','audio_packets','timestamp_offset_ticks']
  OR jsonb_typeof(segment->'discontinuity') IS DISTINCT FROM 'boolean'
  OR EXISTS(SELECT 1 FROM jsonb_each(segment) field WHERE field.key IN ('index','original_bytes','original_video_first_pts','normalized_video_first_pts','video_frames','video_step_ticks','audio_packets','timestamp_offset_ticks') AND jsonb_typeof(field.value)<>'number')
  OR (segment->>'index')::integer<>segment_index
  OR NOT COALESCE(segment->>'original_sha256' ~ '^[0-9a-f]{64}$',false) OR NOT COALESCE(segment->>'normalized_sha256' ~ '^[0-9a-f]{64}$',false)
  OR (segment->>'original_bytes')::bigint NOT BETWEEN 188 AND 33554432 OR (segment->>'original_bytes')::bigint%188<>0
  OR (segment->>'normalized_video_first_pts')::bigint<>expected
  OR (segment->>'original_video_first_pts')::bigint NOT BETWEEN 0 AND 8589934591
  OR (segment->>'original_video_first_pts')::bigint+(segment->>'timestamp_offset_ticks')::bigint<>expected
  OR (segment->>'video_frames')::integer NOT BETWEEN 1 AND 960 OR NOT COALESCE(segment->>'video_step_ticks' IN ('3000','3600'),false)
  OR (segment->>'audio_packets')::integer NOT BETWEEN 0 AND 1502 THEN RETURN false; END IF;
  item=v->'source_inventory'->(inventory_count-segment_count+segment_index);
  IF item->'sha256' IS DISTINCT FROM segment->'original_sha256' OR item->'bytes' IS DISTINCT FROM segment->'original_bytes' THEN RETURN false; END IF;
  IF segment->'original_audio_first_pts'='null'::jsonb THEN
   IF segment->'normalized_audio_first_pts' IS DISTINCT FROM 'null'::jsonb OR segment->'audio_packets' IS DISTINCT FROM '0'::jsonb THEN RETURN false; END IF;
  ELSE
   IF (segment->>'audio_packets')::integer<1 OR (segment->>'original_audio_first_pts')::bigint+(segment->>'timestamp_offset_ticks')::bigint IS DISTINCT FROM (segment->>'normalized_audio_first_pts')::bigint
   OR (segment->>'normalized_audio_first_pts')::bigint<0 THEN RETURN false; END IF;
  END IF;
  expected=expected+(segment->>'video_frames')::integer*(segment->>'video_step_ticks')::integer;
  normalized_total=normalized_total+(segment->>'original_bytes')::bigint; segment_index=segment_index+1;
 END LOOP;
 RETURN COALESCE(normalized_total=n AND source_total=(v->>'source_read_bytes')::bigint AND abs((expected-90000)::numeric/90-(v->>'manifest_duration_ms')::numeric)<0.02,false);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION finite_hls_fmp4_evidence_valid(v jsonb,n bigint,digest text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; segment jsonb; track jsonb; proof jsonb; init_item jsonb; segment_index integer=0; inventory_count integer; segment_count integer; source_total bigint=0; normalized_total bigint=0;
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(v))<>12
 OR NOT v ?& ARRAY['version','scope','source_inventory','source_read_bytes','media_sequence','manifest_duration_ms','normalized_bytes','normalized_sha256','normalized_video_origin_ticks','clock_scale','segments','decoded_timeline']
 OR v->'version' IS DISTINCT FROM '1'::jsonb OR v->>'scope' IS DISTINCT FROM 'finite_clear_fmp4_normalization_v1'
 OR octet_length(v::text)>131072 OR v->>'normalized_sha256' IS DISTINCT FROM digest
 OR v->'clock_scale' IS DISTINCT FROM '0'::jsonb OR v->'normalized_video_origin_ticks' IS DISTINCT FROM '0'::jsonb
 OR jsonb_typeof(v->'source_inventory') IS DISTINCT FROM 'array' OR jsonb_typeof(v->'segments') IS DISTINCT FROM 'array'
 OR NOT COALESCE(v->>'normalized_bytes' ~ '^[0-9]+$',false) OR (v->>'normalized_bytes')::bigint IS DISTINCT FROM n
 OR NOT COALESCE(v->>'source_read_bytes' ~ '^[0-9]+$',false) OR (v->>'source_read_bytes')::bigint NOT BETWEEN 1 AND 134217728
 OR NOT COALESCE(v->>'media_sequence' ~ '^[0-9]+$',false) OR (v->>'media_sequence')::numeric>9007199254740991
 OR jsonb_typeof(v->'manifest_duration_ms') IS DISTINCT FROM 'number' OR (v->>'manifest_duration_ms')::numeric NOT BETWEEN 1 AND 300000
 THEN RETURN false; END IF;
 inventory_count=jsonb_array_length(v->'source_inventory'); segment_count=jsonb_array_length(v->'segments');
 IF segment_count NOT BETWEEN 1 AND 64 OR inventory_count-segment_count NOT BETWEEN 2 AND 3 THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(v->'source_inventory') LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>5
  OR NOT item ?& ARRAY['original_target_sha256','final_target_sha256','strong_etag','bytes','sha256']
  OR NOT COALESCE(item->>'original_target_sha256' ~ '^[0-9a-f]{64}$',false) OR NOT COALESCE(item->>'final_target_sha256' ~ '^[0-9a-f]{64}$',false)
  OR NOT COALESCE(item->>'sha256' ~ '^[0-9a-f]{64}$',false) OR NOT COALESCE(item->>'strong_etag' ~ '^"[^"[:cntrl:] ]*"$',false)
  OR length(item->>'strong_etag')>1024 OR NOT COALESCE(item->>'bytes' ~ '^[0-9]+$',false) OR (item->>'bytes')::bigint NOT BETWEEN 1 AND 33554432 THEN RETURN false; END IF;
  source_total=source_total+(item->>'bytes')::bigint;
 END LOOP;
 proof=v->'decoded_timeline';init_item=v->'source_inventory'->(inventory_count-segment_count-1);
 IF jsonb_typeof(proof) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(proof))<>10
 OR NOT proof ?& ARRAY['version','manifest_sha256','manifest_bytes','init','segments','scope','source_origin_ms','duration_ms','media_sequence','tracks']
 OR proof->'version' IS DISTINCT FROM '1'::jsonb OR proof->>'scope' IS DISTINCT FROM 'finite-normalized-zero-origin-avc-fmp4-v1'
 OR proof->'source_origin_ms' IS DISTINCT FROM '0'::jsonb OR proof->'duration_ms' IS DISTINCT FROM v->'manifest_duration_ms'
 OR proof->'media_sequence' IS DISTINCT FROM v->'media_sequence'
 OR NOT COALESCE(proof->>'manifest_sha256' ~ '^[0-9a-f]{64}$',false) OR (proof->>'manifest_bytes')::bigint NOT BETWEEN 1 AND 262144
 OR jsonb_typeof(proof->'segments') IS DISTINCT FROM 'array' OR jsonb_array_length(proof->'segments')<>segment_count
 OR jsonb_typeof(proof->'tracks') IS DISTINCT FROM 'array' OR jsonb_array_length(proof->'tracks') NOT BETWEEN 1 AND 2
 OR proof->'init'->'sha256' IS DISTINCT FROM init_item->'sha256' OR proof->'init'->'bytes' IS DISTINCT FROM init_item->'bytes'
 OR (init_item->>'bytes')::bigint>2097152 THEN RETURN false; END IF;
 normalized_total=(init_item->>'bytes')::bigint;
 FOR segment IN SELECT value FROM jsonb_array_elements(v->'segments') LOOP
  IF jsonb_typeof(segment) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(segment))<>7
  OR NOT segment ?& ARRAY['index','discontinuity','original_bytes','original_sha256','normalized_bytes','normalized_sha256','tracks']
  OR jsonb_typeof(segment->'discontinuity') IS DISTINCT FROM 'boolean'
  OR EXISTS(SELECT 1 FROM jsonb_each(segment) field WHERE field.key IN ('index','original_bytes','normalized_bytes') AND jsonb_typeof(field.value)<>'number')
  OR (segment->>'index')::integer<>segment_index
  OR NOT COALESCE(segment->>'original_sha256' ~ '^[0-9a-f]{64}$',false) OR NOT COALESCE(segment->>'normalized_sha256' ~ '^[0-9a-f]{64}$',false)
  OR (segment->>'original_bytes')::bigint NOT BETWEEN 1 AND 33554432 OR (segment->>'normalized_bytes')::bigint NOT BETWEEN 1 AND 33554432
  OR (segment->>'normalized_bytes')::bigint>(segment->>'original_bytes')::bigint
  OR jsonb_typeof(segment->'tracks') IS DISTINCT FROM 'array' OR jsonb_array_length(segment->'tracks')<>jsonb_array_length(proof->'tracks') THEN RETURN false; END IF;
  item=v->'source_inventory'->(inventory_count-segment_count+segment_index);
  IF item->'sha256' IS DISTINCT FROM segment->'original_sha256' OR item->'bytes' IS DISTINCT FROM segment->'original_bytes'
  OR proof->'segments'->segment_index->'sha256' IS DISTINCT FROM segment->'normalized_sha256'
  OR proof->'segments'->segment_index->'bytes' IS DISTINCT FROM segment->'normalized_bytes' THEN RETURN false; END IF;
  FOR track IN SELECT value FROM jsonb_array_elements(segment->'tracks') LOOP
   IF jsonb_typeof(track) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(track))<>7
   OR NOT track ?& ARRAY['track_id','clock_scale','original_first_pts','normalized_first_pts','timestamp_offset_ticks','samples','duration_ticks']
   OR EXISTS(SELECT 1 FROM jsonb_each(track) field WHERE jsonb_typeof(field.value)<>'number')
   OR (track->>'track_id')::bigint NOT BETWEEN 1 AND 4294967295 OR (track->>'clock_scale')::integer NOT BETWEEN 1 AND 1000000
   OR (track->>'samples')::integer NOT BETWEEN 1 AND 35000 OR (track->>'duration_ticks')::bigint NOT BETWEEN 1 AND 32000000
   OR (track->>'original_first_pts')::bigint+(track->>'timestamp_offset_ticks')::bigint IS DISTINCT FROM (track->>'normalized_first_pts')::bigint
   OR (track->>'normalized_first_pts')::bigint NOT BETWEEN -1024 AND 9007199254740991 THEN RETURN false; END IF;
  END LOOP;
  normalized_total=normalized_total+(segment->>'normalized_bytes')::bigint;segment_index=segment_index+1;
 END LOOP;
 RETURN COALESCE(normalized_total=n AND source_total=(v->>'source_read_bytes')::bigint,false);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION finite_hls_evidence_valid(v jsonb,n bigint,digest text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE v->>'scope' WHEN 'finite_clear_ts_normalization_v1' THEN finite_hls_ts_evidence_valid($1,$2,$3)
 WHEN 'finite_clear_fmp4_normalization_v1' THEN finite_hls_fmp4_evidence_valid($1,$2,$3) ELSE false END
$$;
ALTER TABLE owned_http_representations ADD CONSTRAINT finite_hls_evidence_shape CHECK(
 finite_hls_evidence IS NULL OR (finite_hls_version=1 AND finite_hls_evidence_valid(finite_hls_evidence,bytes,sha256)));
ALTER FUNCTION playback_source_allowed(uuid,jsonb) RENAME TO playback_source_allowed_pre_finite_hls;
CREATE FUNCTION playback_source_allowed(media uuid,resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT playback_source_allowed_pre_finite_hls($1,$2) AND
 (NOT($2 ? 'http_finite_hls_version') OR
  ($2->'http_finite_hls_version'='1'::jsonb AND $2->'http_owned_response_version'='1'::jsonb
   AND NOT($2 ? 'http_owned_large_response_version')
   AND COALESCE(current_setting('rainsync.finite_hls_reader',true)='1',false)))
$$;
ALTER FUNCTION owned_http_representation_authority_allowed(uuid) RENAME TO owned_http_representation_authority_allowed_pre_finite_hls;
CREATE FUNCTION owned_http_representation_authority_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT owned_http_representation_authority_allowed_pre_finite_hls($1) AND EXISTS(
  SELECT 1 FROM owned_http_representations h JOIN playback_sessions p ON p.id=h.session_id WHERE h.session_id=$1
  AND ((h.finite_hls_version IS NULL AND NOT(p.resource ? 'http_finite_hls_version')) OR
   (h.finite_hls_version=1 AND p.resource->'http_finite_hls_version'='1'::jsonb
    AND COALESCE(current_setting('rainsync.finite_hls_reader',true)='1',false))))
$$;
CREATE FUNCTION protect_finite_hls_representation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.finite_hls_version IS DISTINCT FROM OLD.finite_hls_version
   OR (OLD.finite_hls_evidence IS NOT NULL AND NEW.finite_hls_evidence IS DISTINCT FROM OLD.finite_hls_evidence)
   THEN RAISE EXCEPTION 'finite_hls_source_proof_frozen'; END IF;
 END IF;
 IF NEW.finite_hls_version=1 THEN
  IF NEW.capture_class<>'complete_small_v1' OR (NEW.state IN('capturing','ready') AND NOT EXISTS(SELECT 1 FROM playback_sessions p
    WHERE p.id=NEW.session_id AND p.resource->'http_finite_hls_version'='1'::jsonb
    AND NOT(p.resource ? 'http_owned_large_response_version')))
    THEN RAISE EXCEPTION 'finite_hls_source_binding_required'; END IF;
  IF NEW.state IN('capturing','ready') AND current_setting('rainsync.finite_hls_reader',true) IS DISTINCT FROM '1'
    THEN RAISE EXCEPTION 'finite_hls_reader_required'; END IF;
  IF NEW.state='ready' AND NEW.finite_hls_evidence IS NULL THEN RAISE EXCEPTION 'finite_hls_physical_proof_required'; END IF;
 ELSE
  IF NEW.finite_hls_evidence IS NOT NULL THEN RAISE EXCEPTION 'finite_hls_evidence_unexpected'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ab_finite_hls_representation_guard BEFORE INSERT OR UPDATE ON owned_http_representations FOR EACH ROW EXECUTE FUNCTION protect_finite_hls_representation();
CREATE FUNCTION protect_finite_hls_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM owned_http_representations h WHERE h.session_id=NEW.id AND h.finite_hls_version=1)
 AND (NEW.resource->'http_finite_hls_version' IS DISTINCT FROM '1'::jsonb OR NEW.resource ? 'http_owned_large_response_version')
 THEN RAISE EXCEPTION 'finite_hls_grant_frozen'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ab_finite_hls_session_guard BEFORE INSERT OR UPDATE ON playback_sessions FOR EACH ROW EXECUTE FUNCTION protect_finite_hls_session();
-- The old owned queue predicates call owned_http_job_allowed, which calls the
-- capability-gated authority above. Old workers cannot claim/retry these rows.
-- Legacy sweeps only cancel genuinely stopped/expired sessions or native rows,
-- not an owned job merely because their finite reader capability is absent.
CREATE FUNCTION protect_finite_hls_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.logical_queue='owned_http_v1' AND EXISTS(SELECT 1 FROM owned_http_representations h WHERE h.session_id=NEW.session_id AND h.finite_hls_version=1)
 AND NEW.status='running' AND (TG_OP='INSERT' OR OLD.status<>'running' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.attempt IS DISTINCT FROM OLD.attempt)
 AND current_setting('rainsync.finite_hls_reader',true) IS DISTINCT FROM '1'
 THEN RAISE EXCEPTION 'finite_hls_worker_recipe_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aa_finite_hls_job_guard BEFORE INSERT OR UPDATE ON media_jobs FOR EACH ROW EXECUTE FUNCTION protect_finite_hls_job();
