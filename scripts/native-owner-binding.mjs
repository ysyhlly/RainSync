// Shared build/runtime evidence for the ignored owner fixture. Artifact paths
// come from Cargo's JSON output, never directory order, mtimes or marker scans.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export const nativeOwnerTest =
  "platform_media::delivery::owner::tests::native_delivery_owner_http_fixture";
export const nativeOwnerCases = Object.freeze([
  "body_close", "body_drop", "send_get", "send_head", "send_range_drop",
  "receipt_failure", "receipt_suppressed", "reject_stopped",
  "reject_closed_admission",
]);
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export async function backendSnapshot(root) {
  async function walk(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["target", ".git", ".runtime", "node_modules"].includes(entry.name))
        continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) files.push(...await walk(path));
      else {
        assert.ok(entry.isFile(), "Unexpected non-regular backend input");
        files.push(path);
      }
    }
    return files;
  }
  const files = [resolve(root, "Cargo.toml"), resolve(root, "Cargo.lock")];
  for (const directory of [
    "crates", "apps/server", "apps/media-worker", "apps/nas-agent", "migrations",
  ]) files.push(...await walk(resolve(root, directory)));
  for (const optional of [
    "rust-toolchain.toml", "rust-toolchain", ".cargo/config", ".cargo/config.toml",
  ]) {
    try {
      await readFile(resolve(root, optional));
      files.push(resolve(root, optional));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return Promise.all(files.sort().map(async (path) => ({
    path: relative(root, path).replaceAll("\\", "/"),
    sha256: sha256(await readFile(path)),
  })));
}

export function ownerTestArtifact(messages, target) {
  const paths = new Set();
  for (const line of messages.split(/\r?\n/).filter(Boolean)) {
    const item = JSON.parse(line);
    if (item.reason === "compiler-artifact" && item.profile?.test === true &&
        item.target?.name === "rainsync-server" &&
        item.target.kind?.includes("bin") && item.executable) {
      const path = resolve(item.executable);
      assert.equal(resolve(path, ".."), resolve(target, "debug", "deps"),
        "Cargo owner artifact must belong to the selected target directory");
      paths.add(path);
    }
  }
  assert.equal(paths.size, 1, "Cargo must identify exactly one Server test executable");
  return [...paths][0];
}

export async function loadOwnerBinding({ root, target, path, requireTest = false }) {
  assert.ok(path && isAbsolute(path), "Set an absolute W03_BACKEND_BINDING");
  assert.ok(target && isAbsolute(target), "Set an absolute owned CARGO_TARGET_DIR");
  const bytes = await readFile(path);
  const binding = JSON.parse(bytes);
  assert.equal(binding.schema_version, 1);
  assert.equal(binding.result, "passed");
  assert.equal(binding.platform, process.platform);
  assert.equal(binding.build.exit_code, 0);
  assert.equal(sha256(JSON.stringify(binding.source)), binding.source_digest);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const server = binding.binaries.find((item) => item.name === "rainsync-server");
  assert.equal(server?.path, resolve(target, "debug", `rainsync-server${suffix}`),
    "Binding must describe the Server actually executed by the fixture");
  const password = binding.test_helpers.find((item) => item.name === "fixture_password");
  assert.equal(password?.path,
    resolve(target, "debug", "examples", `fixture_password${suffix}`));
  const owner = binding.owner_fixtures?.find((item) => item.test_name === nativeOwnerTest);
  if (requireTest) {
    assert.ok(owner, "Build with node scripts/bind-native-backend.mjs --owner-fixtures");
    assert.equal(resolve(owner.path, ".."), resolve(target, "debug", "deps"));
    assert.equal(owner.build.exit_code, 0);
    assert.deepEqual(owner.build.command.slice(0, 8), [
      "cargo", "test", "-p", "rainsync-server", "--bin", "rainsync-server",
      "--no-run", "--locked",
    ]);
  }
  const binaries = [...binding.binaries, ...binding.test_helpers,
    ...(requireTest ? [owner] : [])];
  const verify = async () => {
    assert.equal(sha256(await readFile(path)), sha256(bytes), "Build binding changed");
    if (requireTest) {
      assert.deepEqual(binding.producers?.map((item) => item.path), [
        "scripts/bind-native-backend.mjs", "scripts/native-owner-binding.mjs",
      ]);
      for (const item of binding.producers)
        assert.equal(sha256(await readFile(resolve(root, item.path))), item.sha256,
          "Binding producer changed");
    }
    assert.deepEqual(await backendSnapshot(root), binding.source,
      "Backend inputs changed since the successful build");
    for (const binary of binaries) {
      assert.equal(sha256(await readFile(binary.path)), binary.sha256,
        "Bound executable changed");
    }
  };
  await verify();
  return {
    server: server.path,
    owner,
    verify,
    summary: {
      sha256: sha256(bytes),
      source_digest: binding.source_digest,
      binaries: [server, password, ...(requireTest ? [owner] : [])].map(
        ({ name, test_name, path, sha256 }) => ({ name, test_name, path, sha256 }),
      ),
      toolchain: { rustc: binding.build.rustc, cargo: binding.build.cargo },
    },
  };
}

export function assertOwnerRun(output) {
  assert.match(output,
    /test result: ok\. 1 passed; 0 failed; 0 ignored;/,
    "The exact ignored Rust fixture must execute, not match zero tests");
  const lines = output.split(/\r?\n/);
  for (const name of nativeOwnerCases)
    assert.ok(lines.includes(`PASS: native owned real-HTTP lifecycle case ${name}`),
      `Native owner case did not complete: ${name}`);
}
