-- Closed allowlist of non-secret admission limits and explicit access modes.
-- NULL preserves each process's validated deployment baseline, including on upgrade.
CREATE TABLE admin_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    playback_session_limit bigint CHECK (playback_session_limit BETWEEN 1 AND 10000),
    media_queue_limit bigint CHECK (media_queue_limit BETWEEN 1 AND 10000),
    registration_validate_per_minute bigint CHECK (registration_validate_per_minute BETWEEN 1 AND 10000),
    registration_per_ten_minutes bigint CHECK (registration_per_ten_minutes BETWEEN 1 AND 10000),
    registration_mode text CHECK (registration_mode IN ('closed','invite_only','open')),
    guests_enabled boolean,
    updated_at timestamptz,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO admin_settings (singleton) VALUES (true);
