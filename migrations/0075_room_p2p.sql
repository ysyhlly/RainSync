-- Consent-scoped, short-lived room signaling; no public peer discovery.
CREATE TABLE room_p2p_peers (
 id uuid PRIMARY KEY,
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id),
 job_id uuid NOT NULL REFERENCES distributed_compute_jobs(id) ON DELETE CASCADE,
 output_generation uuid NOT NULL,
 login_hash text NOT NULL,
 membership_epoch uuid NOT NULL,
 library_id uuid NOT NULL REFERENCES private_libraries(id),
 library_permission_epoch bigint NOT NULL CHECK(library_permission_epoch>0),
 library_source_generation bigint NOT NULL CHECK(library_source_generation>0),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 seconds'
);
CREATE FUNCTION stamp_room_p2p_library() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding record;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.room_id,NEW.user_id,NEW.job_id,NEW.output_generation,NEW.login_hash,NEW.membership_epoch,NEW.library_id,NEW.library_permission_epoch,NEW.library_source_generation)
   IS DISTINCT FROM ROW(OLD.room_id,OLD.user_id,OLD.job_id,OLD.output_generation,OLD.login_hash,OLD.membership_epoch,OLD.library_id,OLD.library_permission_epoch,OLD.library_source_generation) THEN RAISE EXCEPTION 'room_p2p_origin_immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.library_id IS NOT NULL OR NEW.library_permission_epoch IS NOT NULL OR NEW.library_source_generation IS NOT NULL THEN RAISE EXCEPTION 'room_p2p_library_database_assigned'; END IF;
 SELECT j.library_id,j.library_permission_epoch,j.library_source_generation INTO binding FROM distributed_compute_jobs j WHERE j.id=NEW.job_id AND j.room_id=NEW.room_id AND j.output_generation=NEW.output_generation AND distributed_compute_authorized(j.id) AND library_media_allowed(NEW.user_id,j.media_id,'play',NEW.room_id) AND room_media_allowed(NEW.room_id,j.media_id) FOR SHARE OF j;
 IF binding.library_id IS NULL THEN RAISE EXCEPTION 'room_p2p_library_denied'; END IF;
 NEW.library_id=binding.library_id;NEW.library_permission_epoch=binding.library_permission_epoch;NEW.library_source_generation=binding.library_source_generation;
 RETURN NEW;
END $$;
CREATE TRIGGER room_p2p_library BEFORE INSERT OR UPDATE ON room_p2p_peers FOR EACH ROW EXECUTE FUNCTION stamp_room_p2p_library();
CREATE INDEX room_p2p_scope ON room_p2p_peers(room_id,job_id,output_generation,expires_at);
CREATE TABLE room_p2p_signals (
 sequence bigserial PRIMARY KEY,
 sender uuid NOT NULL REFERENCES room_p2p_peers(id) ON DELETE CASCADE,
 recipient uuid NOT NULL REFERENCES room_p2p_peers(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('offer','answer','ice')),
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=16384),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '20 seconds'
);
CREATE INDEX room_p2p_inbox ON room_p2p_signals(recipient,sequence);
CREATE FUNCTION room_p2p_peer_authorized(peer uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM room_p2p_peers p JOIN distributed_compute_jobs j ON j.id=p.job_id
 WHERE p.id=$1 AND p.expires_at>clock_timestamp() AND j.status='ready' AND j.output_generation=p.output_generation
 AND p.library_id=j.library_id AND p.library_permission_epoch=j.library_permission_epoch AND p.library_source_generation=j.library_source_generation
 AND distributed_compute_authorized(j.id) AND room_media_allowed(p.room_id,j.media_id) AND library_media_allowed(p.user_id,j.media_id,'play',p.room_id) AND playback_origin_allowed(p.user_id,p.room_id,p.login_hash,p.membership_epoch))
$$;
