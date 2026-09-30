// Portable Linux counterpart for main399's Docker-based index-refresh coverage.
// Uses a real Server, Agent and isolated PostgreSQL; no production paths.
import assert from "node:assert/strict";
import { writeFile, rename, mkdir, chmod, unlink, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";

async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(50); }
  throw Error(`Timed out: ${label}`);
}
await isolatedMediaStack("agent-index-port", async f => {
  const a = resolve(f.root, "a.mp4"), b = resolve(f.root, "b.mp4"), bad = resolve(f.root, "blocked-directory");
  await writeFile(a, "alpha");
  const admin = f.client(); await admin.login();
  const { agentId } = await f.startAgent();
  const row = resource => JSON.parse(f.sql(`SELECT row_to_json(m) FROM (SELECT id,available,source_version,metadata,duration_ms FROM media_items WHERE source_id='${agentId}' AND resource='${resource}') m`) || "null");
  const status = async () => (await admin.request("/agents")).find(agent => agent.id === agentId);
  async function scan() {
    let result;
    await until(async () => { result = await admin.request(`/agents/${agentId}/scan`, "POST"); return result.status !== "busy"; }, "manual scan admission");
    return result;
  }
  try {
    await until(() => row("a.mp4")?.available && row("a.mp4").source_version, "startup versioned index");
    const aId = row("a.mp4").id;
    await writeFile(b, "bravo");
    await until(() => row("b.mp4")?.available, "automatic index discovers new file");
    assert.equal(row("a.mp4").id, aId);
    const bId = row("b.mp4").id, oldVersion = row("b.mp4").source_version;
    f.sql(`UPDATE media_items SET metadata='{"fixture":"old probe"}',duration_ms=5000 WHERE id='${bId}'`);
    await writeFile(b, "delta");
    await rename(a, resolve(f.root, "renamed.mp4"));
    await until(() => row("b.mp4")?.source_version !== oldVersion && row("renamed.mp4")?.available && row("a.mp4")?.available === false, "automatic replacement and rename refresh");
    assert.equal(row("b.mp4").id, bId);
    assert.deepEqual(row("b.mp4").metadata, {});
    assert.equal(row("b.mp4").duration_ms, null);
    assert.equal((await scan()).status, "complete");
    assert.equal((await status()).source_version_status, "ready");
    console.log("PASS:399automatic+manual indexing preserves IDs, refreshes source versions and clears only stale probe metadata");

    await chmod(b, 0);
    await until(() => row("b.mp4")?.available === false, "unreadable file explicitly unavailable");
    assert.equal(row("b.mp4").source_version, null);
    const unavailable = await scan();
    assert.equal(unavailable.status, "complete");
    assert.equal(unavailable.count, 1);
    assert.equal(unavailable.unversioned_count, 0, "unavailable files do not falsely demand Agent upgrade");
    assert.equal((await status()).indexed_count, 1);
    console.log("PASS:399per-file unavailable semantics retained and readiness counts only playable entries");

    await mkdir(bad); await writeFile(resolve(bad, "secret.mp4"), "secret");
    await until(() => row("blocked-directory/secret.mp4")?.available, "directory initial index");
    await chmod(bad, 0); await unlink(resolve(f.root, "renamed.mp4"));
    let abort;
    await until(async () => { abort = await scan(); return abort.status === "failed"; }, "manual directory error abort");
    assert.equal(row("renamed.mp4").available, true, "incomplete snapshot must not delete missing previous entries");
    assert.equal(row("blocked-directory/secret.mp4").available, true);
    assert.equal((await status()).connected, true);
    const logs = (await readdir(f.root)).filter(name => /^child-.*\.log$/.test(name));
    assert.ok((await Promise.all(logs.map(name => readFile(resolve(f.root, name), "utf8")))).some(value => value.includes("index scan incomplete")));
    await chmod(bad, 0o700); await chmod(b, 0o600);
    await until(() => row("renamed.mp4")?.available === false && row("b.mp4")?.available === true, "complete refresh after directory recovery");
    console.log("PASS:399INDEX_ABORT retains authoritative prior snapshot, control remains usable, and next complete refresh recovers");

    await f.stopServer();
    await writeFile(resolve(f.root, "reconnected.mp4"), "reconnected");
    await f.startServer();
    await until(() => row("reconnected.mp4")?.available, "reconnect starts valid replacement scan");
    assert.equal((await status()).source_versions, true);
    assert.equal((await status()).drain_receipts, true);
    console.log("PASS:399control reconnect recovers automatic scans while retaining source-version and drain-receipt capabilities");
  } finally {
    await chmod(b, 0o600).catch(() => {});
    await chmod(bad, 0o700).catch(() => {});
  }
}, { env: { AGENT_INDEX_INTERVAL_SECS: "5" } });
