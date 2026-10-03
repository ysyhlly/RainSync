// Current-schema synthetic media fixtures must name their actual owned client,
// user and membership. This bypasses media negotiation, never login provenance.
// Historical NULL/upgrade fixtures must instead seed a pre-0041 schema.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const uuid=value=>{assert.match(value,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);return quote(value)};
export function testLoginHash(f,client) {
 assert.ok(f?.id && typeof f.sql==='function','an owned isolated fixture is required');
 assert.equal(client?.fixture,f,'use this fixture\'s explicit authenticated client');
 const match=/(?:^|;\s*)rainsync_session=([0-9a-f]{64})(?:;|$)/.exec(client.cookie??'');
 assert.ok(match,'explicit current test-client cookie is required');
 return createHash('sha256').update(match[1]).digest('hex');
}

/** Execute test-only grant/reservation INSERTs inside exact-login admission.
 * A generated request owner is a fixture label, never a process/drain receipt.
 * Nothing is selected from "some live session" and no legacy row is adopted.
 */
export function withPlaybackAdmission(f,{client,user,room,session,key=randomUUID()},sql) {
 const hash=testLoginHash(f,client);
 const values={user:uuid(user),room:uuid(room),session:uuid(session),key:uuid(key),login:quote(hash)};
 assert.equal(typeof sql,'string');assert.ok(sql.trim());
 const {user:u,room:r,session:s,key:k,login:l}=values;
 f.sql(`BEGIN;
 SELECT id FROM rooms WHERE id=${r} AND lifecycle='active' FOR NO KEY UPDATE;
 SELECT membership_epoch FROM room_members WHERE room_id=${r} AND user_id=${u} FOR KEY SHARE;
 SELECT token_hash FROM sessions WHERE token_hash=${l} AND user_id=${u} FOR SHARE;
 INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,room_id,lifecycle_epoch,auth_login_hash,auth_membership_epoch)
 SELECT ${u},${k},'owned-explicit-login-fixture',${s},gen_random_uuid(),'pending',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '48 hours',r.id,r.lifecycle_epoch,login.token_hash,m.membership_epoch
 FROM rooms r JOIN room_members m ON m.room_id=r.id AND m.user_id=${u}
 JOIN sessions login ON login.user_id=m.user_id AND login.token_hash=${l}
 WHERE r.id=${r} AND r.lifecycle='active' AND login.expires_at>clock_timestamp();
 DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM playback_requests WHERE session_id=${s} AND auth_login_hash=${l}) THEN RAISE EXCEPTION 'owned_fixture_login_admission_failed'; END IF; END $$;
 ${sql};
 UPDATE playback_requests SET status='completed',response_encrypted='owned-synthetic-fixture-not-api-replay' WHERE session_id=${s};
 COMMIT;`);
 return {key,loginHash:hash};
}
