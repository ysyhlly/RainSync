-- Viewer-owned YouTube sessions remain encrypted, provider/revision-bound and
-- separate from Google OAuth. No existing ciphertext or grant is changed.
ALTER TABLE platform_accounts DROP CONSTRAINT platform_accounts_provider_check;
ALTER TABLE platform_accounts ADD CONSTRAINT platform_accounts_provider_check
    CHECK(provider IN ('bilibili','douyin','tiktok','youtube'));

CREATE OR REPLACE FUNCTION native_platform_source_allowed(media uuid, resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT COALESCE(jsonb_typeof($2)='object'
        AND jsonb_typeof($2->'native_platform_context')='object'
        AND (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof($2->'native_platform_context')='object'
             THEN $2->'native_platform_context' ELSE '{}'::jsonb END))=9
        AND ($2->'native_platform_context') ?& ARRAY['version','provider','media_id','room_id','user_id','entry_revision','credential_mode','account_id','account_revision']
        AND $2->'native_platform_context'->'version'='1'::jsonb
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
            AND e.revision::text=$2->'native_platform_context'->>'entry_revision')
        AND CASE $2->'native_platform_context'->>'credential_mode'
            WHEN 'anonymous' THEN $2->'native_platform_context'->'account_id'='null'::jsonb
                AND $2->'native_platform_context'->'account_revision'='null'::jsonb
            WHEN 'own_account' THEN $2->'native_platform_context'->>'provider' IN ('bilibili','douyin','tiktok','youtube') AND EXISTS(SELECT 1 FROM platform_accounts a
                WHERE a.id::text=$2->'native_platform_context'->>'account_id'
                AND a.user_id::text=$2->'native_platform_context'->>'user_id'
                AND a.provider=$2->'native_platform_context'->>'provider'
                AND a.revision::text=$2->'native_platform_context'->>'account_revision'
                AND a.state='connected' AND a.credential_encrypted IS NOT NULL
                AND (a.credential_expires_at IS NULL OR a.credential_expires_at>clock_timestamp()))
            ELSE false END,false)
$$;

