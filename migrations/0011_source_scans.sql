CREATE TABLE source_scans (
    source_id uuid PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    generation uuid NOT NULL
);
CREATE INDEX media_items_available_id ON media_items(id) WHERE available;
