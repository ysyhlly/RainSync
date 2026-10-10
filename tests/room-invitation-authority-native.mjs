// Same real assertions on original/candidate. No mode, production hook or timer change.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nativeOwnerGate } from "./fixtures/native-owner-gate.mjs";
import { testLoginHash } from "./fixtures/playback-admission.mjs";
import { verifyPidAbsent } from "./fixtures/postgres.mjs";

assert.equal(process.argv.length, 2, "one original/candidate assertion set");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const uuid = (value) => {
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return quote(value);
};
await nativeOwnerGate("room-invitation-authority-native", async (f, { report, check, signal }) => {
  report.scope = "Registered-account invitation ingress plus three real natural-expiry HTTP/PG boundaries, exact blocking PID correlation and positive owned psql release. No guest/publication/prepare/physical owner drain or complete room-stage claim.";
  report.boundary_cases = [];
  const progress = resolve(f.root, "room-invitation-authority-progress.json");
  async function phase(name) {
    signal.throwIfAborted();
    report.active_case.phase = name;
    await writeFile(progress, JSON.stringify({ active_case: report.active_case, boundary_cases: report.boundary_cases }, null, 2) + "\n");
  }
  async function waitSql(sql) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (f.sql(sql) === "t") return;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw Error("owned invitation boundary witness deadline");
  }
  function bounded(work) {
    return new Promise((done, reject) => {
      let timer;
      const settle = (fn, value) => { clearTimeout(timer); signal.removeEventListener("abort", abort); fn(value); };
      const abort = () => settle(reject, signal.reason);
      timer = setTimeout(() => settle(reject, Error("owned invitation boundary deadline")), 10000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      Promise.resolve(work).then((value) => settle(done, value), (error) => settle(reject, error));
    });
  }
  const admin = f.client(); await admin.login();
  let serial = 0;
  async function person() {
    const username = `invite-boundary-${++serial}`;
    await admin.request("/users", "POST", { username, password: f.password });
    const client = f.client(), live = f.client();
    const id = (await client.login(username)).id;
    await live.login(username);
    return { client, live, id };
  }
  async function subject() {
    const owner = await person();
    const room = await owner.client.request("/rooms", "POST", { name: "Owned invitation boundary" });
    return { owner, room };
  }
  // This local helper has only three fixed owned fixture mutations/locks.
  // Intentional expiry updates commit before the holder begins its lock tx.
  async function holder(kind, room, actor, invitation) {
    assert.ok(["create_exact_session_expiry_final_insert", "create_delegated_permission_expiry_final_insert", "join_invite_expiry_room_wait"].includes(kind));
    const marker = `invitation_boundary_${randomUUID().replaceAll("-", "")}`;
    const child = f.sqlProcess(undefined, { interactive: true });
    assert.ok(Number.isInteger(child.pid) && child.pid > 0);
    let output = "", releasePromise, closeObserved = false, closeCode, closeSignal;
    child.once("close", (code, signal) => { closeObserved = true; closeCode = code; closeSignal = signal; });
    child.stdin.on("error", () => {}); // authoritative child.done retains failure.
    const ready = new Promise((done, reject) => {
      child.stdout.on("data", (bytes) => { output += bytes; if (output.includes(marker + "_ready")) done(); });
      child.once("error", reject);
      child.done.then(() => reject(Error("owned invitation holder closed before ready")), reject);
    });
    const login = testLoginHash(f, actor.client);
    const prepare = kind === "create_exact_session_expiry_final_insert"
      ? `UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE user_id=${uuid(actor.id)} AND token_hash=${quote(login)};`
      : kind === "create_delegated_permission_expiry_final_insert"
        ? `UPDATE room_member_permissions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE room_id=${uuid(room.id)} AND user_id=${uuid(actor.id)};`
        : `UPDATE invites SET expires_at=clock_timestamp()+interval '3 seconds' WHERE id=${uuid(invitation.id)};`;
    const lock = kind === "join_invite_expiry_room_wait"
      ? `SELECT id FROM rooms WHERE id=${uuid(room.id)} FOR NO KEY UPDATE`
      : "LOCK TABLE invites IN SHARE MODE";
    child.stdin.write(`${prepare} BEGIN; SET LOCAL application_name=${quote(marker)}; SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='15s'; ${lock};\n\\echo ${marker}_ready\n`);
    let backend;
    const release = () => {
      if (!releasePromise) releasePromise = (async () => {
        child.stdin.end("COMMIT;\n\\q\n");
        let timer;
        try {
          await Promise.race([child.done, new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error("owned invitation holder close deadline")), 12000);
          })]);
        } finally { clearTimeout(timer); }
        assert.equal(closeObserved, true);
        assert.equal(closeCode, 0);
        assert.equal(closeSignal, null);
        assert.equal(child.exitCode, 0);
        assert.equal(verifyPidAbsent(child.pid), true);
        if (backend) assert.equal(f.sql(`SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${backend})`), "t");
        return { holder_child_pid: child.pid, holder_backend_pid: backend, close_observed: true, exit_code: closeCode, signal: closeSignal, pid_absent: true, backend_pid_absent: Boolean(backend) };
      })();
      return releasePromise;
    };
    try {
      await bounded(ready);
      backend = Number(f.sql(`SELECT pid FROM pg_stat_activity WHERE application_name=${quote(marker)}`));
      assert.ok(Number.isInteger(backend) && backend > 0);
    } catch (error) {
      try { await release(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "owned invitation setup/cleanup failure"); }
      throw error;
    }
    const prefix = kind === "join_invite_expiry_room_wait"
      ? "SELECT lifecycle,lifecycle_epoch FROM rooms WHERE id=%FOR NO KEY UPDATE"
      : "INSERT INTO invites%";
    const blockedWhere = `blocked.wait_event_type='Lock' AND blocked.query LIKE ${quote(prefix)} AND ${backend}=ANY(pg_blocking_pids(blocked.pid)) AND EXISTS(SELECT 1 FROM pg_stat_activity held WHERE held.pid=${backend} AND held.application_name=${quote(marker)})`;
    const witness = `SELECT EXISTS(SELECT 1 FROM pg_stat_activity blocked WHERE ${blockedWhere})`;
    const blockedPidsSql = `SELECT COALESCE(jsonb_agg(blocked.pid ORDER BY blocked.pid),'[]'::jsonb)::text FROM pg_stat_activity blocked WHERE ${blockedWhere}`;
    const expiry = kind === "create_exact_session_expiry_final_insert"
      ? `SELECT expires_at<=clock_timestamp() FROM sessions WHERE user_id=${uuid(actor.id)} AND token_hash=${quote(login)}`
      : kind === "create_delegated_permission_expiry_final_insert"
        ? `SELECT expires_at<=clock_timestamp() FROM room_member_permissions WHERE room_id=${uuid(room.id)} AND user_id=${uuid(actor.id)}`
        : `SELECT expires_at<=clock_timestamp() FROM invites WHERE id=${uuid(invitation.id)}`;
    const expiryValueSql = expiry.replace("SELECT expires_at<=clock_timestamp()", "SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')");
    return { release, witness, blockedPidsSql, blockedWhere, expiry, expiryValueSql,
      holder_backend_pid: backend, holder_child_pid: child.pid, blocked_query: kind === "join_invite_expiry_room_wait" ? "room_lifecycle_for_no_key_update" : "invitation_insert" };
  }
  const ingress = await subject();
  report.active_case = { name: "ingress_policy_before_auth", phase: "setup", result: "running" };
  for (const body of [new TextEncoder().encode("{"), { expires_in_seconds: 1 }]) {
    const response = await ingress.owner.client.raw(`/rooms/${ingress.room.id}/invites`, {
      method: "POST", body, headers: { Cookie: "", Origin: "", "x-csrf-token": "" },
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_REQUEST");
  }
  check("original_policy_parse_validation_precedes_auth");
  const cookieOnly = await ingress.owner.client.request(`/rooms/${ingress.room.id}/invites`, "GET", undefined, 200, { Origin: "", "x-csrf-token": "" });
  assert.deepEqual(cookieOnly, []);
  check("invitation_list_cookie_only_get");
  for (const kind of ["create_exact_session_expiry_final_insert", "create_delegated_permission_expiry_final_insert", "join_invite_expiry_room_wait"]) {
    report.active_case = { name: kind, phase: "setup", result: "running" };
    await phase("setup");
    const { owner, room } = await subject();
    let actor = owner, invitation;
    if (kind !== "create_exact_session_expiry_final_insert") {
      actor = await person();
      invitation = await owner.client.request(`/rooms/${room.id}/invites`, "POST");
      if (kind === "create_delegated_permission_expiry_final_insert") {
        await actor.client.request(`/rooms/${room.id}/join`, "POST", { token: invitation.token });
        await owner.client.request(`/rooms/${room.id}/permissions/${actor.id}`, "PUT", { role: "moderator", permissions: ["invite"], expires_in_seconds: 3600 });
      }
    }
    // Exact intentional expiry fields are excluded; every row and all remaining
    // identity/grant/redemption/state fields must remain byte equal on denial.
    const snapshot = () => f.sql(`SELECT jsonb_build_object('invites',COALESCE((SELECT jsonb_agg(to_jsonb(i)-'expires_at' ORDER BY i.id) FROM invites i WHERE i.room_id=${uuid(room.id)}),'[]'::jsonb),'members',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.user_id) FROM room_members m WHERE m.room_id=${uuid(room.id)}),'[]'::jsonb),'permissions',COALESCE((SELECT jsonb_agg(to_jsonb(p)-'expires_at' ORDER BY p.user_id) FROM room_member_permissions p WHERE p.room_id=${uuid(room.id)}),'[]'::jsonb),'redemptions',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.token_hash,r.user_id) FROM room_invite_redemptions r JOIN invites i USING(token_hash) WHERE i.room_id=${uuid(room.id)}),'[]'::jsonb),'snapshot',(SELECT state FROM room_snapshots WHERE room_id=${uuid(room.id)}))::text`);
    const before = snapshot();
    const block = await holder(kind, room, actor, invitation);
    let pending, failure, response, cleanup, exactExpiry, blockedBackendPid;
    const cleanupErrors = [];
    try {
      // Read and persist the exact committed target column before HTTP starts.
      exactExpiry = f.sql(block.expiryValueSql);
      assert.match(exactExpiry, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      report.active_case.exact_expiry_utc = exactExpiry;
      report.active_case.holder_backend_pid = block.holder_backend_pid;
      report.active_case.holder_child_pid = block.holder_child_pid;
      await phase("http_pending");
      pending = actor.client.raw(`/rooms/${room.id}/${kind === "join_invite_expiry_room_wait" ? "join" : "invites"}`, {
        method: "POST", body: kind === "join_invite_expiry_room_wait" ? { token: invitation.token } : undefined,
      });
      pending.catch(() => {});
      await waitSql(block.witness);
      const blockedPids = JSON.parse(f.sql(block.blockedPidsSql));
      report.active_case.blocked_backend_pids_observed = blockedPids;
      assert.equal(blockedPids.length, 1, "exactly one actual production request is blocked by this holder");
      blockedBackendPid = blockedPids[0];
      assert.ok(Number.isInteger(blockedBackendPid) && blockedBackendPid > 0);
      assert.notEqual(blockedBackendPid, block.holder_backend_pid);
      report.active_case.blocked_backend_pid = blockedBackendPid;
      await phase("exact_blocking_pid_witnessed");
      await waitSql(block.expiry);
      // Time passage is valid only for the same immutable target column and
      // the same live holder -> blocked backend edge observed above.
      assert.equal(f.sql(block.expiryValueSql), exactExpiry, "exact expiry column did not change while pending");
      const stableExpirySql = block.expiry.replace("SELECT expires_at<=clock_timestamp()",
        `SELECT expires_at=${quote(exactExpiry)}::timestamptz AND clock_timestamp()>=${quote(exactExpiry)}::timestamptz`);
      assert.equal(f.sql(stableExpirySql), "t", "database clock reached the originally recorded exact expiry");
      const sameBlockerSql = `SELECT EXISTS(SELECT 1 FROM pg_stat_activity blocked WHERE blocked.pid=${blockedBackendPid} AND ${block.blockedWhere})`;
      assert.equal(f.sql(sameBlockerSql), "t", "same holder still blocks the same request after expiry");
      assert.deepEqual(JSON.parse(f.sql(block.blockedPidsSql)), [blockedBackendPid], "single blocked backend identity remained unchanged");
      report.active_case.expiry_unchanged_at_release = true;
      report.active_case.same_blocker_rechecked_at_release = true;
      await phase("natural_three_second_expiry_observed");
      cleanup = await block.release();
      report.active_case.blocker_cleanup = cleanup;
      response = await bounded(pending);
      const value = await bounded(response.json());
      const status = kind === "create_exact_session_expiry_final_insert" ? 401 : 403;
      const code = kind === "create_exact_session_expiry_final_insert" ? "SESSION_EXPIRED"
        : kind === "create_delegated_permission_expiry_final_insert" ? "CONTROLLER_REQUIRED" : "INVALID_INVITE";
      report.active_case.observed = { status: response.status, error_code: value?.error?.code ?? null };
      await phase("denied_response_observed");
      assert.equal(response.status, status);
      assert.equal(value.error.code, code);
      assert.equal(snapshot(), before, "denial rolls back invite/redemption/membership/grant/snapshot changes");
      await phase("independent_live_login_control");
      assert.equal((await actor.live.request("/auth/me")).id, actor.id);
      assert.ok(Array.isArray(await owner.live.request(`/rooms/${room.id}/invites`, "GET", undefined, 200, { Origin: "", "x-csrf-token": "" })));
      report.boundary_cases.push({ name: kind, result: "passed", status, error_code: code,
        blocked_query: block.blocked_query, exact_blocking_pid_witnessed: true,
        holder_backend_pid: block.holder_backend_pid, holder_child_pid: block.holder_child_pid,
        blocked_backend_pid: blockedBackendPid, exact_expiry_utc: exactExpiry,
        expiry_unchanged_at_release: true, same_blocker_rechecked_at_release: true,
        natural_expiry_observed: true, rows_unchanged: true, independent_live_login_control: true, blocker_cleanup: cleanup });
      check(kind);
      report.active_case.result = "passed";
      await phase("completed");
    } catch (error) { failure = error; }
    finally {
      try {
        cleanup = await block.release();
        report.active_case.blocker_cleanup = cleanup;
      } catch (error) {
        cleanupErrors.push(error);
        report.active_case.blocker_cleanup = { completed: false, code: "owned_blocker_cleanup_unconfirmed",
          holder_backend_pid: block.holder_backend_pid, holder_child_pid: block.holder_child_pid };
      }
      if (pending && failure) { try { await pending; } catch {} }
    }
    if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "owned invitation blocker cleanup failed");
    if (failure) throw failure;
    delete report.active_case;
  }
});
