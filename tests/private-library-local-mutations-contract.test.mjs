// Pure Node contracts only. Executes extracted actual pure/transition/main
// definitions with every I/O dependency replaced in memory; never imports the
// native entry point or runs Cargo, child processes, DB, sockets or providers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import test from "node:test";
// Execute the actual pure definitions extracted from the coordinator bytes.
// No import of the native entry point or its service/helper dependency graph.
const nativeSource = readFileSync(new URL("./private-library-local-mutations-native.mjs", import.meta.url), "utf8");
const bindingSource = readFileSync(new URL("../scripts/native-owner-binding.mjs", import.meta.url), "utf8");
const nativeOwnerTest = JSON.parse(bindingSource.match(/export const nativeOwnerTest =\s*("[^"\n]+");/)[1]);
const names = ["assertChecklist", "assertExactState", "assertTimeWindow", "assertCipherReplacement", "assertCleanStop", "allBoundArtifacts", "guardedFetch", "combineFailures", "failureCategory", "safeRunFailure", "verifyEveryReceipt", "consumeJsonResponse", "snapshotSql"];
const declarations = [
  nativeSource.slice(nativeSource.indexOf("export const requiredGroups ="), nativeSource.indexOf("\n\nexport function assertChecklist")),
  nativeSource.match(/^const productionNames = .*;$/m)[0],
  nativeSource.match(/^const helperNames = .*;$/m)[0],
  nativeSource.match(/^const snapshotTables = \{[\s\S]*?^\};/m)[0],
  nativeSource.match(/^const zeroTables = .*;$/m)[0],
  ...names.map((name) => {
    const pattern = new RegExp(`export (?:async )?function ${name}\\([^]*?^}`, "m");
    const found = nativeSource.match(pattern); assert.ok(found, `Actual function ${name} must be extracted`); return found[0];
  }),
].map((definition) => definition.replace(/^export /, ""));
const extracted = new Function("assert", "resolve", "isAbsolute", "nativeOwnerTest", "secret", "quote", "safeFailure", `${declarations.join("\n")}\nreturn { requiredGroups, ${names.join(",")} };`)(
  assert, resolve, isAbsolute, nativeOwnerTest, "private-local-mutations-synthetic-header-secret", (value) => `'${String(value).replaceAll("'", "''")}'`,
  new Function(`${readFileSync(new URL("./fixtures/safe-failure.mjs", import.meta.url), "utf8").replace("export function", "function")}\nreturn safeFailure;`)(),
);
const { requiredGroups, assertChecklist, assertExactState, assertTimeWindow, assertCipherReplacement, assertCleanStop, allBoundArtifacts, guardedFetch, combineFailures, failureCategory, safeRunFailure, verifyEveryReceipt, consumeJsonResponse, snapshotSql } = extracted;

const expectedGroups = [
  ["library_grants_transfer", ["create_library_receipt", "rename_exact_delta", "stale_library_cas_unchanged", "grant_exact_delta", "manager_cannot_revoke", "manager_cannot_transfer", "grant_delete_exact_delta", "regrant_exact_delta", "transfer_exact_delta", "old_owner_loses_access"]],
  ["private_source_metadata", ["safe_source_detail", "no_implicit_admin_or_stranger_access", "source_rename_exact_delta", "empty_config_semantic_noop", "same_headers_semantic_noop", "stale_source_cas_unchanged", "nonadmin_policy_rejected_unchanged"]],
  ["private_source_configuration_and_deletion", ["cross_origin_without_clear_rejected", "config_change_exact_delta", "stale_source_delete_unchanged", "source_delete_exact_delta", "source_tombstone_hidden", "library_delete_exact_delta", "library_tombstone_hidden", "owned_marker_bytes_unchanged"]],
  ["room_share_mutations", ["three_shares_exact_deltas", "invalid_share_expiry_unchanged", "share_update_exact_delta", "stale_share_update_unchanged", "share_revoke_exact_delta", "revoked_share_update_unchanged", "grantor_access_revoked", "issued_share_redacted_after_loss", "other_share_revoke_denied", "lost_grantor_own_revoke_exact_delta", "zero_playback_and_provider_work"]],
];
const complete = () => expectedGroups.map(([name, checks]) => ({ name, checks: checks.map((name) => ({ name, result: "passed" })) }));

test("all four fixed groups reject missing, extra, duplicate, failed and reordered completion", () => {
  assert.deepEqual(requiredGroups, expectedGroups.map(([name, checks]) => ({ name, checks })));
  assert.deepEqual(requiredGroups.map((group) => group.checks.length), [10, 7, 8, 11]);
  assertChecklist(complete());
  for (const mutate of [
    (groups) => groups.pop(),
    (groups) => groups.reverse(),
    (groups) => groups.push(groups[0]),
    (groups) => { groups[0].name = "unknown"; },
    ...requiredGroups.flatMap((_, index) => [
      (groups) => groups[index].checks.pop(),
      (groups) => groups[index].checks.push(groups[index].checks[0]),
      (groups) => groups[index].checks.reverse(),
      (groups) => { groups[index].checks[0].name = "unknown"; },
      (groups) => { groups[index].checks[0].result = "failed"; },
    ]),
  ]) { const groups = complete(); mutate(groups); assert.throws(() => assertChecklist(groups), assert.AssertionError); }
});

test("the actual full-snapshot comparator rejects collateral writes and semantic no-op drift", () => {
  const before = {
    libraries: [{ id: "library", revision: "8", permission_epoch: "3", deleted_at: null }],
    sources: [{ id: "source", settings_revision: "4", config_encrypted: "cipher", name: "old", access_policy_revision: "2" }],
    policy: [{ source_id: "source", revision: "2", config_encrypted: "cipher" }],
    media: [{ id: "media", library_source_generation: "2", preview_generation: "5", available: true }],
    grants: [], shares: [], audit: [{ id: "audit" }], snapshots: [{ room_id: "room", state: { generation: 0 } }], zero_work: { playback_sessions: "0" },
  };
  assertExactState(before, structuredClone(before));
  const renamed = structuredClone(before);
  renamed.sources[0].name = "new"; renamed.sources[0].settings_revision = "5"; renamed.libraries[0].revision = "9";
  const edit = (state) => { state.sources[0].name = "new"; state.sources[0].settings_revision = "5"; state.libraries[0].revision = "9"; };
  assertExactState(before, renamed, edit);
  for (const mutate of [
    (state) => { state.libraries[0].permission_epoch = "4"; },
    (state) => { state.sources[0].config_encrypted = "changed"; },
    (state) => { state.policy[0].config_encrypted = "changed"; },
    (state) => { state.media[0].preview_generation = "6"; },
    (state) => { state.media[0].library_source_generation = "3"; },
    (state) => { state.sources[0].access_policy_revision = "3"; },
    (state) => state.audit.push({ id: "unexpected" }),
    (state) => { state.snapshots[0].state.generation = 1; },
    (state) => { state.zero_work.playback_sessions = "1"; },
    (state) => { state.unexpected = []; },
  ]) {
    const bad = structuredClone(before); mutate(bad); assert.throws(() => assertExactState(before, bad), assert.AssertionError);
    const badRename = structuredClone(renamed); mutate(badRename); assert.throws(() => assertExactState(before, badRename, edit), assert.AssertionError);
  }
  assert.equal(before.sources[0].name, "old", "comparison never mutates the preimage");
});

test("timestamp validation uses the real closed microsecond request window including offsets", () => {
  const window = { start: "1791640000000000", end: "1791640000000123" };
  for (const value of [window.start, "1791640000000001", window.end]) assertTimeWindow(value, window);
  for (const value of ["1791639999999999", "1791640000000124", "1791640000000.1", "-1", "NaN"]) assert.throws(() => assertTimeWindow(value, window));
  assert.throws(() => assertTimeWindow(window.start, { start: window.end, end: window.start }));
  const hour = 3600000000n;
  assertTimeWindow((BigInt(window.start) + hour).toString(), window, hour);
  assertTimeWindow((BigInt(window.end) + hour).toString(), window, hour);
  assert.throws(() => assertTimeWindow((BigInt(window.end) + hour + 1n).toString(), window, hour));
  assert.throws(() => assertTimeWindow((BigInt(window.start) + hour - 1n).toString(), window, hour));
});

test("cipher replacement rejects unchanged, empty, too short and noncanonical ciphertext", () => {
  const old = Buffer.alloc(30, 1).toString("base64"), changed = Buffer.alloc(30, 2).toString("base64");
  assertCipherReplacement(old, changed);
  for (const value of [old, "", "not-base64", Buffer.alloc(27).toString("base64"), changed + "\n", null]) assert.throws(() => assertCipherReplacement(old, value));
});

function cleanupReceipt() {
  return { completed: true, server_port_closed: true,
    servers: [{ closed_at: "2026-10-10T00:00:00Z", pid_absent: true, exit_code: 0, signal: null }],
    postgres: { kind: "native", stopped: true, process_close_observed: true, pid_absent: true, port_closed: true, pg_ctl_status: 3, exit_code: 0, signal: null } };
}
test("real cleanup validator rejects missing close, open port, surviving PID and forced exits", () => {
  assertCleanStop(cleanupReceipt());
  for (const mutate of [
    (r) => { r.completed = false; }, (r) => { r.server_port_closed = false; }, (r) => { r.servers = []; },
    (r) => { r.servers[0].closed_at = null; }, (r) => { r.servers[0].pid_absent = false; },
    (r) => { r.servers[0].signal = "SIGKILL"; }, (r) => { r.servers[0].exit_code = 137; },
    ...["stopped", "process_close_observed", "pid_absent", "port_closed"].map((key) => (r) => { r.postgres[key] = false; }),
    (r) => { r.postgres.kind = "docker"; }, (r) => { r.postgres.pg_ctl_status = 0; },
    (r) => { r.postgres.exit_code = 1; }, (r) => { r.postgres.signal = "SIGKILL"; },
  ]) { const r = cleanupReceipt(); mutate(r); assert.throws(() => assertCleanStop(r), assert.AssertionError); }
});

function bindingManifest(target) {
  const binary = (name, dir = "debug") => ({ name, path: resolve(target, dir, name), sha256: "a".repeat(64) });
  return {
    binaries: ["rainsync-server", "rainsync-media-worker", "rainsync-nas-agent"].map((name) => binary(name)),
    test_helpers: ["verify_job_health_events", "stop_claim_fixture", "verify_job_phase_timings", "emby_profile_request", "fixture_password", "export", "verify_diagnostics", "verify_membership_gates", "verify_room_commands", "verify_cache_budget", "verify_cache_leases", "verify_output_cleanup", "verify_cache_writer_safety"].map((name) => binary(name, "debug/examples")).concat(binary("rainsync-compute-node")),
    owner_fixtures: [{ test_name: nativeOwnerTest, path: resolve(target, "debug/deps/rainsync_server-deterministic-fixture-name"), sha256: "b".repeat(64) }],
  };
}
test("all eighteen artifacts, including the never-executed owner test, are independently required", () => {
  const target = resolve("/owned-pure-test-target");
  assert.equal(allBoundArtifacts(bindingManifest(target), target, "linux").length, 18);
  for (const mutate of [
    (m) => { delete m.owner_fixtures; }, (m) => { m.owner_fixtures = []; }, (m) => m.owner_fixtures.push(m.owner_fixtures[0]),
    (m) => { m.owner_fixtures[0].test_name = "wrong"; }, (m) => { m.owner_fixtures[0].path = resolve(target, "unbound/owner"); },
    (m) => { m.owner_fixtures[0].sha256 = ""; }, (m) => m.test_helpers.pop(), (m) => m.test_helpers.reverse(),
    (m) => { m.binaries[0].path = resolve("/different/server"); }, (m) => { m.test_helpers[0].path = resolve(target, "debug/verify_job_health_events"); },
  ]) { const m = bindingManifest(target); mutate(m); assert.throws(() => allBoundArtifacts(m, target, "linux"), assert.AssertionError); }
});

test("the actual fetch guard drains health on success and error and blocks out-of-scope I/O in memory", async () => {
  const receipt = { health_bodies_drained: 0 }; let calls = 0;
  const responses = [new Response("healthy"), new Response("not ready", { status: 503 })];
  const fetch = guardedFetch(async (_input, options) => { assert.equal(options.redirect, "error"); calls++; return responses[calls - 1]; }, receipt);
  for (const response of responses) { assert.equal(await fetch("http://127.0.0.1:43210/health"), response); assert.equal(response.bodyUsed, true); }
  assert.equal(receipt.health_bodies_drained, 2);
  for (const url of ["http://127.0.0.1:43211/health", "https://media.example.test/a", "http://localhost:43210/health", "http://127.0.0.1:43210/api/v1/playback/prepare", "http://127.0.0.1:43210/api/v1/media/123/preview", "http://127.0.0.1:43210/api/v1/libraries/00000000-0000-0000-0000-000000000001/sources/00000000-0000-0000-0000-000000000002/scan", "http://127.0.0.1:43210/health?token=secret", "http://user:pass@127.0.0.1:43210/health"]) await assert.rejects(fetch(url), assert.AssertionError);
  assert.equal(calls, 2, "denied routes never reach even the in-memory fetch stub");
});

test("actual receipt verification attempts every artifact and tool despite binding, read and hash failures", async () => {
  const items = [
    ...Array.from({ length: 18 }, (_, index) => ({ category: "native_artifact", path: `artifact-${index}`, sha256: "expected" })),
    ...Array.from({ length: 5 }, (_, index) => ({ category: "node_or_pg_tool", path: `tool-${index}`, sha256: "expected" })),
    { category: "binding_bytes", path: "binding", sha256: "expected" },
    { category: "backend_source", path: "source", sha256: "expected" },
    { category: "coordinator_or_helper", path: "helper", sha256: "expected" },
  ];
  const seen = [], bindingFailure = Error("binding failure"), backendFailure = Error("backend source set failure"), readFailure = Error("read failure");
  let backendAttempts = 0;
  const result = await verifyEveryReceipt({
    bindingVerify: async () => { throw bindingFailure; }, backendVerify: async () => { backendAttempts++; throw backendFailure; }, items,
    readBytes: async (path) => { seen.push(path); if (path === "artifact-0") throw readFailure; return path === "tool-0" ? "wrong" : "expected"; },
    digest: (bytes) => bytes,
  });
  assert.deepEqual(seen, items.map((item) => item.path));
  assert.equal(backendAttempts, 1); assert.equal(result.checks.length, items.length + 2);
  assert.equal(result.checks.filter((item) => item.category === "native_artifact").length, 18);
  assert.equal(result.checks.filter((item) => item.category === "node_or_pg_tool").length, 5);
  assert.equal(result.errors.length, 4); assert.equal(result.errors[0], bindingFailure); assert.equal(result.errors[1], backendFailure); assert.equal(result.errors[2], readFailure);
  assert.deepEqual(result.checks.filter((item) => item.result === "failed").map((item) => item.path ?? item.category), ["shared_binding_verifier", "independent_backend_source_set", "artifact-0", "tool-0"]);
  assert.equal(JSON.stringify(result.checks).includes("binding failure"), false);
  const success = await verifyEveryReceipt({ bindingVerify: async () => {}, backendVerify: async () => {}, items, readBytes: async () => "expected", digest: (bytes) => bytes });
  assert.deepEqual(success.errors, []); assert.ok(success.checks.every((item) => item.result === "passed"));
});

test("primary and diagnostic/evidence failures retain both original identities", () => {
  const primary = Error("primary"), secondary = Error("diagnostic");
  assert.equal(combineFailures([primary]), primary);
  assert.equal(combineFailures([secondary]), secondary);
  const combined = combineFailures([primary, secondary]);
  assert.ok(combined instanceof AggregateError);
  assert.deepEqual(combined.errors, [primary, secondary]);
});

test("the actual business consumer drains before status, JSON, code and secrecy failures", async () => {
  for (const [body, status, options, valid] of [
    ['{"ok":true}', 200, {}, true],
    ['{"error":{"code":"SOURCE_CHANGED"}}', 409, { status: 409, code: "SOURCE_CHANGED" }, true],
    ['{"ok":false}', 500, {}, false],
    ['not JSON', 200, {}, false],
    ['{"error":{"code":"WRONG"}}', 409, { status: 409, code: "SOURCE_CHANGED" }, false],
    ['{"private":"sentinel-secret"}', 200, { forbidden: "sentinel-secret" }, false],
  ]) {
    const response = new Response(body, { status }); let observed;
    const run = consumeJsonResponse(response, { ...options, onBody: async (text) => { observed = text; } });
    if (valid) await run; else await assert.rejects(run);
    assert.equal(response.bodyUsed, true); assert.equal(observed, body);
  }
});

test("snapshot SQL reads full rows and only counts forbidden work, with an explicit native invocation guard", () => {
  const sql = snapshotSql();
  assert.match(sql, /to_jsonb\(r\)/); assert.match(sql, /1000000/);
  for (const table of ["private_libraries", "sources", "source_access_policy_snapshots", "media_items", "library_grants", "room_media_grants", "library_permission_audit", "room_snapshots", "room_events", "source_scans"]) assert.ok(sql.includes(`FROM ${table} r`));
  for (const table of ["playback_requests", "playback_sessions", "media_jobs", "upstream_reservations", "media_previews"]) assert.ok(sql.includes(`SELECT count(*)::text FROM ${table}`));
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b/);
  const source = readFileSync(new URL("./private-library-local-mutations-native.mjs", import.meta.url), "utf8");
  assert.match(source, /requireTest: true/);
  assert.match(source, /if \(process\.argv\[1\].*await main\(\);/);
  assert.doesNotMatch(source, /\bwithPlaybackAdmission\b|INSERT INTO (?:playback_requests|playback_sessions|media_jobs|upstream_reservations)|\/playback\/|\/prepare["`]/);
  assert.ok(!source.includes('from "./fixtures/playback-admission.mjs"'), "the hash-only coordinator input is never imported");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.ok(!Object.values(pkg.scripts).some((command) => command.includes("private-library-local-mutations-native")));
  assert.ok(!ci.includes("private-library-local-mutations-native"), "unqualified fixture remains outside CI");
});

const falsyReasons = [undefined, null, false, 0, -0, 0n, "", NaN];
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
async function settled(promise) {
  try { return { rejected: false, value: await promise }; }
  catch (reason) { return { rejected: true, reason }; }
}
function hostileReason(field) {
  return Object.defineProperty({}, field, { get() { throw Error("private getter detail must not escape"); } });
}

test("failure lists preserve every falsy value while safe classification never reads hostile getters unsafely", () => {
  for (const reason of [...falsyReasons, hostileReason("code"), hostileReason("name")]) {
    assert.ok(Object.is(combineFailures([reason]), reason));
    const later = Error("later"), combined = combineFailures([reason, later, undefined]);
    assert.ok(Object.is(combined.errors[0], reason)); assert.equal(combined.errors[1], later); assert.equal(combined.errors.length, 3);
    assert.equal(failureCategory(reason), "verification_failed");
    const safe = safeRunFailure([reason, later], "fixed safe message");
    assert.equal(safe.message, "fixed safe message"); assert.equal(safe.failure_count, 2);
    assert.equal(safe.cause, undefined); assert.equal(safe.errors, undefined);
    assert.equal(JSON.stringify(safe).includes("private getter"), false);
  }
  assert.throws(() => combineFailures([]), assert.AssertionError);
  assert.throws(() => safeRunFailure([], "none"), assert.AssertionError);
});

const transitionDefinition = nativeSource.match(/^  async function transition\([^]*?^  }/m)?.[0];
assert.ok(transitionDefinition, "Extract the actual nested transition function, not a rewritten model");
function transitionHarness(plan = {}) {
  const report = {}, external = { failures: [] }, observed = [];
  let clocks = 0;
  const bindings = {
    report, external, assertExactState, combineFailures, failureCategory,
    snapshot: () => { observed.push("snapshot"); return { row: "unchanged" }; },
    privateEvidence: async (label) => { observed.push(label); return { path: `memory-${label}` }; },
    save: async () => { observed.push("save"); if (has(plan, "saveReason") && clocks === 2) throw plan.saveReason; },
    now: () => { clocks++; observed.push("clock"); if (clocks === 2 && has(plan, "diagnosticReason")) throw plan.diagnosticReason; return String(clocks); },
  };
  const transition = new Function(...Object.keys(bindings), `${transitionDefinition}\nreturn transition;`)(...Object.values(bindings));
  return { transition, external, observed };
}

test("the actual transition rejects every falsy primary, diagnostic and save outcome without losing order", async () => {
  for (const reason of [...falsyReasons, hostileReason("code"), hostileReason("name")]) {
    const one = transitionHarness();
    const outcome = await settled(one.transition("primary", async () => { throw reason; }));
    assert.equal(outcome.rejected, true); assert.ok(Object.is(outcome.reason, reason));
    assert.equal(one.observed.filter((event) => event === "snapshot").length, 2, "after snapshot still runs after any rejection value");
    assert.deepEqual(one.external.failures, [{ stage: "request", code: "verification_failed" }]);
    const diagnostic = Error("diagnostic"), both = transitionHarness({ diagnosticReason: diagnostic });
    const two = await settled(both.transition("both", async () => { throw reason; }));
    assert.equal(two.rejected, true); assert.ok(two.reason instanceof AggregateError);
    assert.ok(Object.is(two.reason.errors[0], reason)); assert.equal(two.reason.errors[1], diagnostic);
    assert.deepEqual(both.external.failures.map((item) => item.stage), ["request", "after_snapshot_or_evidence"]);
  }
  for (const key of ["diagnosticReason", "saveReason"]) for (const reason of falsyReasons) {
    const harness = transitionHarness({ [key]: reason });
    const outcome = await settled(harness.transition("secondary-only", async () => "successful action"));
    assert.equal(outcome.rejected, true); assert.ok(Object.is(outcome.reason, reason));
    assert.deepEqual(harness.external.failures, [{ stage: "after_snapshot_or_evidence", code: "verification_failed" }]);
  }
  const happy = transitionHarness();
  assert.equal(await happy.transition("happy", async () => "value"), "value");
});

const mainDefinition = nativeSource.match(/^export async function main\([^]*?^}/m)?.[0].replace(/^export /, "");
assert.ok(mainDefinition, "Extract the actual full native main without importing or executing its module");
async function mainHarness(plan = {}) {
  // Every dependency capable of filesystem/process/native execution is replaced
  // before the actual main definition is evaluated. All bytes live in this Map.
  const repo = "/pure-repository", target = "/pure-target", bindingPath = "/pure-binding.json", pg = "/pure-pg";
  const files = new Map(), writes = [], reads = [], finalFailures = [], logs = [];
  const memoryHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const bytesFor = (path) => {
    if (!files.has(path)) files.set(path, Buffer.from(`memory bytes for ${path}`));
    return files.get(path);
  };
  const manifest = bindingManifest(target);
  manifest.source = [{ path: "Cargo.toml", sha256: memoryHash(bytesFor(`${repo}/Cargo.toml`)) }];
  manifest.producers = ["scripts/bind-native-backend.mjs", "scripts/native-owner-binding.mjs"].map((path) => ({ path, sha256: memoryHash(bytesFor(`${repo}/${path}`)) }));
  for (const item of [...manifest.binaries, ...manifest.test_helpers, ...manifest.owner_fixtures]) item.sha256 = memoryHash(bytesFor(item.path));
  files.set(bindingPath, Buffer.from(JSON.stringify(manifest)));
  const fixture = { root: "/pure-fixture", verifyStopped: async () => {
    if (has(plan, "cleanupReason")) throw plan.cleanupReason;
    return cleanupReceipt();
  } };
  let after = false, catalogCalls = 0, backendCalls = 0;
  const bindings = {
    assert, isAbsolute, resolve, relative: (a, b) => b.startsWith(a + "/") ? b.slice(a.length + 1) : `../${b.slice(1)}`, sep: "/",
    root: repo, coordinator: "tests/private-library-local-mutations-native.mjs", secret: "synthetic-secret",
    process: { env: { RAINSYNC_ARTIFACT_DIR: "/pure-artifacts", CARGO_TARGET_DIR: target, W03_BACKEND_BINDING: bindingPath, RAINSYNC_NATIVE_POSTGRES_BIN: pg },
      platform: "linux", execPath: "/pure-node", getuid: () => 1000, argv: [] },
    globalThis: { fetch: async () => { throw Error("No HTTP call is permitted by this memory harness"); } },
    console: { log: (value) => logs.push(value) },
    realpath: async (path) => path, randomUUID: () => "pure-run-id", mkdir: async () => {}, hash: memoryHash,
    readFile: async (path, encoding) => {
      reads.push({ path, after });
      const bytes = bytesFor(path); return encoding === "utf8" ? bytes.toString("utf8") : bytes;
    },
    writeFile: async (_path, bytes) => {
      const value = JSON.parse(bytes); writes.push(value);
      if (value.finished_at && has(plan, "saveReason")) throw plan.saveReason;
    },
    execFileSync: (path, args) => path === "git" ? args[0] === "status" ? "" : "f".repeat(40)
      : path === "/pure-node" ? "v24.0.0" : "tool (PostgreSQL) 17.1",
    loadOwnerBinding: async () => ({ verify: async () => { if (after && has(plan, "bindingReason")) throw plan.bindingReason; } }),
    backendSnapshot: async () => { backendCalls++; if (after && has(plan, "backendReason")) throw plan.backendReason; return structuredClone(manifest.source); },
    allBoundArtifacts, guardedFetch, assertChecklist, assertCleanStop, failureCategory,
    verifyEveryReceipt: (options) => verifyEveryReceipt({ ...options, readBytes: bindings.readFile, digest: memoryHash }),
    safeRunFailure: (failures, message) => { finalFailures.push(...failures); return safeRunFailure(failures, message); },
    catalogFixture: async (_options, callback) => {
      catalogCalls++;
      try { await callback(fixture, { coordinator: [] }, { throwIfAborted() {} }); }
      finally { after = true; }
      if (has(plan, "catalogReason")) throw plan.catalogReason;
    },
    runCases: async (_fixture, _catalogReport, _signal, report) => {
      // Complete checks BEFORE injecting rejection to catch false-pass paths.
      report.groups = complete(); report.marker = { path: "/pure-marker", sha256: memoryHash(bytesFor("/pure-marker")) };
      if (has(plan, "businessReason")) throw plan.businessReason;
    },
  };
  const main = new Function(...Object.keys(bindings), `${mainDefinition}\nreturn main;`)(...Object.values(bindings));
  const outcome = await settled(main(["--original"]));
  return { ...outcome, writes, reads, finalFailures, logs, catalogCalls, backendCalls, manifest };
}

test("the actual main fails closed on falsy business, catalog, cleanup, integrity or final-save rejection after completed checks", async () => {
  const happy = await mainHarness(); assert.equal(happy.rejected, false); assert.equal(happy.writes.at(-1).result, "passed");
  for (const key of ["businessReason", "catalogReason", "cleanupReason", "bindingReason", "backendReason", "saveReason"]) {
    for (const reason of [...falsyReasons, hostileReason("code"), hostileReason("name")]) {
      const result = await mainHarness({ [key]: reason });
      assert.equal(result.rejected, true, key); assert.equal(result.reason.failure_count, 1);
      assert.equal(result.finalFailures.length, 1);
      if (["bindingReason", "backendReason"].includes(key)) {
        assert.ok(result.finalFailures[0] instanceof AggregateError);
        assert.equal(result.finalFailures[0].errors.length, 1); assert.ok(Object.is(result.finalFailures[0].errors[0], reason));
      } else assert.ok(Object.is(result.finalFailures[0], reason));
      assert.equal(result.logs.length, 0, "No success message follows a falsy rejection");
      if (key !== "saveReason") assert.equal(result.writes.at(-1).result, "failed");
      assert.equal(result.backendCalls, 2, "Independent before and after source-set verification still runs");
      const after = result.writes.at(-1).integrity.after;
      assert.equal(after.filter((item) => item.category === "native_artifact").length, 18);
      assert.equal(after.filter((item) => item.category === "node_or_pg_tool").length, 5);
      assert.equal(JSON.stringify(result.writes).includes("private getter detail"), false);
    }
  }
});

test("the actual main retains falsy primary, cleanup, all integrity reasons and save rejection in original order", async () => {
  for (const primary of [...falsyReasons, hostileReason("code"), hostileReason("name")]) {
    const cleanup = null, binding = false, backend = undefined, save = "";
    const result = await mainHarness({ businessReason: primary, cleanupReason: cleanup, bindingReason: binding, backendReason: backend, saveReason: save });
    assert.equal(result.rejected, true); assert.equal(result.reason.failure_count, 4);
    assert.equal(result.finalFailures.length, 4); assert.ok(Object.is(result.finalFailures[0], primary));
    assert.equal(result.finalFailures[1], cleanup);
    const integrity = result.finalFailures[2]; assert.ok(integrity instanceof AggregateError); assert.deepEqual(integrity.errors, [binding, backend]);
    assert.equal(result.finalFailures[3], save);
    assert.equal(result.writes.at(-1).result, "failed");
    assert.deepEqual(result.writes.at(-1).failures, [
      { stage: "qualification", code: "verification_failed" }, "cleanup_or_private_evidence_verification_failed", "final_binding_failed",
    ]);
    const after = result.writes.at(-1).integrity.after;
    assert.equal(after.filter((item) => item.category === "native_artifact").length, 18);
    assert.equal(after.filter((item) => item.category === "node_or_pg_tool").length, 5);
    assert.equal(result.logs.length, 0);
  }
});
