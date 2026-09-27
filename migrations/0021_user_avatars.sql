CREATE TABLE user_avatars (
    user_id uuid PRIMARY KEY REFERENCES users(id),
    version uuid NOT NULL,
    content_type text CHECK (content_type = 'image/webp'),
    content bytea CHECK (octet_length(content) BETWEEN 1 AND 262144),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((content IS NULL) = (content_type IS NULL))
);
-- Keep tombstone versions and operation identities: a delayed upload or replay
-- must never reactivate an avatar after replacement/restoration of the default.
CREATE TABLE avatar_operations (
    user_id uuid NOT NULL REFERENCES users(id),
    operation_id uuid NOT NULL,
    expected_version uuid,
    action text NOT NULL CHECK (action IN ('upload', 'delete')),
    request_hash text NOT NULL CHECK (length(request_hash) = 64),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, operation_id)
);
