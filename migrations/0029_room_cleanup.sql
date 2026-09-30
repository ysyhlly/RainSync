-- Cleanup is durable, epoch-fenced and independently retryable. A cancelled job
-- or expired worker lease is NOT evidence that an operating-system tree exited.
CREATE TABLE room_cleanup_tasks (
    room_id uuid NOT NULL REFERENCES rooms(id),
    lifecycle_epoch bigint NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    lease_owner uuid,
    lease_until timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    PRIMARY KEY(room_id,lifecycle_epoch)
);
CREATE INDEX room_cleanup_pending ON room_cleanup_tasks(next_attempt_at)
    WHERE completed_at IS NULL;

CREATE TABLE media_executions (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES playback_sessions(id),
    kind text NOT NULL CHECK(kind IN ('job','delivery')),
    job_id uuid REFERENCES media_jobs(id),
    attempt bigint,
    owner_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    reaped_at timestamptz,
    UNIQUE(job_id,attempt),
    CHECK((kind='job' AND job_id IS NOT NULL AND attempt IS NOT NULL)
       OR (kind='delivery' AND job_id IS NULL AND attempt IS NULL))
);
CREATE INDEX media_executions_unreaped ON media_executions(session_id)
    WHERE reaped_at IS NULL;

-- Old abandoned/cancelled attempts have no durable OS-reaping evidence. Keep
-- them visible as unknown rather than blessing expiry as cleanup. Successful
-- terminal publication was already downstream of explicit child wait/reaping.
INSERT INTO media_executions(id,session_id,kind,job_id,attempt,owner_id,reaped_at)
SELECT gen_random_uuid(),j.session_id,'job',o.job_id,o.attempt,COALESCE(o.owner_id,gen_random_uuid()),
       CASE WHEN j.attempt=o.attempt AND j.status='succeeded'
                 AND o.status='published' AND o.validation_version>=1
            THEN now() ELSE NULL END
FROM media_outputs o JOIN media_jobs j ON j.id=o.job_id
WHERE j.session_id IS NOT NULL;
-- A legacy attempt may predate output bookkeeping or have lost its output row.
-- Record that missing evidence too; an absent output must not imply no process.
INSERT INTO media_executions(id,session_id,kind,job_id,attempt,owner_id)
SELECT gen_random_uuid(),j.session_id,'job',j.id,j.attempt,COALESCE(j.owner_id,gen_random_uuid())
FROM media_jobs j
WHERE j.session_id IS NOT NULL AND (j.attempt>0 OR j.owner_id IS NOT NULL OR j.status='running')
  AND NOT EXISTS(SELECT 1 FROM media_executions e WHERE e.job_id=j.id AND e.attempt=j.attempt);

-- Extend the existing durable upstream ledger; do not create a competing owner.
ALTER TABLE upstream_reservations ADD COLUMN lifecycle_epoch bigint NOT NULL DEFAULT 0 CHECK(lifecycle_epoch>=0);
CREATE INDEX upstream_reservations_lifecycle ON upstream_reservations(room_id,lifecycle_epoch)
    WHERE state<>'closed';

ALTER TABLE playback_requests ADD COLUMN preparation_drained_at timestamptz;
CREATE TABLE playback_preparations (
    session_id uuid PRIMARY KEY,
    user_id uuid REFERENCES users(id),
    room_id uuid NOT NULL REFERENCES rooms(id),
    lifecycle_epoch bigint NOT NULL,
    owner_epoch uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    drained_at timestamptz
);
CREATE INDEX playback_preparations_undrained ON playback_preparations(room_id)
    WHERE drained_at IS NULL;
-- Preserve unfinished preparations that can still publish after migration.
INSERT INTO playback_preparations(session_id,user_id,room_id,lifecycle_epoch,owner_epoch,drained_at)
SELECT session_id,user_id,room_id,lifecycle_epoch,owner_epoch,
       CASE WHEN status='completed' THEN now() ELSE NULL END
FROM playback_requests WHERE room_id IS NOT NULL;

-- Worker-side stream disposal is not proof the NAS process released its file.
ALTER TABLE agent_transfer_runs ADD COLUMN session_id uuid REFERENCES playback_sessions(id);
ALTER TABLE agent_transfer_runs ADD COLUMN dispatched_at timestamptz;
ALTER TABLE agent_transfer_runs ADD COLUMN agent_drained_at timestamptz;
-- Before this migration a transfer has no provable room association or remote
-- disposal receipt. Old workers may also keep inserting after a failed/mixed
-- upgrade, so fail closed by DEFAULT. Instrumented owners explicitly opt out
-- when inserting their fully tracked offers. No runtime path clears this flag.
ALTER TABLE agent_transfer_runs ADD COLUMN legacy_unconfirmed boolean NOT NULL DEFAULT true;
CREATE INDEX agent_transfer_runs_legacy_barrier ON agent_transfer_runs(id)
    WHERE legacy_unconfirmed;
-- A still-running old Server does not know the new history-retention filter.
-- Preserve the evidence at the database boundary too, including that old SQL.
CREATE FUNCTION preserve_legacy_agent_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.legacy_unconfirmed THEN
        RETURN NULL;
    END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER preserve_legacy_agent_cleanup
    BEFORE DELETE ON agent_transfer_runs
    FOR EACH ROW EXECUTE FUNCTION preserve_legacy_agent_cleanup();
CREATE INDEX agent_transfer_runs_session_drain ON agent_transfer_runs(session_id)
    WHERE session_id IS NOT NULL AND agent_drained_at IS NULL;
