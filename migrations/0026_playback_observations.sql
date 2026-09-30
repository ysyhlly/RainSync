-- Only explicitly negotiated v1 grants enter this table. Existing grants keep
-- their compatibility reporting path; no room-clock value is backfilled here.
CREATE TABLE playback_observations (
    -- Cleanup must retain the last fixed sample after a grant/user is removed,
    -- just as the upstream ledger retains its immutable scope and identity.
    session_id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    room_id uuid NOT NULL,
    media_id uuid NOT NULL,
    generation bigint NOT NULL CHECK (generation BETWEEN 0 AND 4294967295),
    timeline_origin_ms double precision NOT NULL
        CHECK (timeline_origin_ms >= 0 AND timeline_origin_ms <= 900719925474),
    duration_ms double precision
        CHECK (duration_ms >= 0 AND duration_ms <= 900719924474),
    seq bigint NOT NULL DEFAULT 0 CHECK (seq BETWEEN 0 AND 9007199254740991),
    payload jsonb,
    position_ms double precision
        CHECK (position_ms >= 0 AND position_ms <= 900719925474),
    has_played boolean NOT NULL DEFAULT false,
    observed_at timestamptz,
    reported_seq bigint NOT NULL DEFAULT 0 CHECK (reported_seq BETWEEN 0 AND seq),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((seq=0 AND payload IS NULL AND position_ms IS NULL AND observed_at IS NULL)
        OR (seq>0 AND payload IS NOT NULL AND position_ms IS NOT NULL AND observed_at IS NOT NULL))
);

-- Persist the captured sample with the I/O claim. A newer accepted observation
-- cannot change an already submitted Start/Progress/Stop payload or its ACK.
ALTER TABLE upstream_reservations ADD COLUMN io_observation_seq bigint;
ALTER TABLE upstream_reservations ADD COLUMN io_observation jsonb;
-- Negotiation ownership predates final plan publication. Keep its v1 marker
-- even when that final transaction fails and its observation row rolls back.
ALTER TABLE upstream_reservations ADD COLUMN observation_version integer
    CHECK (observation_version=1);
ALTER TABLE upstream_reservations ADD CONSTRAINT upstream_observation_claim CHECK (
    (io_observation_seq IS NULL AND io_observation IS NULL)
    OR (io_claim IS NOT NULL AND io_observation_seq BETWEEN 0 AND 9007199254740991
        AND io_observation IS NOT NULL)
);
