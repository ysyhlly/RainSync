-- Rooms and playback sessions use epoch zero before their first lifecycle transition.
-- Keep published0035 immutable; widen only the metrics slot to the same domain.
ALTER TABLE playback_viewer_plans
    DROP CONSTRAINT playback_viewer_metrics_slot,
    ADD CONSTRAINT playback_viewer_metrics_slot CHECK (
        (metrics_meter_start_generation IS NULL
            AND metrics_media_generation IS NULL AND metrics_lifecycle_epoch IS NULL
            AND metrics_startup_origin IS NULL AND metrics_seq=0 AND metrics_payload IS NULL
            AND NOT metrics_closed AND metrics_admitted_at IS NULL
            AND metrics_anchor_elapsed_ms IS NULL AND metrics_anchor_received_at IS NULL)
        OR
        (metrics_meter_start_generation IS NOT NULL
            AND metrics_meter_start_generation BETWEEN 1 AND plan_generation
            AND metrics_media_generation IS NOT NULL AND metrics_media_generation BETWEEN 0 AND 4294967295
            AND metrics_lifecycle_epoch IS NOT NULL AND metrics_lifecycle_epoch>=0
            AND metrics_startup_origin IS NOT NULL AND metrics_startup_origin IN('user_intent','automatic_load')
            AND metrics_admitted_at IS NOT NULL AND metrics_seq BETWEEN 0 AND 9007199254740991
            AND ((metrics_seq=0 AND metrics_payload IS NULL
                    AND metrics_anchor_elapsed_ms IS NULL AND metrics_anchor_received_at IS NULL)
                OR (metrics_seq>0 AND metrics_payload IS NOT NULL
                    AND jsonb_typeof(metrics_payload)='object'
                    AND octet_length(metrics_payload::text)<=4096
                    AND metrics_anchor_elapsed_ms IS NOT NULL AND metrics_anchor_elapsed_ms BETWEEN 0 AND 604800000
                    AND metrics_anchor_received_at IS NOT NULL)))
    );
