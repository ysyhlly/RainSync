// Real isolated 1-32 -> 33 migration; generated legacy rows, never production data.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedPostgres } from "./fixtures/postgres.mjs";
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR);
const id=randomUUID(), root=resolve(process.env.RAINSYNC_ARTIFACT_DIR,"upstream-policy-migration",id);
await mkdir(root,{recursive:true});
const db=isolatedPostgres({root,name:"upstream-policy-migration",id});
const source=randomUUID(), local=randomUUID(), reservation=randomUUID();
const report={result:"running",scope:"isolated generated legacy database",migrations:[],checks:[]};
const check=(sql,expected,label)=>{assert.equal(db.sql(sql),expected,label);report.checks.push(label)};
try {
  await db.start(); report.postgres=db.diagnostics();
  const files=(await readdir("migrations")).filter(n=>/^\d+_.+\.sql$/.test(n)).sort();
  for(const name of files.filter(n=>Number(n.split("_")[0])<=32)) {
    const bytes=await readFile("migrations/"+name); db.sql(`BEGIN; ${bytes}; COMMIT;`);
    report.migrations.push({name,sha256:createHash("sha256").update(bytes).digest("hex")});
  }
  db.sql(`INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${source}','legacy upstream','jellyfin','old-cipher'),('${local}','legacy local','local','local-cipher');
    INSERT INTO upstream_reservations(id,user_id,request_key,owner_epoch,room_id,media_id,source_id,generation,kind,device_id,origin_key,scope_encrypted,state,negotiation,io_uncertain,cleanup_attempts,last_error)
    VALUES('${reservation}','${randomUUID()}','${randomUUID()}','${randomUUID()}','${randomUUID()}','${randomUUID()}','${source}',3,'jellyfin','owned-legacy-device','legacy-origin','legacy-scope','cleanup_failed','unknown',true,5,'upstream_io_uncertain');`);
  const previous=JSON.parse(db.sql(`SELECT row_to_json(u) FROM upstream_reservations u WHERE id='${reservation}'`));
  const name="0033_upstream_account_policy.sql", bytes=await readFile("migrations/"+name);
  db.sql(`BEGIN; ${bytes}; COMMIT;`);report.migrations.push({name,sha256:createHash("sha256").update(bytes).digest("hex")});
  const now=JSON.parse(db.sql(`SELECT row_to_json(u) FROM upstream_reservations u WHERE id='${reservation}'`));
  assert.equal(now.account_policy_generation,null);delete now.account_policy_generation;assert.deepEqual(now,previous);
  report.checks.push("legacy cleanup uncertainty, identities, budgets and receipts unchanged");
  check(`SELECT state='unknown' AND valid_until IS NULL AND generation=1 FROM source_account_policies WHERE source_id='${source}'`,"t","upgrade creates no positive policy evidence");
  check(`SELECT source_account_policy_allowed('${source}',0,NULL)`,"f","legacy upstream fails closed");
  check(`SELECT source_account_policy_allowed('${local}',0,NULL)`,"t","existing non-upstream source retains authorization");
  check(`SELECT source_account_policy_allowed('${randomUUID()}',0,NULL)`,"f","missing source is never legacy authorization");
  db.sql(`UPDATE source_account_policies SET state='allowed',reason='test',valid_until=clock_timestamp()+interval '5 seconds',observer_epoch='${randomUUID()}',observation_seq=1 WHERE source_id='${source}'`);
  check(`SELECT source_account_policy_allowed('${source}',0,1)`,"t","matching observed generation admits");
  check(`SELECT source_account_policy_allowed('${source}',0,2)`,"f","other generation denied");
  db.sql(`UPDATE source_account_policies SET valid_until=clock_timestamp()-interval '1 second' WHERE source_id='${source}'`);
  check(`SELECT source_account_policy_allowed('${source}',0,1)`,"f","expired positive denied without maintenance");
  db.sql(`UPDATE sources SET config_encrypted='new-account-cipher' WHERE id='${source}'`);
  check(`SELECT source_revision=1 AND generation=2 AND state='unknown' AND valid_until IS NULL AND claim IS NULL FROM source_account_policies WHERE source_id='${source}'`,"t","account/config replacement atomically resets evidence and claims");
  db.sql(`UPDATE sources SET kind='emby' WHERE id='${source}'`);
  check(`SELECT source_revision=2 AND generation=3 AND state='unknown' FROM source_account_policies WHERE source_id='${source}'`,"t","provider replacement cannot inherit another provider evidence");
  db.sql(`DELETE FROM sources WHERE id='${source}'`);
  check(`SELECT count(*) FROM source_account_policies WHERE source_id='${source}'`,"0","source deletion removes ordinary account authority");
  check(`SELECT state='cleanup_failed' AND io_uncertain AND cleanup_attempts=5 AND NOT stop_confirmed FROM upstream_reservations WHERE id='${reservation}'`,"t","source deletion retains original cleanup obligation");
  check(`SELECT revision=2 AND config_encrypted='new-account-cipher' FROM source_access_policy_snapshots WHERE source_id='${source}'`,"t","latest destination restriction remains durable for cleanup");
  report.result="passed";
} catch(error) {report.result="failed";report.failure=String(error.stack??error);process.exitCode=1}
finally {await db.stop();report.cleanup=await db.verifyStopped();await writeFile(resolve(root,"report.json"),JSON.stringify(report,null,2));console.log(`${report.result}: ${report.checks.length} upgrade checks; ${resolve(root,"report.json")}`)}
