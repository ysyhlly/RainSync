-- Per-grant representation evidence; old grants have no fabricated validator.
CREATE TABLE playback_http_representations (
    session_id uuid NOT NULL REFERENCES playback_sessions(id) ON DELETE CASCADE,
    target_sha256 text NOT NULL CHECK (target_sha256 ~ '^[0-9a-f]{64}$'),
    identity jsonb NOT NULL CHECK (jsonb_typeof(identity)='object'
        AND identity ?& ARRAY['version','metadata','consumed','changed']
        AND identity->>'version'='1'
        AND jsonb_typeof(identity->'metadata')='object'
        AND jsonb_typeof(identity->'consumed')='boolean'
        AND jsonb_typeof(identity->'changed')='boolean'),
    PRIMARY KEY (session_id,target_sha256)
);

-- All metadata publishers and the Server's probe-to-final publication use the
-- same short fence. Take it before session/representation row writes; never
-- retain it while contacting the upstream or streaming a response body.
CREATE FUNCTION lock_playback_http_representation(session uuid)
RETURNS void LANGUAGE sql VOLATILE AS $$
    SELECT pg_advisory_xact_lock(hashtextextended($1::text,72614934))
$$;
