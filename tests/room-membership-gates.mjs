import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isolatedServer} from './fixtures/server.mjs';
let fixture;
const report={schema_version:1,result:'running',checks:[],scope:'Real isolated PostgreSQL membership admission races; no production or physical drain claim'};
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
try {
 await isolatedServer('room-membership-gates',async f=>{
  fixture=f;
  const inputs=['crates/persistence/src/lib.rs','crates/persistence/examples/verify_membership_gates.rs','tests/room-membership-gates.mjs'];
  report.source=await Promise.all(inputs.map(async path=>({path,sha256:await hash(path)})));
  const binary=resolve(f.target,'examples/verify_membership_gates');report.binary={path:binary,sha256:await hash(binary)};
  const output=execFileSync(binary,[],{env:{...f.env,RAINSYNC_ISOLATED_TEST:'1',RAINSYNC_FIXTURE_DATABASE:f.env.DATABASE_URL},encoding:'utf8',timeout:60000});
  await writeFile(resolve(f.root,'gates.stdout'),output);report.checks=output.trim().split(/\r?\n/);assert.equal(report.checks.length,7);
  for(const v of report.source)assert.equal(await hash(v.path),v.sha256);assert.equal(await hash(binary),report.binary.sha256);report.result='passed';
 });
} catch(e){report.result='failed';report.failure=String(e.stack??e);process.exitCode=1}
finally{if(fixture){report.cleanup=await fixture.verifyStopped();report.postgres=fixture.postgresDiagnostics();await writeFile(resolve(fixture.root,'report.json'),JSON.stringify(report,null,2));console.log(`${report.result}: ${resolve(fixture.root,'report.json')}`)}}
