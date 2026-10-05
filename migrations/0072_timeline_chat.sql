-- Shared activities are independent of viewer playback sessions/quality changes.
CREATE TABLE room_media_activities (
 id uuid PRIMARY KEY,
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 lifecycle_epoch bigint NOT NULL CHECK(lifecycle_epoch>=0),
 media_generation bigint NOT NULL CHECK(media_generation>=0),
 media_id uuid NOT NULL,
 source_identity text NOT NULL CHECK(source_identity ~ '^[0-9a-f]{64}$'),
 versioned boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(room_id,lifecycle_epoch,media_generation,media_id,source_identity),
 UNIQUE(id,room_id)
);
ALTER TABLE chat_messages ADD COLUMN media_activity_id uuid;
ALTER TABLE chat_messages ADD COLUMN media_time_ms bigint;
ALTER TABLE chat_messages ADD COLUMN anchor_source text;
ALTER TABLE chat_messages ADD COLUMN deleted_at timestamptz;
ALTER TABLE chat_messages ADD COLUMN body_digest text;
ALTER TABLE chat_messages ADD CONSTRAINT chat_activity_room_fk FOREIGN KEY(media_activity_id,room_id) REFERENCES room_media_activities(id,room_id) ON DELETE CASCADE;
ALTER TABLE chat_messages ADD CONSTRAINT chat_anchor_valid CHECK (
 (media_activity_id IS NULL AND media_time_ms IS NULL AND anchor_source IS NULL) OR
 (media_activity_id IS NOT NULL AND media_time_ms BETWEEN 0 AND 604800000 AND anchor_source IN ('server_received','client_reported'))
);
CREATE INDEX chat_timeline_page ON chat_messages(room_id,media_activity_id,created_at,id);
ALTER TABLE room_members ADD COLUMN chat_moderator boolean NOT NULL DEFAULT false;
ALTER TABLE room_members ADD COLUMN chat_muted_until timestamptz;
ALTER TABLE room_members ADD COLUMN reaction_tokens double precision NOT NULL DEFAULT 5 CHECK(reaction_tokens BETWEEN 0 AND 5);
ALTER TABLE room_members ADD COLUMN reaction_refilled_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE room_chat_audit (
 id uuid PRIMARY KEY,
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES users(id),
 target_user_id uuid REFERENCES users(id),
 message_id uuid,
 action text NOT NULL CHECK(action IN ('delete','mute','unmute','remove','moderator')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_chat_audit_recent ON room_chat_audit(room_id,created_at DESC);
-- Receipts retain only a digest for 48h; visible reactions expire after 8s.
CREATE TABLE room_reaction_receipts (
 id uuid PRIMARY KEY,
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id),
 client_reaction_id uuid NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(room_id,user_id,client_reaction_id)
);
CREATE TABLE room_reactions (
 id uuid PRIMARY KEY REFERENCES room_reaction_receipts(id) ON DELETE CASCADE,
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id),
 activity_id uuid NOT NULL,
 media_time_ms bigint NOT NULL CHECK(media_time_ms BETWEEN 0 AND 604800000),
 emoji text NOT NULL CHECK(emoji IN ('👏','😂','❤️','😮','🎉','😢')),
 expires_at timestamptz NOT NULL DEFAULT (now()+interval '8 seconds'),
 FOREIGN KEY(activity_id,room_id) REFERENCES room_media_activities(id,room_id) ON DELETE CASCADE
);
CREATE INDEX room_reaction_window ON room_reactions(room_id,expires_at);
