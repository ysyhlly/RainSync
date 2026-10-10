// Own a fresh PostgreSQL cluster for authorization timeout/cancellation probes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedPostgres } from "./fixtures/postgres.mjs";

assert.ok(process.env.RAINSYNC_ARTIFACT_DIR);
const root = resolve(process.env.RAINSYNC_ARTIFACT_DIR, "runtime-metrics-auth", randomUUID());
await mkdir(root, { recursive: true });
const inputs = await Promise.all([
  "apps/media-worker/src/metrics.rs", "apps/media-worker/src/metrics/observations.rs", "apps/media-worker/tests/runtime_metrics.rs",
  "tests/runtime-metrics-auth.mjs", "tests/fixtures/postgres.mjs",
].map(async path => ({ path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
const fixture = isolatedPostgres({ root, name: "runtime-metrics-auth" });
let passed = false;
try {
  await fixture.start();
  const child = spawn("cargo", ["test", "-p", "rainsync-media-worker", "--test", "runtime_metrics", "worker_real_session_authorization_deadlines_and_cancellation", "--locked", "--", "--ignored", "--nocapture"], {
    env: { ...process.env, RAINSYNC_METRICS_TEST_DATABASE_URL: fixture.url }, stdio: "inherit",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 120_000);
  let code;
  try { code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); }); }
  finally { clearTimeout(deadline); }
  assert.equal(code, 0, "actual session authorization, cancellation, and blackholed-query checks");
  for (const input of inputs) assert.equal(createHash("sha256").update(await readFile(input.path)).digest("hex"), input.sha256);
  passed = true;
} finally {
  await fixture.stop();
  const cleanup = await fixture.verifyStopped();
  await writeFile(resolve(root, "report.json"), JSON.stringify({
    schema_version: 1, result: passed ? "passed" : "failed", inputs, cleanup,
    scope: "Owned PostgreSQL lock/query cancellation and blackholed reply; no production database or credential",
  }, null, 2) + "\n");
  console.log(`Evidence: ${resolve(root, "report.json")}`);
}
