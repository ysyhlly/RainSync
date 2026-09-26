CREATE TABLE login_attempts (
    username_hash text PRIMARY KEY,
    window_started timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 11)
);
CREATE INDEX login_attempts_window ON login_attempts(window_started);
