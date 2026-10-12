// Current profile owner and its HTTP identity boundaries on owned native PG.
// This preserves entry-only authentication, including the existing late-expiry
// write behavior; it does not claim a final transaction authorization gate.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { nativeOwnerGate } from "./fixtures/native-owner-gate.mjs";
import { testLoginHash } from "./fixtures/playback-admission.mjs";
import { verifyPidAbsent } from "./fixtures/postgres.mjs";

await nativeOwnerGate("profile-identity-native", async (f, { check, signal, report }) => {
  const path = "/users/me/profile";
  const admin = f.client();
  await admin.login();
  const username = "profile-owner";
  const created = await admin.request("/users", "POST", {
    username, password: f.password,
  });
  const account = f.client();
  const identity = await account.login(username, f.password);
  assert.equal(identity.id, created.id);
  const before = () => f.sql(`SELECT jsonb_build_array(
    (SELECT username FROM users WHERE id='${identity.id}'),
    (SELECT display_name FROM user_profiles WHERE user_id='${identity.id}'),
    (SELECT version FROM user_avatars WHERE user_id='${identity.id}'))`);
  const decode = async (response, status) => {
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "application/json");
    return response.json();
  };
  const initial = await decode(await account.raw(path, {
    headers: { Origin: "", "x-csrf-token": "" },
  }), 200);
  assert.deepEqual(initial, {
    id: identity.id, username, display_name: username,
    custom_display_name: null, avatar_url: null, avatar_version: null,
  });
  check("account_get_cookie_only_exact_projection_and_private_headers");

  const expired = f.client();
  await expired.login(username, f.password);
  f.sql(`UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second'
    WHERE token_hash='${testLoginHash(f, expired)}'`);
  const badHeaders = { Origin: "https://wrong.invalid", "x-csrf-token": "wrong" };
  const invalidName = { display_name: "x".repeat(51) };
  const cases = [
    { name: "get_no_cookie", client: f.client(), status: 401, code: "LOGIN_REQUIRED" },
    { name: "patch_no_cookie_before_origin_and_name", client: f.client(), method: "PATCH", body: invalidName, headers: badHeaders, status: 401, code: "LOGIN_REQUIRED" },
    { name: "get_expired_cookie", client: expired, status: 401, code: "SESSION_EXPIRED" },
    { name: "patch_expired_before_origin_and_name", client: expired, method: "PATCH", body: invalidName, headers: badHeaders, status: 401, code: "SESSION_EXPIRED" },
    { name: "patch_origin_before_csrf_and_name", client: account, method: "PATCH", body: invalidName, headers: badHeaders, status: 403, code: "ORIGIN_REJECTED" },
    { name: "patch_csrf_before_name", client: account, method: "PATCH", body: invalidName, headers: { "x-csrf-token": "wrong" }, status: 403, code: "CSRF_REJECTED" },
    { name: "patch_invalid_name_after_auth", client: account, method: "PATCH", body: invalidName, status: 400, code: "INVALID_REQUEST" },
    { name: "patch_unknown_field_extractor_before_auth", client: f.client(), method: "PATCH", body: { display_name: "safe", username: "other" }, status: 422, code: "INVALID_REQUEST" },
    { name: "patch_missing_field_extractor_before_auth", client: f.client(), method: "PATCH", body: {}, status: 422, code: "INVALID_REQUEST" },
    { name: "patch_json_limit_before_auth", client: f.client(), method: "PATCH", body: { display_name: "x".repeat(66000) }, status: 413, code: "PAYLOAD_TOO_LARGE" },
  ];
  for (const item of cases) {
    const snapshot = before();
    const value = await decode(await item.client.raw(path, {
      method: item.method, body: item.body, headers: item.headers,
    }), item.status);
    assert.equal(value.error.code, item.code);
    assert.equal(before(), snapshot, "denied request changes no profile identity state");
    check(item.name);
  }

  for (const [input, expected] of [["  昵称😀  ", "昵称😀"], [" \t ", null]]) {
    const value = await decode(await account.raw(path, {
      method: "PATCH", body: { display_name: input },
    }), 200);
    assert.equal(value.custom_display_name, expected);
    assert.equal(value.display_name, expected ?? username);
    assert.equal(value.username, username);
  }
  check("patch_trim_upsert_and_blank_delete_keep_immutable_username");
  await account.request(path, "PATCH", { display_name: "reader projection" });
  const profile = await account.request(path);
  const me = await account.request("/auth/me");
  for (const key of ["id", "username", "display_name", "custom_display_name", "avatar_url", "avatar_version"])
    assert.deepEqual(me[key], profile[key]);
  check("main_me_shared_reader_matches_account_profile");

  // Exercise avatars::metadata through the real delete endpoint without an
  // encoder/browser dependency. A tombstone retains its version, with no URL.
  const operation = randomUUID();
  const avatar = await decode(await account.raw("/users/me/avatar", {
    method: "DELETE", headers: { "If-Match": '\"none\"', "x-avatar-operation-id": operation },
  }), 200);
  assert.deepEqual(avatar, { avatar_url: null, avatar_version: operation });
  assert.equal((await account.request(path)).avatar_version, operation);
  assert.equal((await account.request("/auth/me")).avatar_version, operation);
  check("avatar_metadata_shared_reader_keeps_tombstone_version_and_null_url");

  // Existing scoped-guests also exercises WS CHAT's guest identity reader.
  const settings = await admin.request("/admin/settings");
  await admin.request("/admin/settings", "PATCH", {
    expected_revision: settings.revision, changes: { guests_enabled: true },
  });
  const room = await account.request("/rooms", "POST", { name: "profile guests" });
  await account.request(`/rooms/${room.id}/guest-access`, "PUT", { enabled: true });
  const invite = await account.request(`/rooms/${room.id}/invites`, "POST");
  const guest = f.client();
  const guestIdentity = await guest.request(`/rooms/${room.id}/guest-session`, "POST", {
    token: invite.token, display_name: "guest profile reader",
  }, 201);
  guest.csrf = guestIdentity.csrf;
  const guestMe = await guest.request("/auth/me");
  assert.equal(guestMe.display_name, "guest profile reader");
  assert.equal(guestMe.guest, true);
  for (const method of ["GET", "PATCH"]) {
    const snapshot = before();
    const value = await decode(await guest.raw(path, {
      method, body: method === "PATCH" ? invalidName : undefined,
      headers: badHeaders,
    }), 403);
    // guest_restricted currently normalizes to FORBIDDEN; retain that contract.
    assert.equal(value.error.code, "FORBIDDEN");
    assert.equal(before(), snapshot);
    assert.equal(f.sql(`SELECT count(*) FROM user_profiles WHERE user_id='${guestIdentity.id}'`), "0");
    check(`guest_${method.toLowerCase()}_denied_before_origin_and_name`);
  }
  check("main_me_shared_reader_retains_guest_display_name_without_profile_write_access");

  // Preserve the original entry-only gate across a real natural-expiry wait.
  // A PostgreSQL blocker PID, rather than a global lock count, identifies the
  // exact blocker of this fixture's profile INSERT.
  const late = f.client();
  await late.login(username, f.password);
  const hash = testLoginHash(f, late);
  const held = f.sqlProcess(undefined, { interactive: true });
  held.stdout.resume();
  held.stderr.resume();
  const marker = `profile-entry-only-${randomUUID()}`;
  held.stdin.write(`BEGIN; SET LOCAL application_name='${marker}'; SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='15s'; LOCK TABLE user_profiles IN SHARE MODE; SELECT '${marker}';\n`);
  let releasePromise;
  const release = () => {
    if (!releasePromise) releasePromise = (async () => {
      let timer;
      try {
        if (held.exitCode === null && held.signalCode === null)
          held.stdin.end("ROLLBACK;\n\\q\n");
        await Promise.race([
          held.done,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error("owned_profile_lock_release_timeout")), 12000);
          }),
        ]);
        assert.equal(held.exitCode, 0, "owned psql exited successfully");
        assert.equal(held.signalCode, null);
        assert.equal(verifyPidAbsent(held.pid), true, "owned psql PID absent");
      } catch (error) {
        if (held.exitCode === null && held.signalCode === null) held.kill("SIGTERM");
        await held.done.catch(() => {});
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    return releasePromise;
  };
  let pending;
  try {
    await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${marker}' AND state='idle in transaction'`, "1");
    const holderPid = Number(f.sql(`SELECT pid FROM pg_stat_activity WHERE application_name='${marker}' AND state='idle in transaction'`));
    assert.ok(Number.isInteger(holderPid) && holderPid > 0);
    f.sql(`UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE token_hash='${hash}'`);
    const expiresAt = f.sql(`SELECT expires_at::text FROM sessions WHERE token_hash='${hash}'`);
    signal.throwIfAborted();
    pending = late.raw(path, { method: "PATCH", body: { display_name: "entry-only late write" } });
    pending.catch(() => {});
    const blockedByHolder = `SELECT count(*) FROM pg_stat_activity blocked WHERE blocked.wait_event_type='Lock' AND blocked.query LIKE 'INSERT INTO user_profiles%' AND ${holderPid}=ANY(pg_blocking_pids(blocked.pid))`;
    await f.waitForSql(blockedByHolder, "1");
    const blockedPid = Number(f.sql(`SELECT blocked.pid FROM pg_stat_activity blocked WHERE blocked.wait_event_type='Lock' AND blocked.query LIKE 'INSERT INTO user_profiles%' AND ${holderPid}=ANY(pg_blocking_pids(blocked.pid))`));
    assert.ok(Number.isInteger(blockedPid) && blockedPid > 0);
    assert.notEqual(blockedPid, holderPid);
    await f.waitForSql(`SELECT clock_timestamp()>='${expiresAt}'::timestamptz`, "t");
    assert.equal(f.sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity blocked WHERE blocked.pid=${blockedPid} AND blocked.wait_event_type='Lock' AND ${holderPid}=ANY(pg_blocking_pids(blocked.pid)))`), "t");
    assert.equal(f.sql(`SELECT expires_at::text FROM sessions WHERE token_hash='${hash}'`), expiresAt, "expiry was natural, not changed while waiting");
    signal.throwIfAborted();
    await release();
    await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE pid=${holderPid}`, "0");
    report.profile_expiry_wait = {
      holder_pid: holderPid, blocked_pid: blockedPid,
      admission_and_expiry_blocker_link_verified: true,
      natural_expiry_verified: true, expires_at_unchanged: true,
      lock_child_pid: held.pid, lock_child_exit_code: held.exitCode,
      lock_child_pid_absent: verifyPidAbsent(held.pid), database_holder_absent: true,
    };
    const committed = await decode(await pending, 200);
    assert.equal(committed.custom_display_name, "entry-only late write");
    assert.equal(f.sql(`SELECT display_name FROM user_profiles WHERE user_id='${identity.id}'`), "entry-only late write");
    await late.request(path, "GET", undefined, 401);
    check("existing_entry_only_auth_no_transaction_or_final_session_gate_preserved");
  } finally {
    try { await release(); }
    finally { if (pending) await pending.catch(() => {}); }
  }
});
