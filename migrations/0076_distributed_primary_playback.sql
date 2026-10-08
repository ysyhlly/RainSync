-- Primary room playback binds the exact qualified NAS output to an ordinary
-- per-viewer playback session. The original room/source/login/library remain authority.
CREATE TABLE distributed_playback_bindings (
 session_id uuid PRIMARY KEY REFERENCES playback_sessions(id),
 job_id uuid NOT NULL REFERENCES distributed_compute_jobs(id),
 attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
 output_generation uuid NOT NULL,
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
 qualification_sha256 text NOT NULL CHECK(qualification_sha256 ~ '^[0-9a-f]{64}$'),
 duration_ms double precision NOT NULL CHECK(duration_ms>0 AND duration_ms<=86400000 AND duration_ms<='Infinity'::double precision),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX distributed_playback_output ON distributed_playback_bindings(job_id,output_generation);
CREATE FUNCTION distributed_playback_session_authorized(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM distributed_playback_bindings b JOIN playback_sessions p ON p.id=b.session_id
 JOIN distributed_compute_jobs j ON j.id=b.job_id JOIN distributed_compute_files f ON f.job_id=j.id AND f.output_generation=b.output_generation AND f.name='index.m3u8'
 JOIN room_snapshots snap ON snap.room_id=p.room_id JOIN rooms r ON r.id=p.room_id
 WHERE p.id=$1 AND NOT p.stopped AND p.expires_at>clock_timestamp() AND p.expires_at<=j.expires_at
 AND p.resource->'distributed_compute_version'='1'::jsonb AND p.resource->>'distributed_session_id'=p.id::text
 AND p.resource->>'distributed_job_id'=b.job_id::text AND p.resource->>'distributed_output_generation'=b.output_generation::text
 AND p.resource->>'distributed_attempt'=b.attempt::text AND p.resource->>'distributed_qualification_sha256'=b.qualification_sha256
 AND j.status='ready' AND j.attempt=b.attempt AND j.output_generation=b.output_generation
 AND j.qualification_sha256=b.qualification_sha256 AND j.qualification->'schema_version'='1'::jsonb
 AND j.qualification->'full_decode'='true'::jsonb AND f.sha256=b.manifest_sha256
 AND p.room_id=j.room_id AND p.media_id=j.media_id AND p.generation=j.media_generation AND p.lifecycle_epoch=j.lifecycle_epoch
 AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch AND snap.state->>'media_id'=p.media_id::text AND (snap.state->>'media_generation')::bigint=p.generation
 AND p.auth_login_hash IS NOT NULL AND p.auth_membership_epoch IS NOT NULL
 AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch)
 AND distributed_compute_authorized(j.id) AND playback_library_session_allowed(p.id)
 AND library_media_allowed(p.user_id,p.media_id,'play',p.room_id) AND room_media_allowed(p.room_id,p.media_id)
 AND p.viewer_id IS NOT NULL AND p.plan_generation>0 AND EXISTS(SELECT 1 FROM playback_viewer_plans v WHERE v.user_id=p.user_id AND v.room_id=p.room_id AND v.viewer_id=p.viewer_id AND v.plan_generation=p.plan_generation AND v.auth_login_hash=p.auth_login_hash))
$$;
CREATE FUNCTION protect_distributed_playback_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'distributed_playback_binding_immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM playback_sessions p JOIN distributed_compute_jobs j ON j.id=NEW.job_id
 JOIN distributed_compute_files f ON f.job_id=j.id AND f.output_generation=j.output_generation AND f.name='index.m3u8'
 WHERE p.id=NEW.session_id AND p.room_id=j.room_id AND p.media_id=j.media_id AND p.generation=j.media_generation
 AND p.lifecycle_epoch=j.lifecycle_epoch AND p.auth_login_hash IS NOT NULL AND p.viewer_id IS NOT NULL AND p.plan_generation>0
 AND p.resource->'distributed_compute_version'='1'::jsonb AND p.resource->>'distributed_session_id'=p.id::text
 AND p.resource->>'distributed_job_id'=j.id::text AND p.resource->>'distributed_attempt'=NEW.attempt::text
 AND p.resource->>'distributed_output_generation'=NEW.output_generation::text AND p.resource->>'distributed_qualification_sha256'=NEW.qualification_sha256
 AND j.status='ready' AND j.attempt=NEW.attempt AND j.output_generation=NEW.output_generation
 AND j.qualification_sha256=NEW.qualification_sha256 AND j.qualification->'schema_version'='1'::jsonb AND j.qualification->'full_decode'='true'::jsonb
 AND f.sha256=NEW.manifest_sha256 AND NOT p.stopped AND p.expires_at>clock_timestamp() AND p.expires_at<=j.expires_at
 AND distributed_compute_authorized(j.id) AND playback_library_session_allowed(p.id)
 AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch)
 AND library_media_allowed(p.user_id,p.media_id,'play',p.room_id) AND room_media_allowed(p.room_id,p.media_id)
 FOR SHARE OF p,j,f) THEN RAISE EXCEPTION 'distributed_playback_binding_denied'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER distributed_playback_binding BEFORE INSERT OR UPDATE ON distributed_playback_bindings FOR EACH ROW EXECUTE FUNCTION protect_distributed_playback_binding();
CREATE FUNCTION protect_distributed_playback_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.resource ? 'distributed_compute_version' THEN
  IF ROW(NEW.id,NEW.user_id,NEW.room_id,NEW.media_id,NEW.generation,NEW.lifecycle_epoch,NEW.resource,NEW.delivery_token_hash,NEW.viewer_id,NEW.plan_generation,NEW.auth_login_hash,NEW.auth_membership_epoch)
  IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.room_id,OLD.media_id,OLD.generation,OLD.lifecycle_epoch,OLD.resource,OLD.delivery_token_hash,OLD.viewer_id,OLD.plan_generation,OLD.auth_login_hash,OLD.auth_membership_epoch)
  OR NEW.expires_at>OLD.expires_at OR (OLD.stopped AND NOT NEW.stopped) THEN RAISE EXCEPTION 'distributed_playback_session_immutable'; END IF;
 ELSIF NEW.resource ? 'distributed_compute_version' THEN RAISE EXCEPTION 'distributed_playback_requires_fresh_session'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_distributed_playback_session BEFORE UPDATE ON playback_sessions FOR EACH ROW EXECUTE FUNCTION protect_distributed_playback_session();
ALTER FUNCTION playback_source_allowed(uuid,jsonb) RENAME TO playback_source_allowed_pre_distributed;
CREATE FUNCTION playback_source_allowed(media uuid,resource jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT CASE WHEN $2 ? 'distributed_compute_version' THEN
  playback_source_allowed_pre_distributed($1,$2) AND $2->'distributed_compute_version'='1'::jsonb AND EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id::text=$2->>'distributed_session_id' AND p.media_id=$1 AND p.resource=$2 AND distributed_playback_session_authorized(p.id))
 ELSE playback_source_allowed_pre_distributed($1,$2) END
$$;

ALTER FUNCTION playback_source_allowed(uuid,jsonb,uuid) RENAME TO playback_source_allowed_pre_distributed;
CREATE FUNCTION playback_source_allowed(media uuid,resource jsonb,session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT playback_source_allowed_pre_distributed($1,$2,$3) AND (NOT($2 ? 'distributed_compute_version') OR
  ($2->'distributed_compute_version'='1'::jsonb AND $2->>'distributed_session_id'=$3::text AND distributed_playback_session_authorized($3)))
$$;

-- Peer contributions are independently scoped to the exact current viewer plan.
-- Legacy output-only tickets cannot masquerade as primary session tickets.
ALTER TABLE room_p2p_peers ADD COLUMN playback_session_id uuid REFERENCES playback_sessions(id);
ALTER FUNCTION room_p2p_peer_authorized(uuid) RENAME TO room_p2p_peer_authorized_pre_primary;
CREATE FUNCTION room_p2p_peer_authorized(peer uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT room_p2p_peer_authorized_pre_primary($1) AND EXISTS(SELECT 1 FROM room_p2p_peers peer WHERE peer.id=$1 AND (peer.playback_session_id IS NULL OR EXISTS(
 SELECT 1 FROM playback_sessions p JOIN distributed_playback_bindings b ON b.session_id=p.id WHERE p.id=peer.playback_session_id AND p.user_id=peer.user_id AND p.room_id=peer.room_id
 AND p.auth_login_hash=peer.login_hash AND p.auth_membership_epoch=peer.membership_epoch AND b.job_id=peer.job_id AND b.output_generation=peer.output_generation AND distributed_playback_session_authorized(p.id))))
$$;
CREATE FUNCTION protect_primary_peer_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.playback_session_id IS DISTINCT FROM OLD.playback_session_id THEN RAISE EXCEPTION 'primary_peer_session_immutable'; END IF;
 ELSIF NEW.playback_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM playback_sessions p JOIN distributed_playback_bindings b ON b.session_id=p.id
 WHERE p.id=NEW.playback_session_id AND p.user_id=NEW.user_id AND p.room_id=NEW.room_id AND p.auth_login_hash=NEW.login_hash AND p.auth_membership_epoch=NEW.membership_epoch
 AND b.job_id=NEW.job_id AND b.output_generation=NEW.output_generation AND distributed_playback_session_authorized(p.id)) THEN RAISE EXCEPTION 'primary_peer_session_denied'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_primary_peer_session BEFORE INSERT OR UPDATE ON room_p2p_peers FOR EACH ROW EXECUTE FUNCTION protect_primary_peer_session();

-- Independent Server output qualification has its own positive process receipt.
-- NAS reaping, lease loss, missing PID and a new Server epoch cannot release it.
ALTER TABLE distributed_compute_attempts ADD COLUMN server_verification_id uuid,
 ADD COLUMN server_verification_owner_epoch uuid, ADD COLUMN server_verification_started_at timestamptz,
 ADD COLUMN server_verification_reaped_at timestamptz;
ALTER TABLE distributed_compute_attempts ADD CONSTRAINT distributed_server_verification_shape CHECK(
 (server_verification_id IS NULL AND server_verification_owner_epoch IS NULL AND server_verification_started_at IS NULL AND server_verification_reaped_at IS NULL)
 OR (server_verification_id IS NOT NULL AND server_verification_owner_epoch IS NOT NULL AND server_verification_started_at IS NOT NULL));
CREATE OR REPLACE FUNCTION distributed_compute_room_drained(room uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM distributed_compute_attempts WHERE room_id=$1 AND
 (process_reaped_at IS NULL OR files_removed_at IS NULL OR (server_verification_started_at IS NOT NULL AND server_verification_reaped_at IS NULL)))
$$;
