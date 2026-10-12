// Finite metadata-only qualification. Import is inert; native execution requires
// --original or --candidate and explicit bound artifacts in an authorized host.
import assert from "node:assert/strict";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogFixture } from "./fixtures/catalog-evidence.mjs";
import { backendSnapshot, loadOwnerBinding, nativeOwnerTest } from "../scripts/native-owner-binding.mjs";
import { safeFailure } from "./fixtures/safe-failure.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const coordinator = "tests/private-library-local-mutations-native.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const plus = (value, delta = 1) => (BigInt(value) + BigInt(delta)).toString();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const secret = "private-local-mutations-synthetic-header-secret";
const originalUrl = "https://media.example.test/original.mp4";
const changedUrl = "https://other.example.test/changed.mp4";

// Frozen independently of case execution: neither omissions nor reordering pass.
export const requiredGroups = Object.freeze([
  { name: "library_grants_transfer", checks: [
    "create_library_receipt", "rename_exact_delta", "stale_library_cas_unchanged",
    "grant_exact_delta", "manager_cannot_revoke", "manager_cannot_transfer", "grant_delete_exact_delta",
    "regrant_exact_delta", "transfer_exact_delta", "old_owner_loses_access",
  ] },
  { name: "private_source_metadata", checks: [
    "safe_source_detail", "no_implicit_admin_or_stranger_access", "source_rename_exact_delta",
    "empty_config_semantic_noop", "same_headers_semantic_noop", "stale_source_cas_unchanged",
    "nonadmin_policy_rejected_unchanged",
  ] },
  { name: "private_source_configuration_and_deletion", checks: [
    "cross_origin_without_clear_rejected", "config_change_exact_delta",
    "stale_source_delete_unchanged", "source_delete_exact_delta", "source_tombstone_hidden",
    "library_delete_exact_delta", "library_tombstone_hidden", "owned_marker_bytes_unchanged",
  ] },
  { name: "room_share_mutations", checks: [
    "three_shares_exact_deltas", "invalid_share_expiry_unchanged", "share_update_exact_delta",
    "stale_share_update_unchanged", "share_revoke_exact_delta", "revoked_share_update_unchanged",
    "grantor_access_revoked", "issued_share_redacted_after_loss", "other_share_revoke_denied",
    "lost_grantor_own_revoke_exact_delta", "zero_playback_and_provider_work",
  ] },
].map((group) => Object.freeze({ name: group.name, checks: Object.freeze(group.checks) })));

export function assertChecklist(groups) {
  assert.deepEqual(groups, requiredGroups.map(({ name, checks }) => ({
    name, checks: checks.map((check) => ({ name: check, result: "passed" })),
  })), "Every frozen group and check must complete exactly once in order");
}
export function assertExactState(before, after, edit = () => {}) {
  const expected = structuredClone(before);
  edit(expected);
  assert.deepEqual(after, expected, "Only the specified mutation may change the complete catalog snapshot");
}
export function assertTimeWindow(value, window, offset = 0n) {
  assert.match(value, /^\d+$/);
  const time = BigInt(value), start = BigInt(window.start), end = BigInt(window.end);
  assert.ok(start <= end && time >= start + offset && time <= end + offset,
    "Database timestamp must be inside the exact observed request window");
}
export function assertCipherReplacement(previous, next) {
  assert.equal(typeof next, "string");
  assert.notEqual(next, previous);
  const bytes = Buffer.from(next, "base64");
  assert.ok(bytes.length >= 28);
  assert.equal(bytes.toString("base64"), next);
}
export function assertCleanStop(receipt) {
  assert.equal(receipt.completed, true);
  assert.equal(receipt.server_port_closed, true);
  assert.ok(receipt.servers.length > 0);
  for (const server of receipt.servers) {
    assert.ok(server.closed_at);
    assert.equal(server.pid_absent, true);
    assert.equal(server.exit_code, 0);
    assert.equal(server.signal, null);
  }
  const pg = receipt.postgres;
  assert.equal(pg.kind, "native");
  for (const field of ["stopped", "process_close_observed", "pid_absent", "port_closed"]) assert.equal(pg[field], true);
  assert.equal(pg.pg_ctl_status, 3);
  assert.equal(pg.exit_code, 0);
  assert.equal(pg.signal, null);
}

const productionNames = ["rainsync-server", "rainsync-media-worker", "rainsync-nas-agent"];
const helperNames = ["verify_job_health_events", "stop_claim_fixture", "verify_job_phase_timings", "emby_profile_request", "fixture_password", "export", "verify_diagnostics", "verify_membership_gates", "verify_room_commands", "verify_cache_budget", "verify_cache_leases", "verify_output_cleanup", "verify_cache_writer_safety", "rainsync-compute-node"];
export function allBoundArtifacts(manifest, target, platform = process.platform) {
  assert.deepEqual(manifest.binaries.map((item) => item.name), productionNames);
  assert.deepEqual(manifest.test_helpers.map((item) => item.name), helperNames);
  assert.equal(manifest.owner_fixtures?.length, 1, "The eighteenth owner artifact is mandatory even though it is never executed");
  const owner = manifest.owner_fixtures[0];
  assert.equal(owner.test_name, nativeOwnerTest);
  assert.equal(resolve(owner.path, ".."), resolve(target, "debug", "deps"));
  const suffix = platform === "win32" ? ".exe" : "";
  for (const item of [...manifest.binaries, ...manifest.test_helpers]) {
    const directory = helperNames.includes(item.name) && item.name !== "rainsync-compute-node" ? "debug/examples" : "debug";
    assert.equal(item.path, resolve(target, directory, item.name + suffix));
  }
  const items = [...manifest.binaries, ...manifest.test_helpers, owner];
  assert.equal(new Set(items.map((item) => item.path)).size, 18);
  for (const item of items) { assert.ok(isAbsolute(item.path)); assert.match(item.sha256, /^[0-9a-f]{64}$/); }
  return items.map(({ name, test_name, path, sha256 }) => ({ name, test_name, path, sha256 }));
}

// This wrapper also drains the pre-existing helper's /health body, which its
// .ok-only startup probe otherwise leaves unread. No provider URL is admitted.
export function guardedFetch(fetchImpl, receipt) {
  const libraryRoute = /^\/api\/v1\/libraries(?:\/issued-shares|\/[0-9a-f-]{36}(?:\/(?:grants(?:\/[0-9a-f-]{36})?|transfer|sources(?:\/[0-9a-f-]{36})?|room-shares(?:\/[0-9a-f-]{36})?))?)?$/i;
  return async (input, options) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.username + url.password + url.search + url.hash, "");
    assert.ok(url.port);
    if (receipt.origin === undefined) {
      assert.equal(url.pathname, "/health", "The existing owned startup probe must establish the only origin");
      assert.equal(options?.method ?? "GET", "GET");
      receipt.origin = url.origin;
    }
    assert.equal(url.origin, receipt.origin, "Every request must target the single owned server origin");
    assert.ok(url.pathname === "/health" || /^\/api\/v1\/(?:auth\/(?:login|me)|users|rooms)$/.test(url.pathname) || libraryRoute.test(url.pathname), "HTTP route outside the finite metadata fixture");
    const response = await fetchImpl(input, { ...options, redirect: "error" });
    if (url.pathname === "/health") {
      await response.arrayBuffer();
      receipt.health_bodies_drained++;
    }
    return response;
  };
}

// Shared only within this dedicated fixture and its pure in-memory contract.
export function combineFailures(failures) {
  assert.ok(Array.isArray(failures) && failures.length > 0);
  return failures.length === 1 ? failures[0]
    : new AggregateError([...failures], "private_fixture_primary_and_evidence_failed");
}
export function failureCategory(reason) {
  // Rejection values can be primitives or objects with throwing property getters.
  try { return safeFailure(reason) ?? "verification_failed"; }
  catch { return "verification_failed"; }
}
export function safeRunFailure(failures, message) {
  assert.ok(Array.isArray(failures) && failures.length > 0);
  // Keep the ordered raw values local until this reporting boundary. Never put
  // them in Error.cause/errors: Node may print those secrets in an uncaught error.
  const error = Error(message);
  error.failure_count = failures.length;
  return error;
}

// Verify every frozen item even when binding/source or an earlier read fails.
// Raw errors remain local; callers serialize only the fixed categories/digests.
export async function verifyEveryReceipt({ bindingVerify, backendVerify, items, readBytes = readFile, digest = hash }) {
  const checks = [], errors = [];
  for (const [category, verify] of [["shared_binding_verifier", bindingVerify], ["independent_backend_source_set", backendVerify]]) {
    try { await verify(); checks.push({ category, result: "passed" }); }
    catch (error) { errors.push(error); checks.push({ category, result: "failed" }); }
  }
  for (const item of items) {
    let actual_sha256;
    try {
      actual_sha256 = digest(await readBytes(item.path));
      assert.equal(actual_sha256, item.sha256);
      checks.push({ category: item.category, path: item.path, result: "passed", actual_sha256 });
    } catch (error) {
      errors.push(error);
      checks.push({ category: item.category, path: item.path, result: "failed", ...(actual_sha256 ? { actual_sha256 } : {}) });
    }
  }
  return { checks, errors };
}

export async function consumeJsonResponse(response, { status = 200, code, forbidden = secret, onBody = async () => {} } = {}) {
  const text = await response.text();
  await onBody(text);
  const value = JSON.parse(text);
  assert.equal(text.includes(forbidden), false);
  assert.equal(response.status, status);
  if (code) assert.equal(value?.error?.code, code);
  return value;
}

// Full rows, not a projection that could hide collateral writes. Millisecond
// JSON dates are insufficient: all mutation timestamps use exact PG microseconds.
const snapshotTables = {
  libraries: ["private_libraries", "id", ["revision", "permission_epoch"], ["created_at", "deleted_at"]],
  sources: ["sources", "id", ["settings_revision", "access_policy_revision"], ["deleted_at"]],
  media: ["media_items", "id", ["library_source_generation", "preview_generation"], []],
  policy: ["source_access_policy_snapshots", "source_id", ["revision"], []],
  grants: ["library_grants", "library_id,user_id", [], ["expires_at"]],
  shares: ["room_media_grants", "id", ["permission_epoch", "source_generation"], ["created_at", "expires_at", "revoked_at"]],
  audit: ["library_permission_audit", "id", ["permission_epoch"], ["created_at"]],
  rooms: ["rooms", "id", [], ["created_at"]],
  members: ["room_members", "room_id,user_id", [], []],
  snapshots: ["room_snapshots", "room_id", [], []],
  events: ["room_events", "room_id,revision", [], ["created_at"]],
  scans: ["source_scans", "source_id", [], []],
};
const zeroTables = ["playback_requests", "playback_sessions", "media_jobs", "upstream_reservations", "media_previews"];
export function snapshotSql() {
  const entries = Object.entries(snapshotTables).map(([key, [table, order, counters, times]]) => {
    const extras = [...counters.map((column) => `${quote(column)},r.${column}::text`), ...times.map((column) => `${quote(column)},(extract(epoch FROM r.${column})*1000000)::bigint::text`)];
    const row = `to_jsonb(r)${extras.length ? ` || jsonb_build_object(${extras.join(",")})` : ""}`;
    return `${quote(key)},(SELECT COALESCE(jsonb_agg(${row} ORDER BY ${order.split(",").map((column) => `r.${column}`).join(",")}),'[]'::jsonb) FROM ${table} r)`;
  });
  entries.push(`'zero_work',jsonb_build_object(${zeroTables.map((table) => `${quote(table)},(SELECT count(*)::text FROM ${table})`).join(",")})`);
  return `SELECT jsonb_build_object(${entries.join(",")})`;
}
const row = (state, table, id) => {
  const found = state[table].find((item) => (item.id ?? item.source_id) === id);
  assert.ok(found, "Expected fixture identity exists"); return found;
};
const sortRows = (rows) => rows.sort((a, b) => a.id.localeCompare(b.id));
function libraryAdvance(state, id, permission = false) {
  const lib = row(state, "libraries", id);
  lib.revision = plus(lib.revision);
  if (permission) lib.permission_epoch = plus(lib.permission_epoch);
}
function appendAudit(expected, actual, library, actor, action, target, window) {
  const added = actual.audit.filter((item) => !expected.audit.some((old) => old.id === item.id));
  assert.equal(added.length, 1);
  const item = added[0];
  assert.match(item.id, uuidPattern);
  assertTimeWindow(item.created_at, window);
  const audit = { id: item.id, library_id: library, actor_id: actor, action, target_id: target,
    permission_epoch: row(expected, "libraries", library).permission_epoch, created_at: item.created_at };
  assert.deepEqual(item, audit);
  expected.audit.push(audit); sortRows(expected.audit);
}
function decryptOwnedConfig(fixture, encrypted) {
  const bytes = Buffer.from(encrypted, "base64");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(fixture.env.SOURCE_ENCRYPTION_KEY, "base64"), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"));
}

async function runCases(f, report, signal, external, save) {
  assert.equal(external.http.origin, f.origin, "Startup health and all business requests use the actual owned fixture origin");
  const originalVerify = f.verifyStopped.bind(f);
  f.verifyStopped = async () => { const receipt = await originalVerify(); assertCleanStop(receipt); return receipt; };
  external.fixture_root = f.root;
  report.groups = []; external.groups = report.groups;
  let group, serial = 0;
  function startGroup(index) {
    assert.equal(report.groups.length, index);
    group = { name: requiredGroups[index].name, checks: [] }; report.groups.push(group);
  }
  async function check(name) {
    assert.equal(name, requiredGroups[report.groups.length - 1].checks[group.checks.length]);
    group.checks.push({ name, result: "passed" });
    await save();
  }
  async function privateEvidence(label, value) {
    const path = resolve(f.root, `${String(++serial).padStart(3, "0")}-${label}.private.json`);
    const bytes = JSON.stringify(value, null, 2) + "\n";
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    return { path, sha256: hash(bytes) };
  }
  const snapshot = () => JSON.parse(f.sql(snapshotSql()));
  const now = () => f.sql("SELECT (extract(epoch FROM clock_timestamp())*1000000)::bigint::text");
  async function request(client, path, method = "GET", body, status = 200, code) {
    signal.throwIfAborted();
    const response = await client.raw(path, { method, body });
    // Read before any status, JSON, header, or privacy assertion; failures retain
    // a private body receipt, while safe summaries never contain body/header data.
    const value = await consumeJsonResponse(response, { status, code, onBody: async (text) => {
      external.http.business_bodies_drained++;
      external.last_http = await privateEvidence("http", { status: response.status, body: text });
      await save();
    } });
    if (status === 200 && path.startsWith("/libraries")) assert.equal(response.headers.get("cache-control"), "no-store");
    return value;
  }
  async function transition(label, action, edit = () => {}) {
    report.active_case = label; external.active_case = label;
    const before = snapshot();
    external.last_before = await privateEvidence("before", before); await save();
    const start = now();
    let value;
    const failures = [];
    try { value = await action(); }
    catch (reason) {
      failures.push(reason);
      external.failures.push({ stage: "request", code: failureCategory(reason) });
    }
    let after, window;
    try {
      const end = now(); after = snapshot(); window = { start, end };
      external.last_after = await privateEvidence("after", { window, after }); await save();
    } catch (diagnosticFailure) {
      failures.push(diagnosticFailure);
      external.failures.push({ stage: "after_snapshot_or_evidence", code: failureCategory(diagnosticFailure) });
    }
    if (failures.length) throw combineFailures(failures);
    assertExactState(before, after, (expected) => edit(expected, after, window, value));
    return value;
  }
  const admin = f.client(), owner = f.client(), manager = f.client(), target = f.client(), stranger = f.client();
  await admin.login();
  const users = {};
  for (const [name, client] of [["owner", owner], ["manager", manager], ["target", target], ["stranger", stranger]]) {
    users[name] = (await request(admin, "/users", "POST", { username: `local-mutations-${name}`, password: f.password })).id;
    await client.login(`local-mutations-${name}`);
  }
  const rootPath = (library) => `/libraries/${library}`;
  const rev = (library) => row(snapshot(), "libraries", library).revision;
  const sourceRev = (source) => row(snapshot(), "sources", source).settings_revision;
  const createLibrary = (name) => request(owner, "/libraries", "POST", { name });
  async function grant(library, name, label) {
    return transition(label, () => request(owner, `${rootPath(library)}/grants`, "POST", {
      username: `local-mutations-${name}`, browse: true, play: true, share_to_room: true, manage: true,
      expires_in_hours: 24, expected_revision: rev(library),
    }), (expected, actual, window, value) => {
      libraryAdvance(expected, library, true);
      const granted = actual.grants.find((item) => item.library_id === library && item.user_id === users[name]);
      assert.ok(granted); assertTimeWindow(granted.expires_at, window, 86400000000n);
      expected.grants = expected.grants.filter((item) => item.library_id !== library || item.user_id !== users[name]);
      expected.grants.push({ library_id: library, user_id: users[name], browse: true, play: true, share_to_room: true,
        manage: true, expires_at: granted.expires_at, created_by: users.owner });
      expected.grants.sort((a, b) => a.library_id.localeCompare(b.library_id) || a.user_id.localeCompare(b.user_id));
      appendAudit(expected, actual, library, users.owner, "grant_updated", users[name], window);
      assert.equal(value.revision, row(expected, "libraries", library).revision);
      assert.equal(value.permission_epoch, row(expected, "libraries", library).permission_epoch);
    });
  }
  async function revokeGrant(library, name, label) {
    return transition(label, () => request(owner, `${rootPath(library)}/grants/${users[name]}`, "DELETE", { expected_revision: rev(library) }),
      (expected, actual, window, value) => {
        libraryAdvance(expected, library, true);
        expected.grants = expected.grants.filter((item) => item.library_id !== library || item.user_id !== users[name]);
        appendAudit(expected, actual, library, users.owner, "grant_revoked", users[name], window);
        assert.equal(value.revision, row(expected, "libraries", library).revision);
        assert.equal(value.permission_epoch, row(expected, "libraries", library).permission_epoch);
      });
  }
  async function sourceScope(name) {
    const library = (await createLibrary(name)).id;
    const source = (await request(owner, `${rootPath(library)}/sources`, "POST", {
      name: "Synthetic private HTTP", kind: "http", config: { url: originalUrl, headers: { "X-Fixture": secret } },
    })).id;
    const media = randomUUID();
    f.sql(`INSERT INTO media_items(id,source_id,title,resource,metadata,duration_ms,source_version) VALUES(${quote(media)},${quote(source)},'Synthetic retained identity',${quote(originalUrl)},'{"fixture":"metadata-only"}'::jsonb,1234,'fixture-v1')`);
    return { library, source, media, path: `${rootPath(library)}/sources/${source}` };
  }

  startGroup(0);
  const library = await transition("create_library_receipt", () => createLibrary("Local mutations library"), (expected, actual, window, value) => {
    assert.match(value.id, uuidPattern);
    const created = row(actual, "libraries", value.id); assertTimeWindow(created.created_at, window);
    expected.libraries.push({ id: value.id, name: "Local mutations library", owner_id: users.owner, visibility: "private",
      revision: "1", permission_epoch: "1", created_at: created.created_at, deleted_at: null }); sortRows(expected.libraries);
    appendAudit(expected, actual, value.id, users.owner, "created", null, window);
    assert.equal(value.revision, "1"); assert.equal(value.permission_epoch, "1");
  });
  await check("create_library_receipt");
  await transition("rename_exact_delta", () => request(owner, rootPath(library.id), "PUT", { name: "Renamed owned library", expected_revision: library.revision }),
    (expected, actual, window, value) => {
      libraryAdvance(expected, library.id); row(expected, "libraries", library.id).name = "Renamed owned library";
      appendAudit(expected, actual, library.id, users.owner, "renamed", null, window);
      assert.equal(value.revision, "2"); assert.equal(value.permission_epoch, "1");
    });
  await check("rename_exact_delta");
  await transition("stale_library_cas_unchanged", () => request(owner, rootPath(library.id), "PUT", { name: "Rejected stale", expected_revision: library.revision }, 409, "LIBRARY_CONFLICT"));
  await check("stale_library_cas_unchanged");
  await grant(library.id, "manager", "grant_exact_delta"); await check("grant_exact_delta");
  await transition("manager_cannot_revoke", () => request(manager, `${rootPath(library.id)}/grants/${users.manager}`, "DELETE", { expected_revision: rev(library.id) }, 403, "LIBRARY_OWNER_REQUIRED"));
  await check("manager_cannot_revoke");
  await transition("manager_cannot_transfer", () => request(manager, `${rootPath(library.id)}/transfer`, "POST", { username: "local-mutations-target", expected_revision: rev(library.id) }, 403, "LIBRARY_OWNER_REQUIRED"));
  await check("manager_cannot_transfer");
  await revokeGrant(library.id, "manager", "grant_delete_exact_delta"); await check("grant_delete_exact_delta");
  await grant(library.id, "target", "regrant_exact_delta"); await check("regrant_exact_delta");
  await transition("transfer_exact_delta", () => request(owner, `${rootPath(library.id)}/transfer`, "POST", { username: "local-mutations-target", expected_revision: rev(library.id) }),
    (expected, actual, window, value) => {
      libraryAdvance(expected, library.id, true); row(expected, "libraries", library.id).owner_id = users.target;
      expected.grants = expected.grants.filter((item) => item.library_id !== library.id || ![users.owner, users.target].includes(item.user_id));
      appendAudit(expected, actual, library.id, users.owner, "ownership_transferred", users.target, window);
      assert.deepEqual(value, { id: library.id, owner_id: users.target, transferred: true });
    });
  await check("transfer_exact_delta");
  await transition("old_owner_loses_access", async () => {
    await request(owner, rootPath(library.id), "GET", undefined, 404, "LIBRARY_NOT_FOUND");
    const detail = await request(target, rootPath(library.id)); assert.equal(detail.owner_id, users.target); assert.equal(detail.permissions.manage, true);
  }); await check("old_owner_loses_access");

  startGroup(1);
  const scoped = await sourceScope("Source mutation fixture");
  await grant(scoped.library, "manager", "source_manager_setup");
  const marker = resolve(f.root, "owned-not-media.marker"), markerBytes = Buffer.from("Owned marker bytes: never scan, read as media, or remove.\n");
  await writeFile(marker, markerBytes, { flag: "wx", mode: 0o600 });
  external.marker = { path: marker, sha256: hash(markerBytes) };
  await transition("safe_source_detail", async () => {
    const detail = await request(manager, scoped.path);
    assert.equal(detail.credentials.headers_configured, true); assert.equal(detail.config.url, originalUrl);
    assert.equal(detail.config.headers, undefined); assert.equal(detail.config.token, undefined);
  }); await check("safe_source_detail");
  await transition("no_implicit_admin_or_stranger_access", async () => {
    for (const client of [admin, stranger]) await request(client, scoped.path, "GET", undefined, 404, "LIBRARY_NOT_FOUND");
  }); await check("no_implicit_admin_or_stranger_access");
  const initialSourceRevision = sourceRev(scoped.source);
  await transition("source_rename_exact_delta", () => request(manager, scoped.path, "PATCH", { expected_revision: initialSourceRevision, name: "Renamed private source" }),
    (expected, actual, window, value) => {
      const source = row(expected, "sources", scoped.source); source.name = "Renamed private source"; source.settings_revision = plus(source.settings_revision);
      libraryAdvance(expected, scoped.library); appendAudit(expected, actual, scoped.library, users.manager, "source_updated", scoped.source, window);
      assert.equal(value.config_changed, false); assert.equal(value.rescan_required, false); assert.equal(value.revision, source.settings_revision);
    }); await check("source_rename_exact_delta");
  for (const [label, config] of [["empty_config_semantic_noop", {}], ["same_headers_semantic_noop", { headers: { "X-Fixture": secret } }]]) {
    await transition(label, async () => {
      const revision = sourceRev(scoped.source), value = await request(manager, scoped.path, "PATCH", { expected_revision: revision, config });
      assert.equal(value.config_changed, false); assert.equal(value.rescan_required, false); assert.equal(value.revision, revision);
    }); await check(label);
  }
  await transition("stale_source_cas_unchanged", () => request(manager, scoped.path, "PATCH", { expected_revision: initialSourceRevision, name: "Rejected stale source" }, 409, "SOURCE_CHANGED"));
  await check("stale_source_cas_unchanged");
  await transition("nonadmin_policy_rejected_unchanged", () => request(manager, scoped.path, "PATCH", { expected_revision: sourceRev(scoped.source), config: { access_policy: null } }, 403, "ADMIN_REQUIRED"));
  await check("nonadmin_policy_rejected_unchanged");

  startGroup(2);
  await transition("cross_origin_without_clear_rejected", () => request(manager, scoped.path, "PATCH", { expected_revision: sourceRev(scoped.source), config: { url: changedUrl } }, 400, "SOURCE_CREDENTIALS_ORIGIN_CHANGED"));
  await check("cross_origin_without_clear_rejected");
  function changeCipher(expected, actual, sourceId, mediaId, generationDelta) {
    const source = row(expected, "sources", sourceId), updated = row(actual, "sources", sourceId);
    assertCipherReplacement(source.config_encrypted, updated.config_encrypted);
    source.config_encrypted = updated.config_encrypted;
    source.settings_revision = plus(source.settings_revision); source.access_policy_revision = plus(source.access_policy_revision);
    Object.assign(row(expected, "policy", sourceId), { revision: source.access_policy_revision, config_encrypted: source.config_encrypted });
    const media = row(expected, "media", mediaId);
    media.library_source_generation = plus(media.library_source_generation, generationDelta);
    media.preview_generation = plus(media.preview_generation, generationDelta);
  }
  await transition("config_change_exact_delta", () => request(manager, scoped.path, "PATCH", { expected_revision: sourceRev(scoped.source), config: { url: changedUrl, headers: {} } }),
    (expected, actual, window, value) => {
      const expectedConfig = decryptOwnedConfig(f, row(expected, "sources", scoped.source).config_encrypted);
      Object.assign(expectedConfig, { url: changedUrl, headers: {}, access_policy: {
        schema_version: 1, public_only: true, origins: [{ origin: new URL(changedUrl).origin, cidrs: ["0.0.0.0/0", "::/0"] }],
      } });
      changeCipher(expected, actual, scoped.source, scoped.media, 3);
      Object.assign(row(expected, "media", scoped.media), { resource: changedUrl, metadata: {}, duration_ms: null, source_version: null, available: false });
      libraryAdvance(expected, scoped.library); appendAudit(expected, actual, scoped.library, users.manager, "source_updated", scoped.source, window);
      const decoded = decryptOwnedConfig(f, row(actual, "sources", scoped.source).config_encrypted);
      assert.deepEqual(decoded, expectedConfig, "Only the requested fields and mandated public-origin policy change inside the ciphertext");
      assert.equal(value.config_changed, true); assert.equal(value.rescan_required, true); assert.equal(value.credentials.headers_configured, false);
      assert.equal(value.revision, row(expected, "sources", scoped.source).settings_revision);
    }); await check("config_change_exact_delta");
  await transition("stale_source_delete_unchanged", () => request(manager, scoped.path, "DELETE", { expected_revision: initialSourceRevision, expected_library_revision: rev(scoped.library) }, 409, "SOURCE_CHANGED"));
  await check("stale_source_delete_unchanged");
  await transition("source_delete_exact_delta", () => request(manager, scoped.path, "DELETE", { expected_revision: sourceRev(scoped.source), expected_library_revision: rev(scoped.library) }),
    (expected, actual, window, value) => {
      changeCipher(expected, actual, scoped.source, scoped.media, 1);
      const removed = row(actual, "sources", scoped.source); assertTimeWindow(removed.deleted_at, window);
      row(expected, "sources", scoped.source).deleted_at = removed.deleted_at;
      libraryAdvance(expected, scoped.library); appendAudit(expected, actual, scoped.library, users.manager, "source_deleted", scoped.source, window);
      assert.deepEqual(decryptOwnedConfig(f, removed.config_encrypted), {}); assert.deepEqual(value, { id: scoped.source, deleted: true });
    }); await check("source_delete_exact_delta");
  await transition("source_tombstone_hidden", async () => {
    await request(owner, scoped.path, "GET", undefined, 404, "SOURCE_NOT_FOUND");
    const detail = await request(owner, rootPath(scoped.library)); assert.deepEqual(detail.sources, []);
  }); await check("source_tombstone_hidden");
  // A fresh live source exercises the library's own configuration-retirement
  // path; the previous tombstone must remain byte-identical in the full snapshot.
  const remaining = (await request(owner, `${rootPath(scoped.library)}/sources`, "POST", { name: "Remaining synthetic source", kind: "http", config: { url: originalUrl } })).id;
  const remainingMedia = randomUUID();
  f.sql(`INSERT INTO media_items(id,source_id,title,resource) VALUES(${quote(remainingMedia)},${quote(remaining)},'Retained library identity',${quote(originalUrl)})`);
  await transition("library_delete_exact_delta", () => request(owner, rootPath(scoped.library), "DELETE", { expected_revision: rev(scoped.library) }),
    (expected, actual, window, value) => {
      changeCipher(expected, actual, remaining, remainingMedia, 2);
      const removed = row(actual, "sources", remaining); assertTimeWindow(removed.deleted_at, window);
      row(expected, "sources", remaining).deleted_at = removed.deleted_at;
      row(expected, "media", remainingMedia).available = false;
      libraryAdvance(expected, scoped.library, true);
      const lib = row(actual, "libraries", scoped.library); assertTimeWindow(lib.deleted_at, window);
      row(expected, "libraries", scoped.library).deleted_at = lib.deleted_at;
      expected.grants = expected.grants.filter((item) => item.library_id !== scoped.library);
      appendAudit(expected, actual, scoped.library, users.owner, "library_deleted", null, window);
      assert.deepEqual(decryptOwnedConfig(f, removed.config_encrypted), {}); assert.deepEqual(value, { id: scoped.library, deleted: true });
    }); await check("library_delete_exact_delta");
  await transition("library_tombstone_hidden", async () => {
    for (const client of [owner, manager]) await request(client, rootPath(scoped.library), "GET", undefined, 404, "LIBRARY_NOT_FOUND");
    const listing = await request(owner, "/libraries"); assert.equal(listing.items.some((item) => item.id === scoped.library), false);
  }); await check("library_tombstone_hidden");
  assert.deepEqual(await readFile(marker), markerBytes); await check("owned_marker_bytes_unchanged");

  startGroup(3);
  const sharing = await sourceScope("Room share mutation fixture");
  await grant(sharing.library, "manager", "share_manager_setup");
  const room = (await request(owner, "/rooms", "POST", { name: "Owned metadata shares" })).id;
  f.sql(`INSERT INTO room_members(room_id,user_id) VALUES(${quote(room)},${quote(users.manager)})`);
  async function share(client, grantor) {
    return transition("share_setup_exact_delta", () => request(client, `${rootPath(sharing.library)}/room-shares`, "POST", { room_id: room, media_id: sharing.media, mode: "room_members", expires_in_minutes: 60, expected_revision: rev(sharing.library) }),
      (expected, actual, window, value) => {
        assert.match(value.id, uuidPattern); const created = row(actual, "shares", value.id);
        assertTimeWindow(created.created_at, window); assertTimeWindow(created.expires_at, window, 3600000000n);
        expected.shares.push({ id: value.id, library_id: sharing.library, media_id: sharing.media, source_generation: row(expected, "media", sharing.media).library_source_generation,
          room_id: room, grantor_id: grantor, mode: "room_members", permission_epoch: row(expected, "libraries", sharing.library).permission_epoch,
          expires_at: created.expires_at, revoked_at: null, created_at: created.created_at }); sortRows(expected.shares);
        libraryAdvance(expected, sharing.library); appendAudit(expected, actual, sharing.library, grantor, "room_media_shared", value.id, window);
        assert.equal(value.revision, row(expected, "libraries", sharing.library).revision);
      });
  }
  const first = await share(owner, users.owner), second = await share(owner, users.owner), own = await share(manager, users.manager);
  await check("three_shares_exact_deltas");
  const sharePath = (id) => `${rootPath(sharing.library)}/room-shares/${id}`;
  const expiry = () => Number(BigInt(now()) / 1000n) + 1800000;
  const maxExceeded = Number(BigInt(row(snapshot(), "shares", first.id).created_at) / 1000n) + 86460000;
  await transition("invalid_share_expiry_unchanged", () => request(owner, sharePath(first.id), "PATCH", { mode: "library_members", expires_at: maxExceeded, expected_revision: rev(sharing.library) }, 400, "LIBRARY_SHARE_EXPIRY_INVALID"));
  await check("invalid_share_expiry_unchanged");
  const oldShareRevision = rev(sharing.library), nextExpiry = expiry();
  await transition("share_update_exact_delta", () => request(owner, sharePath(first.id), "PATCH", { mode: "library_members", expires_at: nextExpiry, expected_revision: oldShareRevision }),
    (expected, actual, window, value) => {
      libraryAdvance(expected, sharing.library, true);
      const epoch = row(expected, "libraries", sharing.library).permission_epoch;
      for (const id of [first.id, second.id, own.id]) row(expected, "shares", id).permission_epoch = epoch;
      Object.assign(row(expected, "shares", first.id), { mode: "library_members", expires_at: (BigInt(nextExpiry) * 1000n).toString() });
      appendAudit(expected, actual, sharing.library, users.owner, "room_media_updated", first.id, window);
      assert.deepEqual(value, { id: first.id, revision: row(expected, "libraries", sharing.library).revision });
    }); await check("share_update_exact_delta");
  await transition("stale_share_update_unchanged", () => request(owner, sharePath(first.id), "PATCH", { mode: "room_members", expires_at: expiry(), expected_revision: oldShareRevision }, 409, "LIBRARY_CONFLICT"));
  await check("stale_share_update_unchanged");
  async function revokeShare(label, client, actor, id, preserved) {
    await transition(label, () => request(client, sharePath(id), "DELETE", { expected_revision: rev(sharing.library) }),
      (expected, actual, window, value) => {
        const revoked = row(actual, "shares", id); assertTimeWindow(revoked.revoked_at, window);
        row(expected, "shares", id).revoked_at = revoked.revoked_at;
        libraryAdvance(expected, sharing.library, true);
        for (const current of preserved) row(expected, "shares", current).permission_epoch = row(expected, "libraries", sharing.library).permission_epoch;
        appendAudit(expected, actual, sharing.library, actor, "room_media_revoked", id, window);
        assert.deepEqual(value, { ok: true });
      });
  }
  await revokeShare("share_revoke_exact_delta", owner, users.owner, second.id, [first.id, own.id]); await check("share_revoke_exact_delta");
  await transition("revoked_share_update_unchanged", () => request(owner, sharePath(second.id), "PATCH", { mode: "room_members", expires_at: expiry(), expected_revision: rev(sharing.library) }, 409, "LIBRARY_SHARE_INACTIVE"));
  await check("revoked_share_update_unchanged");
  await revokeGrant(sharing.library, "manager", "grantor_access_revoked"); await check("grantor_access_revoked");
  await transition("issued_share_redacted_after_loss", async () => {
    await request(manager, rootPath(sharing.library), "GET", undefined, 404, "LIBRARY_NOT_FOUND");
    const issued = await request(manager, "/libraries/issued-shares"); assert.equal(issued.items.length, 1);
    const item = issued.items[0]; assert.equal(item.id, own.id); assert.equal(item.title, null); assert.equal(item.active, false); assert.equal(item.revision, rev(sharing.library));
    assert.equal(issued.has_more, false);
  }); await check("issued_share_redacted_after_loss");
  await transition("other_share_revoke_denied", () => request(manager, sharePath(first.id), "DELETE", { expected_revision: rev(sharing.library) }, 404, "LIBRARY_NOT_FOUND"));
  await check("other_share_revoke_denied");
  // The owner share is already stale after grant revocation. Own withdrawal
  // must not revive it, even though its owner still has library authority.
  await revokeShare("lost_grantor_own_revoke_exact_delta", manager, users.manager, own.id, []); await check("lost_grantor_own_revoke_exact_delta");
  const finalState = snapshot();
  assert.deepEqual(finalState.zero_work, Object.fromEntries(zeroTables.map((table) => [table, "0"])));
  assert.deepEqual(finalState.scans, []); assert.deepEqual(await readFile(marker), markerBytes);
  await check("zero_playback_and_provider_work");
  assertChecklist(report.groups);
  // catalogFixture's own fixed report checks are also completed only here.
  report.checks = report.groups.flatMap((entry) => entry.checks.map((item) => ({ name: `${entry.name}/${item.name}`, result: item.result })));
  signal.throwIfAborted();
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.length === 1 && ["--original", "--candidate"].includes(args[0]), "Use --original first, then --candidate with the identical coordinator bytes");
  const phase = args[0].slice(2);
  assert.equal(process.env.DATABASE_URL, undefined);
  for (const name of ["RAINSYNC_ARTIFACT_DIR", "CARGO_TARGET_DIR", "W03_BACKEND_BINDING", "RAINSYNC_NATIVE_POSTGRES_BIN"]) assert.ok(isAbsolute(process.env[name] ?? ""), `Set absolute ${name}`);
  const artifacts = await realpath(process.env.RAINSYNC_ARTIFACT_DIR), repository = await realpath(root);
  const rel = relative(repository, artifacts); assert.ok(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel), "Evidence must be outside checkout");
  assert.notEqual(process.getuid?.(), 0, "Native PostgreSQL must run as non-root");
  const evidence = resolve(artifacts, "private-library-local-mutations-native", phase, randomUUID());
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const path = resolve(evidence, "receipt.json");
  const report = { schema_version: 1, phase, result: "running", started_at: new Date().toISOString(),
    groups: [], failures: [], http: { health_bodies_drained: 0, business_bodies_drained: 0 },
    limitations: ["Finite metadata-only qualification, not 20-entry admission coverage", "No attach/scan, disabled feature, exact-login/lock race, cipher-call-count, COMMIT fault, unknown-COMMIT, retirement-failure or physical media disposal proof", "No playback preparation/publication, provider, worker, NAS, browser, WebSocket, CI, deployment or soak execution"] };
  const save = () => writeFile(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  await save();
  let binding, expectedBackendSource, bindingFiles, artifactItems, inputs, toolsReceipt, fixture;
  const failures = [];
  const previousFetch = globalThis.fetch;
  const inputPaths = [coordinator, "tests/private-library-local-mutations-contract.test.mjs", "docs/PRIVATE_LIBRARY_LOCAL_MUTATIONS_NATIVE.md",
    "tests/fixtures/catalog-evidence.mjs", "tests/fixtures/server.mjs", "tests/fixtures/postgres.mjs", "tests/fixtures/unused-port.mjs", "tests/fixtures/safe-failure.mjs",
    "tests/fixtures/playback-admission.mjs", "scripts/native-owner-binding.mjs", "scripts/bind-native-backend.mjs", "deploy/owned-process.mjs"];
  async function verifyReceipts(phase) {
    const items = [...(bindingFiles ?? []),
      ...(artifactItems ?? []).map((item) => ({ ...item, category: "native_artifact" })),
      ...(inputs ?? []).map((item) => ({ ...item, category: "coordinator_or_helper" })),
      ...(toolsReceipt ?? []).map((item) => ({ ...item, category: "node_or_pg_tool" }))];
    const result = await verifyEveryReceipt({ bindingVerify: async () => {
      assert.ok(binding, "No complete baseline binding was admitted"); await binding.verify();
    }, backendVerify: async () => {
      assert.ok(expectedBackendSource, "No complete backend source set was admitted");
      assert.deepEqual(await backendSnapshot(root), expectedBackendSource);
    }, items });
    report.integrity ??= {};
    report.integrity[phase] = result.checks;
    if (result.errors.length) throw new AggregateError(result.errors, "private_fixture_integrity_failed");
  }
  try {
    binding = await loadOwnerBinding({ root, target: process.env.CARGO_TARGET_DIR, path: process.env.W03_BACKEND_BINDING, requireTest: true });
    const manifest = JSON.parse(await readFile(process.env.W03_BACKEND_BINDING, "utf8"));
    artifactItems = allBoundArtifacts(manifest, process.env.CARGO_TARGET_DIR);
    expectedBackendSource = manifest.source;
    const bindingDigest = hash(await readFile(process.env.W03_BACKEND_BINDING));
    bindingFiles = [
      { category: "binding_bytes", path: process.env.W03_BACKEND_BINDING, sha256: bindingDigest },
      ...manifest.source.map((item) => ({ category: "backend_source", path: resolve(root, item.path), sha256: item.sha256 })),
      ...manifest.producers.map((item) => ({ category: "binding_producer", path: resolve(root, item.path), sha256: item.sha256 })),
    ];
    report.binding = { path: process.env.W03_BACKEND_BINDING, sha256: bindingDigest, source_digest: manifest.source_digest,
      artifacts: artifactItems, executed: ["rainsync-server"], owner_fixture_executed: false };
    inputs = await Promise.all(inputPaths.map(async (file) => ({ path: resolve(root, file), sha256: hash(await readFile(resolve(root, file))) })));
    report.coordinator = inputs;
    const suffix = process.platform === "win32" ? ".exe" : "";
    const pgRoot = await realpath(process.env.RAINSYNC_NATIVE_POSTGRES_BIN);
    toolsReceipt = await Promise.all([
      ["node", process.execPath], ...["initdb", "postgres", "psql", "pg_ctl"].map((name) => [name, resolve(pgRoot, name + suffix)]),
    ].map(async ([name, binary]) => {
      const path = await realpath(binary);
      if (name !== "node") assert.equal(resolve(path, ".."), pgRoot, "Native PG tools must belong to one coherent bin directory");
      return { name, path, sha256: hash(await readFile(path)), version: execFileSync(path, ["--version"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim() };
    }));
    const pgVersions = toolsReceipt.filter((item) => item.name !== "node").map((item) => item.version.match(/\(PostgreSQL\)\s+(\d+(?:\.\d+)*)/)?.[1]);
    assert.ok(pgVersions.every((value) => value && value === pgVersions[0]));
    report.tools = toolsReceipt;
    const worktreeStatus = execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" });
    report.repository = { path: root, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      worktree_clean: worktreeStatus.trim() === "", status_sha256: hash(worktreeStatus) };
    await verifyReceipts("before"); await save();
    globalThis.fetch = guardedFetch(previousFetch, report.http);
    await catalogFixture({ name: `private-library-local-mutations-${phase}`, coordinator, timeout: 180000,
      env: { PRIVATE_LIBRARIES_ENABLED: "true" }, limitations: report.limitations }, async (f, catalogReport, signal) => {
      fixture = f;
      catalogReport.phase = phase; catalogReport.outer_receipt = path;
      // All dedicated inputs participate in the existing final helper recheck.
      catalogReport.coordinator.push(...inputs.filter((item) => !catalogReport.coordinator.some((old) => resolve(root, old.path) === item.path)).map((item) => ({ path: relative(root, item.path), sha256: item.sha256 })));
      await runCases(f, catalogReport, signal, report, save);
    });
    assertChecklist(report.groups);
  } catch (reason) {
    failures.push(reason);
    report.failures.push({ stage: "qualification", code: failureCategory(reason) });
  }
  finally {
    globalThis.fetch = previousFetch;
    if (fixture) {
      try {
        report.cleanup = await fixture.verifyStopped();
        assertCleanStop(report.cleanup);
        const logs = await readFile(resolve(fixture.root, "server-1.log"), "utf8");
        assert.equal(logs.includes(secret), false); report.server_log_secret_absent = true;
        report.marker_unchanged = hash(await readFile(report.marker.path)) === report.marker.sha256;
        assert.equal(report.marker_unchanged, true);
      } catch (reason) { failures.push(reason); report.failures.push("cleanup_or_private_evidence_verification_failed"); }
    }
    try { await verifyReceipts("after"); report.inputs_unchanged = Boolean(binding && bindingFiles && artifactItems && inputs && toolsReceipt); }
    catch (reason) { failures.push(reason); report.failures.push("final_binding_failed"); }
    report.finished_at = new Date().toISOString(); report.result = failures.length ? "failed" : "passed";
    try { await save(); }
    catch (reason) { failures.push(reason); report.result = "failed"; report.failures.push("final_receipt_write_failed"); }
  }
  if (failures.length) throw safeRunFailure(failures, `private library local mutations failed; private evidence retained; safe receipt: ${path}`);
  console.log(`private library local mutations ${phase}: passed ${report.groups.length} groups; ${path}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
