// A fresh owned database and production Rust lease functions, never live media.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { isolatedServer } from "./fixtures/server.mjs";
import { verifyPidAbsent } from "./fixtures/postgres.mjs";
let fixture, helper;
await isolatedServer("preview-lease-regressions", async f => {
  fixture = f;
  await f.stopServer();
  const name = `rainsync_preview_${f.id.replaceAll("-", "")}`;
  const url = new URL(f.env.DATABASE_URL);
  const template = url.pathname.slice(1);
  assert.match(template, /^rainsync(?:_[a-z0-9]+)?$/);
  // Stop the only owner of template connections before creating this clone.
  f.sql(`CREATE DATABASE ${name} WITH TEMPLATE ${template}`);
  url.pathname = `/${name}`;
  const binary = resolve(f.target, "examples", process.platform === "win32" ? "verify_preview_recovery.exe" : "verify_preview_recovery");
  const child = spawn(binary, [], { windowsHide: true, env: { ...process.env, RAINSYNC_ISOLATED_TEST: "1", RAINSYNC_FIXTURE_DATABASE: url.toString() }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const closed = new Promise((done, fail) => { child.once("error", fail); child.once("close", (code, signal) => done({ code, signal })); });
  const timer = setTimeout(() => child.kill(), 60000);
  let result;
  try { result = await closed; } finally { clearTimeout(timer); }
  assert.equal(result.code, 0, stderr || stdout);
  assert.equal(verifyPidAbsent(child.pid), true);
  helper = { result, pid_absent: true, stdout, stderr };
});
const cleanup = await fixture.verifyStopped();
await writeFile(resolve(fixture.root, "report.json"), JSON.stringify({ result: "passed", helper, cleanup }, null, 2));
console.log(`PASS production preview lease crossed-expiry regressions; cleanup verified: ${fixture.root}`);
