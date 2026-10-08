// Produce an evidence binding only after a successful build of unchanged source.
import assert from "node:assert/strict";
import { createHash,randomUUID } from "node:crypto";
import { spawn,execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readdir,readFile,mkdir,writeFile } from "node:fs/promises";
import { dirname,resolve,relative } from "node:path";
import { fileURLToPath } from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
assert.ok(process.env.CARGO_TARGET_DIR,"Set an explicit owned CARGO_TARGET_DIR");
const runtime=resolve(process.env.RAINSYNC_RUNTIME_ROOT??resolve(root,".runtime"));
const output=resolve(runtime,"w03-viewer-backend",`native-${new Date().toISOString().replaceAll(/[:.]/g,"-")}-${randomUUID()}`);
await mkdir(output,{recursive:true});
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
async function walk(directory) {
  const files=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(["target",".git",".runtime","node_modules"].includes(entry.name))continue;
    const path=resolve(directory,entry.name);
    if(entry.isDirectory())files.push(...await walk(path));
    else if(entry.isFile())files.push(path);
    else assert.fail(`Unexpected non-regular backend input: ${path}`);
  }
  return files;
}
async function snapshot(){
  const files=[resolve(root,"Cargo.toml"),resolve(root,"Cargo.lock")];
  for(const directory of ["crates","apps/server","apps/media-worker","apps/nas-agent","migrations"]) files.push(...await walk(resolve(root,directory)));
  for(const optional of ["rust-toolchain.toml","rust-toolchain",".cargo/config",".cargo/config.toml"]) {
    try{await readFile(resolve(root,optional));files.push(resolve(root,optional));}catch(error){if(error.code!=="ENOENT")throw error;}
  }
  files.sort();
  return Promise.all(files.map(async path=>({path:relative(root,path).replaceAll("\\","/"),sha256:sha(await readFile(path))})));
}
const before=await snapshot(), started_at=new Date().toISOString(), logPath=resolve(output,"build.log");
const buildJobs=process.env.RAINSYNC_BUILD_JOBS??"2";
assert.ok(["1","2"].includes(buildJobs),"Native binding builds allow one or two Cargo jobs");
const args=["build","--workspace","--bins","--examples","--locked","-j",buildJobs];
const log=createWriteStream(logPath,{flags:"wx"});
const child=spawn("cargo",args,{cwd:root,env:process.env,stdio:["ignore","pipe","pipe"]});
child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
const code=await new Promise((done,reject)=>{child.once("error",reject);child.once("close",done);});
await new Promise(done=>log.end(done));
assert.equal(code,0,`Build failed; no successful binding issued. Inspect ${logPath}`);
const source=await snapshot();assert.deepEqual(source,before,"Backend source changed during build; no binding issued");
const binaries=[];
for(const name of ["rainsync-server","rainsync-media-worker","rainsync-nas-agent"]) {
  const path=resolve(process.env.CARGO_TARGET_DIR,"debug",name+(process.platform==="win32"?".exe":""));
  binaries.push({name,path,sha256:sha(await readFile(path))});
}
// Test drivers are bound separately; the production binary set remains exactly
// Server/Worker/Agent for existing compatibility fixtures.
const test_helpers=[];
for(const name of ["verify_job_health_events","stop_claim_fixture","verify_job_phase_timings","emby_profile_request","fixture_password","export","verify_diagnostics","verify_membership_gates","verify_cache_budget","verify_cache_leases","verify_output_cleanup","verify_cache_writer_safety"]) {
  const path=resolve(process.env.CARGO_TARGET_DIR,"debug","examples",name+(process.platform==="win32"?".exe":""));
  test_helpers.push({name,path,sha256:sha(await readFile(path))});
}
const binding={schema_version:1,result:"passed",platform:process.platform,source,source_digest:sha(Buffer.from(JSON.stringify(source))),binaries,test_helpers,build:{command:["cargo",...args],profile_environment:Object.fromEntries(["CARGO_INCREMENTAL","CARGO_PROFILE_DEV_DEBUG","CARGO_PROFILE_TEST_DEBUG","CARGO_PROFILE_DEV_DEBUG_ASSERTIONS","CARGO_PROFILE_TEST_DEBUG_ASSERTIONS"].filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]])),started_at,finished_at:new Date().toISOString(),exit_code:code,log_path:logPath,log_sha256:sha(await readFile(logPath)),rustc:execFileSync("rustc",["--version"],{encoding:"utf8"}).trim(),cargo:execFileSync("cargo",["--version"],{encoding:"utf8"}).trim()},producer:{path:relative(root,fileURLToPath(import.meta.url)),sha256:sha(await readFile(fileURLToPath(import.meta.url)))}};
const bindingPath=resolve(output,"backend-binding.json");await writeFile(bindingPath,JSON.stringify(binding,null,2)+"\n",{flag:"wx"});
console.log(bindingPath);
