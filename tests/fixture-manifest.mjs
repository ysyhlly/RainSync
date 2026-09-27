import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Build the verifier first: cargo build -p media-core --example verify_fixtures.
const verifier = resolve(
  "target/debug/examples/verify_fixtures" +
    (process.platform === "win32" ? ".exe" : ""),
);
const original = JSON.parse(
  await readFile(".runtime/fixtures/manifest.json", "utf8"),
);
execFileSync(verifier, [], { stdio: "inherit", windowsHide: true });
const path = resolve(`.runtime/fixtures/invalid-${randomUUID()}.json`);
try {
  for (const [name, mutate, message] of [
    ["missing fixture", (m) => m.cases.pop(), "incomplete fixture manifest"],
    [
      "duplicate fixture",
      (m) => {
        m.cases[1] = m.cases[0];
      },
      "missing or duplicate fixture",
    ],
    [
      "wrong content digest",
      (m) => {
        m.cases[0].sha256 = "0".repeat(64);
      },
      "content changed since probe",
    ],
    [
      "changed expectation",
      (m) => {
        m.cases[0].expected_mode = "transcode";
      },
      "stale catalog field",
    ],
  ]) {
    const modified = structuredClone(original);
    mutate(modified);
    await writeFile(path, JSON.stringify(modified));
    const result = spawnSync(verifier, [path], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, name);
    assert.ok(result.stderr.includes(message), `${name}: ${result.stderr}`);
    console.log(`PASS: verifier rejects ${name}`);
  }
} finally {
  await rm(path, { force: true });
}
