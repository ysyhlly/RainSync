-- Keep the original result even after a room is closed or removed. room_id
-- deliberately has no room FK: deleting a room must not make an old retry
-- create a new room. The request and all room rows commit in one transaction.
CREATE TABLE room_creation_requests (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_key text NOT NULL CHECK (
        length(request_key) BETWEEN 1 AND 128
        AND request_key ~ '^[A-Za-z0-9._:-]+$'
    ),
    name text NOT NULL,
    room_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, request_key)
);
