CREATE TABLE control_epochs (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    issued_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
    CHECK (expires_at <= issued_at + interval '24 hours')
);
CREATE INDEX control_epochs_expiry ON control_epochs(expires_at);
