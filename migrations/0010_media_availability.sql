-- Keep referenced media IDs for historical rooms/sessions while removing vanished files from the library.
ALTER TABLE media_items ADD COLUMN available boolean NOT NULL DEFAULT true;
