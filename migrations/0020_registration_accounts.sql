-- Additive schema: legacy INSERT INTO users/sessions VALUES (...) remains valid.
CREATE TABLE user_profiles (
    user_id uuid PRIMARY KEY REFERENCES users(id),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 50 AND btrim(display_name) <> '')
);

CREATE TABLE registration_invite_batches (
    id uuid PRIMARY KEY,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    count integer NOT NULL CHECK (count BETWEEN 1 AND 50),
    valid_days integer NOT NULL CHECK (valid_days IN (1, 7, 30)),
    note text CHECK (char_length(note) <= 60)
);

CREATE TABLE registration_invites (
    id uuid PRIMARY KEY,
    batch_id uuid NOT NULL REFERENCES registration_invite_batches(id),
    code_hash text UNIQUE NOT NULL CHECK (length(code_hash) = 64),
    code_suffix text NOT NULL CHECK (length(code_suffix) = 4),
    expires_at timestamptz NOT NULL,
    used_by uuid REFERENCES users(id),
    used_at timestamptz,
    revoked_by uuid REFERENCES users(id),
    revoked_at timestamptz,
    CHECK ((used_by IS NULL) = (used_at IS NULL)),
    CHECK ((revoked_by IS NULL) = (revoked_at IS NULL)),
    CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX registration_invites_batch ON registration_invites(batch_id, id);
CREATE INDEX registration_invite_batches_order ON registration_invite_batches(created_at DESC, id DESC);
CREATE INDEX registration_invites_expiry ON registration_invites(expires_at) WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE account_rate_limits (
    scope text NOT NULL,
    key_hash text NOT NULL,
    window_started timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts integer NOT NULL CHECK (attempts > 0),
    PRIMARY KEY (scope, key_hash)
);
CREATE INDEX account_rate_limits_expiry ON account_rate_limits(expires_at);
