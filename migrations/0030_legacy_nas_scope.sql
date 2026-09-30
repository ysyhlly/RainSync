-- Narrow legacy uncertainty by causality, never by timestamps or guessed drain.
-- Every room that could precede a legacy offer remains inside that offer's
-- immutable cutoff. Both insertion paths lock the same transactional counter
-- until commit, so allocation order cannot diverge from visibility order.
LOCK TABLE rooms, playback_sessions, agent_transfer_runs IN ACCESS EXCLUSIVE MODE;

CREATE TABLE room_cleanup_birth_counter (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    ordinal bigint NOT NULL CHECK (ordinal >= 0)
);
ALTER TABLE rooms ADD COLUMN cleanup_birth_ordinal bigint;
WITH numbered AS (
    SELECT id,row_number() OVER (ORDER BY id) AS ordinal FROM rooms
)
UPDATE rooms r SET cleanup_birth_ordinal=n.ordinal FROM numbered n WHERE n.id=r.id;
ALTER TABLE rooms ALTER COLUMN cleanup_birth_ordinal SET NOT NULL;
ALTER TABLE rooms ADD CONSTRAINT room_cleanup_birth_positive CHECK (cleanup_birth_ordinal > 0);
ALTER TABLE rooms ADD CONSTRAINT room_cleanup_birth_unique UNIQUE (cleanup_birth_ordinal);
INSERT INTO room_cleanup_birth_counter(singleton,ordinal) SELECT true,count(*) FROM rooms;

ALTER TABLE agent_transfer_runs ADD COLUMN possible_room_cutoff bigint;
UPDATE agent_transfer_runs SET possible_room_cutoff=(SELECT ordinal FROM room_cleanup_birth_counter)
    WHERE legacy_unconfirmed;
ALTER TABLE agent_transfer_runs ADD CONSTRAINT legacy_room_cutoff_valid CHECK (
    (legacy_unconfirmed AND possible_room_cutoff IS NOT NULL AND possible_room_cutoff >= 0)
    OR (NOT legacy_unconfirmed AND possible_room_cutoff IS NULL)
);
CREATE INDEX agent_transfer_runs_legacy_scope ON agent_transfer_runs(possible_room_cutoff)
    WHERE legacy_unconfirmed;

CREATE FUNCTION assign_room_cleanup_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' THEN
        IF NEW.id IS DISTINCT FROM OLD.id
            OR NEW.cleanup_birth_ordinal IS DISTINCT FROM OLD.cleanup_birth_ordinal THEN
            RAISE EXCEPTION 'room_cleanup_birth_immutable';
        END IF;
    ELSE
        IF NEW.cleanup_birth_ordinal IS NOT NULL THEN
            RAISE EXCEPTION 'room_cleanup_birth_database_assigned';
        END IF;
        UPDATE room_cleanup_birth_counter SET ordinal=ordinal+1
            WHERE singleton RETURNING ordinal INTO STRICT NEW.cleanup_birth_ordinal;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER assign_room_cleanup_birth BEFORE INSERT OR UPDATE ON rooms
    FOR EACH ROW EXECUTE FUNCTION assign_room_cleanup_birth();

-- A historical grant cannot be moved into a room outside an old offer's scope.
-- Ordinary grant finalization may update its resource/expiry, never its owner.
CREATE FUNCTION preserve_playback_room_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.room_id IS DISTINCT FROM OLD.room_id THEN
        RAISE EXCEPTION 'playback_room_identity_immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_playback_room_identity BEFORE UPDATE OF id,room_id ON playback_sessions
    FOR EACH ROW EXECUTE FUNCTION preserve_playback_room_identity();

CREATE FUNCTION assign_legacy_room_cutoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' THEN
        IF NEW.legacy_unconfirmed IS DISTINCT FROM OLD.legacy_unconfirmed
            OR NEW.possible_room_cutoff IS DISTINCT FROM OLD.possible_room_cutoff THEN
            RAISE EXCEPTION 'legacy_room_scope_immutable';
        END IF;
    ELSE
        IF NEW.possible_room_cutoff IS NOT NULL THEN
            RAISE EXCEPTION 'legacy_room_scope_database_assigned';
        END IF;
        IF NEW.legacy_unconfirmed THEN
            -- UPDATE, rather than a snapshot SELECT, orders this offer after
            -- preceding room commits and before any later room insertion.
            UPDATE room_cleanup_birth_counter SET ordinal=ordinal
                WHERE singleton RETURNING ordinal INTO STRICT NEW.possible_room_cutoff;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER assign_legacy_room_cutoff BEFORE INSERT OR UPDATE ON agent_transfer_runs
    FOR EACH ROW EXECUTE FUNCTION assign_legacy_room_cutoff();

-- Protect the watermark from ordinary direct DML. Only nested insertion
-- triggers may advance it by one or retain it while taking its row lock.
-- Privileged schema/trigger tampering is outside the application trust model.
CREATE FUNCTION protect_room_cleanup_birth_counter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'room_cleanup_birth_counter_managed';
    END IF;
    IF pg_trigger_depth() < 2 OR NEW.singleton IS DISTINCT FROM OLD.singleton
        OR NEW.ordinal < OLD.ordinal OR NEW.ordinal > OLD.ordinal+1 THEN
        RAISE EXCEPTION 'room_cleanup_birth_counter_managed';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER protect_room_cleanup_birth_counter BEFORE INSERT OR UPDATE OR DELETE ON room_cleanup_birth_counter
    FOR EACH ROW EXECUTE FUNCTION protect_room_cleanup_birth_counter();
CREATE TRIGGER protect_room_cleanup_birth_counter_truncate BEFORE TRUNCATE ON room_cleanup_birth_counter
    FOR EACH STATEMENT EXECUTE FUNCTION protect_room_cleanup_birth_counter();
