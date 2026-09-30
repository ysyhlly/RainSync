-- Additive: existing room snapshots, invitations and playback grants are retained.
-- Ownership changes are audited independently of the short-lived playback log.
CREATE TABLE room_ownership_events (
    id uuid PRIMARY KEY,
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    actor_id uuid NOT NULL REFERENCES users(id),
    previous_owner_id uuid NOT NULL REFERENCES users(id),
    owner_id uuid NOT NULL REFERENCES users(id),
    revision bigint NOT NULL CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (previous_owner_id <> owner_id),
    UNIQUE (room_id, revision)
);
