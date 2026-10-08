// Produce an evidence binding only after a successful build of unchanged source.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn,execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile,mkdir,writeFile } from "node:fs/promises";
import { dirname,resolve,relative } from "node:path";
import { fileURLToPath } from "node:url";
import { backendSnapshot, nativeOwnerTest, ownerTestArtifact, sha256 as sha } from "./native-owner-binding.mjs";
const ownerFixtures = process.argv.slice(2);
assert.ok(ownerFixtures.length === 0 || (ownerFixtures.length === 1 && ownerFixtures[0] === "--owner-fixtures"), "Usage: bind-native-backend.mjs [--owner-fixtures]");
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
assert.ok(process.env.CARGO_TARGET_DIR,"Set an explicit owned CARGO_TARGET_DIR");
const runtime=resolve(process.env.RAINSYNC_RUNTIME_ROOT??resolve(root,".runtime"));
const output=resolve(runtime,"w03-viewer-backend",`native-${new Date().toISOString().replaceAll(/[:.]/g,"-")}-${randomUUID()}`);
await mkdir(output,{recursive:true});
const snapshot = () => backendSnapshot(root);
const producerFiles = ["scripts/bind-native-backend.mjs", "scripts/native-owner-binding.mjs"];
const producerSnapshot = () => Promise.all(producerFiles.map(async path => ({path,sha256:sha(await readFile(resolve(root,path)))})));
const producers = await producerSnapshot();
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
const owner_fixtures = [];
if (ownerFixtures.length) {
  const ownerArgs = ["test", "-p", "rainsync-server", "--bin", "rainsync-server", "--no-run", "--locked", "--message-format=json-render-diagnostics", "-j", buildJobs];
  const ownerStarted = new Date().toISOString();
  const ownerLogPath = resolve(output, "owner-build.log");
  const ownerLog = createWriteStream(ownerLogPath, { flags: "wx" });
  const ownerChild = spawn("cargo", ownerArgs, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let messages = "";
  ownerChild.stdout.on("data", bytes => { messages += bytes.toString("utf8"); });
  ownerChild.stdout.pipe(ownerLog, { end: false });
  ownerChild.stderr.pipe(ownerLog, { end: false });
  const ownerCode = await new Promise((done, reject) => { ownerChild.once("error", reject); ownerChild.once("close", done); });
  await new Promise(done => ownerLog.end(done));
  assert.equal(ownerCode, 0, `Owner fixture build failed; no binding issued. Inspect ${ownerLogPath}`);
  const ownerPath = ownerTestArtifact(messages, process.env.CARGO_TARGET_DIR);
  owner_fixtures.push({
    name: "rainsync-server-owner-tests", test_name: nativeOwnerTest,
    path: ownerPath, sha256: sha(await readFile(ownerPath)),
    build: { command: ["cargo", ...ownerArgs], started_at: ownerStarted,
      finished_at: new Date().toISOString(), exit_code: ownerCode,
      log_path: ownerLogPath, log_sha256: sha(await readFile(ownerLogPath)) },
  });
}
const source=await snapshot();assert.deepEqual(source,before,"Backend source changed during build; no binding issued");
assert.deepEqual(await producerSnapshot(),producers,"Binding producer changed during build; no binding issued");
const binaries=[];
for(const name of ["rainsync-server","rainsync-media-worker","rainsync-nas-agent"]) {
  const path=resolve(process.env.CARGO_TARGET_DIR,"debug",name+(process.platform==="win32"?".exe":""));
  binaries.push({name,path,sha256:sha(await readFile(path))});
}
// Test drivers are bound separately; the production binary set remains exactly
// Server/Worker/Agent for existing compatibility fixtures.
const test_helpers=[];
for(const name of ["verify_job_health_events","stop_claim_fixture","verify_job_phase_timings","emby_profile_request","fixture_password","export","verify_diagnostics","verify_membership_gates","verify_room_commands","verify_cache_budget","verify_cache_leases","verify_output_cleanup","verify_cache_writer_safety"]) {
  const path=resolve(process.env.CARGO_TARGET_DIR,"debug","examples",name+(process.platform==="win32"?".exe":""));
  test_helpers.push({name,path,sha256:sha(await readFile(path))});
}
const binding={schema_version:1,result:"passed",platform:process.platform,producers,source,source_digest:sha(Buffer.from(JSON.stringify(source))),binaries,test_helpers,...(ownerFixtures.length ? {owner_fixtures} : {}),build:{command:["cargo",...args],profile_environment:Object.fromEntries(["CARGO_INCREMENTAL","CARGO_PROFILE_DEV_DEBUG","CARGO_PROFILE_TEST_DEBUG","CARGO_PROFILE_DEV_DEBUG_ASSERTIONS","CARGO_PROFILE_TEST_DEBUG_ASSERTIONS"].filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]])),started_at,finished_at:new Date().toISOString(),exit_code:code,log_path:logPath,log_sha256:sha(await readFile(logPath)),rustc:execFileSync("rustc",["--version"],{encoding:"utf8"}).trim(),cargo:execFileSync("cargo",["--version"],{encoding:"utf8"}).trim()},producer:{path:relative(root,fileURLToPath(import.meta.url)),sha256:sha(await readFile(fileURLToPath(import.meta.url)))}};
const bindingPath=resolve(output,"backend-binding.json");await writeFile(bindingPath,JSON.stringify(binding,null,2)+"\n",{flag:"wx"});
console.log(bindingPath);
