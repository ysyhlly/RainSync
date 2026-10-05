// Owned PostgreSQL schema-level fencing, commit-expiry and incarnation regression.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isolatedPostgres} from './fixtures/postgres.mjs';
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR);
const id=randomUUID(),root=resolve(process.env.RAINSYNC_ARTIFACT_DIR,'control-cluster-sql',id);await mkdir(root,{recursive:true});
const db=isolatedPostgres({root,name:'control-cluster-sql',id});
const q=v=>`'${String(v).replaceAll("'","''")}'`;
const node=randomUUID(),instance=randomUUID(),other=randomUUID(),otherInstance=randomUUID(),user=randomUUID(),room=randomUUID();
const report={schema_version:1,result:'running',checks:[],scope:'Owned disposable PostgreSQL trigger/lease tests only; no server/browser/performance claim'};
try {
 await db.start();
 for(const name of(await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())db.sql(await readFile(resolve('migrations',name),'utf8'));
 db.sql(`INSERT INTO users VALUES(${q(user)},'owned-cluster-sql','not-a-login',true);INSERT INTO control_nodes(id,route_origin,incarnation) VALUES(${q(node)},'http://127.0.0.1:8181',${q(instance)}),(${q(other)},'http://127.0.0.1:8182',${q(otherInstance)});INSERT INTO control_cluster_activation VALUES(true,${q(randomBytes(32).toString('hex'))},clock_timestamp());`);
 const context=`SELECT set_config('rainsync.control_node',${q(node)},false),set_config('rainsync.control_instance',${q(instance)},false);`;
 db.sql(`${context}BEGIN;INSERT INTO rooms(id,name,owner_id) VALUES(${q(room)},'owned',${q(user)});INSERT INTO room_members(room_id,user_id) VALUES(${q(room)},${q(user)});INSERT INTO room_snapshots VALUES(${q(room)},'{"revision":0}');COMMIT;`);
 assert.equal(db.sql(`SELECT owner_node FROM room_leases WHERE room_id=${q(room)}`),node);
 report.checks.push('all current migrations load; opt-in creator acquires first lease atomically with new room');
 assert.throws(()=>db.sql(`UPDATE room_snapshots SET state=state WHERE room_id=${q(room)}`),/room_owner_lost/);
 assert.throws(()=>db.sql(`SELECT set_config('rainsync.control_node',${q(other)},false),set_config('rainsync.control_instance',${q(otherInstance)},false); UPDATE room_snapshots SET state=state WHERE room_id=${q(room)}`),/room_owner_lost/);
 report.checks.push('unconfigured pools and other live nodes cannot mutate existing room snapshots');
 db.sql(`UPDATE room_leases SET lease_until=clock_timestamp()+interval '250 milliseconds' WHERE room_id=${q(room)};UPDATE control_nodes SET heartbeat_at=clock_timestamp() WHERE id=${q(node)};`);
 assert.throws(()=>db.sql(`${context}BEGIN;UPDATE room_snapshots SET state='{"revision":1}' WHERE room_id=${q(room)};SELECT pg_sleep(0.35);COMMIT;`),/room_owner_lost/);
 assert.equal(db.sql(`SELECT state->>'revision' FROM room_snapshots WHERE room_id=${q(room)}`),'0');
 report.checks.push('lease expires during transaction; deferred COMMIT trigger rejects entire write and no ACK-able snapshot is committed');
 db.sql(`UPDATE room_leases SET owner_node=${q(other)},owner_incarnation=${q(otherInstance)},fencing_token=nextval('room_fencing_tokens'),lease_until=clock_timestamp()+interval '10 seconds' WHERE room_id=${q(room)};UPDATE control_nodes SET heartbeat_at=clock_timestamp() WHERE id=${q(other)};`);
 assert.throws(()=>db.sql(`${context}UPDATE room_snapshots SET state=state WHERE room_id=${q(room)}`),/room_owner_lost/);
 const newInstance=randomUUID();db.sql(`UPDATE control_nodes SET incarnation=${q(newInstance)} WHERE id=${q(other)};`);
 assert.throws(()=>db.sql(`SELECT set_config('rainsync.control_node',${q(other)},false),set_config('rainsync.control_instance',${q(otherInstance)},false);UPDATE room_snapshots SET state=state WHERE room_id=${q(room)}`),/room_owner_lost/);
 report.checks.push('takeover changes fence; same node ID restart cannot revive old-pool incarnation, even with healthy node heartbeat');
 report.result='passed';
}catch(error){report.result='failed';report.error=String(error);throw error}
finally{await db.stop();report.cleanup=await db.verifyStopped();await writeFile(resolve(root,'evidence.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))}
