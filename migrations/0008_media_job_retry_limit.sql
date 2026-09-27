ALTER TABLE media_jobs
    ADD COLUMN max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX jobs_ready ON media_jobs(available_at, created_at) WHERE status='queued';
