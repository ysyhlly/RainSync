-- Retain one child claim per published parent. This migration does not enable
-- child capture/encoding: those require their own owner and publication gates.
LOCK TABLE playback_requests IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE static_hls_captures IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE playback_sessions IN ACCESS EXCLUSIVE MODE NOWAIT;

ALTER TABLE playback_requests
    ADD COLUMN static_hls_parent_capture_id uuid
        REFERENCES static_hls_captures(id) ON DELETE RESTRICT,
    ADD CONSTRAINT static_hls_child_request_shape CHECK (
        static_hls_parent_capture_id IS NULL OR
        (static_hls_input_version IS NOT NULL AND static_hls_input_version=1
         AND static_hls_parent_capture_id<>static_hls_operation_id));
CREATE UNIQUE INDEX static_hls_one_child_per_parent
    ON playback_requests(static_hls_parent_capture_id)
    WHERE static_hls_parent_capture_id IS NOT NULL;

CREATE FUNCTION protect_static_hls_child_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent static_hls_captures; original playback_requests;
BEGIN
    IF TG_OP='UPDATE' THEN
        IF NEW.static_hls_parent_capture_id IS DISTINCT FROM OLD.static_hls_parent_capture_id THEN
            RAISE EXCEPTION 'static_hls_child_claim_immutable';
        END IF;
        IF NEW.static_hls_parent_capture_id IS NOT NULL AND NEW.status='completed' THEN
            -- Do not allow the parent's unmarked ordinary fallback completion
            -- to publish a child before the child publication migration exists.
            RAISE EXCEPTION 'static_hls_child_publication_unavailable';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP='DELETE' THEN
        -- A terminal/expired request must not make its parent claim reusable.
        IF OLD.static_hls_parent_capture_id IS NOT NULL THEN
            RAISE EXCEPTION 'static_hls_child_claim_retained';
        END IF;
        RETURN OLD;
    END IF;
    IF NEW.static_hls_parent_capture_id IS NULL THEN RETURN NEW; END IF;
    IF NOT static_hls_pending_reader_supported() THEN
        RAISE EXCEPTION 'static_hls_pending_reader_required';
    END IF;
    SELECT * INTO parent FROM static_hls_captures WHERE id=NEW.static_hls_parent_capture_id;
    SELECT * INTO original FROM playback_requests WHERE session_id=parent.session_id;
    IF parent.id IS NULL OR original.session_id IS NULL
        OR parent.publication_phase<>'published_parent'
        OR NOT static_hls_published_parent_authority_allowed(parent.id)
        OR NEW.status<>'pending' OR NEW.response_encrypted IS NOT NULL
        OR NEW.session_id=parent.session_id
        OR NEW.session_id=parent.id OR NEW.static_hls_operation_id=parent.id
        OR NEW.static_hls_operation_id=parent.session_id
        OR original.static_hls_parent_capture_id IS NOT NULL
        OR NEW.created_at>clock_timestamp()
        OR NEW.static_hls_prepare_expires_at<=clock_timestamp()
        OR NEW.static_hls_root_expires_at<=clock_timestamp()
        OR NEW.static_hls_root_expires_at IS DISTINCT FROM parent.expires_at
        OR NEW.static_hls_worker_instance IS DISTINCT FROM parent.worker_instance
        OR NEW.static_hls_database_id IS DISTINCT FROM parent.database_id
        OR ROW(NEW.user_id,NEW.room_id,NEW.lifecycle_epoch,NEW.auth_login_hash,
               NEW.auth_membership_epoch,NEW.viewer_id,NEW.static_hls_media_id,
               NEW.static_hls_media_generation,NEW.static_hls_source_id,
               NEW.static_hls_source_revision,NEW.static_hls_source_generation)
           IS DISTINCT FROM
           ROW(original.user_id,original.room_id,original.lifecycle_epoch,original.auth_login_hash,
               original.auth_membership_epoch,original.viewer_id,original.static_hls_media_id,
               original.static_hls_media_generation,original.static_hls_source_id,
               original.static_hls_source_revision,original.static_hls_source_generation)
        OR NEW.plan_generation<=original.plan_generation
        OR NEW.created_at<parent.published_at THEN
        RAISE EXCEPTION 'static_hls_child_parent_authority_required';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_child_claim_guard
    BEFORE INSERT OR UPDATE OR DELETE ON playback_requests
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_claim();

CREATE FUNCTION protect_static_hls_child_capture_phase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM playback_requests r WHERE r.session_id=NEW.session_id
        AND r.static_hls_parent_capture_id IS NOT NULL) THEN
        -- Prevent a child input from entering the existing parent admission path.
        RAISE EXCEPTION 'static_hls_child_capture_unavailable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER static_hls_child_capture_phase_guard
    BEFORE INSERT OR UPDATE ON static_hls_captures
    FOR EACH ROW EXECUTE FUNCTION protect_static_hls_child_capture_phase();

CREATE FUNCTION check_static_hls_child_claim_linkage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE child playback_requests; parent static_hls_captures; original playback_requests;
BEGIN
    SELECT * INTO child FROM playback_requests WHERE session_id=NEW.session_id;
    IF child.static_hls_parent_capture_id IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO parent FROM static_hls_captures WHERE id=child.static_hls_parent_capture_id;
    SELECT * INTO original FROM playback_requests WHERE session_id=parent.session_id;
    -- Check the committed transaction, not the intermediate insert: the parent
    -- must be terminalized and stopped without asserting physical drainage.
    IF original.status IS DISTINCT FROM 'failed'
        OR NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=parent.session_id AND p.stopped)
        OR NOT EXISTS(SELECT 1 FROM playback_preparations p WHERE p.session_id=child.session_id
            AND p.owner_epoch=child.owner_epoch AND p.user_id=child.user_id
            AND p.room_id=child.room_id AND p.lifecycle_epoch=child.lifecycle_epoch
            AND p.created_at=child.created_at)
        OR (child.status='pending' AND NOT static_hls_pending_request_authority_allowed(child.session_id)) THEN
        RAISE EXCEPTION 'static_hls_child_claim_atomicity_required';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER static_hls_child_claim_linkage
    AFTER INSERT OR UPDATE ON playback_requests DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_static_hls_child_claim_linkage();
