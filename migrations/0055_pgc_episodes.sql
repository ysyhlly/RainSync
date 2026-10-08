-- Explicit single-episode PGC identities. Legacy UGC rows and v1 grants retain
-- their original shape. All existing immutable row/grant triggers remain active.
ALTER TABLE room_platform_media ADD COLUMN resource_kind text NOT NULL DEFAULT 'video';
ALTER TABLE room_platform_media ADD COLUMN ep_id bigint;
ALTER TABLE room_platform_media ADD COLUMN season_id bigint;
ALTER TABLE room_platform_media DROP CONSTRAINT room_platform_media_identity_shape;
ALTER TABLE room_platform_media ADD CONSTRAINT room_platform_media_identity_shape CHECK (
    CASE resource_kind
    WHEN 'video' THEN ep_id IS NULL AND season_id IS NULL AND CASE provider
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
    WHEN 'pgc_episode' THEN provider='bilibili' AND part=1
        AND ep_id IS NOT NULL AND ep_id>0 AND season_id IS NOT NULL AND season_id>0
        AND cid IS NOT NULL AND cid>0 AND content_id='ep'||ep_id::text
        AND canonical_url IS NOT NULL AND canonical_url='https://www.bilibili.com/bangumi/play/ep'||ep_id::text
    ELSE false END
);

CREATE OR REPLACE FUNCTION native_platform_source_allowed(media uuid, resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT COALESCE(jsonb_typeof($2)='object'
        AND jsonb_typeof($2->'native_platform_context')='object'
        AND $2->'native_platform_context'->>'provider' IN ('bilibili','douyin','tiktok','youtube')
        AND $2->'native_platform_context'->>'media_id'=$1::text
        AND $2->'native_platform_context'->>'user_id'=$2->'auth_context'->>'user_id'
        AND $2->'native_platform_context'->>'room_id'=$2->'auth_context'->>'room_id'
        AND playback_http_file_context_allowed($2->'auth_context')
        AND NOT ($2 ?| ARRAY['http_file_context','static_hls_capture_id','static_hls_input','url','source_url','root','headers'])
        AND EXISTS(SELECT 1 FROM media_items m JOIN room_platform_media e ON e.media_id=m.id
            WHERE m.id=$1 AND m.source_id IS NULL AND m.available
            AND e.room_id::text=$2->'native_platform_context'->>'room_id'
            AND e.provider=$2->'native_platform_context'->>'provider'
            AND e.revision::text=$2->'native_platform_context'->>'entry_revision'
            AND CASE $2->'native_platform_context'->'version'
                WHEN '1'::jsonb THEN e.resource_kind='video'
                    AND (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof($2->'native_platform_context')='object'
                        THEN $2->'native_platform_context' ELSE '{}'::jsonb END))=9
                    AND ($2->'native_platform_context') ?& ARRAY['version','provider','media_id','room_id','user_id','entry_revision','credential_mode','account_id','account_revision']
                WHEN '2'::jsonb THEN e.resource_kind='pgc_episode' AND e.provider='bilibili'
                    AND (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof($2->'native_platform_context')='object'
                        THEN $2->'native_platform_context' ELSE '{}'::jsonb END))=10
                    AND ($2->'native_platform_context') ?& ARRAY['version','provider','media_id','room_id','user_id','entry_revision','credential_mode','account_id','account_revision','resource']
                    AND $2->'native_platform_context'->'resource'=jsonb_build_object('kind','bilibili_pgc','ep_id',e.ep_id::text,'cid',e.cid::text,'season_id',e.season_id::text)
                ELSE false END)
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
