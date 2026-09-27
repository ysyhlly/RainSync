CREATE SEQUENCE media_queue_turn_seq;
-- NULL is one legacy/system bucket, never an unlimited source of new priorities.
CREATE TABLE media_queue_turns (
    user_id uuid UNIQUE NULLS NOT DISTINCT REFERENCES users(id) ON DELETE CASCADE,
    last_turn bigint NOT NULL
);
