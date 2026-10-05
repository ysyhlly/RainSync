-- RELATIONAL-ONLY fixture for migrations 0043-0050 on an isolated backend.
-- Includes synthetic new claim/write/full-publication/read/disposal SQL flow.
-- NEVER a native validation, filesystem owner, or Rust COMMIT receipt witness.
-- ALL ciphertext, owner IDs, inventory and disposal fields are SYNTHETIC.
-- They do not prove encryption, a live original local owner, a complete scan,
-- closed streams, OS reaping, removed files, encoding or playable output.
-- No network/capture/encoder is called. Everything rolls back at the end.
BEGIN;
CREATE FUNCTION pg_temp.child_assert(label text, value boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed: %',label; END IF;
END $$;
CREATE FUNCTION pg_temp.child_rejects(statement text, expected text) RETURNS void LANGUAGE plpgsql AS $$
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
CREATE FUNCTION pg_temp.child_resource(session uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object('encrypted','synthetic-descriptor-ciphertext',
        'source_policy_revision',r.static_hls_source_revision,'account_policy_generation',NULL,
        'auth_context',jsonb_build_object('version',1,'user_id',r.user_id,'room_id',r.room_id,
            'membership_epoch',r.auth_membership_epoch,'login_hash',r.auth_login_hash),
        'static_hls_input',jsonb_build_object('input_version',1,'reader_version',2,'recipe_version',1,
            'source_id',r.static_hls_source_id,'media_source_generation',r.static_hls_source_generation,
            'input_sha256',r.static_hls_input_sha256,'worker_instance',r.static_hls_worker_instance,
            'root_hard_expires_at_ms',floor(extract(epoch FROM r.static_hls_root_expires_at)*1000)::bigint))
    FROM playback_requests r WHERE r.session_id=$1
$$;

SELECT set_config('rainsync.static_hls_reader','2',true),set_config('rainsync.static_hls_pending_recipe','1',true);
CREATE TEMP TABLE child_fixture_clock AS SELECT date_trunc('milliseconds',clock_timestamp()) AS admitted;
INSERT INTO users(id,username,password_hash) VALUES('f2000000-0000-0000-0000-000000000001','child_publication_sql_fixture','synthetic-no-auth');
INSERT INTO sessions(token_hash,user_id,csrf,expires_at)
    SELECT repeat('2f',32),'f2000000-0000-0000-0000-000000000001','synthetic',admitted+interval '1 hour' FROM child_fixture_clock;
INSERT INTO rooms(id,name,owner_id) VALUES('f2000000-0000-0000-0000-000000000010','child publication fixture','f2000000-0000-0000-0000-000000000001');
INSERT INTO room_members(room_id,user_id) VALUES('f2000000-0000-0000-0000-000000000010','f2000000-0000-0000-0000-000000000001');
INSERT INTO sources(id,name,kind,config_encrypted,access_policy_revision)
    VALUES('f2000000-0000-0000-0000-000000000020','synthetic source','http','synthetic-source-ciphertext',1);
INSERT INTO media_items(id,source_id,title,resource)
    VALUES('f2000000-0000-0000-0000-000000000030','f2000000-0000-0000-0000-000000000020','synthetic media','https://fixture.invalid/selected.m3u8');
INSERT INTO room_snapshots(room_id,state) VALUES('f2000000-0000-0000-0000-000000000010',
    '{"media_id":"f2000000-0000-0000-0000-000000000030","media_generation":0}'::jsonb);
INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation,auth_login_hash)
    VALUES('f2000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-000000000010','f2000000-0000-0000-0000-000000000040',1,repeat('2f',32));
INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,created_at,
    room_id,lifecycle_epoch,viewer_id,plan_generation,auth_login_hash,auth_membership_epoch,
    static_hls_input_version,static_hls_input_encrypted,static_hls_input_sha256,static_hls_operation_id,
    static_hls_root_expires_at,static_hls_prepare_expires_at,static_hls_media_id,static_hls_media_generation,
    static_hls_source_id,static_hls_source_revision,static_hls_source_generation,static_hls_worker_instance,static_hls_database_id)
SELECT 'f2000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-000000000041',repeat('b',64),
    'f2000000-0000-0000-0000-000000000042','f2000000-0000-0000-0000-000000000043','pending',admitted+interval '45 seconds',
    admitted+interval '48 hours',admitted,'f2000000-0000-0000-0000-000000000010',0,'f2000000-0000-0000-0000-000000000040',1,
    repeat('2f',32),member.membership_epoch,1,'synthetic-parent-input',repeat('c',64),'f2000000-0000-0000-0000-000000000044',
    admitted+interval '30 minutes',admitted+interval '45 seconds','f2000000-0000-0000-0000-000000000030',0,
    'f2000000-0000-0000-0000-000000000020',1,1,'f2000000-0000-0000-0000-000000000045',db.id
FROM child_fixture_clock CROSS JOIN static_hls_database_binding db CROSS JOIN room_members member
WHERE member.room_id='f2000000-0000-0000-0000-000000000010' AND db.singleton;
INSERT INTO playback_preparations(session_id,user_id,room_id,lifecycle_epoch,owner_epoch,created_at)
    SELECT session_id,user_id,room_id,lifecycle_epoch,owner_epoch,created_at FROM playback_requests WHERE session_id='f2000000-0000-0000-0000-000000000042';
SELECT revision FROM cache_budget WHERE singleton FOR UPDATE;
INSERT INTO static_hls_captures(id,session_id,user_id,owner_id,resource_authority,request_owner_epoch,created_at,expires_at,
    publication_phase,input_sha256,worker_instance,database_id,reader_version,recipe_version)
SELECT static_hls_operation_id,session_id,user_id,'f2000000-0000-0000-0000-000000000046',
    jsonb_build_object('media_id',static_hls_media_id,'source_id',static_hls_source_id,'source_policy_revision',static_hls_source_revision,'media_source_generation',static_hls_source_generation),
    owner_epoch,created_at,static_hls_root_expires_at,'pending_parent',static_hls_input_sha256,static_hls_worker_instance,static_hls_database_id,2,1
FROM playback_requests WHERE session_id='f2000000-0000-0000-0000-000000000042';
INSERT INTO cache_write_reservations(job_id,owner_id,attempt,bytes,purpose)
    VALUES('f2000000-0000-0000-0000-000000000044','f2000000-0000-0000-0000-000000000046',0,134217728,'static_hls_capture');
UPDATE cache_budget SET revision=revision+1 WHERE singleton;
UPDATE static_hls_captures SET state='verified',inventory_encrypted='synthetic-parent-inventory',root_digest=repeat('d',64)
    WHERE id='f2000000-0000-0000-0000-000000000044';
INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,
    lifecycle_epoch,viewer_id,plan_generation,auth_login_hash,auth_membership_epoch,static_hls_capture_id)
SELECT session_id,user_id,room_id,static_hls_media_id,static_hls_media_generation,'synthetic-parent-token',
    pg_temp.child_resource(session_id)||jsonb_build_object('static_hls_capture_id',static_hls_operation_id),static_hls_root_expires_at,
    lifecycle_epoch,viewer_id,plan_generation,auth_login_hash,auth_membership_epoch,static_hls_operation_id
FROM playback_requests WHERE session_id='f2000000-0000-0000-0000-000000000042';
UPDATE static_hls_captures SET publication_phase='published_parent',published_resource=pg_temp.child_resource(session_id),
    published_at=date_trunc('milliseconds',clock_timestamp()) WHERE id='f2000000-0000-0000-0000-000000000044';
UPDATE playback_requests SET status='completed',response_encrypted='synthetic-parent-response' WHERE session_id='f2000000-0000-0000-0000-000000000042';
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.child_assert('published parent is currently authoritative',static_hls_published_parent_authority_allowed('f2000000-0000-0000-0000-000000000044'));

-- One-shot claim is frozen BEFORE logical retirement and positive disposal.
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,created_at,
    room_id,lifecycle_epoch,viewer_id,plan_generation,auth_login_hash,auth_membership_epoch,
    static_hls_input_version,static_hls_input_encrypted,static_hls_input_sha256,static_hls_operation_id,
    static_hls_root_expires_at,static_hls_prepare_expires_at,static_hls_media_id,static_hls_media_generation,
    static_hls_source_id,static_hls_source_revision,static_hls_source_generation,static_hls_worker_instance,static_hls_database_id,static_hls_parent_capture_id)
SELECT user_id,'f2000000-0000-0000-0000-000000000051',repeat('e',64),'f2000000-0000-0000-0000-000000000052',
    'f2000000-0000-0000-0000-000000000053','pending',t.started+interval '45 seconds',t.started+interval '48 hours',t.started,
    room_id,lifecycle_epoch,viewer_id,2,auth_login_hash,auth_membership_epoch,1,'synthetic-child-input',repeat('f',64),
    'f2000000-0000-0000-0000-000000000054',static_hls_root_expires_at,t.started+interval '45 seconds',
    static_hls_media_id,static_hls_media_generation,static_hls_source_id,static_hls_source_revision,static_hls_source_generation,
    static_hls_worker_instance,static_hls_database_id,static_hls_operation_id
FROM playback_requests CROSS JOIN (SELECT date_trunc('milliseconds',clock_timestamp()) AS started) t
WHERE session_id='f2000000-0000-0000-0000-000000000042';
INSERT INTO playback_preparations(session_id,user_id,room_id,lifecycle_epoch,owner_epoch,created_at)
    SELECT session_id,user_id,room_id,lifecycle_epoch,owner_epoch,created_at FROM playback_requests WHERE session_id='f2000000-0000-0000-0000-000000000052';
UPDATE playback_sessions SET stopped=true WHERE id='f2000000-0000-0000-0000-000000000042';
UPDATE playback_requests SET status='failed',response_encrypted=NULL,error_status=409,error_code='static_hls_parent_claimed'
    WHERE session_id='f2000000-0000-0000-0000-000000000042';
UPDATE playback_viewer_plans SET plan_generation=2 WHERE viewer_id='f2000000-0000-0000-0000-000000000040';
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.child_assert('stop alone cannot authorize child capture',NOT static_hls_pending_child_request_authority_allowed('f2000000-0000-0000-0000-000000000052'));

-- SYNTHETIC disposal metadata only: no genuine custody proof is established.
SET CONSTRAINTS ALL DEFERRED;
UPDATE static_hls_captures SET state='disposed',streams_closed_at=clock_timestamp(),process_closed_at=clock_timestamp(),
    process_disposition='never_started',files_removed_at=clock_timestamp(),disposed_at=clock_timestamp()
    WHERE id='f2000000-0000-0000-0000-000000000044' AND owner_id='f2000000-0000-0000-0000-000000000046';
DELETE FROM cache_write_reservations WHERE job_id='f2000000-0000-0000-0000-000000000044';
UPDATE cache_budget SET revision=revision+1 WHERE singleton;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.child_assert('disposed historical parent admits child preparation',static_hls_pending_child_request_authority_allowed('f2000000-0000-0000-0000-000000000052'));
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO static_hls_captures(id,session_id,user_id,owner_id,resource_authority,request_owner_epoch,expires_at,
    publication_phase,input_sha256,worker_instance,database_id,reader_version,recipe_version,child_position_ms,child_selected_audio)
SELECT static_hls_operation_id,session_id,user_id,'f2000000-0000-0000-0000-000000000056',
    jsonb_build_object('media_id',static_hls_media_id,'source_id',static_hls_source_id,'source_policy_revision',static_hls_source_revision,'media_source_generation',static_hls_source_generation),
    owner_epoch,static_hls_root_expires_at,'pending_child',static_hls_input_sha256,static_hls_worker_instance,static_hls_database_id,2,1,
    1234,'{"kind":"single","stream_index":1}'::jsonb
FROM playback_requests WHERE session_id='f2000000-0000-0000-0000-000000000052';
INSERT INTO cache_write_reservations(job_id,owner_id,attempt,bytes,purpose)
    VALUES('f2000000-0000-0000-0000-000000000054','f2000000-0000-0000-0000-000000000056',0,134217728,'static_hls_capture');
UPDATE cache_budget SET revision=revision+1 WHERE singleton;
SET CONSTRAINTS ALL IMMEDIATE;

-- Negative 1: wrong root and substituted startup cannot verify/adopt capture.
SELECT pg_temp.child_rejects($q$UPDATE static_hls_captures SET state='verified',inventory_encrypted='synthetic-child-inventory',root_digest=repeat('9',64)
    WHERE id='f2000000-0000-0000-0000-000000000054'$q$,'static_hls_child_recapture_required');
SELECT pg_temp.child_rejects($q$UPDATE static_hls_captures SET worker_instance='f2000000-0000-0000-0000-000000000099'
    WHERE id='f2000000-0000-0000-0000-000000000054'$q$,'static_hls_child_capture_immutable');
UPDATE static_hls_captures SET state='verified',inventory_encrypted='synthetic-child-inventory',root_digest=repeat('d',64)
    WHERE id='f2000000-0000-0000-0000-000000000054';

CREATE FUNCTION pg_temp.publish_child(include_job boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,
        lifecycle_epoch,viewer_id,plan_generation,auth_login_hash,auth_membership_epoch,static_hls_capture_id)
    SELECT session_id,user_id,room_id,static_hls_media_id,static_hls_media_generation,'synthetic-child-token',
        pg_temp.child_resource(session_id)||jsonb_build_object('static_hls_capture_id',static_hls_operation_id),static_hls_root_expires_at,
        lifecycle_epoch,viewer_id,plan_generation,auth_login_hash,auth_membership_epoch,static_hls_operation_id
    FROM playback_requests WHERE session_id='f2000000-0000-0000-0000-000000000052';
    UPDATE static_hls_captures SET publication_phase='published_child',published_resource=pg_temp.child_resource(session_id),published_at=clock_timestamp()
        WHERE id='f2000000-0000-0000-0000-000000000054';
    UPDATE playback_requests SET status='completed',response_encrypted='synthetic-child-response'
        WHERE session_id='f2000000-0000-0000-0000-000000000052';
    PERFORM pg_temp.child_assert('queue predicate does not require an existing job',static_hls_child_queue_authority_allowed('f2000000-0000-0000-0000-000000000052'));
    IF include_job THEN
        INSERT INTO media_jobs(id,session_id,status,spec,timing_version,timing_attempt,queue_entered_at,run_started_at,
            metrics_queue_ms,metrics_queue_complete,metrics_queue_accounted_attempt,logical_queue)
        SELECT session_id,session_id,'queued',jsonb_build_object('kind','static_hls_child','reader_version',2,'recipe_version',1,
            'input_version',1,'graph_version',1,'capture_id',id,'input_sha256',input_sha256,'root_digest',root_digest,
            'worker_instance',worker_instance,'position_ms',child_position_ms,'selected_audio',child_selected_audio,'estimated_output_bytes',33554432),
            1,0,clock_timestamp(),NULL,0,true,0,'static_hls_v1'
        FROM static_hls_captures WHERE id='f2000000-0000-0000-0000-000000000054';
    END IF;
    SET CONSTRAINTS ALL IMMEDIATE;
END $$;

-- Negative 2: publication without its final exact job fails deferred validation,
-- and the helper's exception subtransaction rolls back all three partial rows.
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.child_rejects('SELECT pg_temp.publish_child(false)','static_hls_child_atomic_publication_required');
SELECT pg_temp.child_assert('failed publication leaves request pending and capture unpublished',
    EXISTS(SELECT 1 FROM playback_requests r JOIN static_hls_captures c ON c.session_id=r.session_id
        WHERE r.session_id='f2000000-0000-0000-0000-000000000052' AND r.status='pending' AND c.publication_phase='pending_child')
    AND NOT EXISTS(SELECT 1 FROM playback_sessions WHERE id='f2000000-0000-0000-0000-000000000052'));

-- Positive: all request/session/capture/exact queued-job constraints run now.
SELECT pg_temp.publish_child(true);
SELECT pg_temp.child_assert('exact child publication committed shape',
    EXISTS(SELECT 1 FROM playback_requests r JOIN static_hls_captures c ON c.session_id=r.session_id JOIN media_jobs j ON j.id=r.session_id
        WHERE r.session_id='f2000000-0000-0000-0000-000000000052' AND r.status='completed' AND c.publication_phase='published_child'
        AND j.status='queued' AND j.attempt=0 AND static_hls_child_job_matches(j,r,c)));
SELECT pg_temp.child_assert('input ownership and disposal never grant playable output',
    NOT static_hls_child_output_authority_allowed('f2000000-0000-0000-0000-000000000052')
    AND NOT static_hls_session_allowed('f2000000-0000-0000-0000-000000000052'));

-- Negative 3: retained one-shot claim cannot be deleted/reset for reuse.
SELECT pg_temp.child_rejects($q$DELETE FROM playback_requests WHERE session_id='f2000000-0000-0000-0000-000000000052'$q$,'static_hls_child_claim_retained');
SELECT pg_temp.child_rejects($q$UPDATE playback_requests SET static_hls_parent_capture_id=NULL WHERE session_id='f2000000-0000-0000-0000-000000000052'$q$,'static_hls_child_claim_immutable');
-- Negative 4: generic queue/spec downgrade cannot replace the immutable child.
SELECT pg_temp.child_rejects($q$UPDATE media_jobs SET logical_queue=NULL,spec='{}'::jsonb WHERE id='f2000000-0000-0000-0000-000000000052'$q$,'static_hls_child_queue_contract_required');
SET CONSTRAINTS ALL IMMEDIATE;

-- Every field below remains SYNTHETIC relational test data. In particular
-- decoder/encoder_input_scope_reaped=true does NOT mean any process ever ran.
-- Such JSON cannot construct ValidatedChildOutput or a Rust publication receipt.
CREATE TEMP TABLE child_fixture_output AS
WITH bytes AS (SELECT
    E'#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1.000,\ns000.m4s\n#EXT-X-ENDLIST\n'::text AS manifest,
    'synthetic-not-an-init-container'::text AS init,
    'synthetic-not-a-media-segment'::text AS segment),
resources AS (SELECT *,jsonb_build_array(
    jsonb_build_object('name','index.m3u8','bytes',octet_length(manifest),'sha256',encode(sha256(convert_to(manifest,'UTF8')),'hex')),
    jsonb_build_object('name','init.mp4','bytes',octet_length(init),'sha256',encode(sha256(convert_to(init,'UTF8')),'hex')),
    jsonb_build_object('name','s000.m4s','bytes',octet_length(segment),'sha256',encode(sha256(convert_to(segment,'UTF8')),'hex'))
    ) AS resources FROM bytes)
SELECT manifest,resources,octet_length(manifest)+octet_length(init)+octet_length(segment) AS total_bytes,
    encode(sha256(convert_to(manifest,'UTF8')),'hex') AS manifest_sha256,
    jsonb_build_object('version',1,'validation_kind','complete_owned_child_v1',
        'source_identity',jsonb_build_object('capture_id','f2000000-0000-0000-0000-000000000054',
            'owner_id','f2000000-0000-0000-0000-000000000056','relative_key','static-hls/f2000000-0000-0000-0000-000000000054'),
        'resources',resources,'encoder_input_scope_reaped',true,'requested_position_ms',1234,
        'decoder',jsonb_build_object('process_tree_reaped',true,'exit_code',0,
            'manifest_sha256',encode(sha256(convert_to(manifest,'UTF8')),'hex')),
        'fixture_only','NO_NATIVE_PROCESS_OR_FILESYSTEM_PROOF') AS evidence
FROM resources;
SELECT pg_temp.child_assert('complete s000 resource shape only',
    static_hls_child_output_resources_match(resources,1,total_bytes)) FROM child_fixture_output;
SELECT pg_temp.child_assert('generic index0 name is not a child resource',NOT
    static_hls_child_output_resources_match(replace(resources::text,'s000.m4s','index0.m4s')::jsonb,1,total_bytes))
    FROM child_fixture_output;

-- Negative publication is tested BEFORE the run lease begins. A version label
-- cannot substitute for actual original running claim/output/proof admission.
SELECT pg_temp.child_rejects($q$INSERT INTO media_outputs(job_id,attempt,owner_id,status,relative_dir,
    validation_version,manifest_sha256,segment_count,published_at,created_at,cleanup_after)
    VALUES('f2000000-0000-0000-0000-000000000052',1,'f2000000-0000-0000-0000-000000000061','published',
        'f2000000-0000-0000-0000-000000000052/1',4,repeat('9',64),1,clock_timestamp(),clock_timestamp(),clock_timestamp())$q$,
    'static_hls_child_output_write_shape_required');

-- Fixture phases take longer than the real one-second observation lease.
-- Repeat ONLY the existing same-original-owner renewal, bounded by the same
-- run_started_at+20 seconds, preparation/root/session fences. The guard rejects
-- an expired original lease; this helper never revives it or extends the root.
CREATE FUNCTION pg_temp.renew_child_output_fixture() RETURNS void LANGUAGE plpgsql AS $$
DECLARE changed bigint;
BEGIN
    UPDATE media_jobs j SET lease_until=LEAST(t.tick+interval '1 second',
        j.run_started_at+interval '20 seconds',r.lease_until,r.static_hls_prepare_expires_at,
        r.static_hls_root_expires_at,p.expires_at)
    FROM (SELECT clock_timestamp() AS tick) t,playback_requests r,playback_sessions p
    WHERE j.id='f2000000-0000-0000-0000-000000000052' AND r.session_id=j.session_id AND p.id=j.session_id
        AND j.status='running' AND j.owner_id='f2000000-0000-0000-0000-000000000061' AND j.attempt=1
        AND static_hls_child_job_attempt_authority_allowed(j.id,j.owner_id,j.attempt);
    GET DIAGNOSTICS changed=ROW_COUNT;
    IF changed<>1 THEN RAISE EXCEPTION 'fixture cannot renew expired original owner'; END IF;
END $$;

-- One exact original scheduling owner, one attempt, compulsory job execution.
SET CONSTRAINTS ALL DEFERRED;
SELECT set_config('rainsync.static_hls_worker_instance','f2000000-0000-0000-0000-000000000045',true),
    set_config('rainsync.static_hls_child_capture_owner','f2000000-0000-0000-0000-000000000056',true),
    set_config('rainsync.static_hls_child_job_owner','f2000000-0000-0000-0000-000000000061',true),
    set_config('rainsync.static_hls_child_execution_id','f2000000-0000-0000-0000-000000000060',true);
UPDATE media_jobs j SET status='running',owner_id='f2000000-0000-0000-0000-000000000061',attempt=1,
    lease_until=LEAST(t.tick+interval '1 second',r.lease_until,r.static_hls_prepare_expires_at,r.static_hls_root_expires_at,p.expires_at),
    timing_version=1,timing_attempt=1,queue_entered_at=NULL,run_started_at=t.tick
FROM (SELECT clock_timestamp() AS tick) t,playback_requests r,playback_sessions p
WHERE j.id='f2000000-0000-0000-0000-000000000052' AND r.session_id=j.session_id AND p.id=j.session_id;
INSERT INTO media_executions(id,session_id,kind,job_id,attempt,owner_id,created_at)
    VALUES('f2000000-0000-0000-0000-000000000060','f2000000-0000-0000-0000-000000000052','job',
        'f2000000-0000-0000-0000-000000000052',1,'f2000000-0000-0000-0000-000000000061',clock_timestamp());
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.child_assert('exact original running attempt',static_hls_child_job_attempt_authority_allowed(
    'f2000000-0000-0000-0000-000000000052','f2000000-0000-0000-0000-000000000061',1));
SELECT pg_temp.renew_child_output_fixture();

-- Independent output admission, still zero validation and no exposed manifest.
-- Diagnostic clocks do not renew or extend any authority. Cold planning must
-- fit the SAME real one-second scheduling lease, exactly like the typed path.
SELECT 'before_output_admission' AS fixture_clock,clock_timestamp() AS observed,
    lease_until-clock_timestamp() AS lease_remaining,status,attempt,owner_id
FROM media_jobs WHERE id='f2000000-0000-0000-0000-000000000052';
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO cache_write_reservations(job_id,owner_id,attempt,bytes,purpose)
    VALUES('f2000000-0000-0000-0000-000000000052','f2000000-0000-0000-0000-000000000061',1,33554432,'static_hls_child_output');
INSERT INTO media_outputs(job_id,attempt,owner_id,status,relative_dir,validation_version,created_at,cleanup_after)
    VALUES('f2000000-0000-0000-0000-000000000052',1,'f2000000-0000-0000-0000-000000000061','writing',
        'f2000000-0000-0000-0000-000000000052/1',0,clock_timestamp(),clock_timestamp());
UPDATE cache_budget SET revision=revision+1 WHERE singleton;
SELECT 'before_output_admission_final_check' AS fixture_clock,clock_timestamp() AS observed,
    lease_until-clock_timestamp() AS lease_remaining,status,attempt,owner_id
FROM media_jobs WHERE id='f2000000-0000-0000-0000-000000000052';
SET CONSTRAINTS ALL IMMEDIATE;

-- Atomic SQL tuple only: full evidence + output published + job succeeded +
-- exact original encoder execution reap. It is not actual decoder validation.
SELECT 'before_original_publication_renewal' AS fixture_clock,clock_timestamp() AS observed,
    lease_until-clock_timestamp() AS lease_remaining,status,attempt,owner_id
FROM media_jobs WHERE id='f2000000-0000-0000-0000-000000000052';
SELECT pg_temp.renew_child_output_fixture();
SELECT 'before_full_publication' AS fixture_clock,clock_timestamp() AS observed,
    lease_until-clock_timestamp() AS lease_remaining,status,attempt,owner_id
FROM media_jobs WHERE id='f2000000-0000-0000-0000-000000000052';
SET CONSTRAINTS ALL DEFERRED;
SELECT set_config('rainsync.static_hls_child_output_publication','full_child_snapshot_v1',true);
INSERT INTO static_hls_child_output_publications(job_id,attempt,owner_id,execution_id,capture_id,input_sha256,
    root_digest,root_expires_at,relative_dir,validation_kind,validation_version,manifest,manifest_sha256,
    segment_count,resources,total_bytes,evidence,evidence_plaintext,evidence_sha256,published_at)
SELECT j.id,j.attempt,j.owner_id,'f2000000-0000-0000-0000-000000000060',c.id,c.input_sha256,c.root_digest,c.expires_at,
    j.id::text||'/1','static_hls_full_child_snapshot_v1',1,f.manifest,f.manifest_sha256,1,
    f.resources,f.total_bytes,f.evidence,f.evidence::text,encode(sha256(convert_to(f.evidence::text,'UTF8')),'hex'),clock_timestamp()
FROM media_jobs j JOIN static_hls_captures c ON c.session_id=j.session_id CROSS JOIN child_fixture_output f
WHERE j.id='f2000000-0000-0000-0000-000000000052';
UPDATE media_outputs o SET status='published',validation_version=4,visible_manifest=proof.manifest,
    ready_segments=proof.segment_count,manifest_sha256=proof.manifest_sha256,segment_count=proof.segment_count,
    published_at=proof.published_at,cleanup_after=proof.root_expires_at
FROM static_hls_child_output_publications proof WHERE o.job_id=proof.job_id AND o.attempt=proof.attempt;
UPDATE media_jobs SET status='succeeded',lease_until=NULL,error=NULL,timing_version=NULL,timing_attempt=NULL,
    queue_entered_at=NULL,run_started_at=NULL WHERE id='f2000000-0000-0000-0000-000000000052';
UPDATE media_executions e SET reaped_at=proof.published_at FROM static_hls_child_output_publications proof
    WHERE e.id=proof.execution_id;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.child_assert('all four publication facts atomic exact',static_hls_child_output_publication_matches('f2000000-0000-0000-0000-000000000052'));
SELECT pg_temp.child_assert('input plus output reservations both counted',
    (SELECT sum(bytes)=167772160 FROM cache_write_reservations WHERE job_id IN
        ('f2000000-0000-0000-0000-000000000052','f2000000-0000-0000-0000-000000000054')));

SELECT pg_temp.child_assert('published retention does not require input disposal',static_hls_child_output_retention_authority_allowed(
    'f2000000-0000-0000-0000-000000000052','f2000000-0000-0000-0000-000000000061',1));
SELECT set_config('rainsync.static_hls_child_reader','original_published_child_v1',true);
SELECT pg_temp.child_assert('full publication alone cannot serve before input disposal',
    NOT static_hls_child_output_authority_allowed('f2000000-0000-0000-0000-000000000052'));

-- SYNTHETIC input disposal fields only; they are not the real CaptureControl
-- Disposed gate which the Rust original receipt also enforces independently.
SET CONSTRAINTS ALL DEFERRED;
UPDATE static_hls_captures SET state='disposed',streams_closed_at=clock_timestamp(),process_closed_at=clock_timestamp(),
    process_disposition='reaped',files_removed_at=clock_timestamp(),disposed_at=clock_timestamp()
    WHERE id='f2000000-0000-0000-0000-000000000054';
DELETE FROM cache_write_reservations WHERE job_id='f2000000-0000-0000-0000-000000000054';
UPDATE cache_budget SET revision=revision+1 WHERE singleton;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.child_assert('full relational read conjunction after input disposal',
    static_hls_child_output_authority_allowed('f2000000-0000-0000-0000-000000000052'));
SELECT set_config('rainsync.static_hls_child_reader','',true);
SELECT pg_temp.child_assert('older generic reader2 cannot consume full child v4',
    NOT static_hls_child_output_authority_allowed('f2000000-0000-0000-0000-000000000052'));
SELECT set_config('rainsync.static_hls_child_reader','original_published_child_v1',true);

-- Exact dedicated delivery execution admission and immutable positive ACK.
SET CONSTRAINTS ALL DEFERRED;
SELECT set_config('rainsync.static_hls_child_delivery_execution','f2000000-0000-0000-0000-000000000070',true),
    set_config('rainsync.static_hls_child_delivery_owner','f2000000-0000-0000-0000-000000000071',true);
INSERT INTO media_executions(id,session_id,kind,owner_id,metrics_entry_candidate,created_at)
    VALUES('f2000000-0000-0000-0000-000000000070','f2000000-0000-0000-0000-000000000052','delivery',
        'f2000000-0000-0000-0000-000000000071',false,clock_timestamp());
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.child_rejects($q$UPDATE media_executions SET owner_id='f2000000-0000-0000-0000-000000000099',reaped_at=clock_timestamp()
    WHERE id='f2000000-0000-0000-0000-000000000070'$q$,'static_hls_child_original_delivery_required');
UPDATE media_executions SET reaped_at=clock_timestamp() WHERE id='f2000000-0000-0000-0000-000000000070';
SELECT pg_temp.child_rejects($q$DELETE FROM media_executions WHERE id='f2000000-0000-0000-0000-000000000070'$q$,'static_hls_child_execution_retained');
SELECT pg_temp.child_rejects($q$DELETE FROM cache_write_reservations WHERE job_id='f2000000-0000-0000-0000-000000000052'$q$,'static_hls_child_output_reservation_retained');

-- SYNTHETIC actual-output-disposal metadata exercises the release fence; it
-- cannot create ChildOutputDisposalProof or acknowledge real files in Rust.
SET CONSTRAINTS ALL DEFERRED;
SELECT set_config('rainsync.static_hls_child_output_disposal_operation','f2000000-0000-0000-0000-000000000080',true);
INSERT INTO static_hls_child_output_disposals(id,job_id,attempt,owner_id,execution_id,capture_id,input_sha256,
    root_digest,relative_dir,process_disposition,directory_device,directory_inode,disposed_at)
SELECT 'f2000000-0000-0000-0000-000000000080',j.id,j.attempt,j.owner_id,proof.execution_id,proof.capture_id,
    proof.input_sha256,proof.root_digest,proof.relative_dir,'reaped',1,2,clock_timestamp()
FROM media_jobs j JOIN static_hls_child_output_publications proof ON proof.job_id=j.id;
DELETE FROM media_outputs WHERE job_id='f2000000-0000-0000-0000-000000000052';
DELETE FROM cache_write_reservations WHERE job_id='f2000000-0000-0000-0000-000000000052';
UPDATE cache_budget SET revision=revision+1 WHERE singleton;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.child_assert('output accounting released only with exact disposal receipt',
    NOT EXISTS(SELECT 1 FROM media_outputs WHERE job_id='f2000000-0000-0000-0000-000000000052')
    AND NOT EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id='f2000000-0000-0000-0000-000000000052')
    AND EXISTS(SELECT 1 FROM static_hls_child_output_disposals WHERE id='f2000000-0000-0000-0000-000000000080')
    AND EXISTS(SELECT 1 FROM static_hls_child_output_publications WHERE job_id='f2000000-0000-0000-0000-000000000052')
    AND NOT static_hls_child_output_authority_allowed('f2000000-0000-0000-0000-000000000052'));
ROLLBACK;
