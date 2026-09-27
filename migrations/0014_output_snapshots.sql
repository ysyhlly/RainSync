ALTER TABLE media_outputs
    ADD COLUMN visible_manifest text CHECK (octet_length(visible_manifest) <= 2097152),
    ADD COLUMN ready_segments integer NOT NULL DEFAULT 0 CHECK (ready_segments >= 0);
-- Previously generated output retains its original verification contract.
ALTER TABLE media_outputs ALTER COLUMN validation_version SET DEFAULT 2;
CREATE TABLE media_output_files (
    job_id uuid NOT NULL,
    attempt bigint NOT NULL,
    segment_index integer NOT NULL CHECK (segment_index >= -1),
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (job_id, attempt, segment_index),
    FOREIGN KEY (job_id, attempt) REFERENCES media_outputs(job_id, attempt) ON DELETE CASCADE
);
-- segment_index -1 names init.mp4; all other indices name indexN.m4s.
