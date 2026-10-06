-- Grants belong to an account's current room membership, never to a media library.
CREATE TABLE room_member_permissions (
 room_id uuid NOT NULL, user_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN('viewer','moderator')),
 permissions text[] NOT NULL DEFAULT '{}',
 expires_at timestamptz, revoked boolean NOT NULL DEFAULT false,
 granted_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(room_id,user_id),
 FOREIGN KEY(room_id,user_id) REFERENCES room_members(room_id,user_id) ON DELETE CASCADE,
 CHECK(permissions <@ ARRAY['invite','kick','close','play','pause','seek','set_rate','change_media','queue']::text[]),
 CHECK(role='moderator' OR cardinality(permissions)=0)
);
ALTER TABLE invites ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE invites ADD CONSTRAINT room_invites_id_unique UNIQUE(id);
ALTER TABLE invites ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE invites ADD COLUMN invited_user_id uuid REFERENCES users(id);
ALTER TABLE invites ADD COLUMN granted_role text NOT NULL DEFAULT 'viewer' CHECK(granted_role IN('viewer','moderator'));
ALTER TABLE invites ADD COLUMN permissions text[] NOT NULL DEFAULT '{}';
ALTER TABLE invites ADD COLUMN grant_expires_at timestamptz;
ALTER TABLE invites ADD COLUMN max_uses integer CHECK(max_uses BETWEEN 1 AND 10000);
ALTER TABLE invites ADD COLUMN use_count integer NOT NULL DEFAULT 0 CHECK(use_count>=0);
ALTER TABLE invites ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE invites ADD COLUMN revoked_at timestamptz;
-- Record the actual new revocation, without inventing times for legacy rows.
CREATE FUNCTION stamp_room_invite_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT OLD.revoked AND NEW.revoked THEN
  NEW.revoked_at=clock_timestamp();
 ELSE
  NEW.revoked_at=OLD.revoked_at;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER room_invite_revocation BEFORE UPDATE ON invites FOR EACH ROW EXECUTE FUNCTION stamp_room_invite_revocation();
ALTER TABLE invites ADD CONSTRAINT room_invites_permission_values CHECK(permissions <@ ARRAY['invite','kick','close','play','pause','seek','set_rate','change_media','queue']::text[]);
ALTER TABLE invites ADD CONSTRAINT room_invites_viewer_permissions CHECK(granted_role='moderator' OR cardinality(permissions)=0);
CREATE TABLE room_invite_redemptions (
 token_hash text NOT NULL REFERENCES invites(token_hash) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id), membership_epoch uuid NOT NULL,
 redeemed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(token_hash,user_id)
);
CREATE INDEX room_invites_room ON invites(room_id,created_at);
-- clock_timestamp observes expiry after lock waits; membership is always required.
CREATE FUNCTION room_permission_allowed(uuid,uuid,text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM room_member_permissions p JOIN room_members m USING(room_id,user_id)
 WHERE p.room_id=$1 AND p.user_id=$2 AND p.role='moderator' AND NOT p.revoked
 AND (p.expires_at IS NULL OR p.expires_at>clock_timestamp()) AND $3=ANY(p.permissions))
$$;
CREATE TRIGGER control_owner_admission BEFORE INSERT OR UPDATE OR DELETE ON room_member_permissions FOR EACH ROW EXECUTE FUNCTION control_cluster_guard_write();
CREATE CONSTRAINT TRIGGER control_owner_commit AFTER INSERT OR UPDATE OR DELETE ON room_member_permissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION control_cluster_guard_write();
