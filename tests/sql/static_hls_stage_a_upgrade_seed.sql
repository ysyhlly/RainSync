-- Synthetic SQL history for 0043 -> 0044 upgrade checks only.
-- No scanner, encryption, process, file or disposal proof is supplied here.
BEGIN;
SELECT set_config('rainsync.static_hls_reader','1',true);
DO $$
DECLARE n integer; principal uuid; room uuid; source uuid; media uuid;
    session uuid; capture uuid; owner uuid; login text;
    admitted timestamptz=date_trunc('milliseconds',clock_timestamp());
BEGIN
    FOR n IN 1..2 LOOP
        principal=('e1000000-0000-0000-0000-'||lpad((n*100+1)::text,12,'0'))::uuid;
        room=('e1000000-0000-0000-0000-'||lpad((n*100+10)::text,12,'0'))::uuid;
        source=('e1000000-0000-0000-0000-'||lpad((n*100+20)::text,12,'0'))::uuid;
        media=('e1000000-0000-0000-0000-'||lpad((n*100+30)::text,12,'0'))::uuid;
        session=('e1000000-0000-0000-0000-'||lpad((n*100+42)::text,12,'0'))::uuid;
        capture=('e1000000-0000-0000-0000-'||lpad((n*100+44)::text,12,'0'))::uuid;
        owner=('e1000000-0000-0000-0000-'||lpad((n*100+46)::text,12,'0'))::uuid;
        login=repeat(CASE WHEN n=1 THEN 'a' ELSE 'b' END,64);
        INSERT INTO users(id,username,password_hash) VALUES(principal,'stage_a_sql_'||n,'synthetic');
        INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(login,principal,'synthetic',admitted+interval '1 hour');
        INSERT INTO rooms(id,name,owner_id) VALUES(room,'Stage A SQL history '||n,principal);
        INSERT INTO room_members(room_id,user_id) VALUES(room,principal);
        INSERT INTO sources(id,name,kind,config_encrypted,access_policy_revision) VALUES(source,'synthetic','http','synthetic',1);
        INSERT INTO media_items(id,source_id,title,resource) VALUES(media,source,'synthetic','https://fixture.invalid/selected.m3u8');
        INSERT INTO room_snapshots(room_id,state) VALUES(room,jsonb_build_object('media_id',media,'media_generation',0));
        INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,
            room_id,lifecycle_epoch,auth_login_hash,auth_membership_epoch)
        SELECT principal,session,repeat('c',64),session,owner,'pending',admitted+interval '45 seconds',admitted+interval '48 hours',
            room,0,login,membership_epoch FROM room_members WHERE room_id=room AND user_id=principal;
        INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at)
        VALUES(session,principal,room,media,0,'synthetic-'||n,jsonb_build_object('source_policy_revision',1),admitted+interval '25 minutes');
        UPDATE playback_requests SET status='completed',response_encrypted='synthetic' WHERE session_id=session;
        INSERT INTO static_hls_captures(id,session_id,user_id,owner_id,resource_authority,request_owner_epoch,expires_at)
        SELECT capture,session,principal,owner,resource,owner,admitted+interval '20 minutes' FROM playback_sessions WHERE id=session;
        IF n=1 THEN
            UPDATE static_hls_captures SET state='disposed',streams_closed_at=clock_timestamp(),process_closed_at=clock_timestamp(),
                process_disposition='never_started',files_removed_at=clock_timestamp(),disposed_at=clock_timestamp() WHERE id=capture;
        END IF;
    END LOOP;
END $$;
COMMIT;
