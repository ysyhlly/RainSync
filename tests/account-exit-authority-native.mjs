// Same boundary assertions on original/candidate; no baseline mode or hooks.
// This gate covers three denied exits only. account-exit.mjs owns actual cleanup.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nativeOwnerGate } from "./fixtures/native-owner-gate.mjs";
import { testLoginHash } from "./fixtures/playback-admission.mjs";
import { verifyPidAbsent } from "./fixtures/postgres.mjs";

assert.equal(process.argv.length, 2, "no baseline mode or alternate expectations");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const uuid = (value) => {
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return quote(value);
};

await nativeOwnerGate("account-exit-authority-native", async (f, { report, check, signal }) => {
  report.scope = "Three actual denied account-exit HTTP operations across exact owned SQL blockers: password revision, locked CSRF and natural session expiry. No success-cleanup, guest, provider, static-HLS publication or physical owner-drain claim.";
  report.boundary_cases = [];
  const progressPath = resolve(f.root, "account-exit-authority-progress.json");
  async function phase(name) {
    signal.throwIfAborted();
    report.active_case.phase = name;
    await writeFile(progressPath, JSON.stringify({ active_case: report.active_case, boundary_cases: report.boundary_cases }, null, 2) + "\n");
  }
  function bounded(work, milliseconds = 10000) {
    return new Promise((done, reject) => {
      let timer;
      const settle = (fn, value) => { clearTimeout(timer); signal.removeEventListener("abort", abort); fn(value); };
      const abort = () => settle(reject, signal.reason);
      timer = setTimeout(() => settle(reject, Error("owned exit boundary step deadline")), milliseconds);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      Promise.resolve(work).then((value) => settle(done, value), (error) => settle(reject, error));
    });
  }
  async function waitSql(statement) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (f.sql(statement) === "t") return;
      await bounded(new Promise((done) => setTimeout(done, 25)), 1000);
    }
    throw Error("owned exit blocking/expiry witness deadline");
  }
  // Fixed local variants, never an arbitrary common SQL/context framework.
  // CSRF UPDATE invokes account_require_active(users FOR SHARE); its retained
  // principal lock blocks the earlier delete principals FOR UPDATE. Therefore
  // this case truthfully witnesses principal wait, not session-query wait.
  async function hold(kind, user, login, replacement) {
    assert.ok(["password_rotation", "csrf_rotation_principal_wait", "login_expiry"].includes(kind));
    const marker = `account_exit_boundary_${randomUUID().replaceAll("-", "")}`;
    const child = f.sqlProcess(undefined, { interactive: true });
    assert.ok(Number.isInteger(child.pid) && child.pid > 0);
    let output = "", releasePromise, closeObserved = false, closeCode, closeSignal;
    child.once("close", (code, signal) => { closeObserved = true; closeCode = code; closeSignal = signal; });
    child.stdin.on("error", () => {}); // child.done still fails authoritatively.
    const ready = new Promise((done, reject) => {
      child.stdout.on("data", (bytes) => { output += bytes; if (output.includes(marker + "_ready")) done(); });
      child.once("error", reject);
      child.done.then(() => reject(Error("owned exit blocker closed before readiness")), reject);
    });
    const statement = kind === "password_rotation"
      ? `UPDATE users SET password_hash=${quote(replacement)} WHERE id=${uuid(user)}`
      : kind === "csrf_rotation_principal_wait"
        ? `UPDATE sessions SET csrf=${quote(replacement)} WHERE user_id=${uuid(user)} AND token_hash=${quote(login)}`
        : `SELECT id FROM users WHERE id=${uuid(user)} FOR UPDATE`;
    // Set the exact three-second expiry before acquiring the principal lock:
    // sessions UPDATE's active-account trigger itself needs users FOR SHARE.
    const preparation = kind === "login_expiry"
      ? `UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE user_id=${uuid(user)} AND token_hash=${quote(login)}; `
      : "";
    child.stdin.write(`${preparation}BEGIN; SET LOCAL application_name=${quote(marker)}; SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='15s'; ${statement};\n\\echo ${marker}_ready\n`);
    const release = () => {
      if (!releasePromise) releasePromise = (async () => {
        child.stdin.end("COMMIT;\n\\q\n");
        let timer;
        try {
          await Promise.race([child.done, new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error("owned exit blocker close deadline")), 12000);
          })]);
        } finally { clearTimeout(timer); }
        assert.equal(closeObserved, true);
        assert.equal(closeCode, 0);
        assert.equal(closeSignal, null);
        assert.equal(child.exitCode, 0);
        assert.equal(verifyPidAbsent(child.pid), true);
        return { process_close_observed: true, exit_code: closeCode, signal: closeSignal, pid_absent: true };
      })();
      return releasePromise;
    };
    try { await bounded(ready); }
    catch (error) {
      try { await release(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "owned exit blocker setup/release failure"); }
      throw error;
    }
    // The holder changes remain uncommitted until after this exact process
    // blocks the production transaction. Ingress reads the old committed value.
    const prefix = "SELECT id,admin,password_hash FROM users WHERE id=%FOR UPDATE";
    const witness = `SELECT EXISTS(SELECT 1 FROM pg_stat_activity blocked WHERE blocked.wait_event_type='Lock' AND blocked.query LIKE ${quote(prefix)} AND EXISTS(SELECT 1 FROM pg_stat_activity holder WHERE holder.application_name=${quote(marker)} AND holder.pid=ANY(pg_blocking_pids(blocked.pid))))`;
    return { release, witness };
  }
  async function acrossBlocker(blocker, client, body, whileBlocked) {
    let pending, response, failure, cleanup;
    const cleanupErrors = [];
    try {
      await phase("http_pending");
      pending = client.raw("/users/me/deletion", { method: "POST", body });
      pending.catch(() => {});
      await waitSql(blocker.witness);
      await phase("blocking_pid_witnessed");
      await whileBlocked();
      await phase("blocker_commit");
      cleanup = await blocker.release();
      response = await bounded(pending);
    } catch (error) { failure = error; }
    finally {
      try { cleanup = await blocker.release(); } catch (error) { cleanupErrors.push(error); }
      if (pending && failure) { try { await pending; } catch {} }
    }
    if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "owned exit request/blocker cleanup failed");
    if (failure) throw failure;
    return { response, cleanup };
  }
  const admin = f.client(); await admin.login();
  for (const kind of ["password_rotation", "csrf_rotation_principal_wait", "login_expiry"]) {
    report.active_case = { name: kind, phase: "setup", result: "running" };
    await phase("setup");
    const username = `exit-boundary-${kind}`;
    await admin.request("/users", "POST", { username, password: f.password, display_name: "Owned unchanged principal" });
    const client = f.client(), liveLogin = f.client();
    const user = (await client.login(username)).id;
    await liveLogin.login(username);
    const login = testLoginHash(f, client);
    const rotatedPassword = `Owned-rotated-${randomUUID()}`;
    const replacement = kind === "password_rotation"
      ? f.legacyPasswordHash(rotatedPassword)
      : kind === "csrf_rotation_principal_wait" ? `owned-csrf-${randomUUID()}` : undefined;
    // Intentional holder mutations are checked separately below. The invariant
    // projection excludes password_hash/csrf/expires_at, never account identity,
    // anonymous naming, session row existence, profile or account_exit records.
    // account_rate_limits are excluded: the original denial spends one attempt
    // in its own already-committed transaction, which this migration preserves.
    const snapshot = () => f.sql(`SELECT jsonb_build_object('user',to_jsonb(u)-'password_hash','profile',(SELECT to_jsonb(p) FROM user_profiles p WHERE p.user_id=u.id),'sessions',COALESCE((SELECT jsonb_agg(to_jsonb(s)-'csrf'-'expires_at' ORDER BY s.token_hash) FROM sessions s WHERE s.user_id=u.id),'[]'::jsonb),'account_exit',(SELECT to_jsonb(e) FROM account_exits e WHERE e.user_id=u.id))::text FROM users u WHERE u.id=${uuid(user)}`);
    const before = snapshot();
    const blocker = await hold(kind, user, login, replacement);
    try {
      const { response, cleanup } = await acrossBlocker(blocker, client,
        { password: f.password, confirmation: "DELETE" }, async () => {
          if (kind === "login_expiry") {
            await phase("natural_exact_login_expiry");
            await waitSql(`SELECT expires_at<=clock_timestamp() FROM sessions WHERE token_hash=${quote(login)} AND user_id=${uuid(user)}`);
          }
        });
      const body = await bounded(response.json());
      report.active_case.observed = { status: response.status, error_code: body?.error?.code ?? null };
      await phase("denied_response_observed");
      const expectedStatus = kind === "csrf_rotation_principal_wait" ? 403 : 401;
      const expectedCode = kind === "password_rotation" ? "INVALID_CREDENTIALS"
        : kind === "csrf_rotation_principal_wait" ? "CSRF_REJECTED" : "SESSION_EXPIRED";
      assert.equal(response.status, expectedStatus);
      assert.equal(body.error.code, expectedCode);
      assert.equal(body.ok, undefined);
      await phase("account_rows_unchanged");
      assert.equal(snapshot(), before, "denied exit retains principal/profile/sessions and creates no exit record");
      if (kind === "password_rotation")
        assert.equal(f.sql(`SELECT password_hash FROM users WHERE id=${uuid(user)}`), replacement);
      if (kind === "csrf_rotation_principal_wait")
        assert.equal(f.sql(`SELECT csrf FROM sessions WHERE user_id=${uuid(user)} AND token_hash=${quote(login)}`), replacement);
      await phase("independent_live_login_control");
      assert.equal((await liveLogin.request("/auth/me")).id, user);
      assert.equal((await liveLogin.request("/users/me/deletion")).can_delete, true);
      if (kind === "password_rotation") {
        const fresh = f.client(); assert.equal((await fresh.login(username, rotatedPassword)).id, user);
      }
      report.boundary_cases.push({ name: kind, result: "passed", status: response.status,
        error_code: body.error.code, blocking_pid_witnessed: true,
        blocked_query: "principals_for_update",
        csrf_rotation_session_query_wait_claimed: false,
        natural_expiry_observed: kind === "login_expiry", invariant_account_rows_unchanged: true,
        independent_live_login_control: true, blocker_cleanup: cleanup });
      check(kind);
      report.active_case.result = "passed";
      await phase("completed");
      delete report.active_case;
    } finally {
      // Covers setup SQL failure and all errors/interruptions before/after HTTP.
      await blocker.release();
    }
  }
});
