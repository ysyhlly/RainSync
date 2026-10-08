// Actual isolated 1-31 -> 32 upgrade, not an old production database.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isolatedPostgres} from './fixtures/postgres.mjs';
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR);
const id=randomUUID(),root=resolve(process.env.RAINSYNC_ARTIFACT_DIR,'source-access-migration',id);
await mkdir(root,{recursive:true});const db=isolatedPostgres({root,name:'source-access-migration',id});
const source=randomUUID(),reservation=randomUUID();const report={schema_version:1,result:'running',migrations:[],checks:[]};
try{
 await db.start();report.postgres=db.diagnostics();
 const files=(await readdir('migrations')).filter(n=>/^\d+_.+\.sql$/.test(n)).sort();
 for(const name of files.filter(n=>Number(n.split('_')[0])<=31)) {const bytes=await readFile('migrations/'+name);db.sql(`BEGIN; ${bytes}; COMMIT;`);report.migrations.push({name,sha256:createHash('sha256').update(bytes).digest('hex')});}
 db.sql(`INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${source}','legacy owned source','jellyfin','legacy-ciphertext'); INSERT INTO upstream_reservations(id,user_id,request_key,owner_epoch,room_id,media_id,source_id,generation,kind,device_id,origin_key,scope_encrypted,state,negotiation,io_uncertain,cleanup_attempts,last_error) VALUES('${reservation}','${randomUUID()}','${randomUUID()}','${randomUUID()}','${randomUUID()}','${randomUUID()}','${source}',3,'jellyfin','owned-legacy-device','legacy-origin','legacy-scope','cleanup_failed','unknown',true,5,'upstream_io_uncertain');`);
 const before=db.sql(`SELECT row_to_json(u)::text FROM upstream_reservations u WHERE id='${reservation}'`);
 const name='0032_source_access_policy_revisions.sql',bytes=await readFile('migrations/'+name);db.sql(`BEGIN; ${bytes}; COMMIT;`);report.migrations.push({name,sha256:createHash('sha256').update(bytes).digest('hex')});
 assert.equal(db.sql(`SELECT access_policy_revision=0 AND config_encrypted='legacy-ciphertext' FROM sources WHERE id='${source}'`),'t');report.checks.push('existing encrypted source stays legacy epoch zero');
 const old=JSON.parse(before),now=JSON.parse(db.sql(`SELECT row_to_json(u)::text FROM upstream_reservations u WHERE id='${reservation}'`));assert.equal(now.source_policy_revision,0);delete now.source_policy_revision;assert.deepEqual(now,old);report.checks.push('unknown cleanup, owner identity, budgets and absent positive receipts stay byte-value equivalent');
 for(const [table,column,where]of [['sources','access_policy_revision',`id='${source}'`],['upstream_reservations','source_policy_revision',`id='${reservation}'`]])for(const value of ['NULL','-1']){assert.throws(()=>db.sql(`UPDATE ${table} SET ${column}=${value} WHERE ${where}`));report.checks.push(`${table} rejects ${value} revision`)}
 const newer=randomUUID();db.sql(`INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${newer}','legacy insert','http','legacy');`);assert.equal(db.sql(`SELECT access_policy_revision FROM sources WHERE id='${newer}'`),'0');report.checks.push('old INSERT column list retains explicit legacy default');
 db.sql(`UPDATE sources SET config_encrypted='tightened-ciphertext' WHERE id='${source}'`);
 assert.equal(db.sql(`SELECT access_policy_revision FROM sources WHERE id='${source}'`),'1');
 assert.equal(db.sql(`SELECT revision=1 AND config_encrypted='tightened-ciphertext' FROM source_access_policy_snapshots WHERE source_id='${source}'`),'t');
 report.checks.push('configuration mutation automatically advances and atomically snapshots authority');
 db.sql(`DELETE FROM sources WHERE id='${source}'`);
 assert.equal(db.sql(`SELECT revision=1 AND config_encrypted='tightened-ciphertext' FROM source_access_policy_snapshots WHERE source_id='${source}'`),'t');
 assert.equal(db.sql(`SELECT state='cleanup_failed' AND io_uncertain AND NOT stop_confirmed AND cleanup_attempts=5 FROM upstream_reservations WHERE id='${reservation}'`),'t');
 report.checks.push('source deletion preserves latest restriction and unresolved original cleanup obligation');
 report.result='passed';
}catch(error){report.result='failed';report.failure=String(error.stack??error);process.exitCode=1}
finally{await db.stop();report.cleanup=await db.verifyStopped();await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2));console.log(`${report.result}: ${report.checks.length} actual 1-31 to32 checks; ${resolve(root,'report.json')}`)}
