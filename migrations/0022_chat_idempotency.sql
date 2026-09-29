-- Nullable for historical rows and older clients without a correlation key.
ALTER TABLE chat_messages ADD COLUMN client_message_id uuid;
CREATE UNIQUE INDEX chat_messages_client_message
    ON chat_messages(room_id, user_id, client_message_id);
