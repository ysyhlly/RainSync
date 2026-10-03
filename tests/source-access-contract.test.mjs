import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {sourceAccessContract,sourceAccessPairPreflight} from "../scripts/source-access-preflight.mjs";

test("source-access pair refuses mixed roles, old readers and unproved absence",async()=>{
 const root=await mkdtemp(join(tmpdir(),"owned-source-contract-"));
 const make=async(name,body)=>{const path=join(root,name);await writeFile(path,`#!${process.execPath}\n${body}\n`,{mode:0o700});return path;};
 try {
  const probe=role=>`if(process.argv[2]!=="--source-access-contract"||process.env.DATABASE_URL||process.env.SOURCE_ENCRYPTION_KEY)process.exit(2);console.log(${JSON.stringify(JSON.stringify(sourceAccessContract(role)))});`;
  const server=await make("server",probe("server")),worker=await make("worker",probe("worker")),old=await make("old",`process.exit(2)`);
  const before=process.env.DATABASE_URL;process.env.DATABASE_URL="owned-invalid-url-must-not-reach-probe";
  try {assert.equal((await sourceAccessPairPreflight({server,worker})).reason,"cannot_prove_absence_of_redirect_identity");}
  finally {if(before===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=before;}
  assert.equal((await sourceAccessPairPreflight({server,worker,requirement:"required"})).required,true);
  await assert.rejects(sourceAccessPairPreflight({server:old,worker}),/Unsupported server/);
  await assert.rejects(sourceAccessPairPreflight({server,worker:old}),/Unsupported worker/);
  await assert.rejects(sourceAccessPairPreflight({server:worker,worker}),/Unsupported server/);
  await assert.rejects(sourceAccessPairPreflight({server,worker,requirement:"none"}),/only required or unknown/);
 } finally {await rm(root,{recursive:true,force:true});}
});

test("owned actual source-access Server/Worker pair and old-reader rejection",{skip:!process.env.RAINSYNC_SOURCE_CONTRACT_SERVER||!process.env.RAINSYNC_SOURCE_CONTRACT_WORKER||!process.env.RAINSYNC_OLD_AUTH_SERVER?"set exact owned frozen pair and pre-redirect Server":false},async()=>{
 const pair={server:process.env.RAINSYNC_SOURCE_CONTRACT_SERVER,worker:process.env.RAINSYNC_SOURCE_CONTRACT_WORKER,requirement:"required"};
 assert.equal((await sourceAccessPairPreflight(pair)).required,true);
 await assert.rejects(sourceAccessPairPreflight({...pair,server:process.env.RAINSYNC_OLD_AUTH_SERVER}),/Unsupported server/);
 if(process.env.RAINSYNC_OLD_SOURCE_WORKER)await assert.rejects(sourceAccessPairPreflight({...pair,worker:process.env.RAINSYNC_OLD_SOURCE_WORKER}),/Unsupported worker/);
});
