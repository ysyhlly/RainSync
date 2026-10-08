-- Other live context5 is separate from Bili live3 and course4.
-- Source observations, current broadcast and immutable short viewer grants.
-- Written and fixture-reviewed only; migration has not been executed.
ALTER TABLE room_platform_media ADD COLUMN live_started_at bigint;
ALTER TABLE room_platform_media ADD COLUMN live_resource jsonb;
CREATE FUNCTION other_live_identity_valid(provider text, resource_id text, broadcaster_id text,
    started_at bigint, broadcast_id text, canonical text, selector jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE expected text; selector_kind text;
BEGIN
    IF provider IS NULL OR resource_id IS NULL OR broadcaster_id IS NULL OR started_at IS NULL OR broadcast_id IS NULL OR canonical IS NULL OR selector IS NULL
        OR provider NOT IN ('youtube','douyin','tiktok') OR started_at NOT BETWEEN 946684800 AND 4102444800
        OR broadcast_id !~ '^[0-9a-f]{64}$' OR jsonb_typeof(selector) IS DISTINCT FROM 'object'
        OR (SELECT count(*) FROM jsonb_object_keys(selector))<>2 OR jsonb_typeof(selector->'kind') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    IF provider IN ('douyin','tiktok') AND (resource_id::numeric>18446744073709551615 OR broadcaster_id::numeric>18446744073709551615) THEN RETURN false; END IF;
    selector_kind=selector->>'kind';
    IF provider='youtube' THEN
        IF resource_id !~ '^[A-Za-z0-9_-]{11}$' OR broadcaster_id !~ '^UC[A-Za-z0-9_-]{22}$'
            OR jsonb_typeof(selector->'id') IS DISTINCT FROM 'string' OR selector_kind IS DISTINCT FROM 'youtube' OR selector->>'id' IS DISTINCT FROM resource_id
            OR NOT selector ?& ARRAY['kind','id'] THEN RETURN false; END IF;
        expected='https://www.youtube.com/live/'||resource_id;
    ELSIF provider='douyin' THEN
        IF resource_id !~ '^[1-9][0-9]{0,19}$' OR broadcaster_id !~ '^[1-9][0-9]{0,19}$'
            OR jsonb_typeof(selector->'web_rid') IS DISTINCT FROM 'string' OR selector_kind IS DISTINCT FROM 'douyin' OR selector->>'web_rid' !~ '^[1-9][0-9]{0,19}$'
            OR NOT selector ?& ARRAY['kind','web_rid'] THEN RETURN false; END IF;
        IF (selector->>'web_rid')::numeric>18446744073709551615 THEN RETURN false; END IF;
        expected='https://live.douyin.com/'||(selector->>'web_rid');
    ELSE
        IF resource_id !~ '^[1-9][0-9]{0,19}$' OR broadcaster_id !~ '^[1-9][0-9]{0,19}$' THEN RETURN false; END IF;
        IF selector_kind='tiktok_room' AND jsonb_typeof(selector->'room_id')='string' AND selector->>'room_id'=resource_id AND selector ?& ARRAY['kind','room_id'] THEN
            expected='https://m.tiktok.com/share/live/'||resource_id;
        ELSIF selector_kind='tiktok_handle' AND jsonb_typeof(selector->'handle')='string' AND selector->>'handle' ~ '^[A-Za-z0-9_.]{1,24}$'
            AND selector->>'handle' NOT IN ('.','..') AND selector ?& ARRAY['kind','handle'] THEN
            expected='https://www.tiktok.com/@'||(selector->>'handle')||'/live';
        ELSE RETURN false; END IF;
    END IF;
    RETURN COALESCE(canonical=expected AND broadcast_id=encode(sha256(convert_to(
        'rainsync-other-live-v1','UTF8')||decode('00','hex')||convert_to(provider,'UTF8')||decode('00','hex')||convert_to(resource_id,'UTF8')||decode('00','hex')||convert_to(broadcaster_id,'UTF8')||decode('00','hex')||convert_to(started_at::text,'UTF8')),'hex'),false);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
ALTER TABLE room_platform_media DROP CONSTRAINT room_platform_media_identity_shape;
ALTER TABLE room_platform_media ADD CONSTRAINT room_platform_media_identity_shape CHECK (
    (resource_kind='other_live' OR (live_started_at IS NULL AND live_resource IS NULL)) AND CASE resource_kind
    WHEN 'video' THEN aid IS NULL AND live_room_id IS NULL AND live_uid IS NULL AND live_broadcast_id IS NULL AND ep_id IS NULL AND season_id IS NULL AND CASE provider
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
    WHEN 'pgc_episode' THEN aid IS NULL AND live_room_id IS NULL AND live_uid IS NULL AND live_broadcast_id IS NULL AND provider='bilibili' AND part=1
        AND ep_id IS NOT NULL AND ep_id>0 AND season_id IS NOT NULL AND season_id>0
        AND cid IS NOT NULL AND cid>0 AND content_id='ep'||ep_id::text
        AND canonical_url IS NOT NULL AND canonical_url='https://www.bilibili.com/bangumi/play/ep'||ep_id::text
    WHEN 'live' THEN aid IS NULL AND provider='bilibili' AND part=1 AND cid IS NULL AND ep_id IS NULL AND season_id IS NULL AND duration_ms IS NULL
        AND live_room_id IS NOT NULL AND live_uid IS NOT NULL AND live_broadcast_id IS NOT NULL
        AND live_room_id ~ '^[1-9][0-9]{0,18}$' AND live_uid ~ '^[1-9][0-9]{0,18}$'
        AND live_broadcast_id ~ '^[1-9][0-9]{0,18}:[1-9][0-9]{0,18}:[1-9][0-9]{8,9}$'
        AND split_part(live_broadcast_id,':',1)=live_room_id AND split_part(live_broadcast_id,':',2)=live_uid
        AND split_part(live_broadcast_id,':',3)::bigint BETWEEN 946684800 AND 4102444800
        AND content_id='live:'||live_room_id||':'||live_broadcast_id
        AND canonical_url IS NOT NULL AND canonical_url='https://live.bilibili.com/'||live_room_id
    WHEN 'course_episode' THEN provider='bilibili' AND part=1
        AND live_room_id IS NULL AND live_uid IS NULL AND live_broadcast_id IS NULL
        AND ep_id IS NOT NULL AND ep_id>0 AND aid IS NOT NULL AND aid>0
        AND season_id IS NOT NULL AND season_id>0 AND cid IS NOT NULL AND cid>0
        AND duration_ms IS NOT NULL AND duration_ms BETWEEN 1000 AND 86400000
        AND content_id='course:ep'||ep_id::text
        AND canonical_url IS NOT NULL AND canonical_url='https://www.bilibili.com/cheese/play/ep'||ep_id::text
    WHEN 'other_live' THEN provider IN ('youtube','douyin','tiktok') AND part=1
        AND aid IS NULL AND cid IS NULL AND ep_id IS NULL AND season_id IS NULL AND duration_ms IS NULL
        AND live_started_at IS NOT NULL AND live_resource IS NOT NULL AND live_room_id IS NOT NULL AND live_uid IS NOT NULL
        AND live_broadcast_id IS NOT NULL AND canonical_url IS NOT NULL
        AND other_live_identity_valid(provider,live_room_id,live_uid,live_started_at,live_broadcast_id,canonical_url,live_resource)
        AND content_id='live:'||provider||':'||live_broadcast_id
    ELSE false END
);

CREATE TABLE other_live_broadcasts (
    provider text NOT NULL CHECK(provider IN ('youtube','douyin','tiktok')),
    canonical_url text NOT NULL,
    resource_id text NOT NULL,
    broadcaster_id text NOT NULL,
    broadcast_id text,
    last_started_at bigint NOT NULL CHECK(last_started_at BETWEEN 946684800 AND 4102444800),
    observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(provider,canonical_url),
    CHECK(broadcast_id IS NULL OR broadcast_id ~ '^[0-9a-f]{64}$')
);
CREATE FUNCTION protect_other_live_broadcast() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' AND (NEW.provider IS DISTINCT FROM OLD.provider OR NEW.canonical_url IS DISTINCT FROM OLD.canonical_url
        OR NEW.last_started_at<OLD.last_started_at
        OR (NEW.last_started_at=OLD.last_started_at AND (NEW.resource_id IS DISTINCT FROM OLD.resource_id OR NEW.broadcaster_id IS DISTINCT FROM OLD.broadcaster_id
            OR (OLD.broadcast_id IS NULL AND NEW.broadcast_id IS NOT NULL)
            OR (OLD.broadcast_id IS NOT NULL AND NEW.broadcast_id IS NOT NULL AND OLD.broadcast_id<>NEW.broadcast_id)))) THEN
        RAISE EXCEPTION 'other_live_broadcast_highwater';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER other_live_broadcast_fence BEFORE INSERT OR UPDATE ON other_live_broadcasts
    FOR EACH ROW EXECUTE FUNCTION protect_other_live_broadcast();
CREATE FUNCTION protect_other_live_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' AND (OLD.resource_kind='other_live' OR NEW.resource_kind='other_live') AND
        (NEW.resource_kind IS DISTINCT FROM OLD.resource_kind OR NEW.live_room_id IS DISTINCT FROM OLD.live_room_id
        OR NEW.live_uid IS DISTINCT FROM OLD.live_uid OR NEW.live_broadcast_id IS DISTINCT FROM OLD.live_broadcast_id
        OR NEW.live_started_at IS DISTINCT FROM OLD.live_started_at OR NEW.live_resource IS DISTINCT FROM OLD.live_resource
        OR NEW.canonical_url IS DISTINCT FROM OLD.canonical_url) THEN RAISE EXCEPTION 'other_live_entry_immutable'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER other_live_entry_fence BEFORE UPDATE ON room_platform_media
    FOR EACH ROW EXECUTE FUNCTION protect_other_live_entry();
ALTER FUNCTION native_platform_source_allowed(uuid,jsonb) RENAME TO native_platform_source_allowed_pre_other_live;
CREATE FUNCTION native_platform_source_allowed(media uuid, resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT CASE WHEN $2->'native_platform_context'->'version'='5'::jsonb THEN COALESCE(
        jsonb_typeof($2)='object' AND (SELECT count(*) FROM jsonb_object_keys($2))=3
        AND $2 ?& ARRAY['encrypted','auth_context','native_platform_context'] AND jsonb_typeof($2->'encrypted')='string'
        AND jsonb_typeof($2->'native_platform_context')='object' AND (SELECT count(*) FROM jsonb_object_keys($2->'native_platform_context'))=10
        AND ($2->'native_platform_context') ?& ARRAY['version','provider','media_id','room_id','user_id','entry_revision','credential_mode','account_id','account_revision','resource']
        AND $2->'native_platform_context'->>'provider' IN ('youtube','douyin','tiktok')
        AND $2->'native_platform_context'->>'media_id'=$1::text
        AND $2->'native_platform_context'->>'user_id'=$2->'auth_context'->>'user_id'
        AND $2->'native_platform_context'->>'room_id'=$2->'auth_context'->>'room_id'
        AND playback_http_file_context_allowed($2->'auth_context')
        AND EXISTS(SELECT 1 FROM media_items m JOIN room_platform_media e ON e.media_id=m.id
            JOIN other_live_broadcasts b ON b.provider=e.provider AND b.canonical_url=e.canonical_url
            WHERE m.id=$1 AND m.source_id IS NULL AND m.available AND e.resource_kind='other_live'
            AND e.room_id::text=$2->'native_platform_context'->>'room_id' AND e.provider=$2->'native_platform_context'->>'provider'
            AND e.revision::text=$2->'native_platform_context'->>'entry_revision'
            AND b.resource_id=e.live_room_id AND b.broadcaster_id=e.live_uid AND b.broadcast_id=e.live_broadcast_id AND b.last_started_at=e.live_started_at
            AND b.observed_at>clock_timestamp()-interval '15 seconds'
            AND $2->'native_platform_context'->'resource'=jsonb_build_object('kind','other_live','provider',e.provider,'resource_id',e.live_room_id,'broadcaster_id',e.live_uid,'started_at',e.live_started_at,'broadcast_id',e.live_broadcast_id,'canonical_url',e.canonical_url))
        AND CASE $2->'native_platform_context'->>'credential_mode'
            WHEN 'anonymous' THEN $2->'native_platform_context'->'account_id'='null'::jsonb AND $2->'native_platform_context'->'account_revision'='null'::jsonb
            WHEN 'own_account' THEN EXISTS(SELECT 1 FROM platform_accounts a
                WHERE a.id::text=$2->'native_platform_context'->>'account_id' AND a.user_id::text=$2->'native_platform_context'->>'user_id'
                AND a.provider=$2->'native_platform_context'->>'provider' AND a.revision::text=$2->'native_platform_context'->>'account_revision'
                AND a.state='connected' AND a.credential_encrypted IS NOT NULL AND (a.credential_expires_at IS NULL OR a.credential_expires_at>clock_timestamp()))
            ELSE false END,false)
        ELSE native_platform_source_allowed_pre_other_live($1,$2) END
$$;
CREATE FUNCTION protect_other_live_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.resource->'native_platform_context'->'version'='5'::jsonb AND (NEW.viewer_id IS NULL OR NEW.plan_generation IS NULL OR NEW.plan_generation<1
        OR NEW.static_hls_capture_id IS NOT NULL OR NEW.expires_at>clock_timestamp()+interval '120 seconds'
        OR NEW.resource->'native_platform_context'->'resource'->>'kind'<>'other_live') THEN RAISE EXCEPTION 'other_live_grant_shape'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER zzz_other_live_grant BEFORE INSERT OR UPDATE ON playback_sessions
    FOR EACH ROW EXECUTE FUNCTION protect_other_live_grant();
