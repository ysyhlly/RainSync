-- Additive lifecycle fencing. Existing rooms and grants remain in epoch zero.
ALTER TABLE rooms ADD COLUMN lifecycle text NOT NULL DEFAULT 'active'
    CHECK (lifecycle IN ('active','closing','closed','archived'));
ALTER TABLE rooms ADD COLUMN lifecycle_epoch bigint NOT NULL DEFAULT 0 CHECK (lifecycle_epoch >= 0);
ALTER TABLE playback_sessions ADD COLUMN lifecycle_epoch bigint NOT NULL DEFAULT 0 CHECK (lifecycle_epoch >= 0);
-- Legacy requests may not have a materialized session; do not guess their room.
ALTER TABLE playback_requests ADD COLUMN room_id uuid REFERENCES rooms(id);
ALTER TABLE playback_requests ADD COLUMN lifecycle_epoch bigint CHECK (lifecycle_epoch >= 0);
UPDATE playback_requests r SET room_id=p.room_id,lifecycle_epoch=p.lifecycle_epoch
    FROM playback_sessions p WHERE p.id=r.session_id;
CREATE INDEX playback_requests_room_epoch ON playback_requests(room_id,lifecycle_epoch);
CREATE TABLE room_lifecycle_events (
    id uuid PRIMARY KEY,
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    actor_id uuid REFERENCES users(id),
    previous_lifecycle text NOT NULL CHECK (previous_lifecycle IN ('active','closing','closed','archived')),
    lifecycle text NOT NULL CHECK (lifecycle IN ('active','closing','closed','archived')),
    lifecycle_epoch bigint NOT NULL CHECK (lifecycle_epoch >= 0),
    revision bigint NOT NULL CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (previous_lifecycle <> lifecycle),
    UNIQUE (room_id, revision)
);
