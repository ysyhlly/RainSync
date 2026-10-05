-- A deletion followed by rejoin must never restore an old continuation right.
ALTER TABLE room_members ADD COLUMN membership_epoch uuid NOT NULL DEFAULT gen_random_uuid();

-- Reuse the bounded request ledger and its existing cancellation/attempt rules.
-- Context is server-produced and encrypted; a claim contains exactly one pin.
ALTER TABLE playback_requests
    ADD COLUMN http_file_context_encrypted text,
    ADD COLUMN http_file_parent uuid REFERENCES playback_sessions(id),
    ADD CONSTRAINT playback_requests_http_file_context CHECK (
        (http_file_context_encrypted IS NULL AND http_file_parent IS NULL)
        OR (http_file_context_encrypted IS NOT NULL
            AND octet_length(http_file_context_encrypted) BETWEEN 1 AND 8192));
CREATE UNIQUE INDEX playback_requests_http_file_parent
    ON playback_requests(http_file_parent) WHERE http_file_parent IS NOT NULL;

-- This is a server-written restriction, not a credential. Missing means the
-- original grant behavior; an explicitly malformed context is fail closed.
CREATE FUNCTION playback_http_file_context_allowed(context jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT CASE WHEN $1 IS NULL THEN true
        WHEN jsonb_typeof($1)<>'object' THEN false
        ELSE COALESCE($1->'version'='1'::jsonb
            AND $1 ?& ARRAY['user_id','room_id','membership_epoch','login_hash']
            AND $1 - ARRAY['version','user_id','room_id','membership_epoch','login_hash']='{}'::jsonb
            AND jsonb_typeof($1->'user_id')='string'
            AND jsonb_typeof($1->'room_id')='string'
            AND jsonb_typeof($1->'membership_epoch')='string'
            AND jsonb_typeof($1->'login_hash')='string'
            AND $1->>'login_hash' ~ '^[0-9a-f]{64}$'
            AND EXISTS(SELECT 1 FROM sessions s JOIN room_members m ON m.user_id=s.user_id
            WHERE s.token_hash=$1->>'login_hash' AND s.expires_at>clock_timestamp()
            AND m.user_id::text=$1->>'user_id' AND m.room_id::text=$1->>'room_id'
            AND m.membership_epoch::text=$1->>'membership_epoch'),false) END
$$;

-- All existing prepare/replay/renew/readiness/delivery/body guards already use
-- this source gate. Legacy grants retain their previous semantics.
CREATE OR REPLACE FUNCTION playback_source_allowed(media uuid, resource jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
    SELECT playback_http_file_context_allowed($2->'http_file_context')
        AND EXISTS(SELECT 1 FROM media_items m WHERE m.id=$1 AND
            source_account_policy_allowed(m.source_id,
                COALESCE(($2->>'source_policy_revision')::bigint,0),
                ($2->>'account_policy_generation')::bigint))
$$;
