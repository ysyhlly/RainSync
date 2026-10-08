-- Closed in-process metadata transforms. This table never contains executable code,
-- remote endpoints, credentials, host paths or dynamically granted permissions.
CREATE FUNCTION rainsync_plugin_config_valid(id text, version text, config jsonb, permissions jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF version NOT IN ('1.0.0','1.1.0') OR permissions IS DISTINCT FROM '["metadata:read"]'::jsonb OR jsonb_typeof(config) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF id='metadata.duration-badge' THEN
  RETURN (SELECT count(*) FROM jsonb_object_keys(config))=1 AND config->>'format' IN ('minutes','clock');
 ELSIF id='metadata.title-label' THEN
  RETURN (SELECT count(*) FROM jsonb_object_keys(config))=1 AND jsonb_typeof(config->'label')='string' AND length(config->>'label') BETWEEN 1 AND 40 AND NOT (config->>'label' ~ '[[:cntrl:]]');
 END IF;
 RETURN false;
END $$;
CREATE TABLE rainsync_plugins (
 id text PRIMARY KEY CHECK(id IN ('metadata.duration-badge','metadata.title-label')),
 version text NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 config jsonb NOT NULL,
 granted_permissions jsonb NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),
 artifact_digest text NOT NULL CHECK(artifact_digest ~ '^[0-9a-f]{64}$'),
 previous_state jsonb,
 updated_by uuid NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(rainsync_plugin_config_valid(id,version,config,granted_permissions))
);
CREATE TABLE rainsync_plugin_audit (
 id uuid PRIMARY KEY,
 plugin_id text NOT NULL REFERENCES rainsync_plugins(id),
 actor_id uuid NOT NULL REFERENCES users(id),
 revision bigint NOT NULL CHECK(revision>0),
 action text NOT NULL CHECK(action IN ('install','configure','upgrade','rollback','enable','disable')),
 artifact_digest text NOT NULL CHECK(artifact_digest ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rainsync_plugin_audit_recent ON rainsync_plugin_audit(plugin_id,created_at DESC);
