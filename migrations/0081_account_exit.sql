-- Retain an anonymous principal for shared history and audit foreign keys.
-- A tombstone can never authenticate or receive new ownership/authority.
CREATE TABLE account_exits (
 user_id uuid PRIMARY KEY REFERENCES users(id),
 exited_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION account_require_active(principal uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF principal IS NULL THEN RETURN; END IF;
 PERFORM id FROM users WHERE id=principal FOR SHARE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM account_exits WHERE user_id=principal) THEN
  RAISE EXCEPTION 'account_inactive' USING ERRCODE='42501';
 END IF;
END $$;

CREATE FUNCTION account_guard_principals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field text; principal uuid;
BEGIN
 FOREACH field IN ARRAY TG_ARGV LOOP
  principal=(to_jsonb(NEW)->>field)::uuid;
  PERFORM account_require_active(principal);
 END LOOP;
 RETURN NEW;
END $$;

CREATE TRIGGER account_session_active BEFORE INSERT OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION account_guard_principals('user_id');
CREATE TRIGGER account_room_owner_active BEFORE INSERT OR UPDATE OF owner_id ON rooms FOR EACH ROW EXECUTE FUNCTION account_guard_principals('owner_id');
CREATE TRIGGER account_member_active BEFORE INSERT ON room_members FOR EACH ROW EXECUTE FUNCTION account_guard_principals('user_id');
CREATE TRIGGER account_library_owner_active BEFORE INSERT OR UPDATE OF owner_id ON private_libraries FOR EACH ROW EXECUTE FUNCTION account_guard_principals('owner_id');
CREATE TRIGGER account_library_grant_active BEFORE INSERT OR UPDATE ON library_grants FOR EACH ROW EXECUTE FUNCTION account_guard_principals('user_id','created_by');
CREATE FUNCTION account_guard_room_permission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.revoked AND
  ROW(NEW.room_id,NEW.user_id,NEW.role,NEW.permissions,NEW.expires_at,NEW.granted_by) IS NOT DISTINCT FROM
  ROW(OLD.room_id,OLD.user_id,OLD.role,OLD.permissions,OLD.expires_at,OLD.granted_by) THEN RETURN NEW; END IF;
 PERFORM account_require_active(NEW.user_id);
 PERFORM account_require_active(NEW.granted_by);
 RETURN NEW;
END $$;
CREATE TRIGGER account_room_permission_active BEFORE INSERT OR UPDATE ON room_member_permissions FOR EACH ROW EXECUTE FUNCTION account_guard_room_permission();
CREATE TRIGGER account_invite_active BEFORE INSERT ON invites FOR EACH ROW EXECUTE FUNCTION account_guard_principals('created_by','invited_user_id');
CREATE TRIGGER account_profile_active BEFORE INSERT OR UPDATE ON user_profiles FOR EACH ROW EXECUTE FUNCTION account_guard_principals('user_id');
CREATE TRIGGER account_avatar_active BEFORE INSERT OR UPDATE ON user_avatars FOR EACH ROW EXECUTE FUNCTION account_guard_principals('user_id');
CREATE TRIGGER account_playback_active BEFORE INSERT ON playback_sessions FOR EACH ROW EXECUTE FUNCTION account_guard_principals('user_id');
CREATE TRIGGER account_request_active BEFORE INSERT ON playback_requests FOR EACH ROW EXECUTE FUNCTION account_guard_principals('user_id');
CREATE TRIGGER account_control_active BEFORE INSERT ON control_epochs FOR EACH ROW EXECUTE FUNCTION account_guard_principals('user_id');
CREATE TRIGGER account_chat_active BEFORE INSERT ON chat_messages FOR EACH ROW EXECUTE FUNCTION account_guard_principals('user_id');
CREATE TRIGGER account_peer_active BEFORE INSERT ON room_p2p_peers FOR EACH ROW EXECUTE FUNCTION account_guard_principals('user_id');
CREATE TRIGGER account_platform_login_active BEFORE INSERT ON platform_login_requests FOR EACH ROW EXECUTE FUNCTION account_guard_principals('user_id');
CREATE TRIGGER account_oauth_login_active BEFORE INSERT ON platform_oauth_requests FOR EACH ROW EXECUTE FUNCTION account_guard_principals('user_id');

CREATE FUNCTION account_guard_platform_credentials() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.state<>'revoked' THEN PERFORM account_require_active(NEW.user_id); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_platform_active BEFORE INSERT OR UPDATE ON platform_accounts FOR EACH ROW EXECUTE FUNCTION account_guard_platform_credentials();
CREATE TRIGGER account_oauth_active BEFORE INSERT OR UPDATE ON platform_oauth_accounts FOR EACH ROW EXECUTE FUNCTION account_guard_platform_credentials();

CREATE FUNCTION account_preserve_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM account_exits WHERE user_id=OLD.id) AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'account_inactive' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_tombstone_immutable BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION account_preserve_tombstone();

CREATE FUNCTION account_preserve_profile_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM account_exits WHERE user_id=OLD.user_id) THEN
  RAISE EXCEPTION 'account_inactive' USING ERRCODE='42501';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER account_profile_tombstone BEFORE DELETE ON user_profiles FOR EACH ROW EXECUTE FUNCTION account_preserve_profile_tombstone();
CREATE TRIGGER account_compute_active BEFORE INSERT ON distributed_compute_jobs FOR EACH ROW EXECUTE FUNCTION account_guard_principals('user_id');
CREATE TRIGGER account_registration_batch_active BEFORE INSERT ON registration_invite_batches FOR EACH ROW EXECUTE FUNCTION account_guard_principals('created_by');

CREATE FUNCTION account_guard_registration_invite() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE principal uuid;
BEGIN
 SELECT created_by INTO principal FROM registration_invite_batches WHERE id=NEW.batch_id;
 PERFORM account_require_active(principal);
 RETURN NEW;
END $$;
CREATE TRIGGER account_registration_invite_active BEFORE INSERT ON registration_invites FOR EACH ROW EXECUTE FUNCTION account_guard_registration_invite();

CREATE FUNCTION account_guard_platform_renewal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE principal uuid;
BEGIN
 SELECT user_id INTO principal FROM platform_accounts WHERE id=NEW.account_id;
 PERFORM account_require_active(principal);
 RETURN NEW;
END $$;
CREATE TRIGGER account_platform_renewal_active BEFORE INSERT OR UPDATE ON platform_account_renewals FOR EACH ROW EXECUTE FUNCTION account_guard_platform_renewal();

ALTER FUNCTION library_allowed(uuid,uuid,text) RENAME TO library_allowed_before_account_exit;
CREATE FUNCTION library_allowed(principal uuid,library uuid,action text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM account_exits WHERE user_id=$1) AND library_allowed_before_account_exit($1,$2,$3)
$$;

CREATE FUNCTION account_active(principal uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT $1 IS NULL OR EXISTS(SELECT 1 FROM users u WHERE u.id=$1 AND NOT EXISTS(SELECT 1 FROM account_exits e WHERE e.user_id=u.id))
$$;
CREATE OR REPLACE FUNCTION room_permission_allowed(uuid,uuid,text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM room_member_permissions p JOIN room_members m USING(room_id,user_id)
 WHERE p.room_id=$1 AND p.user_id=$2 AND p.role='moderator' AND NOT p.revoked
 AND account_active(p.user_id) AND account_active(p.granted_by)
 AND (p.expires_at IS NULL OR p.expires_at>clock_timestamp()) AND $3=ANY(p.permissions))
$$;

-- Global revocation is immediate. Room-owner nodes perform the physical room
-- mutations later under the existing lease admission and COMMIT fences.
CREATE TABLE account_exit_room_cleanup (
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES account_exits(user_id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_attempt_at timestamptz,
 PRIMARY KEY(room_id,user_id)
);
CREATE INDEX account_exit_room_cleanup_next ON account_exit_room_cleanup(last_attempt_at ASC NULLS FIRST,created_at,room_id,user_id);
