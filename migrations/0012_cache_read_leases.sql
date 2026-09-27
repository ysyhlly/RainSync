-- Extend the original cache catalog without dropping legacy keys or paths.
ALTER TABLE cache_entries
    ADD COLUMN id uuid UNIQUE,
    ADD COLUMN state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','evicting','evicted')),
    ADD COLUMN eviction_owner uuid,
    ADD COLUMN eviction_until timestamptz,
    ADD COLUMN evicted_at timestamptz;
UPDATE cache_entries SET id=cache_key::uuid
WHERE cache_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
CREATE TABLE cache_read_leases (
    id uuid PRIMARY KEY,
    cache_id uuid NOT NULL REFERENCES cache_entries(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX cache_read_leases_entry_expiry ON cache_read_leases(cache_id,expires_at);
CREATE INDEX cache_read_leases_expiry ON cache_read_leases(expires_at);
