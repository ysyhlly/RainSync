-- This ledger survives failed prepare transactions, request retention cleanup,
-- and removal of mutable source configuration. Credentials and wire responses
-- are encrypted with the site key; audit identifiers intentionally have no FK.
CREATE TABLE upstream_reservations (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    request_key uuid NOT NULL,
    owner_epoch uuid NOT NULL,
    room_id uuid NOT NULL,
    media_id uuid NOT NULL,
    source_id uuid NOT NULL,
    generation bigint NOT NULL,
    kind text NOT NULL CHECK (kind IN ('jellyfin','emby')),
    device_id text NOT NULL UNIQUE,
    origin_key text NOT NULL,
    scope_encrypted text NOT NULL,
    response_encrypted text,
    play_session_id text,
    media_source_id text,
    live_stream_id text,
    play_method text,
    state text NOT NULL DEFAULT 'preparing'
        CHECK (state IN ('preparing','active','closing','closed','cleanup_failed')),
    negotiation text NOT NULL DEFAULT 'reserved'
        CHECK (negotiation IN ('reserved','running','received','not_sent','unknown')),
    negotiation_token uuid,
    negotiation_deadline timestamptz,
    io_claim uuid,
    io_kind text CHECK (io_kind IN ('negotiate','start','progress','stop')),
    io_lease_until timestamptz,
    -- A local timeout cannot fence a request already executing at the upstream.
    io_uncertain boolean NOT NULL DEFAULT false,
    start_reported boolean NOT NULL DEFAULT false,
    last_report_at timestamptz,
    stop_confirmed boolean NOT NULL DEFAULT false,
    encoding_stop_confirmed boolean NOT NULL DEFAULT false,
    cleanup_attempts integer NOT NULL DEFAULT 0 CHECK (cleanup_attempts BETWEEN 0 AND 5),
    cleanup_after timestamptz,
    cleanup_deadline timestamptz,
    close_reason text,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    closed_at timestamptz,
    CHECK ((io_claim IS NULL AND io_kind IS NULL AND io_lease_until IS NULL)
        OR (io_claim IS NOT NULL AND io_kind IS NOT NULL AND io_lease_until IS NOT NULL)),
    CHECK (state <> 'active' OR (negotiation='received' AND play_session_id IS NOT NULL)),
    CHECK (state <> 'closed' OR negotiation='not_sent'
        OR (stop_confirmed AND (kind='jellyfin' OR encoding_stop_confirmed) AND NOT io_uncertain))
);
CREATE INDEX upstream_reservations_room ON upstream_reservations(room_id,generation)
    WHERE state IN ('preparing','active');
CREATE INDEX upstream_reservations_cleanup ON upstream_reservations(cleanup_after,created_at)
    WHERE state='closing';
CREATE INDEX upstream_reservations_active ON upstream_reservations(last_report_at)
    WHERE state='active';
