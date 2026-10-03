// Offline role-specific reader/transport contract, independent of login binding.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
export const sourceAccessContract = role => ({schema_version:1,contract:"controlled-media-redirects-v1",identity:"final-target-sha256-v1",credential_origin:"configured-origin",methods:["GET","HEAD"],default:"no-follow",role});
export async function sourceAccessPreflight(binary, role) {
  assert.ok(["server","worker"].includes(role), "unsupported source-access role");
  const path = resolve(binary), before = await readFile(path);
  const cwd = await mkdtemp(join(tmpdir(), "rainsync-source-contract-"));
  try {
    const env = Object.fromEntries(["PATH","SystemRoot","WINDIR","LD_LIBRARY_PATH"].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
    const {stdout} = await exec(path,["--source-access-contract"],{cwd,env,timeout:5000,maxBuffer:4096,windowsHide:true});
    assert.deepEqual(JSON.parse(stdout),sourceAccessContract(role));
    assert.deepEqual(await readFile(path),before,"binary changed during source-access probe");
    return {path,role,sha256:createHash("sha256").update(before).digest("hex"),contract:"controlled-media-redirects-v1",result:"passed"};
  } catch(error) {
    throw new Error(`Unsupported ${role} source-access reader: controlled-media-redirects-v1 required`,{cause:error});
  } finally { await rm(cwd,{recursive:true,force:true}); }
}
export async function sourceAccessPairPreflight({server,worker,requirement="unknown"}) {
  // Never treat an operator assertion, a migration number or successful login
  // probe as evidence that persisted/active redirect identity is absent.
  assert.ok(["required","unknown"].includes(requirement),"only required or unknown workload states are admitted");
  return {required:true,reason:requirement==="required"?"explicit_redirect_identity_workload":"cannot_prove_absence_of_redirect_identity",server:await sourceAccessPreflight(server,"server"),worker:await sourceAccessPreflight(worker,"worker")};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length,4,"usage: node scripts/source-access-preflight.mjs SERVER WORKER");
  console.log(JSON.stringify(await sourceAccessPairPreflight({server:process.argv[2],worker:process.argv[3]}),null,2));
}
