// Own a fresh database and run the small HTTP/header/race contract suite only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedPostgres } from "./fixtures/postgres.mjs";

const root = resolve(process.env.RAINSYNC_RUNTIME_ROOT ?? "/tmp", `http-identity-${randomUUID()}`);
await mkdir(root, { recursive: true });
const fixture = isolatedPostgres({ root, name: "http-identity" });
let passed = false;
try {
  await fixture.start();
  const child = spawn("cargo", ["test", "-p", "rainsync-media-worker", "http_media::identity_tests::isolated_http_representation_contract", "--", "--ignored", "--nocapture"], {
    stdio: "inherit",
    env: { ...process.env, RAINSYNC_HTTP_IDENTITY_TEST_DATABASE: fixture.url },
  });
  const exit = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  assert.equal(exit, 0, "isolated HTTP representation contract passed");
  passed = true;
} finally {
  await fixture.stop();
  const cleanup = await fixture.verifyStopped();
  await writeFile(resolve(root, "report.json"), JSON.stringify({
    schema_version: 1, result: passed ? "passed" : "failed", cleanup,
    scope: "Generic HTTP representation headers, stream lengths, durable pins and concurrent first requests",
    limitations: ["Focused native fixtures; no long-media, real-device, or final product acceptance"],
  }, null, 2) + "\n");
  console.log(`Evidence: ${resolve(root, "report.json")}`);
}
