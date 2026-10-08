-- PostgreSQL SQL assertion fixture. Originally unexecuted at handoff.
-- Run on an isolated backend via tests/static-hls-pending-postgres.mjs, which
-- applies migrations 0001-0044 transactionally. No runtime receipts are supplied.
-- Synthetic envelope/inventory values below are SQL statements only. They do
-- not authenticate ciphertext or prove scanner, stream, process or file closure.
-- The owned Rust harness must additionally exercise the actual consuming
-- transactions and opaque permits. This file never substitutes for that run.
BEGIN;
CREATE FUNCTION pg_temp.assert_true(label text, value boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed: %',label; END IF;
END $$;
CREATE FUNCTION pg_temp.rejects(statement text, expected text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE rejected boolean=false;
BEGIN
    BEGIN
        EXECUTE statement;
    EXCEPTION WHEN OTHERS THEN
        IF position(expected IN SQLERRM)=0 THEN RAISE EXCEPTION 'unexpected rejection: %',SQLERRM; END IF;
        rejected=true;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'expected rejection missing: %',expected; END IF;
END $$;

-- Executable envelope/trigger assertions are intentionally accompanied by a
-- required multi-connection/pure-boundary matrix that this single SQL session
-- cannot establish. The later harness must report each case independently.
CREATE TEMP TABLE required_owned_cases(case_id text PRIMARY KEY, required_evidence text NOT NULL);
INSERT INTO required_owned_cases VALUES
('migration_missing_request','On 0043, preserve a disposed capture while pruning its request; 0044 must abort without creating provenance'),
('migration_conflicting_owner','On 0043, change the disposed capture request owner; 0044 must abort and preserve all old rows'),
('migration_busy_writer','Two connections: pending request mutation or Stage A verify holds a prerequisite table; NOWAIT aborts 0044 atomically'),
('stage_a_legacy_retention','Legacy NULL behavior remains; every capture-referenced request including disposed Stage A is retained; room drain still uses its original session room even if old request room is NULL'),
('stage_a_unmarked_rekey','Capturing and disposed unmarked Stage A sessions refuse DELETE and ID UPDATE'),
('freeze_source_ciphertext_changed','Barrier after construction: change exact source ciphertext before final locks; freeze rejects with no viewer/request/preparation side effects'),
('freeze_source_kind_changed','Barrier after construction: change source kind; freeze rejects'),
('freeze_resource_version_generation_changed','Separately change media resource, source_version, preview_generation and source revision; every stale candidate rejects'),
('freeze_new_viewer','First fresh viewer and same-login newer generation insert one fully bound pending request/preparation; cap 1024 is enforced'),
('freeze_cross_login','Same key and viewer from another exact login fail before retry retirement, source work or high-water changes'),
('freeze_duplicate_key','Repeated pending/failed/custody key returns its stable result without re-encryption, owner/session/deadline replacement or high-water advancement'),
('freeze_original_login_limit','Capture login expiry before construction; root and preparation never exceed it and a shorter current login cannot authorize the final write'),
('freeze_deadlines','Contended final locks consume original preparation/root/login time; expired final conditional insert changes zero rows and rolls back'),
('admit_budget_revision','Measurement revision changed before lock: no capture/reservation/local permit is minted'),
('admit_dispose_contention','Concurrent admission and positive disposal use budget then exact capture then reservation; retained capacity/headroom is rechecked'),
('lifecycle_admit_contention','Lifecycle before request/budget prevents late admission; cancellation preserves unknown responsibility and reservation'),
('multi_capture_cancel_admit','Two users in one room terminalize captures while another room admits; no global admission capture scan or opposite-order waits'),
('verify_required_parent_binding','Actual Rust consuming boundary calls required root-to-parent-input validator, matching original target hash and audio before still-pending SQL update'),
('verify_no_budget','A second connection holding budget does not block verify/cancel through direct SQL or trigger-induced locks'),
('verify_revocation_race','After exact authority locks, repeat fresh pending/source/member/login/viewer/Worker/database/deadline predicates before installing root and inventory once'),
('cancel_retryable_stable','Retryable transport failure remains failed; begin, explicit cancel, newer viewer, lifecycle and startup cannot reset its input or reason'),
('unknown_reader_vs_revocation','Unknown capability is not source revocation; reader1 monotonic terminalization actually changes one request row'),
('dispose_original_opaque_owner','Only original mint-only local permit and opaque all-positive DisposalProof discharge responsibility after revocation'),
('dispose_ack_uncertainty','Lost DB acknowledgment retains the original local owner/proof; no restart UUID reconstruction or fabricated release'),
('request_expiry_retains_custody','Generic expiry skips all pending inputs and all capture-linked requests, including disposed Stage A'),
('generic_preparation_prune','Positive/negative Stage B preparation evidence is excluded from generic 48-hour pruning even without capture'),
('preparation_ack_prune_contention','Request-before-preparation positive acknowledgment competes with room/request/budget/capture/reservation/preparation pruning without inversion'),
('prune_positive_disposed','Fresh post-lock statement proves elapsed retention, positive Server and capture closure, zero session/job/read/output/cache/cleanup dependencies; delete capture then preparation then request'),
('prune_positive_never_admitted','Terminal original request lock synchronizes against admission; fresh absence of capture and operation/session reservation plus positive preparation closure permits cleanup'),
('prune_uncertain_admission','Absent or unknown acknowledgment never substitutes for positive known-capture disposal; request/preparation/capacity stay retained'),
('rollback_counts','Faults between request/preparation, capture/reservation/budget, or disposal/release roll back all writes; each consuming conditional write must affect exactly one row');

SELECT set_config('rainsync.static_hls_reader','2',true),set_config('rainsync.static_hls_pending_recipe','1',true);
CREATE TEMP TABLE fixture_clock AS SELECT date_trunc('milliseconds',clock_timestamp()) AS admitted;
INSERT INTO users(id,username,password_hash) VALUES('f1000000-0000-0000-0000-000000000001','pending_custody_sql_fixture','synthetic-no-auth');
INSERT INTO sessions(token_hash,user_id,csrf,expires_at)
    SELECT repeat('a',64),'f1000000-0000-0000-0000-000000000001','synthetic',admitted+interval '1 hour' FROM fixture_clock;
INSERT INTO rooms(id,name,owner_id) VALUES('f1000000-0000-0000-0000-000000000010','pending custody fixture','f1000000-0000-0000-0000-000000000001');
INSERT INTO room_members(room_id,user_id) VALUES('f1000000-0000-0000-0000-000000000010','f1000000-0000-0000-0000-000000000001');
INSERT INTO sources(id,name,kind,config_encrypted,access_policy_revision)
    VALUES('f1000000-0000-0000-0000-000000000020','synthetic source','http','synthetic-source-ciphertext',1);
INSERT INTO media_items(id,source_id,title,resource)
    VALUES('f1000000-0000-0000-0000-000000000030','f1000000-0000-0000-0000-000000000020','synthetic media','https://fixture.invalid/selected.m3u8');
INSERT INTO room_snapshots(room_id,state) VALUES('f1000000-0000-0000-0000-000000000010',
    '{"media_id":"f1000000-0000-0000-0000-000000000030","media_generation":0}'::jsonb);
INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation,auth_login_hash)
    VALUES('f1000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000010','f1000000-0000-0000-0000-000000000040',1,repeat('a',64));
INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,created_at,
    room_id,lifecycle_epoch,viewer_id,plan_generation,auth_login_hash,auth_membership_epoch,
    static_hls_input_version,static_hls_input_encrypted,static_hls_input_sha256,static_hls_operation_id,
    static_hls_root_expires_at,static_hls_prepare_expires_at,static_hls_media_id,static_hls_media_generation,
    static_hls_source_id,static_hls_source_revision,static_hls_source_generation,static_hls_worker_instance,static_hls_database_id)
SELECT 'f1000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000041',repeat('b',64),
    'f1000000-0000-0000-0000-000000000042','f1000000-0000-0000-0000-000000000043','pending',admitted+interval '45 seconds',
    admitted+interval '48 hours',admitted,'f1000000-0000-0000-0000-000000000010',0,'f1000000-0000-0000-0000-000000000040',1,
    repeat('a',64),member.membership_epoch,1,'synthetic-input-ciphertext',repeat('c',64),'f1000000-0000-0000-0000-000000000044',
    admitted+interval '30 minutes',admitted+interval '45 seconds','f1000000-0000-0000-0000-000000000030',0,
    'f1000000-0000-0000-0000-000000000020',1,1,'f1000000-0000-0000-0000-000000000045',db.id
FROM fixture_clock CROSS JOIN static_hls_database_binding db CROSS JOIN room_members member
WHERE member.room_id='f1000000-0000-0000-0000-000000000010' AND db.singleton;
INSERT INTO playback_preparations(session_id,user_id,room_id,lifecycle_epoch,owner_epoch,created_at)
SELECT session_id,user_id,room_id,lifecycle_epoch,owner_epoch,created_at FROM playback_requests
WHERE session_id='f1000000-0000-0000-0000-000000000042';
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.assert_true('pending parent authority without any session',static_hls_pending_request_authority_allowed('f1000000-0000-0000-0000-000000000042'));
SELECT pg_temp.assert_true('no provisional grant',NOT EXISTS(SELECT 1 FROM playback_sessions WHERE id='f1000000-0000-0000-0000-000000000042'));
SELECT pg_temp.assert_true('production reader support remains reader1',NOT static_hls_reader_supported() AND static_hls_pending_reader_supported());
SELECT pg_temp.rejects($q$UPDATE playback_requests SET status='completed',response_encrypted='synthetic' WHERE session_id='f1000000-0000-0000-0000-000000000042'$q$,
    CASE WHEN to_regprocedure('static_hls_published_parent_authority_allowed(uuid)') IS NULL
        THEN 'static_hls_pending_request_immutable' ELSE 'static_hls_parent_publication_required' END);
SELECT pg_temp.rejects($q$UPDATE playback_requests SET static_hls_input_encrypted='reencrypted' WHERE session_id='f1000000-0000-0000-0000-000000000042'$q$,'static_hls_pending_request_immutable');
SELECT pg_temp.rejects($q$UPDATE playback_requests SET static_hls_media_generation=1 WHERE session_id='f1000000-0000-0000-0000-000000000042'$q$,'static_hls_pending_request_immutable');
SELECT pg_temp.rejects($q$UPDATE playback_requests SET lease_until=lease_until+interval '1 second' WHERE session_id='f1000000-0000-0000-0000-000000000042'$q$,'static_hls_pending_request_immutable');
SELECT pg_temp.rejects($q$INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at)
    VALUES('f1000000-0000-0000-0000-000000000042','f1000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000010','f1000000-0000-0000-0000-000000000030',0,'synthetic-delivery','{}',clock_timestamp()+interval '30 minutes')$q$,
    CASE WHEN to_regprocedure('static_hls_published_parent_authority_allowed(uuid)') IS NULL
        THEN 'static_hls_pending_publication_forbidden' ELSE 'static_hls_parent_publication_required' END);
SELECT pg_temp.rejects($q$INSERT INTO media_jobs(id,session_id,status,spec)
    VALUES('f1000000-0000-0000-0000-000000000042','f1000000-0000-0000-0000-000000000042','queued','{}')$q$,'static_hls_pending_publication_forbidden');

-- Same explicit suffix as admission. Deferred linkage checks require both
-- writes before commit; the harness must separately test mid-write rollback.
SELECT revision FROM cache_budget WHERE singleton FOR UPDATE;
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO static_hls_captures(id,session_id,user_id,owner_id,resource_authority,request_owner_epoch,expires_at,
    publication_phase,input_sha256,worker_instance,database_id,reader_version,recipe_version)
SELECT static_hls_operation_id,session_id,user_id,'f1000000-0000-0000-0000-000000000046',
    jsonb_build_object('media_id',static_hls_media_id,'source_id',static_hls_source_id,'source_policy_revision',static_hls_source_revision,'media_source_generation',static_hls_source_generation),
    owner_epoch,static_hls_root_expires_at,'pending_parent',static_hls_input_sha256,static_hls_worker_instance,static_hls_database_id,2,1
FROM playback_requests WHERE session_id='f1000000-0000-0000-0000-000000000042';
INSERT INTO cache_write_reservations(job_id,owner_id,attempt,bytes,purpose)
    VALUES('f1000000-0000-0000-0000-000000000044','f1000000-0000-0000-0000-000000000046',0,134217728,'static_hls_capture');
UPDATE cache_budget SET revision=revision+1 WHERE singleton;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.assert_true('exact atomic capture linkage',static_hls_pending_capture_authority_allowed('f1000000-0000-0000-0000-000000000044'));
SELECT pg_temp.rejects($q$UPDATE static_hls_captures SET input_sha256=repeat('d',64) WHERE id='f1000000-0000-0000-0000-000000000044'$q$,'static_hls_pending_capture_immutable');
SELECT pg_temp.rejects($q$UPDATE static_hls_captures SET inventory_encrypted='synthetic',root_digest=repeat('d',64) WHERE id='f1000000-0000-0000-0000-000000000044'$q$,'static_hls_pending_capture_immutable');
UPDATE static_hls_captures SET state='verified',inventory_encrypted='synthetic-root-ciphertext',root_digest=repeat('d',64)
    WHERE id='f1000000-0000-0000-0000-000000000044';
SELECT pg_temp.rejects($q$UPDATE static_hls_captures SET state='capturing' WHERE id='f1000000-0000-0000-0000-000000000044'$q$,'static_hls_pending_capture_immutable');
SELECT pg_temp.rejects($q$UPDATE static_hls_captures SET root_digest=repeat('e',64) WHERE id='f1000000-0000-0000-0000-000000000044'$q$,'static_hls_pending_capture_immutable');

SELECT set_config('rainsync.static_hls_reader','0',true);
SELECT pg_temp.assert_true('unknown reader does not revoke actual authority',static_hls_pending_capture_authority_allowed('f1000000-0000-0000-0000-000000000044'));
SELECT pg_temp.rejects($q$UPDATE playback_requests SET status='failed',error_status=410,error_code='playback_request_cancelled' WHERE session_id='f1000000-0000-0000-0000-000000000042'$q$,'static_hls_pending_reader_required');
SELECT pg_temp.rejects($q$UPDATE static_hls_captures SET state='cancelled' WHERE id='f1000000-0000-0000-0000-000000000044'$q$,'static_hls_pending_reader_required');
SELECT set_config('rainsync.static_hls_reader','1',true);
DO $$ DECLARE changed bigint; BEGIN
    UPDATE playback_requests SET status='failed',error_status=502,error_code='upstream_failed' WHERE session_id='f1000000-0000-0000-0000-000000000042' AND status='pending';
    GET DIAGNOSTICS changed=ROW_COUNT;
    PERFORM pg_temp.assert_true('reader1 terminalization changes exactly one request',changed=1);
END $$;
UPDATE static_hls_captures SET state='cancelled' WHERE id='f1000000-0000-0000-0000-000000000044';
SELECT pg_temp.assert_true('actual terminalization revokes authority',NOT static_hls_pending_capture_authority_allowed('f1000000-0000-0000-0000-000000000044'));
SELECT pg_temp.assert_true('cancelled custody still consumes capacity',EXISTS(SELECT 1 FROM static_hls_captures WHERE id='f1000000-0000-0000-0000-000000000044' AND disposed_at IS NULL));
SELECT pg_temp.assert_true('cancelled custody retains reservation',EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id='f1000000-0000-0000-0000-000000000044'));
SELECT pg_temp.rejects($q$UPDATE playback_requests SET status='pending',error_status=NULL,error_code=NULL WHERE session_id='f1000000-0000-0000-0000-000000000042'$q$,'static_hls_pending_request_immutable');
SELECT pg_temp.rejects($q$UPDATE playback_requests SET error_code='playback_request_cancelled' WHERE session_id='f1000000-0000-0000-0000-000000000042'$q$,'static_hls_pending_request_immutable');
DO $$ DECLARE changed bigint; BEGIN
    DELETE FROM cache_write_reservations WHERE job_id='f1000000-0000-0000-0000-000000000044';
    GET DIAGNOSTICS changed=ROW_COUNT;
    PERFORM pg_temp.assert_true('cancellation cannot release storage',changed=0);
    DELETE FROM playback_requests WHERE session_id='f1000000-0000-0000-0000-000000000042';
    GET DIAGNOSTICS changed=ROW_COUNT;
    PERFORM pg_temp.assert_true('referenced request retained before disposal',changed=0);
END $$;

-- SQL metadata acknowledgment only. Real acceptance must obtain the opaque
-- all-positive proof from the original local owner after real closure.
SELECT set_config('rainsync.static_hls_reader','2',true);
SET CONSTRAINTS ALL DEFERRED;
SELECT revision FROM cache_budget WHERE singleton FOR UPDATE;
SELECT id FROM static_hls_captures WHERE id='f1000000-0000-0000-0000-000000000044' FOR UPDATE;
SELECT job_id FROM cache_write_reservations WHERE job_id='f1000000-0000-0000-0000-000000000044' FOR UPDATE;
UPDATE static_hls_captures SET state='disposed',streams_closed_at=clock_timestamp(),process_closed_at=clock_timestamp(),
    process_disposition='never_started',files_removed_at=clock_timestamp(),disposed_at=clock_timestamp()
WHERE id='f1000000-0000-0000-0000-000000000044' AND owner_id='f1000000-0000-0000-0000-000000000046';
DELETE FROM cache_write_reservations WHERE job_id='f1000000-0000-0000-0000-000000000044';
UPDATE cache_budget SET revision=revision+1 WHERE singleton;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.assert_true('positive metadata disposal releases only exact reservation',NOT EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id='f1000000-0000-0000-0000-000000000044'));
-- The failed request is no longer a pending login-bound publication origin.
-- The existing playback_session_origin trigger runs before the HLS guard and
-- must reject this INSERT first. This still creates no provisional grant.
SELECT pg_temp.rejects($q$INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at)
    VALUES('f1000000-0000-0000-0000-000000000042','f1000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000010','f1000000-0000-0000-0000-000000000030',0,'synthetic-delivery','{}',clock_timestamp()+interval '30 minutes')$q$,'media_login_binding_required');
SELECT pg_temp.rejects($q$DELETE FROM playback_preparations WHERE session_id='f1000000-0000-0000-0000-000000000042'$q$,'static_hls_pending_preparation_retained');
SELECT set_config('rainsync.static_hls_pending_prune','1',true);
SELECT pg_temp.rejects($q$DELETE FROM static_hls_captures WHERE id='f1000000-0000-0000-0000-000000000044'$q$,'static_hls_pending_prune_unconfirmed');

-- Session-key dependencies are retained too, without reclaiming a reservation
-- or pretending an absent capture proves uncertain admission was never made.
INSERT INTO cache_write_reservations(job_id,owner_id,attempt,bytes,purpose)
    VALUES('f1000000-0000-0000-0000-000000000042','f1000000-0000-0000-0000-000000000046',0,1,'media_job');
SELECT pg_temp.assert_true('session-key reservation blocks prune',NOT static_hls_pending_prune_dependencies_absent(
    'f1000000-0000-0000-0000-000000000042','f1000000-0000-0000-0000-000000000044','f1000000-0000-0000-0000-000000000010'));

-- A dedicated never-admitted retained terminal row has positive original
-- preparation metadata. Each ordered DELETE below must affect exactly one row.
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,error_status,error_code,lease_until,expires_at,created_at,
    room_id,lifecycle_epoch,preparation_drained_at,viewer_id,plan_generation,auth_login_hash,auth_membership_epoch,
    static_hls_input_version,static_hls_input_encrypted,static_hls_input_sha256,static_hls_operation_id,
    static_hls_root_expires_at,static_hls_prepare_expires_at,static_hls_media_id,static_hls_media_generation,
    static_hls_source_id,static_hls_source_revision,static_hls_source_generation,static_hls_worker_instance,static_hls_database_id)
SELECT user_id,'f1000000-0000-0000-0000-000000000061',request_hash,'f1000000-0000-0000-0000-000000000062',owner_epoch,'failed',410,'playback_request_cancelled',
    created_at-interval '49 hours'+interval '45 seconds',created_at-interval '1 hour',created_at-interval '49 hours',
    room_id,lifecycle_epoch,created_at-interval '49 hours'+interval '1 minute',viewer_id,plan_generation,auth_login_hash,auth_membership_epoch,
    static_hls_input_version,static_hls_input_encrypted,static_hls_input_sha256,'f1000000-0000-0000-0000-000000000064',
    created_at-interval '49 hours'+interval '30 minutes',created_at-interval '49 hours'+interval '45 seconds',static_hls_media_id,static_hls_media_generation,
    static_hls_source_id,static_hls_source_revision,static_hls_source_generation,static_hls_worker_instance,static_hls_database_id
FROM playback_requests WHERE session_id='f1000000-0000-0000-0000-000000000042';
INSERT INTO playback_preparations(session_id,user_id,room_id,lifecycle_epoch,owner_epoch,created_at,drained_at)
SELECT session_id,user_id,room_id,lifecycle_epoch,owner_epoch,created_at,preparation_drained_at FROM playback_requests
WHERE session_id='f1000000-0000-0000-0000-000000000062';
SET CONSTRAINTS ALL IMMEDIATE;
SELECT id FROM rooms WHERE id='f1000000-0000-0000-0000-000000000010' FOR NO KEY UPDATE;
SELECT session_id FROM playback_requests WHERE session_id='f1000000-0000-0000-0000-000000000062' FOR UPDATE;
SELECT revision FROM cache_budget WHERE singleton FOR UPDATE;
SELECT id FROM static_hls_captures WHERE session_id='f1000000-0000-0000-0000-000000000062' FOR UPDATE;
SELECT job_id FROM cache_write_reservations WHERE job_id IN ('f1000000-0000-0000-0000-000000000062','f1000000-0000-0000-0000-000000000064') FOR UPDATE;
SELECT session_id FROM playback_preparations WHERE session_id='f1000000-0000-0000-0000-000000000062' FOR UPDATE;
SELECT pg_temp.assert_true('fresh never-admitted absence and retained positive preparation',
    EXISTS(SELECT 1 FROM playback_requests r JOIN playback_preparations p ON p.session_id=r.session_id
        WHERE r.session_id='f1000000-0000-0000-0000-000000000062' AND r.status='failed' AND r.expires_at<clock_timestamp()
        AND p.drained_at=r.preparation_drained_at AND p.drained_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM static_hls_captures WHERE session_id=r.session_id)
        AND static_hls_pending_prune_dependencies_absent(r.session_id,r.static_hls_operation_id,r.room_id)));
DO $$ DECLARE changed bigint; BEGIN
    DELETE FROM playback_preparations WHERE session_id='f1000000-0000-0000-0000-000000000062';
    GET DIAGNOSTICS changed=ROW_COUNT; PERFORM pg_temp.assert_true('never-admitted preparation DELETE count',changed=1);
    DELETE FROM playback_requests WHERE session_id='f1000000-0000-0000-0000-000000000062';
    GET DIAGNOSTICS changed=ROW_COUNT; PERFORM pg_temp.assert_true('never-admitted request DELETE count',changed=1);
END $$;

-- Legacy/Stage A migration and disposal-retention cases are staged on
-- 0043 by the separate owned upgrade harness. These permanent guards are checked
-- for both unmarked capturing and unmarked disposed captures: DELETE/ID UPDATE
-- must never succeed after retargeting the FK to requests. A marked guard may
-- return zero rows; unmarked DELETE raises static_hls_stage_a_session_retained.
-- ID UPDATE is rejected earlier by playback_room_identity_immutable.
-- No pre-0044 setup or migration launch is hidden in this assertion file.
ROLLBACK;
