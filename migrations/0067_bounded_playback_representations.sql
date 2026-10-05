-- A finite output observation belongs to one immutable existing upstream SID.
-- Missing, running and failed observations remain unknown; they grant no SID.
CREATE TABLE upstream_output_observations (
 session_id uuid PRIMARY KEY REFERENCES playback_sessions(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL,
 sid_sha256 text NOT NULL CHECK (sid_sha256 ~ '^[0-9a-f]{64}$'),
 binding_sha256 text NOT NULL CHECK (binding_sha256 ~ '^[0-9a-f]{64}$'),
 route_sha256 text NOT NULL CHECK (route_sha256 ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK (state IN ('running','measured','failed','unknown')),
 attempts smallint NOT NULL DEFAULT 1 CHECK (attempts = 1),
 facts jsonb,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 CHECK ((state = 'measured') = (facts IS NOT NULL)),
 CHECK (facts IS NULL OR octet_length(facts::text) <= 16384)
);

-- Input custody is separate from playback scheduling. Never cascade a physical
-- ownership obligation or release its budget merely because a grant vanished.
CREATE TABLE owned_http_representations (
 session_id uuid PRIMARY KEY,
 owner_id uuid NOT NULL,
 runtime_id uuid NOT NULL,
 request_owner_epoch uuid NOT NULL,
 user_id uuid NOT NULL,
 room_id uuid NOT NULL,
 media_id uuid NOT NULL,
 media_generation bigint NOT NULL,
 lifecycle_epoch bigint NOT NULL,
 login_hash text NOT NULL CHECK(login_hash ~ '^[0-9a-f]{64}$'),
 membership_epoch uuid NOT NULL,
 source_id uuid NOT NULL,
 source_revision bigint NOT NULL,
 viewer_id uuid,
 plan_generation bigint,
 target_sha256 text NOT NULL CHECK(target_sha256 ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('capturing','ready','retired','disposed','unknown')),
 bytes bigint CHECK(bytes>0 AND bytes<=134217728),
 sha256 text CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 streams_closed_at timestamptz,
 files_removed_at timestamptz,
 disposed_at timestamptz,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 minutes'),
 CHECK(state<>'ready' OR (bytes IS NOT NULL AND sha256 IS NOT NULL)),
 CHECK((state='disposed')=(disposed_at IS NOT NULL)),
 CHECK(disposed_at IS NULL OR (streams_closed_at IS NOT NULL AND files_removed_at IS NOT NULL))
);
ALTER TABLE cache_write_reservations DROP CONSTRAINT cache_write_reservations_purpose_check;
ALTER TABLE cache_write_reservations ADD CONSTRAINT cache_write_reservations_purpose_check
 CHECK(purpose IN ('media_job','static_hls_capture','static_hls_child_output','owned_http_representation'));
ALTER TABLE cache_write_reservations ADD CONSTRAINT owned_http_reservation_shape
 CHECK(purpose<>'owned_http_representation' OR (attempt=1 AND bytes=134217728));

ALTER FUNCTION playback_source_allowed(uuid,jsonb) RENAME TO playback_source_allowed_pre_owned_http;
CREATE FUNCTION owned_http_representation_authority_allowed(session uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM owned_http_representations h
 JOIN playback_sessions p ON p.id=h.session_id
 JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id
 WHERE h.session_id=$1 AND h.state IN('capturing','ready') AND h.expires_at>clock_timestamp()
 AND ROW(p.user_id,p.room_id,p.media_id,p.generation,p.lifecycle_epoch,p.auth_login_hash,p.auth_membership_epoch,p.viewer_id,p.plan_generation) IS NOT DISTINCT FROM
     ROW(h.user_id,h.room_id,h.media_id,h.media_generation,h.lifecycle_epoch,h.login_hash,h.membership_epoch,h.viewer_id,h.plan_generation)
 AND EXISTS(SELECT 1 FROM playback_requests request WHERE request.session_id=p.id
   AND request.user_id=h.user_id AND request.room_id=h.room_id AND request.owner_epoch=h.request_owner_epoch
   AND request.auth_login_hash=h.login_hash AND request.auth_membership_epoch=h.membership_epoch
   AND (request.status='completed' OR (request.status='pending' AND request.lease_until>clock_timestamp())))
 AND p.resource->>'source_policy_revision'=h.source_revision::text
 AND NOT p.stopped AND p.expires_at>clock_timestamp()
 AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch
 AND (s.state->>'media_generation')::bigint=p.generation
 AND playback_origin_allowed(h.user_id,h.room_id,h.login_hash,h.membership_epoch)
 AND playback_source_allowed_pre_owned_http(p.media_id,p.resource)
 AND EXISTS(SELECT 1 FROM media_items m JOIN sources src ON src.id=m.source_id
     WHERE m.id=h.media_id AND m.available AND src.kind='http'
     AND src.id=h.source_id AND src.access_policy_revision=h.source_revision)
 AND (p.viewer_id IS NULL OR EXISTS(SELECT 1 FROM playback_viewer_plans v
     WHERE v.user_id=p.user_id AND v.room_id=p.room_id AND v.viewer_id=p.viewer_id
     AND v.plan_generation=p.plan_generation AND v.auth_login_hash=h.login_hash)))
$$;

-- Unknown or old readers cannot reinterpret a complete-owned representation.
-- Missing markers preserve every preceding native/static/advanced check.
CREATE FUNCTION playback_source_allowed(media uuid,resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT playback_source_allowed_pre_owned_http($1,$2) AND
 (NOT ($2 ?| ARRAY['http_owned_response_version','owned_http_session_id']) OR
  ($2->'http_owned_response_version'='1'::jsonb
   AND current_setting('rainsync.owned_http_reader',true)='1'
   AND COALESCE($2->>'owned_http_session_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)
   AND NOT EXISTS(SELECT 1 FROM owned_http_representations h
     WHERE h.session_id::text=$2->>'owned_http_session_id' AND
       (h.media_id<>$1 OR h.state NOT IN ('capturing','ready') OR h.expires_at<=clock_timestamp()
        OR NOT owned_http_representation_authority_allowed(h.session_id)))))
$$;
CREATE FUNCTION protect_owned_http_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h owned_http_representations;
BEGIN
 SELECT * INTO h FROM owned_http_representations WHERE session_id=NEW.id;
 IF h.session_id IS NULL THEN RETURN NEW; END IF;
 IF ROW(NEW.user_id,NEW.room_id,NEW.media_id,NEW.generation,NEW.lifecycle_epoch,NEW.auth_login_hash,NEW.auth_membership_epoch,NEW.viewer_id,NEW.plan_generation)
  IS DISTINCT FROM ROW(h.user_id,h.room_id,h.media_id,h.media_generation,h.lifecycle_epoch,h.login_hash,h.membership_epoch,h.viewer_id,h.plan_generation)
  OR NEW.resource->'http_owned_response_version' IS DISTINCT FROM '1'::jsonb
  OR NEW.resource->>'owned_http_session_id' IS DISTINCT FROM NEW.id::text
  OR NEW.resource->>'source_policy_revision' IS DISTINCT FROM h.source_revision::text
  THEN RAISE EXCEPTION 'owned_http_grant_frozen'; END IF;
 NEW.expires_at=LEAST(NEW.expires_at,h.expires_at);
 RETURN NEW;
END $$;
CREATE TRIGGER zz_owned_http_grant BEFORE INSERT OR UPDATE ON playback_sessions FOR EACH ROW EXECUTE FUNCTION protect_owned_http_grant();

-- Mixed-binary fence: pre-feature Workers never claim this logical queue.
ALTER TABLE media_jobs DROP CONSTRAINT media_jobs_logical_queue_check;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_logical_queue_check CHECK
 (logical_queue IS NULL OR logical_queue IN ('static_hls_v1','advanced_local_v1','local_hls_ladder_v1',
 'native_platform_transcode_v1','native_platform_hls_ladder_v1','advanced_hls_ladder_v1','advanced_owned_v1','advanced_owned_hls_ladder_v1','owned_http_v1'));
ALTER TABLE owned_http_representations ADD COLUMN frozen_spec jsonb;
CREATE FUNCTION owned_http_job_spec_valid(spec jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF jsonb_typeof(spec) IS DISTINCT FROM 'object' OR spec->>'kind' IS DISTINCT FROM 'owned_http_transcode_v1'
 OR spec->'owned_http_response_version' IS DISTINCT FROM '1'::jsonb OR spec->>'source_kind' IS DISTINCT FROM 'http'
 OR spec->'transcode' IS DISTINCT FROM 'true'::jsonb OR spec->'source_version' IS DISTINCT FROM 'null'::jsonb
 OR jsonb_typeof(spec->'input_ticket') IS DISTINCT FROM 'string' OR length(spec->>'input_ticket') NOT BETWEEN 1 AND 16384
 OR jsonb_typeof(spec->'start_seconds') IS DISTINCT FROM 'number'
 OR (spec->>'start_seconds')::numeric NOT BETWEEN 0 AND 21600
 OR (spec->'negotiated_mode' IS DISTINCT FROM 'null'::jsonb AND spec->>'negotiated_mode' IS DISTINCT FROM 'transcode')
 OR (spec->'estimated_output_bytes' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(spec->'estimated_output_bytes') IS DISTINCT FROM 'number' OR NOT (spec->>'estimated_output_bytes' ~ '^[0-9]+$') OR (spec->>'estimated_output_bytes')::numeric NOT BETWEEN 1 AND 9223372036854775807))
 OR jsonb_typeof(spec->'root') IS DISTINCT FROM 'string' OR jsonb_typeof(spec->'resource') IS DISTINCT FROM 'string'
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(spec) k WHERE k NOT IN ('kind','owned_http_response_version','root','resource','source_kind','input_ticket','start_seconds','transcode','audio_index','estimated_output_bytes','negotiated_mode','source_version')) THEN RETURN false; END IF;
 IF NOT (spec ?& ARRAY['kind','owned_http_response_version','root','resource','source_kind','input_ticket','start_seconds','transcode','audio_index','estimated_output_bytes','negotiated_mode','source_version']) THEN RETURN false; END IF;
 IF spec->'audio_index' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(spec->'audio_index') IS DISTINCT FROM 'number' OR NOT (spec->>'audio_index' ~ '^[0-9]+$') OR (spec->>'audio_index')::numeric>4294967295) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION owned_http_job_allowed(job uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM media_jobs j JOIN owned_http_representations h ON h.session_id=j.session_id
 JOIN playback_sessions p ON p.id=h.session_id WHERE j.id=$1 AND j.id=j.session_id
 AND j.logical_queue='owned_http_v1' AND h.state='ready' AND j.spec=h.frozen_spec
 AND owned_http_job_spec_valid(j.spec) AND p.expires_at<=h.expires_at
 AND owned_http_representation_authority_allowed(h.session_id))
$$;
CREATE FUNCTION protect_owned_http_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT owned_http_job_spec_valid(NEW.spec) OR NOT EXISTS(SELECT 1 FROM owned_http_representations h
    WHERE h.session_id=NEW.session_id AND h.state='ready' AND h.frozen_spec=NEW.spec
    AND owned_http_representation_authority_allowed(h.session_id)) THEN RAISE EXCEPTION 'owned_http_job_invalid'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.session_id,NEW.logical_queue,NEW.spec) IS DISTINCT FROM ROW(OLD.id,OLD.session_id,OLD.logical_queue,OLD.spec)
    THEN RAISE EXCEPTION 'owned_http_job_frozen'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER owned_http_job_insert BEFORE INSERT ON media_jobs FOR EACH ROW WHEN (NEW.logical_queue='owned_http_v1') EXECUTE FUNCTION protect_owned_http_job();
CREATE TRIGGER owned_http_job_update BEFORE UPDATE ON media_jobs FOR EACH ROW WHEN (OLD.logical_queue='owned_http_v1' OR NEW.logical_queue='owned_http_v1') EXECUTE FUNCTION protect_owned_http_job();

-- Retain static/child predicates verbatim and exclude only the new queue.
DROP TRIGGER static_hls_job_guard_insert ON media_jobs;
DROP TRIGGER static_hls_job_guard ON media_jobs;
DROP TRIGGER static_hls_job_guard_delete ON media_jobs;
CREATE TRIGGER static_hls_job_guard_insert BEFORE INSERT ON media_jobs
    FOR EACH ROW WHEN (NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND NEW.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_owned_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_owned_hls_ladder_v1'
        AND NEW.logical_queue IS DISTINCT FROM 'owned_http_v1'
        AND NOT static_hls_is_child_session(NEW.session_id) AND NOT static_hls_child_identity_reserved(NEW.id)
        AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard BEFORE UPDATE ON media_jobs
    FOR EACH ROW WHEN (OLD.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_local_v1'
        AND OLD.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_owned_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_owned_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND NEW.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_owned_v1' AND NEW.logical_queue IS DISTINCT FROM 'advanced_owned_hls_ladder_v1'
        AND OLD.logical_queue IS DISTINCT FROM 'owned_http_v1' AND NEW.logical_queue IS DISTINCT FROM 'owned_http_v1'
        AND NOT static_hls_is_child_session(OLD.session_id)
        AND NOT static_hls_is_child_session(NEW.session_id)
        AND NOT static_hls_child_identity_reserved(OLD.id) AND NOT static_hls_child_identity_reserved(NEW.id)
        AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child' AND COALESCE(NEW.spec->>'kind','')<>'static_hls_child')
        EXECUTE FUNCTION protect_static_hls_job();
CREATE TRIGGER static_hls_job_guard_delete BEFORE DELETE ON media_jobs
    FOR EACH ROW WHEN (OLD.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND OLD.logical_queue IS DISTINCT FROM 'local_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' AND OLD.logical_queue IS DISTINCT FROM 'native_platform_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_hls_ladder_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_owned_v1' AND OLD.logical_queue IS DISTINCT FROM 'advanced_owned_hls_ladder_v1'
        AND OLD.logical_queue IS DISTINCT FROM 'owned_http_v1'
        AND NOT static_hls_is_child_session(OLD.session_id) AND NOT static_hls_child_identity_reserved(OLD.id)
        AND COALESCE(OLD.spec->>'kind','')<>'static_hls_child') EXECUTE FUNCTION protect_static_hls_job();


CREATE FUNCTION protect_owned_http_representation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.session_id,NEW.owner_id,NEW.runtime_id,NEW.request_owner_epoch,NEW.user_id,NEW.room_id,NEW.media_id,NEW.media_generation,NEW.lifecycle_epoch,NEW.login_hash,NEW.membership_epoch,NEW.source_id,NEW.source_revision,NEW.target_sha256,NEW.created_at,NEW.expires_at,NEW.viewer_id,NEW.plan_generation)
   IS DISTINCT FROM ROW(OLD.session_id,OLD.owner_id,OLD.runtime_id,OLD.request_owner_epoch,OLD.user_id,OLD.room_id,OLD.media_id,OLD.media_generation,OLD.lifecycle_epoch,OLD.login_hash,OLD.membership_epoch,OLD.source_id,OLD.source_revision,OLD.target_sha256,OLD.created_at,OLD.expires_at,OLD.viewer_id,OLD.plan_generation)
   OR (OLD.frozen_spec IS NOT NULL AND NEW.frozen_spec IS DISTINCT FROM OLD.frozen_spec)
   OR (OLD.state IN ('disposed','unknown') AND NEW IS DISTINCT FROM OLD)
   OR (OLD.state='retired' AND NEW.state NOT IN ('retired','disposed','unknown'))
   OR (OLD.state='ready' AND NEW.state='capturing')
   THEN RAISE EXCEPTION 'owned_http_representation_frozen'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER owned_http_representation_update BEFORE UPDATE ON owned_http_representations FOR EACH ROW EXECUTE FUNCTION protect_owned_http_representation();
