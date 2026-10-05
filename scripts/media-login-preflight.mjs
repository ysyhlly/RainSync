// Run before switching a Server binary or rolling back after migration 0041.
// A capability declaration is necessary, not sufficient: release evidence must
// also bind this exact executable to the per-login API integration tests.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const run=promisify(execFile);
export async function mediaLoginPreflight(binary) {
  const path=resolve(binary), before=await readFile(path);
  const cwd=await mkdtemp(join(tmpdir(),'rainsync-media-preflight-'));
  try {
    // No inherited DB URL, key, password, configuration or dotenv working dir.
    // Only OS dynamic-linker/runtime paths survive, never application settings.
    const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','LD_LIBRARY_PATH'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    const {stdout}=await run(path,['--media-authorization-contract'],{cwd,env,timeout:5000,maxBuffer:4096,windowsHide:true});
    assert.deepEqual(JSON.parse(stdout),{schema_version:1,contract:'media-login-binding-v1',migration:41,legacy:'fixed-expiry',caller:'exact-login'},'Server lacks the required exact-login contract');
    const after=await readFile(path);assert.deepEqual(after,before,'Server changed during capability probe');
    return {path,sha256:createHash('sha256').update(before).digest('hex'),contract:'media-login-binding-v1',result:'passed'};
  } catch(error) {
    throw new Error('Unsafe Server cutover: media-login-binding-v1 preflight failed; retain a compatible Server', {cause:error});
  } finally { await rm(cwd,{recursive:true,force:true}); }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length,3,'usage: node scripts/media-login-preflight.mjs /absolute/path/to/rainsync-server');
  console.log(JSON.stringify(await mediaLoginPreflight(process.argv[2]),null,2));
}
