-- Optional observation metadata. Historical rows remain entirely unknown;
-- created_at/available_at are not substituted for phase-entry timestamps.
ALTER TABLE media_jobs
    ADD COLUMN timing_version smallint,
    ADD COLUMN timing_attempt bigint,
    ADD COLUMN queue_entered_at timestamptz,
    ADD COLUMN run_started_at timestamptz;

-- Do not constrain these fields to the scheduling state/attempt: older writers
-- may still mutate those columns. New readers must compare the version,
-- attempt and phase with the locked pre-transition row before using a sample.
-- A new writer replaces the complete tuple when entering its next phase.
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_timing_shape CHECK (
    (
        timing_version IS NULL
        AND timing_attempt IS NULL
        AND queue_entered_at IS NULL
        AND run_started_at IS NULL
    ) OR (
        timing_version IS NOT NULL AND timing_version = 1
        AND timing_attempt IS NOT NULL AND timing_attempt >= 0
        AND (
            (queue_entered_at IS NOT NULL AND run_started_at IS NULL
             AND isfinite(queue_entered_at))
            OR
            (run_started_at IS NOT NULL AND queue_entered_at IS NULL
             AND isfinite(run_started_at))
        )
    )
);
