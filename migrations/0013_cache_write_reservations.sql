CREATE TABLE cache_budget (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    revision bigint NOT NULL DEFAULT 0
);
INSERT INTO cache_budget(singleton) VALUES(true);
CREATE TABLE cache_write_reservations (
    -- No cascading delete: snapshot() reclaims missing jobs and advances the
    -- budget revision, so an old filesystem measurement cannot miss released bytes.
    job_id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    attempt bigint NOT NULL,
    bytes bigint NOT NULL CHECK(bytes>0)
);
