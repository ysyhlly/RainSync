ALTER TABLE media_jobs ADD COLUMN attempt bigint NOT NULL DEFAULT 0 CHECK (attempt >= 0);
-- Attempt zero denotes legacy output. Do not reuse it for running work after upgrade.
UPDATE media_jobs SET status='queued', owner_id=NULL, lease_until=NULL WHERE status='running';
