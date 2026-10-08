ALTER TABLE sources DROP CONSTRAINT sources_kind_check;
ALTER TABLE sources ADD CONSTRAINT sources_kind_check CHECK(kind IN('local','http','jellyfin','emby','agent','s3'));
CREATE TABLE s3_index_scans (
 source_id uuid PRIMARY KEY REFERENCES sources(id), scan_id uuid NOT NULL,
 source_revision bigint NOT NULL CHECK(source_revision>=0), continuation_token text,
 status text NOT NULL CHECK(status IN('running','failed','completed')),
 item_count bigint NOT NULL DEFAULT 0 CHECK(item_count>=0), page_count bigint NOT NULL DEFAULT 0 CHECK(page_count>=0),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 last_error text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(continuation_token IS NULL OR octet_length(continuation_token)<=16384),
 CHECK(last_error IS NULL OR last_error IN('s3_scan_failed','source_changed')),
 CHECK((status='completed')=(completed_at IS NOT NULL))
);
CREATE TABLE s3_index_scan_seen (
 source_id uuid NOT NULL REFERENCES sources(id), scan_id uuid NOT NULL, resource text NOT NULL,
 PRIMARY KEY(source_id,scan_id,resource)
);
-- HTTP replacement validators are not content hashes; preserve explicit S3 version identity.
ALTER TABLE media_items ADD COLUMN s3_object_identity jsonb;
ALTER TABLE media_items ADD CONSTRAINT s3_object_identity_shape CHECK(s3_object_identity IS NULL OR
 (jsonb_typeof(s3_object_identity)='object' AND s3_object_identity ?& ARRAY['key','version_id','etag','size']));

CREATE TABLE s3_index_scan_cursors (
 source_id uuid NOT NULL REFERENCES sources(id), scan_id uuid NOT NULL,
 cursor_sha256 text NOT NULL CHECK(cursor_sha256 ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(source_id,scan_id,cursor_sha256)
);
