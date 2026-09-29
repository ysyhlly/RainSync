ALTER TABLE media_items
  ADD COLUMN shared_title text CHECK (shared_title IS NULL OR char_length(shared_title) BETWEEN 1 AND 200),
  ADD COLUMN shared_title_revision bigint NOT NULL DEFAULT 0 CHECK (shared_title_revision >= 0);

CREATE TABLE media_user_titles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (user_id, media_id)
);
