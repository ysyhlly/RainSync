-- Optional envelopes do not reinterpret or backfill historical event facts.
ALTER TABLE room_events ADD COLUMN diagnostic jsonb;
ALTER TABLE room_events ADD CONSTRAINT room_events_diagnostic_bound CHECK (
    diagnostic IS NULL OR (
        jsonb_typeof(diagnostic) = 'object'
        AND octet_length(diagnostic::text) <= 8192
    )
);
