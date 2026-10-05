-- Preserve the bounded durable v1 slot. Only a known old metrics slot gets v1;
-- no old row acquires invented phase durations or first-frame attribution.
ALTER TABLE playback_viewer_plans ADD COLUMN metrics_version integer;
UPDATE playback_viewer_plans SET metrics_version=1 WHERE metrics_meter_start_generation IS NOT NULL;
ALTER TABLE playback_viewer_plans
    ADD COLUMN metrics_first_frame_source text,
    ADD COLUMN metrics_first_frame_mode text,
    ADD CONSTRAINT playback_viewer_metrics_version CHECK (
        (metrics_meter_start_generation IS NULL AND metrics_version IS NULL)
        OR (metrics_meter_start_generation IS NOT NULL AND metrics_version IS NOT NULL AND metrics_version IN (1,2))),
    ADD CONSTRAINT playback_viewer_metrics_attribution CHECK (
        (metrics_first_frame_source IS NULL AND metrics_first_frame_mode IS NULL)
        OR (metrics_version IS NOT NULL AND metrics_version=2 AND metrics_first_frame_source IS NOT NULL AND metrics_first_frame_mode IS NOT NULL AND metrics_payload IS NOT NULL AND metrics_payload ? 'first_frame' AND jsonb_typeof(metrics_payload->'first_frame')='object'
            AND metrics_first_frame_source IN ('local','http','agent','jellyfin','emby','unknown')
            AND metrics_first_frame_mode IN ('direct','remux','transcode','unknown')));

-- These are immutable publication facts, separate from the encrypted resource
-- whose authorization wrapper/representation may evolve after publication.
-- The historical lookup uses them for attribution only, never authorization.
ALTER TABLE playback_sessions DROP CONSTRAINT playback_session_metrics_pair;
ALTER TABLE playback_sessions
    ADD COLUMN metrics_source_kind text,
    ADD COLUMN metrics_delivery_mode text,
    ADD CONSTRAINT playback_session_metrics_pair CHECK (
        (playback_metrics_version IS NULL AND metrics_meter_start_generation IS NULL)
        OR (playback_metrics_version IS NOT NULL AND playback_metrics_version IN (1,2)
            AND metrics_meter_start_generation IS NOT NULL
            AND user_id IS NOT NULL AND room_id IS NOT NULL
            AND viewer_id IS NOT NULL AND plan_generation IS NOT NULL
            AND metrics_meter_start_generation BETWEEN 1 AND plan_generation)),
    ADD CONSTRAINT playback_session_metrics_attribution CHECK (
        (metrics_source_kind IS NULL AND metrics_delivery_mode IS NULL)
        OR (playback_metrics_version IS NOT NULL AND playback_metrics_version=2 AND metrics_source_kind IS NOT NULL AND metrics_delivery_mode IS NOT NULL
            AND metrics_source_kind IN ('local','http','agent','jellyfin','emby','unknown')
            AND metrics_delivery_mode IN ('direct','remux','transcode','unknown')));
