-- Ordered retained-history pruning only. This creates no capture, runtime,
-- decoder, filesystem disposal, output-success or deployment authority.
-- GUCs are cooperative mixed-binary fences, never physical cleanup proofs.
LOCK TABLE playback_requests, static_hls_captures, playback_sessions,
    playback_preparations, media_jobs, media_executions,
    static_hls_child_output_publications, static_hls_child_output_disposals
    IN ACCESS EXCLUSIVE MODE NOWAIT;

-- Store only exact immutable ownership keys in the transaction ticket. Never
-- place decrypted sources, encrypted inputs, manifests or evidence in GUCs.
CREATE FUNCTION static_hls_history_identity(table_name text, value jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(jsonb_object_agg(key, item),'{}'::jsonb)
    FROM jsonb_each($2) fields(key,item) WHERE key=ANY(CASE $1
      WHEN 'playback_requests' THEN ARRAY['user_id','idempotency_key','session_id','owner_epoch','static_hls_operation_id','static_hls_input_sha256','static_hls_parent_capture_id','static_hls_worker_instance','static_hls_database_id']
      WHEN 'static_hls_captures' THEN ARRAY['id','session_id','user_id','owner_id','request_owner_epoch','input_sha256','worker_instance','database_id','publication_phase','root_digest']
      WHEN 'playback_sessions' THEN ARRAY['id','user_id','room_id','media_id','generation','lifecycle_epoch','viewer_id','plan_generation','auth_login_hash','auth_membership_epoch','static_hls_capture_id']
      WHEN 'playback_preparations' THEN ARRAY['session_id','user_id','room_id','lifecycle_epoch','owner_epoch']
      WHEN 'media_jobs' THEN ARRAY['id','session_id','owner_id','attempt','logical_queue']
      WHEN 'media_executions' THEN ARRAY['id','session_id','job_id','attempt','owner_id','kind']
      WHEN 'static_hls_child_output_publications' THEN ARRAY['job_id','attempt','owner_id','execution_id','capture_id','input_sha256','root_digest','relative_dir']
      WHEN 'static_hls_child_output_disposals' THEN ARRAY['id','job_id','attempt','owner_id','execution_id','capture_id','input_sha256','root_digest','relative_dir','process_disposition','directory_device','directory_inode']
      ELSE ARRAY[]::text[] END)
$$;
-- A caller-set GUC cannot manufacture this certificate. The INSERT guard
-- below repeats the complete locked positive-proof check. It is transaction
-- bound, immutable, and may not survive COMMIT even if cleanup is interrupted.
CREATE TABLE static_hls_history_prune_tickets (
    transaction_id bigint PRIMARY KEY,
    session_id uuid NOT NULL,
    identities jsonb NOT NULL CHECK(jsonb_typeof(identities)='object'),
    created_at timestamptz NOT NULL CHECK(isfinite(created_at))
);
CREATE FUNCTION static_hls_history_prune_row_allowed(table_name text, value jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT COALESCE(static_hls_pending_reader_supported()
        AND current_setting('rainsync.static_hls_history_stage',true)=$1
        AND static_hls_history_identity($1,$2)<>'{}'::jsonb
        AND EXISTS(SELECT 1 FROM static_hls_history_prune_tickets issued
            WHERE issued.transaction_id=txid_current()
            AND jsonb_typeof(issued.identities->$1)='array'
            AND issued.identities->$1 @> jsonb_build_array(static_hls_history_identity($1,$2))),false)
$$;

-- Preserve every historical guard body, including mixed old-binary refusals.
-- Only an exact row from this transaction's validated prune ticket skips DELETE
-- retention. INSERT/UPDATE and every ordinary DELETE execute the old body.
-- Fail if a required guard is missing; do not silently loosen an old schema.
DO $$
DECLARE name text; definition text; prefix text;
BEGIN
    prefix=E'BEGIN\n    IF TG_OP=''DELETE'' AND static_hls_history_prune_row_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;';
    FOREACH name IN ARRAY ARRAY[
        'protect_static_hls_capture','protect_static_hls_request','protect_static_hls_session',
        'protect_static_hls_job','protect_static_hls_job_artifact',
        'protect_static_hls_child_claim','protect_static_hls_child_capture_phase',
        'protect_static_hls_child_session','protect_static_hls_child_job',
        'protect_static_hls_child_job_execution','protect_static_hls_child_artifact',
        'protect_static_hls_pending_preparation','protect_static_hls_child_output_publication',
        'protect_static_hls_child_output_disposal'
    ] LOOP
        definition=pg_get_functiondef((name||'()')::regprocedure);
        IF position('static_hls_history_prune_row_allowed' IN definition)>0 OR position('BEGIN' IN definition)=0 THEN
            RAISE EXCEPTION 'static_hls_history_guard_shape_changed';
        END IF;
        EXECUTE regexp_replace(definition,'\mBEGIN\M',prefix);
    END LOOP;
END $$;

CREATE FUNCTION static_hls_history_prepare_ticket(target_session uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r playback_requests; c static_hls_captures; p playback_sessions;
    prep playback_preparations; j media_jobs; cutoff timestamptz;
    ticket jsonb; rows jsonb;
BEGIN
    IF NOT static_hls_pending_reader_supported() THEN RETURN NULL; END IF;
    SELECT * INTO r FROM playback_requests WHERE session_id=target_session AND static_hls_input_version=1;
    IF r.session_id IS NULL OR r.room_id IS NULL THEN RETURN NULL; END IF;
    -- Match admission's room -> snapshot -> user -> sorted request prefix.
    -- Capture/output cleanup's suffix remains budget -> job -> capture/session.
    PERFORM id FROM rooms WHERE id=r.room_id FOR NO KEY UPDATE;
    PERFORM room_id FROM room_snapshots WHERE room_id=r.room_id FOR UPDATE;
    PERFORM id FROM users WHERE id=r.user_id FOR NO KEY UPDATE;
    PERFORM session_id FROM playback_requests WHERE user_id=r.user_id AND room_id=r.room_id ORDER BY session_id FOR UPDATE;
    SELECT * INTO r FROM playback_requests WHERE session_id=target_session AND static_hls_input_version=1;
    IF r.session_id IS NULL THEN RETURN NULL; END IF;
    PERFORM revision FROM cache_budget WHERE singleton FOR UPDATE;
    PERFORM id FROM media_jobs WHERE session_id=target_session OR id IN(target_session,r.static_hls_operation_id) ORDER BY id FOR UPDATE;
    PERFORM id FROM static_hls_captures WHERE session_id=target_session ORDER BY id FOR UPDATE;
    PERFORM id FROM playback_sessions WHERE id=target_session OR static_hls_capture_id=r.static_hls_operation_id ORDER BY id FOR UPDATE;
    PERFORM id FROM media_executions WHERE session_id=target_session OR job_id=target_session ORDER BY id FOR UPDATE;
    PERFORM job_id FROM static_hls_child_output_publications WHERE job_id=target_session ORDER BY attempt FOR UPDATE;
    PERFORM id FROM static_hls_child_output_disposals WHERE job_id=target_session ORDER BY id FOR UPDATE;
    PERFORM session_id FROM playback_preparations WHERE session_id=target_session FOR UPDATE;
    -- Fresh DB clock and statement snapshots after every lock. Expired leases,
    -- terminal labels and missing registry entries are never disposal evidence.
    cutoff=clock_timestamp()-interval '48 hours';
    SELECT * INTO c FROM static_hls_captures WHERE session_id=target_session;
    SELECT * INTO p FROM playback_sessions WHERE id=target_session;
    SELECT * INTO prep FROM playback_preparations WHERE session_id=target_session;
    SELECT * INTO j FROM media_jobs WHERE id=target_session;
    IF r.status NOT IN('completed','failed') OR NOT isfinite(r.expires_at) OR r.expires_at>=clock_timestamp()
       OR NOT isfinite(r.static_hls_root_expires_at) OR r.static_hls_root_expires_at>=cutoff
       OR r.preparation_drained_at IS NULL OR NOT isfinite(r.preparation_drained_at) OR r.preparation_drained_at>=cutoff
       OR prep.session_id IS NULL OR prep.owner_epoch IS DISTINCT FROM r.owner_epoch
       OR prep.user_id IS DISTINCT FROM r.user_id OR prep.room_id IS DISTINCT FROM r.room_id
       OR prep.lifecycle_epoch IS DISTINCT FROM r.lifecycle_epoch OR prep.created_at IS DISTINCT FROM r.created_at
       OR prep.drained_at IS DISTINCT FROM r.preparation_drained_at THEN RETURN NULL; END IF;
    IF EXISTS(SELECT 1 FROM playback_requests child WHERE child.static_hls_parent_capture_id=r.static_hls_operation_id)
       OR EXISTS(SELECT 1 FROM static_hls_captures other WHERE other.session_id=target_session AND other.id<>r.static_hls_operation_id)
       OR EXISTS(SELECT 1 FROM playback_sessions other WHERE other.static_hls_capture_id=r.static_hls_operation_id AND other.id<>target_session)
       OR EXISTS(SELECT 1 FROM media_jobs other WHERE (other.session_id=target_session OR other.id=r.static_hls_operation_id) AND other.id<>target_session)
       OR EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id IN(target_session,r.static_hls_operation_id))
       OR EXISTS(SELECT 1 FROM cache_entries WHERE id IN(target_session,r.static_hls_operation_id) OR cache_key IN(target_session::text,r.static_hls_operation_id::text))
       OR EXISTS(SELECT 1 FROM cache_read_leases WHERE cache_id IN(target_session,r.static_hls_operation_id))
       OR EXISTS(SELECT 1 FROM media_outputs WHERE job_id IN(target_session,r.static_hls_operation_id))
       OR EXISTS(SELECT 1 FROM media_output_files WHERE job_id IN(target_session,r.static_hls_operation_id))
       OR EXISTS(SELECT 1 FROM upstream_reservations WHERE id=target_session)
       OR EXISTS(SELECT 1 FROM playback_observations WHERE session_id=target_session)
       OR EXISTS(SELECT 1 FROM playback_http_representations WHERE session_id=target_session)
       OR EXISTS(SELECT 1 FROM agent_transfer_runs WHERE session_id=target_session)
       OR EXISTS(SELECT 1 FROM room_cleanup_tasks WHERE room_id=r.room_id AND completed_at IS NULL) THEN RETURN NULL; END IF;
    IF p.id IS NOT NULL AND (NOT isfinite(p.expires_at) OR p.expires_at>=cutoff
       OR ROW(p.user_id,p.room_id,p.media_id,p.generation,p.lifecycle_epoch,p.viewer_id,p.plan_generation,p.auth_login_hash,p.auth_membership_epoch)
          IS DISTINCT FROM ROW(r.user_id,r.room_id,r.static_hls_media_id,r.static_hls_media_generation,r.lifecycle_epoch,r.viewer_id,r.plan_generation,r.auth_login_hash,r.auth_membership_epoch)
       OR (p.static_hls_capture_id IS DISTINCT FROM c.id AND NOT
           (r.static_hls_parent_capture_id IS NULL AND p.static_hls_capture_id IS NULL AND c.publication_phase='pending_parent'))
       OR (p.static_hls_capture_id IS NULL AND (p.resource ? 'static_hls_capture_id' OR p.resource ? 'static_hls_input'))) THEN RETURN NULL; END IF;
    IF c.id IS NULL THEN
        -- The original positively closed prepare can prove never-admitted under
        -- these same request locks. A completed parent may have safely fallen
        -- back to an UNMARKED native grant; child requests never use that branch.
        IF j.id IS NOT NULL OR (r.status='completed' AND p.id IS NULL)
           OR (p.id IS NOT NULL AND (p.static_hls_capture_id IS NOT NULL OR p.resource ? 'static_hls_capture_id' OR p.resource ? 'static_hls_input'))
           OR (r.static_hls_parent_capture_id IS NOT NULL AND
               (r.status<>'failed' OR p.id IS NOT NULL OR EXISTS(SELECT 1 FROM media_executions WHERE session_id=target_session))) THEN RETURN NULL; END IF;
    ELSE
        IF c.publication_phase='stage_a' OR c.id IS DISTINCT FROM r.static_hls_operation_id
           OR c.user_id IS DISTINCT FROM r.user_id OR c.request_owner_epoch IS DISTINCT FROM r.owner_epoch
           OR c.input_sha256 IS DISTINCT FROM r.static_hls_input_sha256
           OR c.worker_instance IS DISTINCT FROM r.static_hls_worker_instance OR c.database_id IS DISTINCT FROM r.static_hls_database_id
           OR c.expires_at IS DISTINCT FROM r.static_hls_root_expires_at OR c.reader_version<>2 OR c.recipe_version<>1
           OR c.state<>'disposed' OR c.owner_id IS NULL
           OR c.streams_closed_at IS NULL OR c.process_closed_at IS NULL OR c.files_removed_at IS NULL OR c.disposed_at IS NULL
           OR c.process_disposition IS NULL OR c.process_disposition NOT IN('never_started','reaped')
           OR NOT isfinite(c.streams_closed_at) OR NOT isfinite(c.process_closed_at) OR NOT isfinite(c.files_removed_at) OR NOT isfinite(c.disposed_at)
           OR greatest(c.streams_closed_at,c.process_closed_at,c.files_removed_at,c.disposed_at)>=cutoff THEN RETURN NULL; END IF;
        IF (r.static_hls_parent_capture_id IS NULL AND c.publication_phase NOT IN('pending_parent','published_parent'))
           OR (r.static_hls_parent_capture_id IS NOT NULL AND c.publication_phase NOT IN('pending_child','published_child'))
           OR (c.publication_phase IN('published_parent','published_child') AND p.id IS NULL)
           OR (c.publication_phase IN('pending_parent','pending_child') AND j.id IS NOT NULL)
           OR (c.publication_phase='pending_child' AND p.id IS NOT NULL)
           OR (c.publication_phase='pending_parent' AND p.static_hls_capture_id IS NOT NULL) THEN RETURN NULL; END IF;
    END IF;
    IF (SELECT count(*) FROM media_executions WHERE session_id=target_session OR job_id=target_session)>128
       OR EXISTS(SELECT 1 FROM media_executions WHERE (session_id=target_session OR job_id=target_session)
          AND (session_id<>target_session OR reaped_at IS NULL OR NOT isfinite(reaped_at) OR reaped_at<created_at OR reaped_at>=cutoff)) THEN RETURN NULL; END IF;
    IF j.id IS NOT NULL THEN
        IF r.static_hls_parent_capture_id IS NULL OR c.publication_phase<>'published_child'
           OR NOT static_hls_child_job_matches(j,r,c) OR j.status NOT IN('succeeded','failed','cancelled')
           OR j.attempt NOT IN(0,1) OR (j.attempt=0 AND j.owner_id IS NOT NULL) OR j.lease_until IS NOT NULL THEN RETURN NULL; END IF;
        IF j.attempt=0 AND EXISTS(SELECT 1 FROM media_executions WHERE job_id=j.id) THEN RETURN NULL; END IF;
        IF j.attempt=1 AND NOT EXISTS(SELECT 1 FROM media_executions e
           JOIN static_hls_child_output_disposals d ON d.execution_id=e.id
           WHERE e.job_id=j.id AND e.session_id=j.session_id AND e.kind='job' AND e.attempt=1
           AND (j.owner_id IS NULL OR j.owner_id=e.owner_id)
           AND d.job_id=j.id AND d.attempt=e.attempt AND d.owner_id=e.owner_id AND d.capture_id=c.id
           AND d.input_sha256=c.input_sha256 AND d.root_digest=c.root_digest AND d.relative_dir=j.id::text||'/1'
           AND d.process_disposition IN('never_started','reaped') AND isfinite(d.disposed_at) AND d.disposed_at<cutoff) THEN RETURN NULL; END IF;
    ELSIF EXISTS(SELECT 1 FROM media_executions WHERE session_id=target_session AND kind='job') THEN RETURN NULL;
    END IF;
    -- Published/disposed output histories must both refer to the SAME original
    -- attempt/execution/capture tuple. A row mismatch is preserved, not repaired.
    IF EXISTS(SELECT 1 FROM static_hls_child_output_publications proof
       WHERE proof.job_id=target_session AND NOT EXISTS(SELECT 1 FROM static_hls_child_output_disposals d
          WHERE d.job_id=proof.job_id AND d.attempt=proof.attempt AND d.owner_id=proof.owner_id
          AND d.execution_id=proof.execution_id AND d.capture_id=proof.capture_id
          AND d.input_sha256=proof.input_sha256 AND d.root_digest=proof.root_digest
          AND d.relative_dir=proof.relative_dir AND d.disposed_at<cutoff))
       OR EXISTS(SELECT 1 FROM static_hls_child_output_disposals d WHERE d.job_id=target_session
          AND (j.id IS NULL OR d.capture_id IS DISTINCT FROM c.id OR d.input_sha256 IS DISTINCT FROM c.input_sha256
            OR d.root_digest IS DISTINCT FROM c.root_digest OR d.disposed_at>=cutoff
            OR NOT EXISTS(SELECT 1 FROM media_executions e WHERE e.id=d.execution_id AND e.job_id=d.job_id
               AND e.attempt=d.attempt AND e.owner_id=d.owner_id AND e.kind='job'))) THEN RETURN NULL; END IF;
    rows=jsonb_build_object(
       'playback_requests',jsonb_build_array(static_hls_history_identity('playback_requests',to_jsonb(r))),
       'playback_preparations',jsonb_build_array(static_hls_history_identity('playback_preparations',to_jsonb(prep))),
       'static_hls_captures',CASE WHEN c.id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(static_hls_history_identity('static_hls_captures',to_jsonb(c))) END,
       'playback_sessions',CASE WHEN p.id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(static_hls_history_identity('playback_sessions',to_jsonb(p))) END,
       'media_jobs',CASE WHEN j.id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(static_hls_history_identity('media_jobs',to_jsonb(j))) END,
       'media_executions',COALESCE((SELECT jsonb_agg(static_hls_history_identity('media_executions',to_jsonb(e)) ORDER BY e.id) FROM media_executions e WHERE e.session_id=target_session),'[]'::jsonb),
       'static_hls_child_output_publications',COALESCE((SELECT jsonb_agg(static_hls_history_identity('static_hls_child_output_publications',to_jsonb(proof))) FROM static_hls_child_output_publications proof WHERE proof.job_id=target_session),'[]'::jsonb),
       'static_hls_child_output_disposals',COALESCE((SELECT jsonb_agg(static_hls_history_identity('static_hls_child_output_disposals',to_jsonb(d))) FROM static_hls_child_output_disposals d WHERE d.job_id=target_session),'[]'::jsonb));
    ticket=jsonb_build_object('version',1,'transaction',txid_current()::text,'session',target_session,'rows',rows);
    RETURN ticket;
END $$;

CREATE FUNCTION protect_static_hls_history_ticket() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected jsonb;
BEGIN
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'static_hls_history_ticket_immutable'; END IF;
    IF TG_OP='INSERT' THEN
        IF NEW.transaction_id<>txid_current() OR NEW.created_at>clock_timestamp()
            OR NOT static_hls_pending_reader_supported() THEN RAISE EXCEPTION 'static_hls_history_ticket_invalid'; END IF;
        expected=static_hls_history_prepare_ticket(NEW.session_id);
        IF expected IS NULL OR NEW.identities IS DISTINCT FROM expected->'rows' THEN
            RAISE EXCEPTION 'static_hls_history_positive_original_receipts_required';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.transaction_id<>txid_current()
        OR EXISTS(SELECT 1 FROM playback_requests WHERE session_id=OLD.session_id)
        OR EXISTS(SELECT 1 FROM playback_preparations WHERE session_id=OLD.session_id)
        OR EXISTS(SELECT 1 FROM static_hls_captures WHERE session_id=OLD.session_id)
        OR EXISTS(SELECT 1 FROM playback_sessions WHERE id=OLD.session_id)
        OR EXISTS(SELECT 1 FROM media_jobs WHERE id=OLD.session_id OR session_id=OLD.session_id)
        OR EXISTS(SELECT 1 FROM media_executions WHERE session_id=OLD.session_id OR job_id=OLD.session_id)
        OR EXISTS(SELECT 1 FROM static_hls_child_output_publications WHERE job_id=OLD.session_id)
        OR EXISTS(SELECT 1 FROM static_hls_child_output_disposals WHERE job_id=OLD.session_id) THEN
        RAISE EXCEPTION 'static_hls_history_ticket_not_consumed';
    END IF;
    RETURN OLD;
END $$;
CREATE TRIGGER static_hls_history_ticket_guard BEFORE INSERT OR UPDATE OR DELETE
    ON static_hls_history_prune_tickets FOR EACH ROW EXECUTE FUNCTION protect_static_hls_history_ticket();
CREATE FUNCTION check_static_hls_history_ticket_consumed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM static_hls_history_prune_tickets WHERE transaction_id=NEW.transaction_id) THEN
        RAISE EXCEPTION 'static_hls_history_ticket_not_consumed';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER static_hls_history_ticket_consumed AFTER INSERT ON static_hls_history_prune_tickets
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_static_hls_history_ticket_consumed();

CREATE FUNCTION static_hls_prune_history(target_session uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE ticket jsonb; rows jsonb; table_name text; count_rows bigint; expected bigint;
BEGIN
    ticket=static_hls_history_prepare_ticket(target_session);
    IF ticket IS NULL THEN RETURN false; END IF;
    rows=ticket->'rows';
    INSERT INTO static_hls_history_prune_tickets(transaction_id,session_id,identities,created_at)
        VALUES(txid_current(),target_session,rows,clock_timestamp());
    -- Foreign-key dependency order; no CASCADE or deletion of physical owners.
    FOREACH table_name IN ARRAY ARRAY['static_hls_child_output_publications','static_hls_child_output_disposals',
        'media_executions','media_jobs','playback_sessions','static_hls_captures','playback_preparations','playback_requests'] LOOP
        PERFORM set_config('rainsync.static_hls_history_stage',table_name,true);
        expected=jsonb_array_length(rows->table_name);
        EXECUTE format('DELETE FROM %I WHERE %I=$1',table_name,
            CASE WHEN table_name IN('static_hls_child_output_publications','static_hls_child_output_disposals') THEN 'job_id'
                 WHEN table_name IN('playback_sessions','media_jobs') THEN 'id' ELSE 'session_id' END) USING target_session;
        GET DIAGNOSTICS count_rows=ROW_COUNT;
        IF count_rows<>expected THEN RAISE EXCEPTION 'static_hls_history_prune_unconfirmed'; END IF;
    END LOOP;
    PERFORM set_config('rainsync.static_hls_history_stage','',true);
    DELETE FROM static_hls_history_prune_tickets WHERE transaction_id=txid_current() AND session_id=target_session;
    GET DIAGNOSTICS count_rows=ROW_COUNT;
    IF count_rows<>1 THEN RAISE EXCEPTION 'static_hls_history_ticket_not_consumed'; END IF;
    RETURN true;
END $$;

-- Bind every new certificate/authorization entry point and wrapped historical
-- guard to the schema installed by THIS migration, never the caller's path.
-- A pg_temp relation may otherwise impersonate the certificate without firing
-- its INSERT guard. Keep pg_catalog first and pg_temp explicitly last, and
-- additionally qualify the real certificate in all stored function bodies.
-- Nested authorization helpers inherit this fixed path; the checked relations
-- must already exist in the same trusted namespace or installation fails.
DO $$
DECLARE trusted_schema name; relation_name text; signature text;
    function_id oid; definition text;
BEGIN
    SELECT namespace.nspname INTO STRICT trusted_schema
        FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        WHERE relation.oid='static_hls_history_prune_tickets'::regclass;
    IF trusted_schema IN ('pg_catalog','information_schema') OR trusted_schema LIKE 'pg_temp_%'
        OR trusted_schema LIKE 'pg_toast%' THEN
        RAISE EXCEPTION 'static_hls_history_trusted_schema_required';
    END IF;
    FOREACH relation_name IN ARRAY ARRAY[
        'static_hls_history_prune_tickets','playback_requests','static_hls_captures',
        'playback_sessions','playback_preparations','media_jobs','media_executions',
        'static_hls_child_output_publications','static_hls_child_output_disposals',
        'rooms','room_snapshots','users','cache_budget','cache_write_reservations',
        'cache_entries','cache_read_leases','media_outputs','media_output_files',
        'upstream_reservations','playback_observations','playback_http_representations',
        'agent_transfer_runs','room_cleanup_tasks'
    ] LOOP
        IF to_regclass(format('%I.%I',trusted_schema,relation_name)) IS NULL THEN
            RAISE EXCEPTION 'static_hls_history_trusted_relation_required';
        END IF;
    END LOOP;
    FOREACH signature IN ARRAY ARRAY[
        'static_hls_history_identity(text,jsonb)',
        'static_hls_history_prune_row_allowed(text,jsonb)',
        'static_hls_history_prepare_ticket(uuid)',
        'protect_static_hls_history_ticket()',
        'check_static_hls_history_ticket_consumed()',
        'static_hls_prune_history(uuid)',
        'protect_static_hls_capture()','protect_static_hls_request()','protect_static_hls_session()',
        'protect_static_hls_job()','protect_static_hls_job_artifact()',
        'protect_static_hls_child_claim()','protect_static_hls_child_capture_phase()',
        'protect_static_hls_child_session()','protect_static_hls_child_job()',
        'protect_static_hls_child_job_execution()','protect_static_hls_child_artifact()',
        'protect_static_hls_pending_preparation()','protect_static_hls_child_output_publication()',
        'protect_static_hls_child_output_disposal()'
    ] LOOP
        function_id=to_regprocedure(format('%I.%s',trusted_schema,signature));
        IF function_id IS NULL THEN RAISE EXCEPTION 'static_hls_history_trusted_function_required'; END IF;
        definition=pg_get_functiondef(function_id);
        definition=replace(definition,'static_hls_history_prune_tickets',
            format('%I.static_hls_history_prune_tickets',trusted_schema));
        EXECUTE definition;
        EXECUTE format('ALTER FUNCTION %I.%s SET search_path TO pg_catalog, %I, pg_temp',
            trusted_schema,signature,trusted_schema);
    END LOOP;
END $$;
