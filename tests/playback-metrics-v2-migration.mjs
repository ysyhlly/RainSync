// Real isolated PostgreSQL upgrade. Historical slots remain v1 or absent.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isolatedPostgres} from './fixtures/postgres.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR);
const id=randomUUID(),root=resolve(process.env.RAINSYNC_ARTIFACT_DIR,'playback-metrics-v2-migration',id);
await mkdir(root,{recursive:true});
const db=isolatedPostgres({root,name:'metrics-v2-upgrade',id});
const owner=randomUUID(),room=randomUUID(),viewer=randomUUID(),session=randomUUID();
const q=v=>`'${String(v).replaceAll("'","''")}'`;
const report={result:'running',checks:[],rejections:[],migrations:[]};
const check=(name,fn)=>{fn();report.checks.push(name);};
const reject=(name,sql)=>{assert.throws(()=>db.sql(sql));report.rejections.push(name);};
const sha=v=>createHash('sha256').update(v).digest('hex');
try {
 await db.start();report.postgres=db.diagnostics();
 const names=(await readdir(resolve(repo,'migrations'))).filter(n=>/^\d+_.*\.sql$/.test(n)&&Number(n.split('_')[0])<=40).sort();
 assert.equal(names.length,40);
 for(const name of names.slice(0,39)){const bytes=await readFile(resolve(repo,'migrations',name));db.sql(`BEGIN;${bytes};COMMIT;`);report.migrations.push({name,sha256:sha(bytes)});}
 db.sql(`INSERT INTO users(id,username,password_hash) VALUES('${owner}','metrics-v2-upgrade','not-for-login');
 INSERT INTO rooms(id,name,owner_id) VALUES('${room}','metrics v2 upgrade','${owner}');
 INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation)
 SELECT '${owner}','${room}',CASE WHEN g=1 THEN '${viewer}'::uuid ELSE md5('${id}:'||g)::uuid END,2 FROM generate_series(1,1024) g;
 UPDATE playback_viewer_plans SET metrics_meter_start_generation=1,metrics_media_generation=1,metrics_lifecycle_epoch=0,metrics_startup_origin='user_intent',metrics_admitted_at=clock_timestamp() WHERE viewer_id='${viewer}';
 INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch,viewer_id,plan_generation,playback_metrics_version,metrics_meter_start_generation)
 VALUES('${session}','${owner}','${room}',1,'generated-v2-upgrade-token','{}',now()+interval '1 hour',0,'${viewer}',2,1,1);`);
 const beforeViewers=db.sql("SELECT jsonb_agg(to_jsonb(v) ORDER BY viewer_id)::text FROM playback_viewer_plans v");
 const beforeSessions=db.sql("SELECT jsonb_agg(to_jsonb(v) ORDER BY id)::text FROM playback_sessions v");
 const bytes=await readFile(resolve(repo,'migrations',names[39]));db.sql(`BEGIN;${bytes};COMMIT;`);report.migrations.push({name:names[39],sha256:sha(bytes)});
 check('1024 viewer values remain byte-for-byte, only known slot receives version1',()=>{
  assert.equal(db.sql("SELECT jsonb_agg(to_jsonb(v)-ARRAY['metrics_version','metrics_first_frame_source','metrics_first_frame_mode'] ORDER BY viewer_id)::text FROM playback_viewer_plans v"),beforeViewers);
  assert.equal(db.sql('SELECT count(*) FROM playback_viewer_plans WHERE metrics_version=1'),'1');
  assert.equal(db.sql('SELECT count(*) FROM playback_viewer_plans WHERE metrics_version IS NULL'),'1023');
 });
 check('legacy session preserved with unknown attribution',()=>assert.equal(db.sql("SELECT jsonb_agg(to_jsonb(v)-ARRAY['metrics_source_kind','metrics_delivery_mode'] ORDER BY id)::text FROM playback_sessions v"),beforeSessions));
 const slot=`UPDATE playback_viewer_plans SET `, where=` WHERE viewer_id='${viewer}'`;
 for(const [name,change] of [['null version','metrics_version=NULL'],['unknown version','metrics_version=3'],['v1 attribution',"metrics_first_frame_source='local',metrics_first_frame_mode='direct'"],['unpaired attribution',"metrics_first_frame_source='local'"],['absent first frame',"metrics_version=2,metrics_first_frame_source='local',metrics_first_frame_mode='direct'"]])reject(name,slot+change+where);
 const sessionUpdate=`UPDATE playback_sessions SET `,sessionWhere=` WHERE id='${session}'`;
 for(const [name,change] of [['null paired version','playback_metrics_version=NULL'],['unknown session version','playback_metrics_version=3'],['unpaired session source',"metrics_source_kind='local'"],['unknown source',"playback_metrics_version=2,metrics_source_kind='arbitrary',metrics_delivery_mode='direct'"],['unknown mode',"playback_metrics_version=2,metrics_source_kind='local',metrics_delivery_mode='arbitrary'"]])reject(name,sessionUpdate+change+sessionWhere);
 db.sql(sessionUpdate+"playback_metrics_version=2,metrics_source_kind='local',metrics_delivery_mode='direct'"+sessionWhere);
 check('new v2 publication accepts bounded trusted facts',()=>assert.equal(db.sql(`SELECT playback_metrics_version||':'||metrics_source_kind||':'||metrics_delivery_mode FROM playback_sessions WHERE id='${session}'`),'2:local:direct'));
 report.result='passed';
} catch(error){report.result='failed';report.error=error.stack;throw error;}
finally{await db.stop();report.cleanup=await db.verifyStopped();await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(`Evidence: ${root}/report.json`);}
