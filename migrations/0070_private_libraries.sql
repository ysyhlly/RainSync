-- Explicit legacy scope: existing sources remain in the instance shared library.
CREATE TABLE private_libraries (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100),
 owner_id uuid REFERENCES users(id), visibility text NOT NULL CHECK(visibility IN('private','instance_shared')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), permission_epoch bigint NOT NULL DEFAULT 1 CHECK(permission_epoch>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((visibility='private' AND owner_id IS NOT NULL) OR (visibility='instance_shared' AND owner_id IS NULL))
);
CREATE UNIQUE INDEX private_libraries_instance_shared ON private_libraries(visibility) WHERE visibility='instance_shared';
INSERT INTO private_libraries(id,name,visibility) VALUES('00000000-0000-0000-0000-000000000001','实例共享库','instance_shared');
ALTER TABLE sources ADD COLUMN library_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES private_libraries(id);
CREATE INDEX sources_library ON sources(library_id);
ALTER TABLE media_items ADD COLUMN library_source_generation bigint NOT NULL DEFAULT 1 CHECK(library_source_generation>0), ADD COLUMN library_source_identity text;
UPDATE media_items SET library_source_identity=COALESCE(source_version,
 CASE WHEN COALESCE(metadata->>'capability_source_version',metadata->>'preview_file_version') ~ '^stat-v1:[0-9a-f]{64}$' THEN COALESCE(metadata->>'capability_source_version',metadata->>'preview_file_version') END);
-- Presentation/probe metadata and preview recipes are not content authority.
CREATE FUNCTION advance_library_media_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity text;
BEGIN
 identity=COALESCE(NEW.source_version,
  CASE WHEN COALESCE(NEW.metadata->>'capability_source_version',NEW.metadata->>'preview_file_version') ~ '^stat-v1:[0-9a-f]{64}$' THEN COALESCE(NEW.metadata->>'capability_source_version',NEW.metadata->>'preview_file_version') END);
 NEW.library_source_identity=COALESCE(identity,CASE WHEN TG_OP='UPDATE' THEN OLD.library_source_identity END);
 IF TG_OP='INSERT' THEN RETURN NEW; END IF;
 IF ROW(NEW.source_id,NEW.resource,NEW.source_version,NEW.available) IS DISTINCT FROM ROW(OLD.source_id,OLD.resource,OLD.source_version,OLD.available) OR (OLD.library_source_identity IS NOT NULL AND NEW.library_source_identity IS DISTINCT FROM OLD.library_source_identity) THEN
  NEW.library_source_generation=OLD.library_source_generation+1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER library_media_identity BEFORE INSERT OR UPDATE ON media_items FOR EACH ROW EXECUTE FUNCTION advance_library_media_identity();
CREATE FUNCTION advance_library_source_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.config_encrypted IS DISTINCT FROM OLD.config_encrypted OR NEW.kind IS DISTINCT FROM OLD.kind THEN
  UPDATE media_items SET library_source_generation=library_source_generation+1 WHERE source_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER library_source_configuration AFTER UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION advance_library_source_configuration();

CREATE TABLE library_grants (
 library_id uuid NOT NULL REFERENCES private_libraries(id), user_id uuid NOT NULL REFERENCES users(id),
 browse boolean NOT NULL DEFAULT false, play boolean NOT NULL DEFAULT false, share_to_room boolean NOT NULL DEFAULT false,
 manage boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
 PRIMARY KEY(library_id,user_id), CHECK(browse OR play OR share_to_room OR manage), CHECK(NOT share_to_room OR play)
);
CREATE TABLE room_media_grants (
 id uuid PRIMARY KEY, library_id uuid NOT NULL REFERENCES private_libraries(id), media_id uuid NOT NULL REFERENCES media_items(id),
 source_generation bigint NOT NULL CHECK(source_generation>0), room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 grantor_id uuid NOT NULL REFERENCES users(id), mode text NOT NULL CHECK(mode IN('room_members','library_members')),
 permission_epoch bigint NOT NULL CHECK(permission_epoch>0), expires_at timestamptz NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(expires_at<=created_at+interval '24 hours')
);
CREATE INDEX room_media_grants_scope ON room_media_grants(room_id,media_id,permission_epoch) WHERE revoked_at IS NULL;
CREATE TABLE library_permission_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), library_id uuid NOT NULL REFERENCES private_libraries(id),
 actor_id uuid REFERENCES users(id), action text NOT NULL CHECK(char_length(action) BETWEEN 1 AND 80),
 target_id uuid, permission_epoch bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX library_permission_audit_recent ON library_permission_audit(library_id,created_at DESC);
INSERT INTO library_permission_audit(library_id,action,permission_epoch) VALUES('00000000-0000-0000-0000-000000000001','legacy_sources_migrated_without_scope_expansion',1);

CREATE FUNCTION library_allowed(principal uuid,library uuid,action text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM private_libraries l WHERE l.id=$2 AND $3 IN('browse','play','share_to_room','manage') AND EXISTS(SELECT 1 FROM users principal WHERE principal.id=$1) AND (
  (l.visibility='instance_shared' AND ($3 IN('browse','play','share_to_room') OR ($3='manage' AND EXISTS(SELECT 1 FROM users u WHERE u.id=$1 AND u.admin))))
  OR (l.visibility='private' AND (l.owner_id=$1 OR EXISTS(SELECT 1 FROM library_grants g WHERE g.library_id=l.id AND g.user_id=$1 AND g.expires_at>clock_timestamp() AND
   CASE $3 WHEN 'browse' THEN g.browse WHEN 'play' THEN g.play WHEN 'share_to_room' THEN g.share_to_room WHEN 'manage' THEN g.manage ELSE false END)))))
$$;
CREATE FUNCTION library_room_media_allowed(principal uuid,media uuid,room uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM room_media_grants g JOIN private_libraries l ON l.id=g.library_id
 JOIN media_items m ON m.id=g.media_id JOIN sources s ON s.id=m.source_id
 WHERE g.media_id=$2 AND g.room_id=$3 AND g.library_id=s.library_id AND g.permission_epoch=l.permission_epoch
 AND g.source_generation=m.library_source_generation AND m.available AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
 AND library_allowed(g.grantor_id,l.id,'share_to_room')
 AND EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=g.room_id AND rm.user_id=$1)
 AND (g.mode='room_members' OR library_allowed($1,l.id,'play')))
$$;
CREATE FUNCTION library_media_allowed(principal uuid,media uuid,action text,room uuid DEFAULT NULL) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$2 AND m.available
 AND (s.kind<>'agent' OR EXISTS(SELECT 1 FROM agents a WHERE a.id=s.id AND NOT a.revoked))
 AND (library_allowed($1,s.library_id,$3) OR ($3='play' AND $4 IS NOT NULL AND library_room_media_allowed($1,m.id,$4))))
 OR ($3='play' AND $4 IS NOT NULL AND EXISTS(SELECT 1 FROM room_platform_media e JOIN media_items m ON m.id=e.media_id
 WHERE e.media_id=$2 AND e.room_id=$4 AND m.available AND EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=$4 AND rm.user_id=$1)))
$$;

ALTER FUNCTION room_media_allowed(uuid,uuid) RENAME TO room_media_allowed_pre_library;
CREATE FUNCTION room_media_allowed(room uuid,media uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT room_media_allowed_pre_library($1,$2) AND (
 NOT EXISTS(SELECT 1 FROM media_items m JOIN sources s ON s.id=m.source_id JOIN private_libraries l ON l.id=s.library_id WHERE m.id=$2 AND l.visibility='private')
 OR EXISTS(SELECT 1 FROM room_media_grants g JOIN private_libraries l ON l.id=g.library_id
 JOIN media_items m ON m.id=g.media_id JOIN sources s ON s.id=m.source_id WHERE g.room_id=$1 AND g.media_id=$2
 AND g.library_id=s.library_id AND g.permission_epoch=l.permission_epoch AND g.source_generation=m.library_source_generation
 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND library_allowed(g.grantor_id,l.id,'share_to_room')))
$$;

-- Immutable per-session authorization stored apart from the frozen resource.
-- Exact static-HLS/advanced publication hashes and encrypted resources stay intact.
ALTER TABLE playback_sessions ADD COLUMN library_id uuid REFERENCES private_libraries(id),
 ADD COLUMN library_permission_epoch bigint, ADD COLUMN library_source_generation bigint;
ALTER TABLE playback_sessions ADD CONSTRAINT playback_library_binding_shape CHECK(
 (library_id IS NULL AND library_permission_epoch IS NULL AND library_source_generation IS NULL) OR
 (library_id IS NOT NULL AND library_permission_epoch>0 AND library_source_generation>0));
CREATE INDEX playback_sessions_library ON playback_sessions(library_id,library_permission_epoch) WHERE library_id IS NOT NULL;
CREATE FUNCTION stamp_library_playback_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lib record;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.library_id,NEW.library_permission_epoch,NEW.library_source_generation) IS DISTINCT FROM
     ROW(OLD.library_id,OLD.library_permission_epoch,OLD.library_source_generation) THEN RAISE EXCEPTION 'private_playback_binding_immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.library_id IS NOT NULL OR NEW.library_permission_epoch IS NOT NULL OR NEW.library_source_generation IS NOT NULL THEN
  RAISE EXCEPTION 'private_playback_binding_database_assigned';
 END IF;
 SELECT l.*,m.library_source_generation AS source_generation INTO lib
 FROM media_items m JOIN sources s ON s.id=m.source_id JOIN private_libraries l ON l.id=s.library_id WHERE m.id=NEW.media_id;
 IF lib.id IS NULL OR lib.visibility<>'private' THEN RETURN NEW; END IF;
 IF NOT playback_library_request_allowed(NEW.id) OR NOT library_media_allowed(NEW.user_id,NEW.media_id,'play',NEW.room_id) OR NOT room_media_allowed(NEW.room_id,NEW.media_id) THEN
  RAISE EXCEPTION 'private_media_not_authorized';
 END IF;
 NEW.library_id=lib.id;NEW.library_permission_epoch=lib.permission_epoch;NEW.library_source_generation=lib.source_generation;
 RETURN NEW;
END $$;
CREATE TRIGGER a_library_playback_context BEFORE INSERT OR UPDATE ON playback_sessions FOR EACH ROW EXECUTE FUNCTION stamp_library_playback_context();

CREATE FUNCTION playback_library_allowed(media uuid,resource jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM media_items m JOIN sources s ON s.id=m.source_id JOIN private_libraries l ON l.id=s.library_id WHERE m.id=$1 AND l.visibility='private')
 OR EXISTS(SELECT 1 FROM playback_sessions p JOIN media_items m ON m.id=p.media_id JOIN sources s ON s.id=m.source_id
 JOIN private_libraries l ON l.id=s.library_id WHERE p.media_id=$1 AND p.resource=$2 AND p.library_id=l.id
 AND p.library_permission_epoch=l.permission_epoch AND p.library_source_generation=m.library_source_generation
 AND NOT p.stopped AND p.expires_at>clock_timestamp() AND p.auth_login_hash IS NOT NULL
 AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch)
 AND library_media_allowed(p.user_id,p.media_id,'play',p.room_id) AND room_media_allowed(p.room_id,p.media_id))
$$;
ALTER FUNCTION playback_source_allowed(uuid,jsonb) RENAME TO playback_source_allowed_pre_library;
CREATE FUNCTION playback_source_allowed(media uuid,resource jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT playback_library_allowed($1,$2) AND playback_source_allowed_pre_library($1,$2)
$$;

-- Source reassignment fences all previous grants without changing source bytes.
CREATE FUNCTION fence_library_source_move() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.library_id IS DISTINCT FROM OLD.library_id THEN
  -- Existing source revision trigger permits explicit config changes only.
  -- Library contexts and preview_generation independently fence the reassignment.
  UPDATE media_items SET preview_generation=preview_generation+1,library_source_generation=library_source_generation+1 WHERE source_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_library_source_move BEFORE UPDATE OF library_id ON sources FOR EACH ROW EXECUTE FUNCTION fence_library_source_move();

-- Moving a source is an authority change, independent of credential bytes.
CREATE OR REPLACE FUNCTION fence_source_access_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.config_encrypted IS DISTINCT FROM OLD.config_encrypted OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.library_id IS DISTINCT FROM OLD.library_id THEN
  IF OLD.access_policy_revision=9223372036854775807 THEN RAISE EXCEPTION 'source policy revision exhausted'; END IF;
  IF NEW.access_policy_revision=OLD.access_policy_revision THEN NEW.access_policy_revision=OLD.access_policy_revision+1;
  ELSIF NEW.access_policy_revision<>OLD.access_policy_revision+1 THEN RAISE EXCEPTION 'invalid source policy revision'; END IF;
 ELSIF NEW.access_policy_revision<>OLD.access_policy_revision THEN RAISE EXCEPTION 'source policy revision without configuration change';
 END IF;
 RETURN NEW;
END $$;

-- Exact session identity is authoritative. Resource JSON is intentionally not a
-- unique session identifier (same-login native resources can be identical).
CREATE FUNCTION playback_library_session_allowed(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=$1 AND (
  (p.library_id IS NULL AND NOT EXISTS(SELECT 1 FROM media_items m JOIN sources s ON s.id=m.source_id JOIN private_libraries l ON l.id=s.library_id WHERE m.id=p.media_id AND l.visibility='private'))
  OR EXISTS(SELECT 1 FROM media_items m JOIN sources s ON s.id=m.source_id JOIN private_libraries l ON l.id=s.library_id
   WHERE m.id=p.media_id AND p.library_id=l.id AND p.library_permission_epoch=l.permission_epoch
   AND p.library_source_generation=m.library_source_generation AND NOT p.stopped AND p.expires_at>clock_timestamp()
   AND p.auth_login_hash IS NOT NULL AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch)
   AND library_media_allowed(p.user_id,p.media_id,'play',p.room_id) AND room_media_allowed(p.room_id,p.media_id))))
$$;
-- Conservative resource-only callers cannot borrow one valid session to lift an
-- invalid active session. All actual byte/job/grant readers additionally use ID.
CREATE OR REPLACE FUNCTION playback_library_allowed(media uuid,resource jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM media_items m JOIN sources s ON s.id=m.source_id JOIN private_libraries l ON l.id=s.library_id WHERE m.id=$1 AND l.visibility='private')
 OR (EXISTS(SELECT 1 FROM playback_sessions p WHERE p.media_id=$1 AND p.resource=$2 AND playback_library_session_allowed(p.id))
 AND NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.media_id=$1 AND p.resource=$2 AND NOT p.stopped AND p.expires_at>clock_timestamp() AND NOT playback_library_session_allowed(p.id)))
$$;

-- Pending static-HLS has no playback session yet. Its original request gets an
-- independent immutable epoch/media/version binding before any source I/O.
ALTER TABLE playback_requests ADD COLUMN library_id uuid REFERENCES private_libraries(id),
 ADD COLUMN library_permission_epoch bigint, ADD COLUMN library_source_generation bigint,
 ADD COLUMN library_media_id uuid REFERENCES media_items(id);
ALTER TABLE playback_requests ADD CONSTRAINT playback_request_library_shape CHECK(
 (library_id IS NULL AND library_permission_epoch IS NULL AND library_source_generation IS NULL AND library_media_id IS NULL)
 OR (library_id IS NOT NULL AND library_permission_epoch>0 AND library_source_generation>0 AND library_media_id IS NOT NULL));
CREATE FUNCTION stamp_library_request_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding record;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.library_id,NEW.library_permission_epoch,NEW.library_source_generation,NEW.library_media_id) IS DISTINCT FROM
     ROW(OLD.library_id,OLD.library_permission_epoch,OLD.library_source_generation,OLD.library_media_id) THEN RAISE EXCEPTION 'private_request_binding_immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.library_id IS NOT NULL OR NEW.library_permission_epoch IS NOT NULL OR NEW.library_source_generation IS NOT NULL OR NEW.library_media_id IS NOT NULL THEN RAISE EXCEPTION 'private_request_binding_database_assigned'; END IF;
 SELECT l.id,l.permission_epoch,m.id AS media_id,m.library_source_generation INTO binding
 FROM room_snapshots snap JOIN media_items m ON m.id=(snap.state->>'media_id')::uuid
 JOIN sources s ON s.id=m.source_id JOIN private_libraries l ON l.id=s.library_id
 WHERE snap.room_id=NEW.room_id AND l.visibility='private';
 IF binding.id IS NULL THEN RETURN NEW; END IF;
 IF NOT library_media_allowed(NEW.user_id,binding.media_id,'play',NEW.room_id) OR NOT room_media_allowed(NEW.room_id,binding.media_id) THEN RAISE EXCEPTION 'private_media_not_authorized'; END IF;
 NEW.library_id=binding.id;NEW.library_permission_epoch=binding.permission_epoch;NEW.library_source_generation=binding.library_source_generation;NEW.library_media_id=binding.media_id;
 RETURN NEW;
END $$;
CREATE TRIGGER a_library_request_context BEFORE INSERT OR UPDATE ON playback_requests FOR EACH ROW EXECUTE FUNCTION stamp_library_request_context();
CREATE FUNCTION playback_library_request_allowed(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM playback_requests request WHERE request.session_id=$1 AND (
  (request.library_id IS NULL AND NOT EXISTS(SELECT 1 FROM room_snapshots snap JOIN media_items m ON m.id=(snap.state->>'media_id')::uuid JOIN sources s ON s.id=m.source_id JOIN private_libraries l ON l.id=s.library_id WHERE snap.room_id=request.room_id AND l.visibility='private'))
  OR EXISTS(SELECT 1 FROM media_items m JOIN sources s ON s.id=m.source_id JOIN private_libraries l ON l.id=s.library_id
   JOIN room_snapshots snap ON snap.room_id=request.room_id WHERE m.id=request.library_media_id AND snap.state->>'media_id'=m.id::text
   AND l.id=request.library_id AND l.permission_epoch=request.library_permission_epoch AND m.library_source_generation=request.library_source_generation
   AND playback_origin_allowed(request.user_id,request.room_id,request.auth_login_hash,request.auth_membership_epoch)
   AND library_media_allowed(request.user_id,m.id,'play',request.room_id) AND room_media_allowed(request.room_id,m.id))))
$$;

-- Direct authority helpers deliberately bypass the generic source gate for
-- recursive static/owned representation proofs; they must fence libraries here.
ALTER FUNCTION static_hls_parent_authority_allowed(uuid) RENAME TO static_hls_parent_authority_allowed_pre_library;
CREATE FUNCTION static_hls_parent_authority_allowed(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT playback_library_session_allowed($1) AND static_hls_parent_authority_allowed_pre_library($1) $$;
ALTER FUNCTION static_hls_session_authority_allowed(uuid) RENAME TO static_hls_session_authority_allowed_pre_library;
CREATE FUNCTION static_hls_session_authority_allowed(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT playback_library_session_allowed($1) AND static_hls_session_authority_allowed_pre_library($1) $$;
ALTER FUNCTION static_hls_capture_authority_allowed(uuid) RENAME TO static_hls_capture_authority_allowed_pre_library;
CREATE FUNCTION static_hls_capture_authority_allowed(capture uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT EXISTS(SELECT 1 FROM static_hls_captures c WHERE c.id=$1 AND playback_library_session_allowed(c.session_id)) AND static_hls_capture_authority_allowed_pre_library($1) $$;
ALTER FUNCTION static_hls_published_parent_authority_allowed(uuid) RENAME TO static_hls_published_parent_authority_allowed_pre_library;
CREATE FUNCTION static_hls_published_parent_authority_allowed(capture uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT EXISTS(SELECT 1 FROM static_hls_captures c WHERE c.id=$1 AND playback_library_session_allowed(c.session_id)) AND static_hls_published_parent_authority_allowed_pre_library($1) $$;
ALTER FUNCTION static_hls_pending_request_authority_allowed(uuid) RENAME TO static_hls_pending_request_authority_allowed_pre_library;
CREATE FUNCTION static_hls_pending_request_authority_allowed(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT playback_library_request_allowed($1) AND static_hls_pending_request_authority_allowed_pre_library($1) $$;
ALTER FUNCTION static_hls_pending_capture_authority_allowed(uuid) RENAME TO static_hls_pending_capture_authority_allowed_pre_library;
CREATE FUNCTION static_hls_pending_capture_authority_allowed(capture uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT EXISTS(SELECT 1 FROM static_hls_captures c WHERE c.id=$1 AND playback_library_request_allowed(c.session_id)) AND static_hls_pending_capture_authority_allowed_pre_library($1) $$;
ALTER FUNCTION static_hls_pending_child_request_authority_allowed(uuid) RENAME TO static_hls_pending_child_request_authority_allowed_pre_library;
CREATE FUNCTION static_hls_pending_child_request_authority_allowed(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT playback_library_request_allowed($1) AND static_hls_pending_child_request_authority_allowed_pre_library($1) $$;
ALTER FUNCTION static_hls_pending_child_capture_authority_allowed(uuid) RENAME TO static_hls_pending_child_capture_authority_allowed_pre_library;
CREATE FUNCTION static_hls_pending_child_capture_authority_allowed(capture uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT EXISTS(SELECT 1 FROM static_hls_captures c WHERE c.id=$1 AND playback_library_request_allowed(c.session_id)) AND static_hls_pending_child_capture_authority_allowed_pre_library($1) $$;
ALTER FUNCTION static_hls_pending_child_publication_authority_allowed(uuid) RENAME TO sh_pending_child_publish_pre_library;
CREATE FUNCTION static_hls_pending_child_publication_authority_allowed(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT playback_library_request_allowed($1) AND sh_pending_child_publish_pre_library($1) $$;
ALTER FUNCTION static_hls_child_grant_authority_allowed(uuid) RENAME TO static_hls_child_grant_authority_allowed_pre_library;
CREATE FUNCTION static_hls_child_grant_authority_allowed(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT playback_library_session_allowed($1) AND static_hls_child_grant_authority_allowed_pre_library($1) $$;
ALTER FUNCTION static_hls_published_child_capture_authority_allowed(uuid) RENAME TO sh_published_child_capture_pre_library;
CREATE FUNCTION static_hls_published_child_capture_authority_allowed(capture uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT EXISTS(SELECT 1 FROM static_hls_captures c WHERE c.id=$1 AND playback_library_session_allowed(c.session_id)) AND sh_published_child_capture_pre_library($1) $$;
ALTER FUNCTION static_hls_child_queue_authority_allowed(uuid) RENAME TO static_hls_child_queue_authority_allowed_pre_library;
CREATE FUNCTION static_hls_child_queue_authority_allowed(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT playback_library_session_allowed($1) AND static_hls_child_queue_authority_allowed_pre_library($1) $$;
ALTER FUNCTION static_hls_child_output_authority_allowed(uuid) RENAME TO static_hls_child_output_authority_allowed_pre_library;
CREATE FUNCTION static_hls_child_output_authority_allowed(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT playback_library_session_allowed($1) AND static_hls_child_output_authority_allowed_pre_library($1) $$;
ALTER FUNCTION owned_http_representation_authority_allowed(uuid) RENAME TO owned_http_representation_authority_allowed_pre_library;
CREATE FUNCTION owned_http_representation_authority_allowed(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT playback_library_session_allowed($1) AND owned_http_representation_authority_allowed_pre_library($1) $$;
ALTER FUNCTION local_hls_ladder_session_allowed(uuid) RENAME TO local_hls_ladder_session_allowed_pre_library;
CREATE FUNCTION local_hls_ladder_session_allowed(session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT playback_library_session_allowed($1) AND local_hls_ladder_session_allowed_pre_library($1) $$;
ALTER FUNCTION advanced_media_job_allowed(uuid) RENAME TO advanced_media_job_allowed_pre_library;
CREATE FUNCTION advanced_media_job_allowed(job uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=$1 AND playback_library_session_allowed(j.session_id)) AND advanced_media_job_allowed_pre_library($1) $$;
ALTER FUNCTION hls_ladder_job_allowed(uuid) RENAME TO hls_ladder_job_allowed_pre_library;
CREATE FUNCTION hls_ladder_job_allowed(job uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=$1 AND playback_library_session_allowed(j.session_id)) AND hls_ladder_job_allowed_pre_library($1) $$;
ALTER FUNCTION remote_asset_job_allowed(uuid) RENAME TO remote_asset_job_allowed_pre_library;
CREATE FUNCTION remote_asset_job_allowed(job uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=$1 AND playback_library_session_allowed(j.session_id)) AND remote_asset_job_allowed_pre_library($1) $$;

-- Unscoped resource-only reads are legacy shared-library checks. Private media
-- requires an exact session ID; identical JSON never supplies that identity.
CREATE OR REPLACE FUNCTION playback_library_allowed(media uuid,resource jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM media_items m JOIN sources s ON s.id=m.source_id JOIN private_libraries l ON l.id=s.library_id WHERE m.id=$1 AND l.visibility='private')
$$;
CREATE OR REPLACE FUNCTION playback_source_allowed(media uuid,resource jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT playback_library_allowed($1,$2) AND playback_source_allowed_pre_library($1,$2)
$$;
CREATE FUNCTION playback_source_allowed(media uuid,resource jsonb,session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=$3 AND p.media_id=$1 AND p.resource=$2)
 AND playback_library_session_allowed($3) AND playback_source_allowed_pre_library($1,$2)
$$;
-- Upgrade source checks embedded in earlier SQL helper definitions without
-- editing historical migrations or relaxing any of their existing predicates.
DO $$
DECLARE helper record; definition text; updated text;
BEGIN
 FOR helper IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind='f' AND p.prosrc LIKE '%playback_source_allowed(%'
 LOOP
  definition=pg_get_functiondef(helper.oid);
  updated=regexp_replace(definition,
   'playback_source_allowed\(([[:alnum:]_]+)\.media_id,[[:space:]]*\1\.resource\)',
   'playback_source_allowed(\1.media_id,\1.resource,\1.id)','g');
  IF updated IS DISTINCT FROM definition THEN EXECUTE updated; END IF;
 END LOOP;
END $$;
