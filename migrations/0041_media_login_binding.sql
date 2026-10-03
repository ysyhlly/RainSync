-- Origin is an immutable reference to an existing login hash, never a credential
-- and never inferred for historical grants. No FK: logout must retain provenance.
ALTER TABLE playback_requests ADD COLUMN auth_login_hash text,
    ADD COLUMN auth_membership_epoch uuid;
ALTER TABLE playback_sessions ADD COLUMN auth_login_hash text,
    ADD COLUMN auth_membership_epoch uuid;
ALTER TABLE upstream_reservations ADD COLUMN auth_login_hash text,
    ADD COLUMN auth_membership_epoch uuid;
ALTER TABLE playback_viewer_plans ADD COLUMN auth_login_hash text;
CREATE INDEX playback_requests_login ON playback_requests(auth_login_hash) WHERE auth_login_hash IS NOT NULL;
CREATE INDEX playback_sessions_login ON playback_sessions(auth_login_hash) WHERE auth_login_hash IS NOT NULL;
CREATE INDEX upstream_reservations_login ON upstream_reservations(auth_login_hash) WHERE auth_login_hash IS NOT NULL;

CREATE FUNCTION playback_login_allowed(principal uuid, login text)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT $2 ~ '^[0-9a-f]{64}$' AND EXISTS(SELECT 1 FROM sessions
        WHERE token_hash=$2 AND user_id=$1 AND expires_at>clock_timestamp())
$$;
CREATE FUNCTION playback_origin_allowed(principal uuid, room uuid, login text, membership uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT CASE WHEN $3 IS NULL THEN true ELSE COALESCE(
        playback_login_allowed($1,$3) AND EXISTS(SELECT 1 FROM room_members
            WHERE user_id=$1 AND room_id=$2 AND membership_epoch=$4),false) END
$$;
CREATE FUNCTION playback_caller_allowed(resource jsonb, principal uuid, login text)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT COALESCE(playback_login_allowed($2,$3) AND
        (NOT ($1 ? 'auth_context') OR
         (playback_http_file_context_allowed($1->'auth_context') AND
          $1->'auth_context'->>'login_hash'=$3 AND
          $1->'auth_context'->>'user_id'=$2::text)),false)
$$;
CREATE OR REPLACE FUNCTION playback_source_allowed(media uuid, resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT playback_http_file_context_allowed($2->'http_file_context')
        AND playback_http_file_context_allowed($2->'auth_context')
        AND EXISTS(SELECT 1 FROM media_items m WHERE m.id=$1 AND
            source_account_policy_allowed(m.source_id,
                COALESCE(($2->>'source_policy_revision')::bigint,0),
                ($2->>'account_policy_generation')::bigint))
$$;

-- New NULL rows from pre-cutover writers cannot create unbound authority.
-- New cancellation tombstones have a login but may precede knowing a room.
CREATE FUNCTION protect_playback_request_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' THEN
        IF NEW.auth_login_hash IS DISTINCT FROM OLD.auth_login_hash
            OR NEW.auth_membership_epoch IS DISTINCT FROM OLD.auth_membership_epoch
            OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.room_id IS DISTINCT FROM OLD.room_id THEN
            RAISE EXCEPTION 'media_login_origin_immutable';
        END IF;
        IF OLD.auth_login_hash IS NULL AND NEW.session_id IS DISTINCT FROM OLD.session_id THEN
            RAISE EXCEPTION 'legacy_playback_request_requires_fresh_key';
        END IF;
    ELSE
        IF NEW.auth_login_hash IS NULL OR NOT COALESCE(playback_login_allowed(NEW.user_id,NEW.auth_login_hash),false) THEN
            RAISE EXCEPTION 'media_login_binding_required';
        END IF;
        IF NEW.room_id IS NOT NULL AND NOT playback_origin_allowed(NEW.user_id,NEW.room_id,NEW.auth_login_hash,NEW.auth_membership_epoch) THEN
            RAISE EXCEPTION 'media_login_binding_required';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER playback_request_origin BEFORE INSERT OR UPDATE ON playback_requests
    FOR EACH ROW EXECUTE FUNCTION protect_playback_request_origin();

CREATE FUNCTION protect_playback_session_origin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin jsonb;
BEGIN
    IF TG_OP='INSERT' AND NEW.user_id IS NOT NULL THEN
        SELECT r.auth_login_hash,r.auth_membership_epoch INTO NEW.auth_login_hash,NEW.auth_membership_epoch
            FROM playback_requests r WHERE r.session_id=NEW.id AND r.user_id=NEW.user_id AND r.room_id=NEW.room_id AND r.status='pending';
        IF NEW.auth_login_hash IS NULL OR NOT playback_origin_allowed(NEW.user_id,NEW.room_id,NEW.auth_login_hash,NEW.auth_membership_epoch) THEN
            RAISE EXCEPTION 'media_login_binding_required';
        END IF;
    ELSIF TG_OP='UPDATE' THEN
        IF NEW.auth_login_hash IS DISTINCT FROM OLD.auth_login_hash
            OR NEW.auth_membership_epoch IS DISTINCT FROM OLD.auth_membership_epoch
            OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.room_id IS DISTINCT FROM OLD.room_id THEN
            RAISE EXCEPTION 'media_login_origin_immutable';
        END IF;
        -- Preserve every historical expiry exactly on upgrade; later operations
        -- may shorten/revoke it, but neither renewal nor an old writer extends it.
        IF OLD.auth_login_hash IS NULL AND NEW.expires_at>OLD.expires_at THEN
            RAISE EXCEPTION 'legacy_playback_session_not_renewable';
        END IF;
    END IF;
    IF NEW.auth_login_hash IS NOT NULL THEN
        origin=jsonb_build_object('version',1,'user_id',NEW.user_id,'room_id',NEW.room_id,
            'membership_epoch',NEW.auth_membership_epoch,'login_hash',NEW.auth_login_hash);
        IF NEW.resource ? 'auth_context' AND NEW.resource->'auth_context' IS DISTINCT FROM origin THEN
            RAISE EXCEPTION 'media_login_origin_immutable';
        END IF;
        -- Resource replacement cannot erase the immutable restriction, including
        -- provisional-to-final publication and old resource-only UPDATE writers.
        NEW.resource=NEW.resource||jsonb_build_object('auth_context',origin);
    ELSIF NEW.resource ? 'auth_context' THEN
        RAISE EXCEPTION 'media_login_binding_required';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER playback_session_origin BEFORE INSERT OR UPDATE ON playback_sessions
    FOR EACH ROW EXECUTE FUNCTION protect_playback_session_origin();

CREATE FUNCTION protect_upstream_reservation_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        SELECT r.auth_login_hash,r.auth_membership_epoch INTO NEW.auth_login_hash,NEW.auth_membership_epoch
            FROM playback_requests r WHERE r.session_id=NEW.id AND r.user_id=NEW.user_id AND r.room_id=NEW.room_id AND r.status='pending';
        IF NEW.auth_login_hash IS NULL OR NOT playback_origin_allowed(NEW.user_id,NEW.room_id,NEW.auth_login_hash,NEW.auth_membership_epoch) THEN
            RAISE EXCEPTION 'media_login_binding_required';
        END IF;
    ELSIF NEW.auth_login_hash IS DISTINCT FROM OLD.auth_login_hash
        OR NEW.auth_membership_epoch IS DISTINCT FROM OLD.auth_membership_epoch
        OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.room_id IS DISTINCT FROM OLD.room_id THEN
        RAISE EXCEPTION 'media_login_origin_immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER upstream_reservation_origin BEFORE INSERT OR UPDATE ON upstream_reservations
    FOR EACH ROW EXECUTE FUNCTION protect_upstream_reservation_origin();

CREATE FUNCTION protect_playback_viewer_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        IF NEW.auth_login_hash IS NULL OR NOT COALESCE(playback_login_allowed(NEW.user_id,NEW.auth_login_hash),false) THEN
            RAISE EXCEPTION 'media_login_binding_required';
        END IF;
    ELSIF NEW.auth_login_hash IS DISTINCT FROM OLD.auth_login_hash THEN
        RAISE EXCEPTION 'media_login_origin_immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER playback_viewer_origin BEFORE INSERT OR UPDATE ON playback_viewer_plans
    FOR EACH ROW EXECUTE FUNCTION protect_playback_viewer_origin();
