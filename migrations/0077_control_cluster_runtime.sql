-- Explicit, persistent opt-in. Old/unconfigured processes fail closed after activation.
CREATE TABLE control_cluster_activation (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 configuration_hash text NOT NULL CHECK(configuration_hash ~ '^[0-9a-f]{64}$'),
 activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE control_nodes ADD COLUMN incarnation uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE room_leases ADD COLUMN owner_incarnation uuid;
UPDATE room_leases l SET owner_incarnation=n.incarnation FROM control_nodes n WHERE n.id=l.owner_node;
ALTER TABLE room_leases ALTER COLUMN owner_incarnation SET NOT NULL;
ALTER TABLE room_leases ADD COLUMN prepared_fencing_token bigint;
ALTER TABLE room_leases ADD COLUMN prepared_clock_epoch uuid;
ALTER TABLE room_leases ADD COLUMN checkpoint_revision bigint;
ALTER TABLE room_leases ADD COLUMN checkpoint_generation bigint;
ALTER TABLE room_leases ADD COLUMN checkpoint_clock_epoch uuid;
ALTER TABLE room_leases ADD COLUMN checkpoint_position_ms double precision;
ALTER TABLE room_leases ADD COLUMN checkpoint_confirmed_at timestamptz;
ALTER TABLE room_leases ADD CONSTRAINT room_checkpoint_position_valid CHECK (
 checkpoint_position_ms IS NULL OR
 (checkpoint_position_ms>=0 AND checkpoint_position_ms<='604800000'::double precision)
);

CREATE FUNCTION control_cluster_guard_room(room uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE node uuid; instance uuid; valid bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM control_cluster_activation) THEN RETURN; END IF;
 BEGIN node := NULLIF(current_setting('rainsync.control_node',true),'')::uuid;
 instance := NULLIF(current_setting('rainsync.control_instance',true),'')::uuid;
 EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'room_owner_lost'; END;
 IF node IS NULL OR instance IS NULL THEN RAISE EXCEPTION 'room_owner_lost'; END IF;
 -- A creator acquires its initial room lease in the same transaction. No other
 -- transaction can use the absence of a lease to bypass ownership.
 IF EXISTS(SELECT 1 FROM rooms WHERE id=room AND xmin::text=pg_current_xact_id()::text)
    AND EXISTS(SELECT 1 FROM control_nodes WHERE id=node AND incarnation=instance AND heartbeat_at>clock_timestamp()-interval '10 seconds') THEN
   INSERT INTO room_leases(room_id,owner_node,owner_incarnation,lease_until)
   VALUES(room,node,instance,clock_timestamp()+interval '10 seconds') ON CONFLICT DO NOTHING;
 END IF;
 SELECT l.fencing_token INTO valid FROM room_leases l JOIN control_nodes n ON n.id=l.owner_node
 WHERE l.room_id=room AND l.owner_node=node AND l.owner_incarnation=instance AND n.incarnation=instance AND l.lease_until>clock_timestamp()
 AND n.heartbeat_at>clock_timestamp()-interval '10 seconds' FOR SHARE OF l FOR KEY SHARE OF n;
 IF valid IS NULL THEN RAISE EXCEPTION 'room_owner_lost'; END IF;
END $$;

CREATE FUNCTION control_cluster_guard_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE room uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM control_cluster_activation) THEN
   IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='rooms' THEN
   room:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
 ELSE
   room:=CASE WHEN TG_OP='DELETE' THEN OLD.room_id ELSE NEW.room_id END;
 END IF;
 PERFORM control_cluster_guard_room(room);
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

-- Early admission plus a deferred wall-clock check at COMMIT. SHARE locks fence
-- takeover until the transaction finishes; expired transactions cannot ACK.
DO $$ DECLARE t text; operations text; BEGIN
 FOREACH t IN ARRAY ARRAY['room_snapshots','room_events','command_results','control_epochs',
 'room_members','playlist_items','invites','chat_messages','room_media_activities',
 'room_chat_audit','room_reaction_receipts','room_reactions','room_ownership_events','room_lifecycle_events'] LOOP
   operations := CASE WHEN t IN ('room_members','playlist_items','invites') THEN 'INSERT OR UPDATE OR DELETE' ELSE 'INSERT OR UPDATE' END;
   EXECUTE format('CREATE TRIGGER control_owner_admission BEFORE %s ON %I FOR EACH ROW EXECUTE FUNCTION control_cluster_guard_write()',operations,t);
   EXECUTE format('CREATE CONSTRAINT TRIGGER control_owner_commit AFTER %s ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION control_cluster_guard_write()',operations,t);
 END LOOP;
END $$;
CREATE TRIGGER control_owner_admission BEFORE UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION control_cluster_guard_write();
CREATE CONSTRAINT TRIGGER control_owner_commit AFTER UPDATE ON rooms DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION control_cluster_guard_write();
