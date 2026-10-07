import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

test("release containers inherit the same account admission and proxy settings as development", async () => {
  const fields = [
    "REGISTRATION_VALIDATE_PER_MINUTE",
    "REGISTRATION_PER_TEN_MINUTES",
    "ACCOUNT_HASH_CONCURRENCY",
    "TRUSTED_PROXY_CIDRS",
    "AVATAR_PROCESS_CONCURRENCY",
    "AVATAR_PROCESS_TIMEOUT_MS",
    "AVATAR_WRITES_PER_MINUTE",
  ];
  const environments = await Promise.all(
    ["compose.yaml", "deploy/release.compose.yaml"].map(async (name) => {
      const source = await readFile(new URL(name, root), "utf8");
      const block = source.match(/    environment: &backend\n([\s\S]*?)^    volumes:/m);
      assert.ok(block, `${name} has the shared backend environment`);
      return new Map(
        [...block[1].matchAll(/^      ([A-Z_]+): (.+)$/gm)].map((match) => [
          match[1],
          match[2],
        ]),
      );
    }),
  );
  for (const field of fields) {
    assert.ok(environments[0].has(field), `development declares ${field}`);
    assert.equal(environments[1].get(field), environments[0].get(field), field);
  }
  assert.equal(environments[1].get("TRUSTED_PROXY_CIDRS"), "${TRUSTED_PROXY_CIDRS:-}");
});

test("new setup secrets stay private under a permissive umask and existing files stay unchanged", {
  skip: process.platform === "win32" ? "POSIX file-mode contract" : false,
}, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "rainsync-setup-modes-"));
  try {
    const setup = new URL("scripts/setup.mjs", root).href;
    const run = () => spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `process.umask(0o022); await import(${JSON.stringify(setup)});`,
    ], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory },
      encoding: "utf8",
      timeout: 10000,
    });
    const first = run();
    assert.equal(first.status, 0, "isolated setup completes");
    const paths = [".env", ".runtime/login.txt"];
    const originals = [];
    for (const path of paths) {
      const file = resolve(directory, path);
      assert.equal((await stat(file)).mode & 0o777, 0o600, `${path} is owner-only`);
      originals.push(await readFile(file));
    }
    assert.equal(run().status, 0, "repeated isolated setup completes");
    for (const [index, path] of paths.entries()) {
      assert.ok(originals[index].equals(await readFile(resolve(directory, path))), `${path} is never replaced`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
