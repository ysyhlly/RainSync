-- One optional client-reported metrics slot per already bounded viewer identity.
-- Never delete or evict this durable high-water state to reclaim telemetry space.
ALTER TABLE playback_viewer_plans
    ADD COLUMN metrics_meter_start_generation bigint,
    ADD COLUMN metrics_media_generation bigint,
    ADD COLUMN metrics_lifecycle_epoch bigint,
    ADD COLUMN metrics_startup_origin text,
    ADD COLUMN metrics_seq bigint NOT NULL DEFAULT 0,
    ADD COLUMN metrics_payload jsonb,
    ADD COLUMN metrics_closed boolean NOT NULL DEFAULT false,
    ADD COLUMN metrics_admitted_at timestamptz,
    ADD COLUMN metrics_anchor_elapsed_ms bigint,
    ADD COLUMN metrics_anchor_received_at timestamptz,
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
            AND metrics_lifecycle_epoch IS NOT NULL AND metrics_lifecycle_epoch>=1
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

-- Only successfully published opted-in grants receive this marker. Legacy and
-- provisional grants keep NULL; they cannot use the independent metrics route.
ALTER TABLE playback_sessions
    ADD COLUMN playback_metrics_version integer,
    ADD COLUMN metrics_meter_start_generation bigint,
    ADD CONSTRAINT playback_session_metrics_pair CHECK (
        (playback_metrics_version IS NULL AND metrics_meter_start_generation IS NULL)
        OR (playback_metrics_version IS NOT NULL AND playback_metrics_version=1
            AND metrics_meter_start_generation IS NOT NULL
            AND user_id IS NOT NULL AND room_id IS NOT NULL
            AND viewer_id IS NOT NULL AND plan_generation IS NOT NULL
            AND metrics_meter_start_generation BETWEEN 1 AND plan_generation)
    );
