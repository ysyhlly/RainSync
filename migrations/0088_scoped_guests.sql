-- Guests are immutable credentialless principals, never reusable accounts.
ALTER TABLE users ADD COLUMN principal_kind text NOT NULL DEFAULT 'account'
 CHECK(principal_kind IN('account','guest'));
ALTER TABLE users ADD CONSTRAINT guest_credentials_absent CHECK(principal_kind<>'guest' OR (NOT admin AND password_hash='!'));
CREATE TABLE room_guest_access (
 room_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false,
 updated_by uuid NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE guest_principals (
 user_id uuid PRIMARY KEY REFERENCES users(id),
 room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
 login_hash text NOT NULL UNIQUE CHECK(login_hash ~ '^[0-9a-f]{64}$'),
 display_name text NOT NULL CHECK(char_length(display_name) BETWEEN 1 AND 50),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CHECK(expires_at<=created_at+interval '2 hours')
);
CREATE INDEX guest_principals_room ON guest_principals(room_id) WHERE revoked_at IS NULL;
CREATE INDEX guest_principals_expiry ON guest_principals(expires_at) WHERE revoked_at IS NULL;
CREATE FUNCTION guest_active(principal uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM guest_principals g JOIN users u ON u.id=g.user_id
 JOIN rooms r ON r.id=g.room_id JOIN room_guest_access a ON a.room_id=r.id
 WHERE g.user_id=$1 AND u.principal_kind='guest' AND NOT u.admin AND u.password_hash='!'
 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND r.lifecycle='active' AND a.enabled
 AND EXISTS(SELECT 1 FROM admin_settings WHERE singleton AND COALESCE(guests_enabled,false)))
$$;
CREATE FUNCTION guest_room_allowed(principal uuid,room uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT guest_active($1) AND EXISTS(SELECT 1 FROM guest_principals g JOIN room_members m ON m.user_id=g.user_id AND m.room_id=g.room_id WHERE g.user_id=$1 AND g.room_id=$2)
$$;
CREATE FUNCTION guest_current_media_allowed(principal uuid,room uuid,media uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT guest_room_allowed($1,$2) AND EXISTS(SELECT 1 FROM room_snapshots WHERE room_id=$2 AND state->>'media_id'=$3::text)
$$;
CREATE FUNCTION guest_is_account(principal uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT $1 IS NULL OR EXISTS(SELECT 1 FROM users WHERE id=$1 AND principal_kind='account')
$$;
CREATE FUNCTION protect_guest_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.principal_kind IS DISTINCT FROM OLD.principal_kind OR
 (OLD.principal_kind='guest' AND ROW(NEW.username,NEW.password_hash,NEW.admin) IS DISTINCT FROM ROW(OLD.username,OLD.password_hash,OLD.admin)) THEN
 RAISE EXCEPTION 'guest_restricted' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_kind_immutable BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION protect_guest_kind();
CREATE FUNCTION protect_guest_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'guest_restricted' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND principal_kind='guest') THEN RAISE EXCEPTION 'guest_restricted' USING ERRCODE='42501'; END IF;
 ELSIF ROW(NEW.user_id,NEW.login_hash,NEW.created_at) IS DISTINCT FROM ROW(OLD.user_id,OLD.login_hash,OLD.created_at)
 OR (NEW.room_id IS DISTINCT FROM OLD.room_id AND NEW.room_id IS NOT NULL)
 OR NEW.expires_at>OLD.expires_at OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
  RAISE EXCEPTION 'guest_restricted' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_identity_immutable BEFORE INSERT OR UPDATE OR DELETE ON guest_principals FOR EACH ROW EXECUTE FUNCTION protect_guest_identity();
CREATE FUNCTION guard_registered_principals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field text;
BEGIN
 FOREACH field IN ARRAY TG_ARGV LOOP
 IF NOT guest_is_account((to_jsonb(NEW)->>field)::uuid) THEN RAISE EXCEPTION 'guest_restricted' USING ERRCODE='42501'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_no_room_owner BEFORE INSERT OR UPDATE OF owner_id ON rooms FOR EACH ROW EXECUTE FUNCTION guard_registered_principals('owner_id');
CREATE TRIGGER guest_no_library_owner BEFORE INSERT OR UPDATE OF owner_id ON private_libraries FOR EACH ROW EXECUTE FUNCTION guard_registered_principals('owner_id');
CREATE TRIGGER guest_no_library_grant BEFORE INSERT OR UPDATE ON library_grants FOR EACH ROW EXECUTE FUNCTION guard_registered_principals('user_id','created_by');
CREATE TRIGGER guest_no_delegation BEFORE INSERT OR UPDATE ON room_member_permissions FOR EACH ROW EXECUTE FUNCTION guard_registered_principals('user_id','granted_by');
CREATE TRIGGER guest_no_invitation BEFORE INSERT OR UPDATE ON invites FOR EACH ROW EXECUTE FUNCTION guard_registered_principals('created_by','invited_user_id');
CREATE TRIGGER guest_no_profile BEFORE INSERT OR UPDATE ON user_profiles FOR EACH ROW EXECUTE FUNCTION guard_registered_principals('user_id');
CREATE TRIGGER guest_no_avatar BEFORE INSERT OR UPDATE ON user_avatars FOR EACH ROW EXECUTE FUNCTION guard_registered_principals('user_id');
CREATE TRIGGER guest_no_control_epoch BEFORE INSERT OR UPDATE ON control_epochs FOR EACH ROW EXECUTE FUNCTION guard_registered_principals('user_id');
CREATE TRIGGER guest_no_platform_account BEFORE INSERT OR UPDATE ON platform_accounts FOR EACH ROW EXECUTE FUNCTION guard_registered_principals('user_id');
CREATE TRIGGER guest_no_oauth_account BEFORE INSERT OR UPDATE ON platform_oauth_accounts FOR EACH ROW EXECUTE FUNCTION guard_registered_principals('user_id');
CREATE TRIGGER guest_no_p2p BEFORE INSERT OR UPDATE ON room_p2p_peers FOR EACH ROW EXECUTE FUNCTION guard_registered_principals('user_id');
CREATE FUNCTION guard_guest_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT guest_is_account(NEW.user_id) AND (NEW.chat_moderator OR NOT EXISTS(SELECT 1 FROM guest_principals WHERE user_id=NEW.user_id AND room_id=NEW.room_id AND revoked_at IS NULL AND expires_at>clock_timestamp()) OR NOT guest_active(NEW.user_id)) THEN
 RAISE EXCEPTION 'guest_restricted' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_membership_scope BEFORE INSERT OR UPDATE ON room_members FOR EACH ROW EXECUTE FUNCTION guard_guest_membership();
CREATE FUNCTION guard_guest_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT guest_is_account(NEW.user_id) AND (NOT guest_active(NEW.user_id) OR NOT EXISTS(SELECT 1 FROM guest_principals WHERE user_id=NEW.user_id AND login_hash=NEW.token_hash AND NEW.expires_at<=expires_at)) THEN
 RAISE EXCEPTION 'guest_restricted' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_session_scope BEFORE INSERT OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION guard_guest_session();
CREATE FUNCTION guard_guest_controller() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT guest_is_account((NEW.state->>'controller_user_id')::uuid) THEN RAISE EXCEPTION 'guest_restricted' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_no_controller BEFORE INSERT OR UPDATE ON room_snapshots FOR EACH ROW EXECUTE FUNCTION guard_guest_controller();
-- No off/on sequence resurrects authority. Physical membership cleanup stays
-- on the room owner node; immediate session deletion fences every byte reader.
CREATE FUNCTION revoke_room_guests(room uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM sessions s USING guest_principals g WHERE s.user_id=g.user_id AND g.room_id=$1;
 UPDATE guest_principals SET revoked_at=clock_timestamp(),display_name='游客' WHERE room_id=$1 AND revoked_at IS NULL;
END $$;
CREATE FUNCTION guest_policy_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='admin_settings' THEN
  IF TG_OP='DELETE' OR NOT COALESCE(NEW.guests_enabled,false) THEN
   DELETE FROM sessions WHERE user_id IN(SELECT user_id FROM guest_principals);
   UPDATE guest_principals SET revoked_at=clock_timestamp(),display_name='游客' WHERE revoked_at IS NULL;
  END IF;
 ELSIF TG_TABLE_NAME='room_guest_access' THEN
  IF TG_OP='DELETE' THEN PERFORM revoke_room_guests(OLD.room_id);
  ELSIF NOT NEW.enabled THEN PERFORM revoke_room_guests(NEW.room_id); END IF;
 ELSIF TG_TABLE_NAME='rooms' THEN
  IF TG_OP='DELETE' THEN PERFORM revoke_room_guests(OLD.id);
  ELSIF NEW.lifecycle<>'active' THEN PERFORM revoke_room_guests(NEW.id); END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER guest_global_revocation AFTER UPDATE OR DELETE ON admin_settings FOR EACH ROW EXECUTE FUNCTION guest_policy_changed();
CREATE TRIGGER guest_room_policy_revocation AFTER UPDATE OR DELETE ON room_guest_access FOR EACH ROW EXECUTE FUNCTION guest_policy_changed();
CREATE TRIGGER guest_room_close_revocation AFTER UPDATE OF lifecycle OR DELETE ON rooms FOR EACH ROW EXECUTE FUNCTION guest_policy_changed();
CREATE FUNCTION revoke_departing_guest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM sessions WHERE user_id=OLD.user_id AND NOT guest_is_account(OLD.user_id);
 UPDATE guest_principals SET revoked_at=COALESCE(revoked_at,clock_timestamp()),display_name='游客' WHERE user_id=OLD.user_id;
 RETURN NULL;
END $$;
CREATE TRIGGER guest_member_revocation AFTER DELETE ON room_members FOR EACH ROW EXECUTE FUNCTION revoke_departing_guest();
-- Logout also retires the identity, even if a stale cookie is later replayed.
CREATE FUNCTION revoke_guest_login() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE guest_principals SET revoked_at=COALESCE(revoked_at,clock_timestamp()),display_name='游客' WHERE user_id=OLD.user_id AND login_hash=OLD.token_hash;
 RETURN NULL;
END $$;
CREATE TRIGGER guest_login_revocation AFTER DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION revoke_guest_login();
ALTER FUNCTION account_active(uuid) RENAME TO account_active_before_guests;
CREATE FUNCTION account_active(principal uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT account_active_before_guests($1) AND (guest_is_account($1) OR guest_active($1))
$$;
ALTER FUNCTION playback_login_allowed(uuid,text) RENAME TO playback_login_allowed_before_guests;
CREATE FUNCTION playback_login_allowed(principal uuid,login text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT playback_login_allowed_before_guests($1,$2) AND (guest_is_account($1) OR (guest_active($1) AND EXISTS(SELECT 1 FROM guest_principals WHERE user_id=$1 AND login_hash=$2)))
$$;
ALTER FUNCTION playback_origin_allowed(uuid,uuid,text,uuid) RENAME TO playback_origin_allowed_before_guests;
CREATE FUNCTION playback_origin_allowed(principal uuid,room uuid,login text,membership uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT playback_origin_allowed_before_guests($1,$2,$3,$4) AND (guest_is_account($1) OR ($3 IS NOT NULL AND guest_room_allowed($1,$2)))
$$;
ALTER FUNCTION library_allowed(uuid,uuid,text) RENAME TO library_allowed_before_guests;
CREATE FUNCTION library_allowed(principal uuid,library uuid,action text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT guest_is_account($1) AND library_allowed_before_guests($1,$2,$3)
$$;
ALTER FUNCTION library_media_allowed(uuid,uuid,text,uuid) RENAME TO library_media_allowed_before_guests;
CREATE FUNCTION library_media_allowed(principal uuid,media uuid,action text,room uuid DEFAULT NULL) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT CASE WHEN guest_is_account($1) THEN library_media_allowed_before_guests($1,$2,$3,$4) ELSE
 $3='play' AND guest_current_media_allowed($1,$4,$2) AND room_media_allowed($4,$2) AND EXISTS(
 SELECT 1 FROM media_items m LEFT JOIN sources s ON s.id=m.source_id LEFT JOIN private_libraries l ON l.id=s.library_id
 WHERE m.id=$2 AND m.available AND s.deleted_at IS NULL AND l.deleted_at IS NULL
 AND (s.kind IS DISTINCT FROM 'agent' OR EXISTS(SELECT 1 FROM agents WHERE id=s.id AND NOT revoked))
 AND (l.visibility='instance_shared' OR library_room_media_allowed($1,$2,$4) OR
 (m.source_id IS NULL AND EXISTS(SELECT 1 FROM room_platform_media WHERE room_id=$4 AND media_id=$2)))) END
$$;
ALTER FUNCTION playback_source_allowed(uuid,jsonb) RENAME TO playback_source_allowed_before_guests;
CREATE FUNCTION playback_source_allowed(media uuid,resource jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT playback_source_allowed_before_guests($1,$2) AND
 (NOT($2 ? 'auth_context') OR guest_is_account(($2->'auth_context'->>'user_id')::uuid) OR
 library_media_allowed(($2->'auth_context'->>'user_id')::uuid,$1,'play',($2->'auth_context'->>'room_id')::uuid))
$$;
ALTER FUNCTION playback_source_allowed(uuid,jsonb,uuid) RENAME TO playback_source_allowed_before_guests;
CREATE FUNCTION playback_source_allowed(media uuid,resource jsonb,session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT playback_source_allowed_before_guests($1,$2,$3) AND EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=$3 AND
 (guest_is_account(p.user_id) OR library_media_allowed(p.user_id,$1,'play',p.room_id)))
$$;
-- Match room mutations' existing multi-node ownership fences.
CREATE TRIGGER control_owner_admission BEFORE INSERT OR UPDATE OR DELETE ON room_guest_access FOR EACH ROW EXECUTE FUNCTION control_cluster_guard_write();
CREATE CONSTRAINT TRIGGER control_owner_commit AFTER INSERT OR UPDATE OR DELETE ON room_guest_access DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION control_cluster_guard_write();
