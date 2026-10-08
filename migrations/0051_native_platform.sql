-- Room-private platform identities. The global media row contains no platform
-- URL/title/account data and has no source, so legacy JOIN-sources readers
-- cannot accidentally expose or send it through the generic HTTP pipeline.
CREATE TABLE room_platform_media (
    media_id uuid PRIMARY KEY REFERENCES media_items(id),
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider='bilibili'),
    content_id text NOT NULL CHECK (content_id ~ '^(BV[A-Za-z0-9]{10}|av[1-9][0-9]{0,18})$'),
    part integer NOT NULL CHECK (part BETWEEN 1 AND 10000),
    cid bigint CHECK (cid>0),
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    duration_ms double precision CHECK (duration_ms>=0 AND duration_ms<=604800000),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(room_id,provider,content_id,part),
    UNIQUE(room_id,media_id)
);

CREATE TABLE platform_accounts (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK(provider='bilibili'),
    revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
    state text NOT NULL CHECK(state IN ('connected','expired','revoked')),
    credential_encrypted text,
    credential_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(user_id,provider),
    CHECK ((state='connected' AND credential_encrypted IS NOT NULL AND length(credential_encrypted)>0)
        OR (state<>'connected' AND credential_encrypted IS NULL))
);

CREATE TABLE platform_login_requests (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    auth_login_hash text NOT NULL CHECK(auth_login_hash ~ '^[0-9a-f]{64}$'),
    provider text NOT NULL CHECK(provider='bilibili'),
    status text NOT NULL CHECK(status IN ('pending','confirmed','expired','failed')),
    qr_key_encrypted text,
    qr_payload_encrypted text,
    expires_at timestamptz NOT NULL,
    next_poll_at timestamptz NOT NULL,
    operation_nonce uuid,
    operation_expires_at timestamptz,
    account_id uuid NOT NULL REFERENCES platform_accounts(id),
    account_revision bigint NOT NULL CHECK(account_revision>0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((operation_nonce IS NULL) = (operation_expires_at IS NULL)),
    CHECK (expires_at<=created_at+interval '5 minutes'),
    CHECK (operation_expires_at IS NULL OR operation_expires_at<=expires_at),
    CHECK (status='pending' OR (qr_key_encrypted IS NULL AND qr_payload_encrypted IS NULL AND operation_nonce IS NULL))
);
CREATE INDEX platform_login_requests_user ON platform_login_requests(user_id,provider,status);
CREATE UNIQUE INDEX platform_login_one_pending ON platform_login_requests(user_id,provider) WHERE status='pending';

CREATE FUNCTION protect_platform_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' THEN
        IF (NEW.id,NEW.user_id,NEW.provider,NEW.created_at) IS DISTINCT FROM
           (OLD.id,OLD.user_id,OLD.provider,OLD.created_at) THEN
            RAISE EXCEPTION 'platform_account_identity_immutable';
        END IF;
        IF (NEW.state,NEW.credential_encrypted,NEW.credential_expires_at) IS DISTINCT FROM
           (OLD.state,OLD.credential_encrypted,OLD.credential_expires_at) THEN
            IF NEW.revision<>OLD.revision+1 THEN
                RAISE EXCEPTION 'platform_account_revision_required';
            END IF;
        ELSIF NEW.revision IS DISTINCT FROM OLD.revision AND NOT
            (OLD.state='revoked' AND NEW.state='revoked' AND NEW.revision=OLD.revision+1) THEN
            RAISE EXCEPTION 'platform_account_revision_without_change';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER platform_account_identity BEFORE UPDATE ON platform_accounts
    FOR EACH ROW EXECUTE FUNCTION protect_platform_account();

CREATE FUNCTION protect_platform_login_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' THEN
        IF (NEW.id,NEW.user_id,NEW.auth_login_hash,NEW.provider,NEW.account_id,NEW.account_revision,NEW.expires_at,NEW.created_at)
            IS DISTINCT FROM
           (OLD.id,OLD.user_id,OLD.auth_login_hash,OLD.provider,OLD.account_id,OLD.account_revision,OLD.expires_at,OLD.created_at) THEN
            RAISE EXCEPTION 'platform_login_origin_immutable';
        END IF;
        IF OLD.status<>'pending' AND NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'platform_login_terminal';
        END IF;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM platform_accounts a WHERE a.id=NEW.account_id
        AND a.user_id=NEW.user_id AND a.provider=NEW.provider) THEN
        RAISE EXCEPTION 'platform_login_account_scope';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER platform_login_origin BEFORE INSERT OR UPDATE ON platform_login_requests
    FOR EACH ROW EXECUTE FUNCTION protect_platform_login_request();

CREATE FUNCTION protect_room_platform_media() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'room_platform_media_immutable';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM media_items m WHERE m.id=NEW.media_id AND m.source_id IS NULL
        AND m.title='平台影片' AND m.resource='platform:'||m.id::text
        AND m.metadata='{}'::jsonb AND m.duration_ms IS NULL) THEN
        RAISE EXCEPTION 'platform_placeholder_required';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER room_platform_media_identity BEFORE INSERT OR UPDATE ON room_platform_media
    FOR EACH ROW EXECUTE FUNCTION protect_room_platform_media();

CREATE FUNCTION protect_platform_placeholder() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM room_platform_media e WHERE e.media_id=OLD.id)
        AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.source_id IS NOT NULL OR NEW.title<>'平台影片'
        OR NEW.resource<>'platform:'||NEW.id::text OR NEW.metadata<>'{}'::jsonb OR NEW.duration_ms IS NOT NULL) THEN
        RAISE EXCEPTION 'platform_placeholder_immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER platform_placeholder_identity BEFORE UPDATE ON media_items
    FOR EACH ROW EXECUTE FUNCTION protect_platform_placeholder();

-- This checks media scope, not caller/control authority. Callers retain their
-- existing room, lifecycle, membership and exact-login admission gates.
CREATE FUNCTION room_media_allowed(room uuid, media uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT EXISTS(SELECT 1 FROM media_items m WHERE m.id=$2 AND m.available AND (
        (m.source_id IS NOT NULL AND EXISTS(SELECT 1 FROM sources s WHERE s.id=m.source_id
            AND (s.kind<>'agent' OR EXISTS(SELECT 1 FROM agents a WHERE a.id=s.id AND NOT a.revoked))))
        OR (m.source_id IS NULL AND EXISTS(SELECT 1 FROM room_platform_media e
            WHERE e.media_id=m.id AND e.room_id=$1))))
$$;

CREATE FUNCTION protect_platform_playlist_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM room_platform_media e WHERE e.media_id=NEW.media_id)
        AND NOT room_media_allowed(NEW.room_id,NEW.media_id) THEN
        RAISE EXCEPTION 'media_not_found';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER platform_playlist_scope BEFORE INSERT OR UPDATE ON playlist_items
    FOR EACH ROW EXECUTE FUNCTION protect_platform_playlist_scope();

CREATE FUNCTION native_platform_source_allowed(media uuid, resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT COALESCE(jsonb_typeof($2)='object'
        AND jsonb_typeof($2->'native_platform_context')='object'
        AND (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof($2->'native_platform_context')='object'
             THEN $2->'native_platform_context' ELSE '{}'::jsonb END))=9
        AND ($2->'native_platform_context') ?& ARRAY['version','provider','media_id','room_id','user_id','entry_revision','credential_mode','account_id','account_revision']
        AND $2->'native_platform_context'->'version'='1'::jsonb
        AND $2->'native_platform_context'->>'provider'='bilibili'
        AND $2->'native_platform_context'->>'media_id'=$1::text
        AND $2->'native_platform_context'->>'user_id'=$2->'auth_context'->>'user_id'
        AND $2->'native_platform_context'->>'room_id'=$2->'auth_context'->>'room_id'
        AND playback_http_file_context_allowed($2->'auth_context')
        AND NOT ($2 ?| ARRAY['http_file_context','static_hls_capture_id','static_hls_input','url','source_url','root','headers'])
        AND EXISTS(SELECT 1 FROM media_items m JOIN room_platform_media e ON e.media_id=m.id
            WHERE m.id=$1 AND m.source_id IS NULL AND m.available
            AND e.room_id::text=$2->'native_platform_context'->>'room_id'
            AND e.provider=$2->'native_platform_context'->>'provider'
            AND e.revision::text=$2->'native_platform_context'->>'entry_revision')
        AND CASE $2->'native_platform_context'->>'credential_mode'
            WHEN 'anonymous' THEN $2->'native_platform_context'->'account_id'='null'::jsonb
                AND $2->'native_platform_context'->'account_revision'='null'::jsonb
            WHEN 'own_account' THEN EXISTS(SELECT 1 FROM platform_accounts a
                WHERE a.id::text=$2->'native_platform_context'->>'account_id'
                AND a.user_id::text=$2->'native_platform_context'->>'user_id'
                AND a.provider=$2->'native_platform_context'->>'provider'
                AND a.revision::text=$2->'native_platform_context'->>'account_revision'
                AND a.state='connected' AND a.credential_encrypted IS NOT NULL
                AND (a.credential_expires_at IS NULL OR a.credential_expires_at>clock_timestamp()))
            ELSE false END,false)
$$;

-- Keep all prior source and static-HLS reader gates intact.
ALTER FUNCTION playback_source_allowed(uuid,jsonb) RENAME TO playback_source_allowed_pre_native_platform;
CREATE FUNCTION playback_source_allowed(media uuid, resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT CASE WHEN $2 ? 'native_platform_context' THEN native_platform_source_allowed($1,$2)
        ELSE playback_source_allowed_pre_native_platform($1,$2) END
$$;

CREATE FUNCTION protect_native_platform_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' AND (OLD.resource ? 'native_platform_context' OR NEW.resource ? 'native_platform_context') THEN
        IF NOT (OLD.resource ? 'native_platform_context')
            OR (NEW.resource-'auth_context') IS DISTINCT FROM (OLD.resource-'auth_context')
            OR (NEW.id,NEW.media_id,NEW.generation,NEW.lifecycle_epoch,NEW.viewer_id,NEW.plan_generation,NEW.delivery_token_hash)
                IS DISTINCT FROM (OLD.id,OLD.media_id,OLD.generation,OLD.lifecycle_epoch,OLD.viewer_id,OLD.plan_generation,OLD.delivery_token_hash)
            OR (OLD.stopped AND NOT NEW.stopped)
            OR NEW.expires_at>OLD.expires_at THEN
            RAISE EXCEPTION 'native_platform_grant_immutable';
        END IF;
    END IF;
    IF NEW.resource ? 'native_platform_context' THEN
        IF NEW.resource->'native_platform_context'->>'media_id' IS DISTINCT FROM NEW.media_id::text
            OR NEW.resource->'native_platform_context'->>'room_id' IS DISTINCT FROM NEW.room_id::text
            OR NEW.resource->'native_platform_context'->>'user_id' IS DISTINCT FROM NEW.user_id::text
            OR NEW.static_hls_capture_id IS NOT NULL THEN
            RAISE EXCEPTION 'native_platform_grant_scope';
        END IF;
        -- Revocation/expiry must remain writable after authority disappears.
        IF TG_OP='INSERT' AND NOT native_platform_source_allowed(NEW.media_id,NEW.resource) THEN
            RAISE EXCEPTION 'native_platform_source_denied';
        END IF;
    END IF;
    RETURN NEW;
END $$;
-- Sort after the existing playback_session_origin trigger, which fills the
-- exact originating auth_context from the retained pending request.
CREATE TRIGGER zz_native_platform_grant BEFORE INSERT OR UPDATE ON playback_sessions
    FOR EACH ROW EXECUTE FUNCTION protect_native_platform_grant();
