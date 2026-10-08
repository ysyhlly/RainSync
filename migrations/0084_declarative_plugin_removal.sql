-- Keep catalog identity, revision fencing and metadata-only audit history while
-- allowing operators to erase saved plugin configuration and explicit grants.
ALTER TABLE rainsync_plugins ADD COLUMN removed boolean NOT NULL DEFAULT false;
ALTER TABLE rainsync_plugins DROP CONSTRAINT rainsync_plugins_check;
ALTER TABLE rainsync_plugins ADD CONSTRAINT rainsync_plugin_state_valid CHECK (
    (NOT removed AND rainsync_plugin_config_valid(id,version,config,granted_permissions))
    OR (removed AND NOT enabled AND config='{}'::jsonb
        AND granted_permissions='[]'::jsonb AND previous_state IS NULL)
);
ALTER TABLE rainsync_plugin_audit DROP CONSTRAINT rainsync_plugin_audit_action_check;
ALTER TABLE rainsync_plugin_audit ADD CONSTRAINT rainsync_plugin_audit_action_check
    CHECK(action IN ('install','configure','upgrade','rollback','enable','disable','remove'));
