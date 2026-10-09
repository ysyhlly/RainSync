// PROPOSAL ONLY. Intended location: tests/plugin-identity-compatibility-runtime.mjs.
// Run only after coordinator approval in its owned disposable fixture window.
// Historical source copies and ledger are test evidence, never runtime authority.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedServer } from "./fixtures/server.mjs";
import { withTerminationSignal } from "../deploy/owned-process.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const history = new URL("./fixtures/plugin-identity-history/", import.meta.url);
const ledgerBytes = await readFile(new URL("ledger.json", history));
const ledger = JSON.parse(ledgerBytes);
const phase = process.env.RAINSYNC_P21_PHASE;
assert.ok(["baseline", "candidate"].includes(phase), "Explicit reviewed phase required");
assert.equal(process.env.RAINSYNC_FIXTURE_CLEANUP_REPORT, "1");
const expectedBinary = process.env.RAINSYNC_P21_EXPECTED_SERVER_SHA256;
const expectedSource = process.env.RAINSYNC_P21_EXPECTED_SOURCE_SHA256;
assert.match(expectedBinary ?? "", /^[0-9a-f]{64}$/, "Coordinator must bind exact executable");
assert.match(expectedSource ?? "", /^[0-9a-f]{64}$/, "Coordinator must bind source bytes");
assert.equal(process.platform, "linux", "This draft binds the actual running /proc executable");
const selectedBinary = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug", "rainsync-server");
assert.equal(sha(await readFile(selectedBinary)), expectedBinary, "Reject a rebound shared target before spawning anything");
const runningSource = await readFile(resolve("apps/server/src/plugins.rs"));
assert.equal(sha(runningSource), expectedSource);
if (phase === "baseline") assert.equal(expectedSource, ledger.canonical_source_sha256);
const rustTestsAt = runningSource.indexOf(Buffer.from("#[cfg(test)]"));
assert.ok(rustTestsAt >= 0);
assert.equal(sha(runningSource.subarray(rustTestsAt)), ledger.existing_plugins_rust_tests_sha256);
for (const [file, digest] of Object.entries(ledger.retained_assertion_sources))
  assert.equal(sha(await readFile(resolve(file))), digest, `Existing assertions retained: ${file}`);

assert.equal(ledger.sources.length, 3);
assert.equal(ledger.canonical.length, 4);
assert.equal(ledger.aliases.length, 24);
assert.equal(new Set(ledger.aliases.map((item) => item.artifact_digest)).size, 24);
const historicalBytes = new Map();
for (const source of ledger.sources) {
  const bytes = await readFile(new URL(source.file, history));
  assert.equal(bytes.length, source.lf_bytes);
  assert.equal(bytes.includes(13), false, "Historical LF object has no CR");
  assert.equal(sha(bytes), source.lf_sha256);
  const crlf = Buffer.from(bytes.toString("utf8").replaceAll("\n", "\r\n"));
  assert.equal(sha(crlf), source.crlf_sha256);
  historicalBytes.set(source.name + "/LF", bytes);
  historicalBytes.set(source.name + "/CRLF", crlf);
}
const known = new Set();
for (const alias of ledger.aliases) {
  const prefix = Buffer.from(`rainsync-declarative-metadata-v1:${alias.id}:${alias.version}:`);
  const source = historicalBytes.get(`${alias.source}/${alias.line_ending}`);
  assert.ok(source);
  assert.equal(sha(Buffer.concat([prefix, source])), alias.artifact_digest);
  known.add(`${alias.id}/${alias.version}/${alias.artifact_digest}`);
}
const canonical = (id, version) => {
  const item = ledger.canonical.find((entry) => entry.id === id && entry.version === version);
  assert.ok(item, "Only the four fixed test cases have canonical identities");
  return item.artifact_digest;
};
for (const item of ledger.canonical) {
  const prefix = Buffer.from(`rainsync-declarative-metadata-v1:${item.id}:${item.version}:`);
  assert.equal(sha(Buffer.concat([prefix, historicalBytes.get("H3/LF")])), item.artifact_digest);
}
// These are negative test specimens. They never enter a production identity map.
const unknown = "f".repeat(64);
for (const item of ledger.canonical) {
  assert.equal(known.has(`${item.id}/${item.version}/${unknown}`), false);
  for (const bad of ["a".repeat(64), "b".repeat(64), item.artifact_digest.toUpperCase(), item.artifact_digest.slice(1)])
    assert.equal(known.has(`${item.id}/${item.version}/${bad}`), false);
}

const grants = ["metadata:read"];
const duration = "metadata.duration-badge";
const note = "metadata.title-label";
const configB = (id) => id === duration ? { format: "minutes" } : { label: "B literal label" };
const configA = (id) => id === duration ? { format: "clock" } : { label: "A <script>literal</script>" };
const expectedB = (id) => id === duration ? "1 分钟" : "B literal label";
const expectedA = (id) => id === duration ? "0:01:00" : "A <script>literal</script>";
const otherVersion = (version) => version === "1.0.0" ? "1.1.0" : "1.0.0";
const q = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => q(JSON.stringify(value)) + "::jsonb";
const body = (version, config, revision, enabled = true) => ({
  version, enabled, config, granted_permissions: grants, expected_revision: revision,
});
let fixture, failure;
const runDeadlineMs = 180000;
const report = {
  schema_version: 1, phase, result: "running", checks: [],
  run_deadline_ms: runDeadlineMs,
  source_sha256: sha(runningSource), expected_server_sha256: expectedBinary,
  history_ledger_sha256: sha(ledgerBytes),
  scope: "Owned synthetic metadata/configuration endpoints; no deployed database or external service",
};
try {
  await withTerminationSignal(async (termination) => {
    const signal = AbortSignal.any([termination, AbortSignal.timeout(runDeadlineMs)]);
    signal.throwIfAborted();
    await isolatedServer("plugin-identity-compatibility", async (f) => {
    fixture = f;
    report.actual_server_sha256 = sha(await readFile(`/proc/${f.serverPid}/exe`));
    assert.equal(report.actual_server_sha256, expectedBinary);
    const admin = f.client();
    const actor = (await admin.login()).id;
    async function rejected(path, method, body, status, code) {
      signal.throwIfAborted();
      const response = await admin.request(path, method, body, status);
      assert.equal(response?.error?.code, code, `${method} ${path}: exact public rejection`);
      return response;
    }
    const source = randomUUID(), media = randomUUID();
    f.sql(`INSERT INTO sources(id,name,kind,config_encrypted) VALUES(${q(source)},'P21 synthetic metadata','local','fixture-only');
      INSERT INTO media_items(id,source_id,title,resource,duration_ms,source_version)
      VALUES(${q(media)},${q(source)},'P21 identity fixture','fixture-only.mp4',60000,'fixture-v1');`);
    const path = (id) => `/admin/plugins/${id}`;
    const auditRows = () => JSON.parse(f.sql("SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY revision,id),'[]'::jsonb) FROM rainsync_plugin_audit a"));
    const row = (id) => JSON.parse(f.sql(`SELECT row_to_json(p) FROM rainsync_plugins p WHERE id=${q(id)}`));
    const state = (id) => ({ row: row(id), audits: auditRows() });
    const metadata = () => admin.request(`/media/${media}/plugin-metadata`);
    async function assertLabel(id, version, revision, label) {
      const result = await metadata();
      assert.deepEqual(result, {
        media_id: media, api_major: 1,
        extensions: [{ plugin_id: id, revision, extension_version: version,
          kind: id === duration ? "duration" : "annotation", label }],
      });
    }
    function seed(entry, { previous, enabled = true } = {}) {
      signal.throwIfAborted();
      const prior = previous === undefined ? {
        version: otherVersion(entry.version), enabled: true,
        config: configA(entry.id), granted_permissions: grants,
      } : previous;
      f.sql(`DELETE FROM rainsync_plugin_audit; DELETE FROM rainsync_plugins;
        INSERT INTO rainsync_plugins(id,version,enabled,config,granted_permissions,revision,artifact_digest,previous_state,updated_by,updated_at)
        VALUES(${q(entry.id)},${q(entry.version)},${enabled},${json(configB(entry.id))},${json(grants)},7,${q(entry.artifact_digest)},${prior === null ? "NULL" : json(prior)},${q(actor)},'2026-10-01T00:00:00Z');
        INSERT INTO rainsync_plugin_audit(id,plugin_id,actor_id,revision,action,artifact_digest,created_at)
        VALUES(${q(randomUUID())},${q(entry.id)},${q(actor)},7,'configure',${q(entry.artifact_digest)},'2026-10-01T00:00:00Z');`);
    }

    const catalog = await admin.request("/admin/plugins");
    await rejected("/admin/plugins/not-in-catalog", "PUT", body("1.0.0", { format: "clock" }, "0"), 400, "PLUGIN_MANIFEST_OR_PERMISSIONS_INVALID");
    await rejected("/admin/plugins/not-in-catalog/rollback", "POST", { expected_revision: "0" }, 404, "PLUGIN_NOT_FOUND");
    await rejected(path(duration), "PUT", body("2.0.0", { format: "clock" }, "0"), 400, "PLUGIN_MANIFEST_OR_PERMISSIONS_INVALID");
    assert.equal(catalog.api_major, 1);
    assert.equal(catalog.api_minor, 0);
    assert.deepEqual(catalog.installed, []);
    assert.deepEqual(catalog.configuration_revisions, {});
    assert.equal(catalog.catalog.length, 2);
    for (const manifest of catalog.catalog) {
      assert.deepEqual(manifest.extension_points, ["metadata"]);
      assert.deepEqual(manifest.requested_permissions, grants);
      assert.equal(manifest.isolation, "closed_declarative");
      assert.equal(manifest.trusted_operator_catalog, true);
      assert.deepEqual(manifest.limits, { max_return_bytes: 4096, max_extensions: 2, max_label_chars: 100 });
      assert.deepEqual(manifest.versions, ledger.canonical.filter((item) => item.id === manifest.id)
        .map(({ version, artifact_digest }) => ({ version, artifact_digest })));
    }
    report.checks.push("four actual catalog identities equal independently frozen LF pins");

    const cases = [...ledger.aliases, ...ledger.canonical.map((entry) => ({
      ...entry, source: "unknown-test-only", artifact_digest: unknown,
    }))];
    for (const entry of cases) {
      signal.throwIfAborted();
      seed(entry);
      const initial = state(entry.id);
      assert.equal(Object.hasOwn(initial.row.previous_state, "artifact_digest"), false);
      let current = await admin.request("/admin/plugins");
      const saved = current.installed.find((item) => item.id === entry.id);
      assert.equal(saved.artifact_digest, entry.artifact_digest);
      assert.equal(saved.can_rollback, true);
      assert.equal(current.configuration_revisions[entry.id], "7");
      assert.equal((await admin.request("/admin/plugins/audit")).items[0].artifact_digest, entry.artifact_digest);
      await assertLabel(entry.id, entry.version, "7", expectedB(entry.id));
      assert.deepEqual(state(entry.id), initial, "Catalog/audit/metadata reads must not repair provenance");
      const unchanged = await admin.request(path(entry.id), "PUT", body(entry.version, configB(entry.id), "7"));
      assert.deepEqual(unchanged, saved);
      assert.deepEqual(state(entry.id), initial, "No-op preserves full row, prior snapshot and audit");
      await rejected(path(entry.id), "PUT", body(entry.version, configB(entry.id), "6"), 409, "PLUGIN_REVISION_CONFLICT");
      assert.deepEqual(state(entry.id), initial);
      const restored = await admin.request(path(entry.id) + "/rollback", "POST", { expected_revision: "7" });
      assert.deepEqual(restored, {
        id: entry.id, version: otherVersion(entry.version), enabled: true,
        config: configA(entry.id), granted_permissions: grants, revision: "8",
        artifact_digest: canonical(entry.id, otherVersion(entry.version)), can_rollback: false,
      });
      assert.equal(row(entry.id).previous_state, null);
      assert.deepEqual(auditRows()[0], initial.audits[0], "Historical audit remains byte-for-value unchanged");
      assert.equal(auditRows().length, 2);
      assert.equal(auditRows()[1].action, "rollback");
      assert.equal(auditRows()[1].artifact_digest, restored.artifact_digest);
      await assertLabel(entry.id, restored.version, "8", expectedA(entry.id));

      // A separate historical specimen checks removal without replacing its digest first.
      seed(entry);
      const beforeRemove = state(entry.id);
      assert.deepEqual(await admin.request(path(entry.id), "DELETE", { expected_revision: "7" }),
        { id: entry.id, removed: true, revision: "8" });
      const tombstone = state(entry.id);
      assert.equal(tombstone.row.artifact_digest, entry.artifact_digest);
      assert.equal(tombstone.row.version, entry.version);
      assert.equal(tombstone.row.removed, true);
      assert.equal(tombstone.row.enabled, false);
      assert.deepEqual(tombstone.row.config, {});
      assert.deepEqual(tombstone.row.granted_permissions, []);
      assert.equal(tombstone.row.previous_state, null);
      assert.deepEqual(tombstone.audits[0], beforeRemove.audits[0]);
      assert.equal(tombstone.audits.length, 2);
      assert.equal(tombstone.audits[1].action, "remove");
      assert.equal(tombstone.audits[1].artifact_digest, entry.artifact_digest);
      assert.deepEqual((await metadata()).extensions, []);
      current = await admin.request("/admin/plugins");
      assert.deepEqual(current.installed, []);
      assert.equal(current.configuration_revisions[entry.id], "8");
      assert.deepEqual(await admin.request(path(entry.id), "DELETE", { expected_revision: "8" }),
        { id: entry.id, removed: true, revision: "8" });
      await rejected(path(entry.id) + "/rollback", "POST", { expected_revision: "8" }, 409, "PLUGIN_NO_ROLLBACK");
      await rejected(path(entry.id), "PUT", body(entry.version, configB(entry.id), "0"), 409, "PLUGIN_REVISION_CONFLICT");
      await rejected(path(entry.id), "PUT", { ...body(entry.version, configB(entry.id), "8"), granted_permissions: [] }, 400, "PLUGIN_MANIFEST_OR_PERMISSIONS_INVALID");
      assert.deepEqual(state(entry.id), tombstone, "No repeated remove, rejected rollback or invalid grant repair");
      const reinstall = await admin.request(path(entry.id), "PUT", body(entry.version, configB(entry.id), "8", false));
      assert.equal(reinstall.artifact_digest, canonical(entry.id, entry.version));
      assert.equal(reinstall.revision, "9");
      assert.equal(reinstall.enabled, false);
      assert.equal(reinstall.can_rollback, false);
      assert.equal(auditRows().length, 3);
      assert.equal(auditRows()[2].action, "install");
      assert.deepEqual((await metadata()).extensions, []);
    }
    report.checks.push("24 grounded source-formula digests and four unknown specimens preserve read/no-op/rollback/remove/reinstall contracts");

    for (const entry of ledger.canonical) {
      signal.throwIfAborted();
      seed({ ...entry, artifact_digest: unknown }, { enabled: false });
      const disabled = state(entry.id);
      await admin.request(path(entry.id), "PUT", body(entry.version, configB(entry.id), "7", false));
      assert.deepEqual(state(entry.id), disabled);
      assert.deepEqual((await metadata()).extensions, []);
      const enabled = await admin.request(path(entry.id), "PUT", body(entry.version, configB(entry.id), "7"));
      assert.equal(enabled.revision, "8");
      assert.equal(enabled.artifact_digest, canonical(entry.id, entry.version));
      assert.deepEqual(row(entry.id).previous_state, {
        version: entry.version, enabled: false, config: configB(entry.id), granted_permissions: grants,
      });
      await assertLabel(entry.id, entry.version, "8", expectedB(entry.id));
      await admin.request(path(entry.id), "PUT", body(entry.version, configB(entry.id), "8", false));
      await admin.request(path(entry.id), "PUT", body(entry.version, configA(entry.id), "9", false));
      const changedVersion = await admin.request(path(entry.id), "PUT", body(otherVersion(entry.version), configA(entry.id), "10", false));
      assert.equal(changedVersion.revision, "11");
      assert.equal(changedVersion.artifact_digest, canonical(entry.id, otherVersion(entry.version)));
      assert.deepEqual(auditRows().map((item) => item.action), ["configure", "enable", "disable", "configure", "upgrade"]);
      assert.equal(auditRows()[0].artifact_digest, unknown);
      assert.deepEqual(auditRows().slice(1).map((item) => item.artifact_digest), [
        canonical(entry.id, entry.version), canonical(entry.id, entry.version),
        canonical(entry.id, entry.version), canonical(entry.id, otherVersion(entry.version)),
      ]);
    }
    report.checks.push("real enabled/disabled/configured/version-change endpoints mint only current identity at existing mutation boundaries");

    const sample = ledger.canonical.find((item) => item.id === duration && item.version === "1.0.0");
    for (const prior of [null, {}, { config: { format: "clock" } },
      { version: "1.0.0", enabled: true, config: { format: "clock" }, granted_permissions: ["network:*"] },
      { version: "2.0.0", enabled: true, config: { format: "clock" }, granted_permissions: grants }]) {
      seed(sample, { previous: prior });
      const before = state(sample.id);
      await rejected(path(sample.id) + "/rollback", "POST", { expected_revision: "7" }, 409,
        prior === null ? "PLUGIN_NO_ROLLBACK" : "PLUGIN_ROLLBACK_INVALID");
      assert.deepEqual(state(sample.id), before);
    }
    seed(sample, { previous: { version: "1.0.0", enabled: true, config: { format: "clock" }, granted_permissions: grants, existing_extra_key: "ignored" } });
    const extra = await admin.request(path(sample.id) + "/rollback", "POST", { expected_revision: "7" });
    assert.equal(extra.revision, "8");
    assert.equal(extra.artifact_digest, canonical(duration, "1.0.0"));
    report.checks.push("digest-free and extra-key snapshots retain current acceptance; malformed/null/unsupported snapshots remain nonmutating conflicts");

    // Literal expected values exercise the real Rust transform through metadata.
    // There is no JavaScript replica of the transform implementation here.
    for (const version of ["1.0.0", "1.1.0"]) {
      signal.throwIfAborted();
      seed({ id: duration, version, artifact_digest: unknown });
      for (const [ms, expected] of [[0, "0 分钟"], [1, "1 分钟"], [60000, "1 分钟"], [60001, "2 分钟"], [604800000, "10080 分钟"], [-1, null], [604800001, null], [null, null]]) {
        signal.throwIfAborted();
        f.sql(`UPDATE media_items SET duration_ms=${ms === null ? "NULL" : ms} WHERE id=${q(media)}`);
        if (expected === null) assert.deepEqual((await metadata()).extensions, []);
        else await assertLabel(duration, version, "7", expected);
      }
      await admin.request(path(duration), "PUT", body(version, { format: "clock" }, "7"));
      for (const [ms, expected] of [[0, "0:00:00"], [999, "0:00:00"], [1000, "0:00:01"], [3661000, "1:01:01"], [604800000, "168:00:00"]]) {
        signal.throwIfAborted();
        f.sql(`UPDATE media_items SET duration_ms=${ms} WHERE id=${q(media)}`);
        await assertLabel(duration, version, "8", expected);
      }
    }
    f.sql(`UPDATE media_items SET duration_ms=60000 WHERE id=${q(media)}`);
    for (const version of ["1.0.0", "1.1.0"]) {
      signal.throwIfAborted();
      seed({ id: note, version, artifact_digest: unknown });
      const before = state(note);
      for (const label of ["", "   ", "x".repeat(41), "x\n", "x\u2028", "x\u2029", "x\u202e", "x\u2066"])
        await rejected(path(note), "PUT", body(version, { label }, "7"), 400, "PLUGIN_MANIFEST_OR_PERMISSIONS_INVALID");
      for (const granted_permissions of [[], ["metadata:read", "metadata:read"], ["network:*"], ["metadata:read", "execute"]])
        await rejected(path(note), "PUT", { ...body(version, configA(note), "7"), granted_permissions }, 400, "PLUGIN_MANIFEST_OR_PERMISSIONS_INVALID");
      await rejected(path(note), "PUT", body(version, { label: "fine", script: "not executed" }, "7"), 400, "PLUGIN_MANIFEST_OR_PERMISSIONS_INVALID");
      await rejected(path(note), "PUT", body("2.0.0", configA(note), "7"), 400, "PLUGIN_MANIFEST_OR_PERMISSIONS_INVALID");
      assert.deepEqual(state(note), before);
      const text = "🙂".repeat(40);
      await admin.request(path(note), "PUT", body(version, { label: text }, "7"));
      await assertLabel(note, version, "8", text);
      await admin.request(path(note), "PUT", body(version, configA(note), "8"));
      await assertLabel(note, version, "9", expectedA(note));
    }
    report.checks.push("actual metadata endpoint covers literal duration boundaries, both versions, label scalar bounds/text and unchanged closed grant/config validation");
    signal.throwIfAborted();
    }, { signal });
    signal.throwIfAborted();
  });
} catch (error) {
  failure = error;
} finally {
  report.result = failure ? "failed" : "passed";
  if (fixture) {
    try {
      const cleanup = JSON.parse(await readFile(resolve(fixture.root, "fixture-cleanup.json")));
      report.fixture_test_outcome = cleanup.test_outcome;
      report.fixture_cleanup_outcome = cleanup.cleanup_outcome;
      report.fixture_result = cleanup.result;
      report.cleanup_receipt = "fixture-cleanup.json";
      assert.equal(cleanup.cleanup_outcome, "verified");
      assert.equal(cleanup.cleanup.completed, true);
      if (!failure) assert.equal(cleanup.result, "passed");
    } catch (error) {
      report.result = "failed";
      report.cleanup_verification = "unverified_or_failed";
      failure = failure ?? error;
    }
    try {
      await writeFile(resolve(fixture.root, "plugin-identity-compatibility-evidence.json"), JSON.stringify(report, null, 2) + "\n");
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], "fixture_and_evidence_failed") : error;
    }
  }
}
if (failure) throw failure;
assert.equal(report.result, "passed");
console.log("PASS: P21 exact catalog identity and historical/unknown configuration compatibility; owned cleanup verified");
