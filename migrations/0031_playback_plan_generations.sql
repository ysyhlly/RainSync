-- Additive opt-in fencing. Legacy grants remain NULL and keep their behavior.
-- The durable high-water mark survives cancelled/failed requests and media or
-- lifecycle changes. viewer_id is an untrusted correlation ID, never authority.
CREATE TABLE playback_viewer_plans (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    viewer_id uuid NOT NULL,
    plan_generation bigint NOT NULL CHECK (plan_generation BETWEEN 1 AND 4294967295),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, room_id, viewer_id)
);

ALTER TABLE playback_sessions
    ADD COLUMN viewer_id uuid,
    ADD COLUMN plan_generation bigint,
    ADD CONSTRAINT playback_session_plan_pair CHECK (
        (viewer_id IS NULL AND plan_generation IS NULL)
        OR (viewer_id IS NOT NULL AND plan_generation IS NOT NULL
            AND plan_generation BETWEEN 1 AND 4294967295)
    );
CREATE INDEX playback_sessions_viewer_plan
    ON playback_sessions(user_id, room_id, viewer_id, plan_generation)
    WHERE viewer_id IS NOT NULL;

ALTER TABLE playback_requests
    ADD COLUMN viewer_id uuid,
    ADD COLUMN plan_generation bigint,
    ADD CONSTRAINT playback_request_plan_pair CHECK (
        (viewer_id IS NULL AND plan_generation IS NULL)
        OR (viewer_id IS NOT NULL AND plan_generation IS NOT NULL
            AND plan_generation BETWEEN 1 AND 4294967295)
    );
CREATE INDEX playback_requests_viewer_plan
    ON playback_requests(user_id, room_id, viewer_id, plan_generation)
    WHERE viewer_id IS NOT NULL;
