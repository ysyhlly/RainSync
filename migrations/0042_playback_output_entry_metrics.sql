-- This bit rides the existing compulsory delivery admission ledger. NULL is an
-- older/uninstrumented admission, not proof that no output-entry request ran.
ALTER TABLE media_executions ADD COLUMN metrics_entry_candidate boolean;
CREATE INDEX media_execution_entry_witness ON media_executions(session_id,id)
    WHERE kind='delivery' AND metrics_entry_candidate IS DISTINCT FROM false;

-- Server/Worker-owned facts only. Availability describes the initial eligible
-- Worker index request, never general cache hotness. Queue is an overlapping
-- observed prefix, captured only at that request's initial expected attempt.
ALTER TABLE playback_sessions
    ADD COLUMN metrics_output_entry_availability text,
    ADD COLUMN metrics_output_entry_completed boolean NOT NULL DEFAULT false,
    ADD COLUMN metrics_output_entry_queue_ms bigint,
    ADD CONSTRAINT playback_session_output_entry_metrics CHECK (
        (metrics_output_entry_availability IS NULL AND NOT metrics_output_entry_completed AND metrics_output_entry_queue_ms IS NULL)
        OR (playback_metrics_version IS NOT NULL AND playback_metrics_version=2
            AND metrics_output_entry_availability IS NOT NULL
            AND metrics_output_entry_availability IN ('cold_waiting','warm','not_applicable','unknown')
            AND (metrics_output_entry_queue_ms IS NULL OR
                (metrics_output_entry_completed AND metrics_output_entry_availability IN ('cold_waiting','warm')
                    AND metrics_output_entry_queue_ms BETWEEN 0 AND 604800000))));
ALTER TABLE playback_viewer_plans
    ADD COLUMN metrics_first_frame_output_entry text,
    ADD COLUMN metrics_first_frame_queue_ms bigint,
    ADD CONSTRAINT playback_viewer_first_frame_output_entry CHECK (
        (metrics_first_frame_output_entry IS NULL AND metrics_first_frame_queue_ms IS NULL)
        OR (metrics_version IS NOT NULL AND metrics_version=2
            AND metrics_first_frame_source IS NOT NULL
            AND metrics_first_frame_output_entry IS NOT NULL
            AND metrics_first_frame_output_entry IN ('cold_waiting','warm','not_applicable','unknown')
            AND (metrics_first_frame_queue_ms IS NULL OR
                (metrics_first_frame_output_entry IN ('cold_waiting','warm')
                    AND metrics_first_frame_queue_ms BETWEEN 0 AND 604800000))));

-- Only new enqueues opt in. Old rows/writers remain NULL. Prefixes survive0039
-- phase clearing; incomplete knowledge is sticky and never exported as zero.
ALTER TABLE media_jobs
    ADD COLUMN metrics_queue_ms bigint,
    ADD COLUMN metrics_queue_complete boolean,
    ADD COLUMN metrics_queue_accounted_attempt bigint,
    ADD CONSTRAINT media_job_queue_prefix_shape CHECK (
        (metrics_queue_ms IS NULL AND metrics_queue_complete IS NULL AND metrics_queue_accounted_attempt IS NULL)
        OR (metrics_queue_ms IS NOT NULL AND metrics_queue_ms BETWEEN 0 AND 604800000
            AND metrics_queue_complete IS NOT NULL
            AND metrics_queue_accounted_attempt IS NOT NULL AND metrics_queue_accounted_attempt>=0));

CREATE FUNCTION retain_media_queue_prefix() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    ended timestamptz;
    elapsed_ms numeric;
    old_phase_valid boolean;
    new_phase_valid boolean;
BEGIN
    -- Updates cannot initialize a missing historical prefix or overwrite an
    -- accumulated one. The producer's INSERT is the only initial known zero.
    NEW.metrics_queue_ms := OLD.metrics_queue_ms;
    NEW.metrics_queue_complete := OLD.metrics_queue_complete;
    NEW.metrics_queue_accounted_attempt := OLD.metrics_queue_accounted_attempt;
    IF OLD.metrics_queue_ms IS NULL THEN RETURN NEW; END IF;
    IF (NEW.status,NEW.attempt,NEW.timing_version,NEW.timing_attempt,NEW.queue_entered_at,NEW.run_started_at)
        IS NOT DISTINCT FROM
       (OLD.status,OLD.attempt,OLD.timing_version,OLD.timing_attempt,OLD.queue_entered_at,OLD.run_started_at)
    THEN RETURN NEW; END IF;
    IF OLD.metrics_queue_accounted_attempt<>OLD.attempt THEN
        NEW.metrics_queue_complete := false;
    END IF;
    IF OLD.status='queued' THEN
        old_phase_valid := coalesce(OLD.timing_version=1 AND OLD.timing_attempt=OLD.attempt
            AND OLD.queue_entered_at IS NOT NULL AND isfinite(OLD.queue_entered_at)
            AND OLD.run_started_at IS NULL, false);
        IF NEW.status='running' THEN
            new_phase_valid := coalesce(NEW.attempt=OLD.attempt+1 AND NEW.timing_version=1
                AND NEW.timing_attempt=NEW.attempt AND NEW.queue_entered_at IS NULL
                AND NEW.run_started_at IS NOT NULL AND isfinite(NEW.run_started_at),false);
            ended := NEW.run_started_at;
        ELSIF NEW.status IN ('cancelled','failed') THEN
            new_phase_valid := NEW.attempt=OLD.attempt AND NEW.timing_version IS NULL
                AND NEW.timing_attempt IS NULL AND NEW.queue_entered_at IS NULL AND NEW.run_started_at IS NULL;
            ended := clock_timestamp();
        ELSE
            new_phase_valid := false;
        END IF;
        IF old_phase_valid AND new_phase_valid AND ended>=OLD.queue_entered_at THEN
            elapsed_ms := floor((extract(epoch FROM ended)-extract(epoch FROM OLD.queue_entered_at))*1000);
            IF elapsed_ms BETWEEN 0 AND 604800000-OLD.metrics_queue_ms THEN
                NEW.metrics_queue_ms := OLD.metrics_queue_ms+elapsed_ms::bigint;
                NEW.metrics_queue_accounted_attempt := NEW.attempt;
            ELSE NEW.metrics_queue_complete := false; END IF;
        ELSE NEW.metrics_queue_complete := false; END IF;
    ELSIF OLD.status='running' THEN
        old_phase_valid := coalesce(OLD.timing_version=1 AND OLD.timing_attempt=OLD.attempt
            AND OLD.run_started_at IS NOT NULL AND isfinite(OLD.run_started_at)
            AND OLD.queue_entered_at IS NULL,false);
        IF NEW.status='queued' THEN
            new_phase_valid := coalesce(NEW.attempt=OLD.attempt AND NEW.timing_version=1
                AND NEW.timing_attempt=NEW.attempt AND NEW.queue_entered_at IS NOT NULL
                AND isfinite(NEW.queue_entered_at) AND NEW.queue_entered_at>=OLD.run_started_at
                AND NEW.run_started_at IS NULL,false);
        ELSE
            new_phase_valid := NEW.status IN ('succeeded','failed','cancelled') AND NEW.attempt=OLD.attempt
                AND NEW.timing_version IS NULL AND NEW.timing_attempt IS NULL
                AND NEW.queue_entered_at IS NULL AND NEW.run_started_at IS NULL;
        END IF;
        IF NOT(old_phase_valid AND new_phase_valid) THEN NEW.metrics_queue_complete := false; END IF;
    ELSE
        NEW.metrics_queue_complete := false;
    END IF;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- Observation decoding/arithmetic cannot fail a business transition. Keep
    -- the bounded old prefix but permanently withhold completeness on failure.
    NEW.metrics_queue_ms := OLD.metrics_queue_ms;
    NEW.metrics_queue_complete := CASE WHEN OLD.metrics_queue_ms IS NULL THEN NULL ELSE false END;
    NEW.metrics_queue_accounted_attempt := OLD.metrics_queue_accounted_attempt;
    RETURN NEW;
END $$;
CREATE TRIGGER media_job_queue_prefix BEFORE UPDATE ON media_jobs
    FOR EACH ROW EXECUTE FUNCTION retain_media_queue_prefix();
