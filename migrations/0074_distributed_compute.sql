-- Opt-in NAS-local structured computation. Agent registration does not grant compute.
CREATE TABLE distributed_compute_policy (
 agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false,
 slots integer NOT NULL DEFAULT 1 CHECK(slots BETWEEN 1 AND 4),
 output_budget_bytes bigint NOT NULL DEFAULT 67108864 CHECK(output_budget_bytes BETWEEN 1048576 AND 1073741824),
 revision bigint NOT NULL DEFAULT 1
);
CREATE TABLE distributed_compute_nodes (
 agent_id uuid PRIMARY KEY REFERENCES distributed_compute_policy(agent_id) ON DELETE CASCADE,
 connection_id uuid NOT NULL,
 capabilities text[] NOT NULL CHECK(capabilities <@ ARRAY['remux_hls_v1','h264_480p_hls_v1']::text[]),
 heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 self_test jsonb NOT NULL CHECK(jsonb_typeof(self_test)='object')
);
CREATE TABLE distributed_compute_sources (
 media_id uuid PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
 agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
 source_version text NOT NULL CHECK(source_version ~ '^stat-v1:[0-9a-f]{64}$'),
 content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes bigint NOT NULL CHECK(size_bytes>0),
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX distributed_compute_replicas ON distributed_compute_sources(content_sha256,size_bytes,agent_id);
CREATE TABLE distributed_compute_jobs (
 id uuid PRIMARY KEY,
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id),
 login_hash text NOT NULL,
 membership_epoch uuid NOT NULL,
 media_id uuid NOT NULL REFERENCES media_items(id),
 media_generation bigint NOT NULL,
 lifecycle_epoch bigint NOT NULL,
 source_version text NOT NULL,
 source_revision bigint NOT NULL,
 library_id uuid NOT NULL REFERENCES private_libraries(id),
 library_permission_epoch bigint NOT NULL CHECK(library_permission_epoch>0),
 library_source_generation bigint NOT NULL CHECK(library_source_generation>0),
 content_sha256 text NOT NULL,
 source_bytes bigint NOT NULL,
 selected_video_index integer NOT NULL DEFAULT 0 CHECK(selected_video_index BETWEEN 0 AND 65535),
 selected_audio_index integer CHECK(selected_audio_index BETWEEN 0 AND 65535),
 qualification jsonb CHECK(qualification IS NULL OR jsonb_typeof(qualification)='object'),
 qualification_sha256 text CHECK(qualification_sha256 IS NULL OR qualification_sha256 ~ '^[0-9a-f]{64}$'),
 recipe text NOT NULL CHECK(recipe IN ('remux_hls_v1','h264_480p_hls_v1')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','ready','failed','cancelled')),
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 3),
 output_generation uuid,
 owner_agent uuid REFERENCES agents(id),
 owner_connection uuid,
 input_media_id uuid REFERENCES media_items(id),
 input_version text,
 lease_until timestamptz,
 output_budget_bytes bigint NOT NULL DEFAULT 67108864,
 error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 minutes'
);
-- Capture authority once in the database, including instance-shared origins.
-- Restoring an ACL or room share never makes an older compute request current.
CREATE FUNCTION stamp_distributed_compute_library() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding record;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.room_id,NEW.user_id,NEW.login_hash,NEW.membership_epoch,NEW.media_id,NEW.media_generation,NEW.lifecycle_epoch,NEW.source_version,NEW.source_revision,NEW.library_id,NEW.library_permission_epoch,NEW.library_source_generation,NEW.content_sha256,NEW.source_bytes,NEW.recipe,NEW.selected_video_index,NEW.selected_audio_index,NEW.expires_at)
   IS DISTINCT FROM ROW(OLD.room_id,OLD.user_id,OLD.login_hash,OLD.membership_epoch,OLD.media_id,OLD.media_generation,OLD.lifecycle_epoch,OLD.source_version,OLD.source_revision,OLD.library_id,OLD.library_permission_epoch,OLD.library_source_generation,OLD.content_sha256,OLD.source_bytes,OLD.recipe,OLD.selected_video_index,OLD.selected_audio_index,OLD.expires_at) THEN
   RAISE EXCEPTION 'distributed_compute_origin_immutable';
  END IF;
  IF OLD.status='ready' AND ROW(NEW.qualification,NEW.qualification_sha256,NEW.output_generation,NEW.attempt,NEW.owner_agent,NEW.owner_connection) IS DISTINCT FROM ROW(OLD.qualification,OLD.qualification_sha256,OLD.output_generation,OLD.attempt,OLD.owner_agent,OLD.owner_connection) THEN RAISE EXCEPTION 'distributed_compute_output_immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.library_id IS NOT NULL OR NEW.library_permission_epoch IS NOT NULL OR NEW.library_source_generation IS NOT NULL THEN RAISE EXCEPTION 'distributed_compute_library_database_assigned'; END IF;
 SELECT l.id,l.permission_epoch,m.library_source_generation INTO binding
 FROM media_items m JOIN sources s ON s.id=m.source_id JOIN private_libraries l ON l.id=s.library_id WHERE m.id=NEW.media_id FOR SHARE OF m,s,l;
 IF binding.id IS NULL OR NOT library_media_allowed(NEW.user_id,NEW.media_id,'play',NEW.room_id) OR NOT room_media_allowed(NEW.room_id,NEW.media_id) THEN RAISE EXCEPTION 'distributed_compute_library_denied'; END IF;
 NEW.library_id=binding.id;NEW.library_permission_epoch=binding.permission_epoch;NEW.library_source_generation=binding.library_source_generation;
 RETURN NEW;
END $$;
CREATE TRIGGER distributed_compute_library BEFORE INSERT OR UPDATE ON distributed_compute_jobs FOR EACH ROW EXECUTE FUNCTION stamp_distributed_compute_library();
CREATE INDEX distributed_compute_claim ON distributed_compute_jobs(status,lease_until);
CREATE TABLE distributed_compute_files (
 job_id uuid NOT NULL REFERENCES distributed_compute_jobs(id) ON DELETE CASCADE,
 output_generation uuid NOT NULL,
 name text NOT NULL CHECK(name ~ '^(index[.]m3u8|segment[0-9]{5}[.]ts)$'),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 8388608),
 PRIMARY KEY(job_id,output_generation,name)
);
CREATE FUNCTION distributed_compute_authorized(job uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM distributed_compute_jobs j JOIN rooms r ON r.id=j.room_id
 JOIN room_snapshots s ON s.room_id=r.id JOIN media_items m ON m.id=j.media_id JOIN sources src ON src.id=m.source_id
 JOIN agents a ON a.id=m.source_id JOIN private_libraries l ON l.id=j.library_id
 WHERE j.id=$1 AND j.expires_at>clock_timestamp() AND r.lifecycle='active' AND r.lifecycle_epoch=j.lifecycle_epoch
 AND s.state->>'media_id'=j.media_id::text AND (s.state->>'media_generation')::bigint=j.media_generation
 AND src.library_id=j.library_id AND l.permission_epoch=j.library_permission_epoch AND m.library_source_generation=j.library_source_generation
 AND m.available AND m.source_version=j.source_version AND src.access_policy_revision=j.source_revision
 AND NOT a.revoked AND playback_origin_allowed(j.user_id,j.room_id,j.login_hash,j.membership_epoch)
 AND source_account_policy_allowed(m.source_id,j.source_revision,NULL)
 AND library_media_allowed(j.user_id,j.media_id,'play',j.room_id) AND room_media_allowed(j.room_id,j.media_id))
$$;

-- Control ownership is independent from NAS compute ownership.
CREATE TABLE control_nodes (
 id uuid PRIMARY KEY,
 route_origin text NOT NULL CHECK(length(route_origin) BETWEEN 1 AND 512),
 heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE SEQUENCE room_fencing_tokens;
CREATE TABLE room_leases (
 room_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
 owner_node uuid NOT NULL REFERENCES control_nodes(id),
 fencing_token bigint NOT NULL UNIQUE DEFAULT nextval('room_fencing_tokens'),
 lease_until timestamptz NOT NULL
);
CREATE INDEX room_lease_owners ON room_leases(owner_node,lease_until);

-- Every exposed attempt retains its own cleanup obligation, including after takeover.
CREATE TABLE distributed_compute_attempts (
 job_id uuid NOT NULL REFERENCES distributed_compute_jobs(id),
 room_id uuid NOT NULL REFERENCES rooms(id),
 attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
 output_generation uuid NOT NULL UNIQUE,
 owner_agent uuid NOT NULL REFERENCES agents(id),
 owner_connection uuid NOT NULL,
 owner_token_hash text NOT NULL,
 process_disposition text CHECK(process_disposition IN('never_started','reaped')),
 process_reaped_at timestamptz,
 files_removed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(job_id,attempt),
 CHECK((process_disposition IS NULL AND process_reaped_at IS NULL AND files_removed_at IS NULL)
 OR (process_disposition IS NOT NULL AND process_reaped_at IS NOT NULL AND files_removed_at IS NOT NULL))
);
CREATE INDEX distributed_compute_pending_drain ON distributed_compute_attempts(room_id) WHERE process_reaped_at IS NULL OR files_removed_at IS NULL;
CREATE FUNCTION distributed_compute_room_drained(room uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM distributed_compute_attempts WHERE room_id=$1 AND (process_reaped_at IS NULL OR files_removed_at IS NULL))
$$;
