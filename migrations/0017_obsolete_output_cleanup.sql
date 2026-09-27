-- NULL protects the entire cache entry for pre-upgrade/unscoped readers.
ALTER TABLE cache_read_leases ADD COLUMN attempt bigint CHECK (attempt >= 0);
CREATE INDEX cache_read_attempt ON cache_read_leases(cache_id, attempt, expires_at);
ALTER TABLE media_outputs
    ADD COLUMN cleanup_owner uuid,
    ADD COLUMN cleanup_until timestamptz,
    ADD COLUMN cleanup_after timestamptz NOT NULL DEFAULT now();
CREATE INDEX media_outputs_cleanup ON media_outputs(cleanup_after, job_id, attempt)
    WHERE attempt > 0 AND status IN ('abandoned','failed');
