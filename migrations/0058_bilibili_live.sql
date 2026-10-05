-- Rolling live identities are immutable and separate from finite VOD/static-HLS.
-- A restart inserts a fresh media row; observing a different broadcast revokes
-- every old grant without changing its identity or extending its expiry.
ALTER TABLE room_platform_media ADD COLUMN live_room_id text;
ALTER TABLE room_platform_media ADD COLUMN live_uid text;
ALTER TABLE room_platform_media ADD COLUMN live_broadcast_id text;
ALTER TABLE room_platform_media DROP CONSTRAINT room_platform_media_identity_shape;
ALTER TABLE room_platform_media ADD CONSTRAINT room_platform_media_identity_shape CHECK (
    CASE resource_kind
    WHEN 'video' THEN live_room_id IS NULL AND live_uid IS NULL AND live_broadcast_id IS NULL AND ep_id IS NULL AND season_id IS NULL AND CASE provider
        WHEN 'bilibili' THEN content_id ~ '^(BV[A-Za-z0-9]{10}|av[1-9][0-9]{0,18})$' AND canonical_url IS NULL
        WHEN 'douyin' THEN content_id ~ '^[1-9][0-9]{0,19}$' AND part=1 AND cid IS NULL
            AND canonical_url IS NOT NULL AND canonical_url='https://www.douyin.com/video/'||content_id
        WHEN 'tiktok' THEN content_id ~ '^[1-9][0-9]{0,19}$' AND part=1 AND cid IS NULL
            AND canonical_url IS NOT NULL
            AND canonical_url ~ '^https://www\.tiktok\.com/@[A-Za-z0-9_.]{1,24}/video/[1-9][0-9]{0,19}$'
            AND right(canonical_url,length('/video/'||content_id))='/video/'||content_id
        WHEN 'youtube' THEN content_id ~ '^[A-Za-z0-9_-]{11}$' AND part=1 AND cid IS NULL
            AND canonical_url IS NOT NULL AND canonical_url='https://www.youtube.com/watch?v='||content_id
        ELSE false END
    WHEN 'pgc_episode' THEN live_room_id IS NULL AND live_uid IS NULL AND live_broadcast_id IS NULL AND provider='bilibili' AND part=1
        AND ep_id IS NOT NULL AND ep_id>0 AND season_id IS NOT NULL AND season_id>0
        AND cid IS NOT NULL AND cid>0 AND content_id='ep'||ep_id::text
        AND canonical_url IS NOT NULL AND canonical_url='https://www.bilibili.com/bangumi/play/ep'||ep_id::text
    WHEN 'live' THEN provider='bilibili' AND part=1 AND cid IS NULL AND ep_id IS NULL AND season_id IS NULL AND duration_ms IS NULL
        AND live_room_id IS NOT NULL AND live_uid IS NOT NULL AND live_broadcast_id IS NOT NULL
        AND live_room_id ~ '^[1-9][0-9]{0,18}$' AND live_uid ~ '^[1-9][0-9]{0,18}$'
        AND live_broadcast_id ~ '^[1-9][0-9]{0,18}:[1-9][0-9]{0,18}:[1-9][0-9]{8,9}$'
        AND split_part(live_broadcast_id,':',1)=live_room_id AND split_part(live_broadcast_id,':',2)=live_uid
        AND split_part(live_broadcast_id,':',3)::bigint BETWEEN 946684800 AND 4102444800
        AND content_id='live:'||live_room_id||':'||live_broadcast_id
        AND canonical_url IS NOT NULL AND canonical_url='https://live.bilibili.com/'||live_room_id
    ELSE false END
);


CREATE TABLE bilibili_live_broadcasts (
    room_id text PRIMARY KEY CHECK(room_id ~ '^[1-9][0-9]{0,18}$'),
    uid text NOT NULL CHECK(uid ~ '^[1-9][0-9]{0,18}$'),
    broadcast_id text,
    last_started_at bigint NOT NULL CHECK(last_started_at BETWEEN 946684800 AND 4102444800),
    observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK(broadcast_id IS NULL OR (split_part(broadcast_id,':',3)::bigint=last_started_at AND split_part(broadcast_id,':',1)=room_id AND split_part(broadcast_id,':',2)=uid
        AND broadcast_id ~ '^[1-9][0-9]{0,18}:[1-9][0-9]{0,18}:[1-9][0-9]{8,9}$'))
);

ALTER FUNCTION native_platform_source_allowed(uuid,jsonb) RENAME TO native_platform_source_allowed_pre_live;
CREATE FUNCTION native_platform_source_allowed(media uuid, resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT CASE WHEN $2->'native_platform_context'->'version'='3'::jsonb THEN COALESCE(
        jsonb_typeof($2)='object' AND (SELECT count(*) FROM jsonb_object_keys($2))=3
        AND $2 ?& ARRAY['encrypted','auth_context','native_platform_context']
        AND jsonb_typeof($2->'encrypted')='string'
        AND jsonb_typeof($2->'native_platform_context')='object'
        AND (SELECT count(*) FROM jsonb_object_keys($2->'native_platform_context'))=10
        AND ($2->'native_platform_context') ?& ARRAY['version','provider','media_id','room_id','user_id','entry_revision','credential_mode','account_id','account_revision','resource']
        AND $2->'native_platform_context'->>'provider'='bilibili'
        AND $2->'native_platform_context'->>'media_id'=$1::text
        AND $2->'native_platform_context'->>'user_id'=$2->'auth_context'->>'user_id'
        AND $2->'native_platform_context'->>'room_id'=$2->'auth_context'->>'room_id'
        AND playback_http_file_context_allowed($2->'auth_context')
        AND EXISTS(SELECT 1 FROM media_items m JOIN room_platform_media e ON e.media_id=m.id
            JOIN bilibili_live_broadcasts b ON b.room_id=e.live_room_id
            WHERE m.id=$1 AND m.source_id IS NULL AND m.available AND e.resource_kind='live'
            AND e.room_id::text=$2->'native_platform_context'->>'room_id' AND e.provider='bilibili'
            AND e.revision::text=$2->'native_platform_context'->>'entry_revision'
            AND b.uid=e.live_uid AND b.broadcast_id=e.live_broadcast_id
            AND $2->'native_platform_context'->'resource'=jsonb_build_object('kind','bilibili_live','room_id',e.live_room_id,'uid',e.live_uid,'broadcast_id',e.live_broadcast_id))
        AND CASE $2->'native_platform_context'->>'credential_mode'
            WHEN 'anonymous' THEN $2->'native_platform_context'->'account_id'='null'::jsonb
                AND $2->'native_platform_context'->'account_revision'='null'::jsonb
            WHEN 'own_account' THEN EXISTS(SELECT 1 FROM platform_accounts a
                WHERE a.id::text=$2->'native_platform_context'->>'account_id'
                AND a.user_id::text=$2->'native_platform_context'->>'user_id' AND a.provider='bilibili'
                AND a.revision::text=$2->'native_platform_context'->>'account_revision'
                AND a.state='connected' AND a.credential_encrypted IS NOT NULL
                AND (a.credential_expires_at IS NULL OR a.credential_expires_at>clock_timestamp()))
            ELSE false END,false)
        ELSE native_platform_source_allowed_pre_live($1,$2) END
$$;

-- Existing immutable native/auth/viewer-plan triggers still apply. The live
-- deadline cannot be extended, including after replay or signed-URL renewal.
CREATE FUNCTION protect_native_live_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.resource->'native_platform_context'->'version'='3'::jsonb THEN
        IF NEW.viewer_id IS NULL OR NEW.plan_generation IS NULL OR NEW.plan_generation<1
            OR NEW.static_hls_capture_id IS NOT NULL OR NEW.expires_at>clock_timestamp()+interval '120 seconds'
            OR NEW.resource->'native_platform_context'->'resource'->>'kind'<>'bilibili_live' THEN
            RAISE EXCEPTION 'native_live_grant_shape';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER zzz_native_live_grant BEFORE INSERT OR UPDATE ON playback_sessions
    FOR EACH ROW EXECUTE FUNCTION protect_native_live_grant();
