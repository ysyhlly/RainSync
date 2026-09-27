CREATE TABLE media_outputs (
    job_id uuid NOT NULL REFERENCES media_jobs(id) ON DELETE CASCADE,
    attempt bigint NOT NULL CHECK (attempt >= 0),
    owner_id uuid,
    status text NOT NULL CHECK (status IN ('writing','published','failed','abandoned','legacy')),
    relative_dir text NOT NULL,
    validation_version integer NOT NULL DEFAULT 1 CHECK (validation_version >= 0),
    manifest_sha256 text CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    segment_count integer CHECK (segment_count > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    PRIMARY KEY(job_id, attempt),
    CHECK (status <> 'published' OR (manifest_sha256 IS NOT NULL AND segment_count IS NOT NULL AND published_at IS NOT NULL))
);
-- Previous completions have no validation proof. Keep them explicitly legacy.
INSERT INTO media_outputs(job_id,attempt,owner_id,status,relative_dir,validation_version)
SELECT id,attempt,owner_id,'legacy',id::text || CASE WHEN attempt=0 THEN '' ELSE '/'||attempt::text END,0
FROM media_jobs WHERE status='succeeded';
