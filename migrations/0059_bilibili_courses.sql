-- Explicit finite course identity. UGC1, PGC2 and live3 branches retain their
-- existing predicates and immutable row/grant protections.
ALTER TABLE room_platform_media ADD COLUMN aid bigint;
ALTER TABLE room_platform_media DROP CONSTRAINT room_platform_media_identity_shape;
ALTER TABLE room_platform_media ADD CONSTRAINT room_platform_media_identity_shape CHECK (
    CASE resource_kind
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
    ELSE false END
);

ALTER FUNCTION native_platform_source_allowed(uuid,jsonb) RENAME TO native_platform_source_allowed_pre_course;
CREATE FUNCTION native_platform_source_allowed(media uuid, resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT CASE WHEN $2->'native_platform_context'->'version'='4'::jsonb THEN COALESCE(
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
            WHERE m.id=$1 AND m.source_id IS NULL AND m.available AND e.resource_kind='course_episode'
            AND e.room_id::text=$2->'native_platform_context'->>'room_id' AND e.provider='bilibili'
            AND e.revision::text=$2->'native_platform_context'->>'entry_revision'
            AND $2->'native_platform_context'->'resource'=jsonb_build_object('kind','bilibili_course','ep_id',e.ep_id::text,'aid',e.aid::text,'cid',e.cid::text,'season_id',e.season_id::text))
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
        ELSE native_platform_source_allowed_pre_course($1,$2) END
$$;
