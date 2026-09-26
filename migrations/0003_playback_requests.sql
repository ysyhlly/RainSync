CREATE TABLE playback_requests (
    user_id uuid NOT NULL REFERENCES users(id),
    idempotency_key uuid NOT NULL,
    request_hash text NOT NULL,
    session_id uuid NOT NULL UNIQUE,
    owner_epoch uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('pending','completed','failed')),
    response_encrypted text,
    error_status smallint,
    error_code text,
    lease_until timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, idempotency_key),
    CHECK (
        (status='pending' AND response_encrypted IS NULL AND error_status IS NULL AND error_code IS NULL)
        OR (status='completed' AND response_encrypted IS NOT NULL AND error_status IS NULL AND error_code IS NULL)
        OR (status='failed' AND response_encrypted IS NULL AND error_status IS NOT NULL AND error_code IS NOT NULL)
    )
);
CREATE INDEX playback_requests_expiry ON playback_requests(expires_at);
CREATE INDEX playback_requests_pending ON playback_requests(user_id,lease_until) WHERE status='pending';
