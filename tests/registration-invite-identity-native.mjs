// Deterministic gaps beyond registration-invites.mjs, on owned native PG/HTTP.
// Preserve original entry-only admin admission; do not require a new final gate.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { nativeOwnerGate } from "./fixtures/native-owner-gate.mjs";
import { testLoginHash } from "./fixtures/playback-admission.mjs";
import { verifyPidAbsent } from "./fixtures/postgres.mjs";

await nativeOwnerGate("registration-invite-identity-native", async (f, { check, signal, report }) => {
  const path = "/admin/registration-invites";
  const admin = f.client();
  const administrator = await admin.login();
  const actorRecord = await admin.request("/users", "POST", {
    username: "invite-entry-actor", password: f.password,
  });
  f.sql(`UPDATE users SET admin=true WHERE id='${actorRecord.id}'`);
  const pendingRequests = [];
  const raw = (client, url, options) => {
    // Track the complete JSON read too, so every issued request settles even
    // when an assertion/lock-witness fails before its response is examined.
    const pending = client.raw(url, options).then(async (response) => ({
      status: response.status,
      cache: response.headers.get("cache-control"),
      type: response.headers.get("content-type"),
      value: await response.json(),
    }));
    pending.catch(() => {});
    pendingRequests.push(pending);
    return pending;
  };
  const decode = (response, expected) => {
    assert.equal(response.status, expected);
    assert.equal(response.cache, "no-store");
    assert.equal(response.type, "application/json");
    return response.value;
  };
  const actor = async () => {
    const client = f.client();
    await client.login("invite-entry-actor", f.password);
    return client;
  };
  const naturalDeadline = (client) => {
    const hash = testLoginHash(f, client);
    f.sql(`UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE token_hash='${hash}'`);
    return { hash, at: f.sql(`SELECT expires_at::text FROM sessions WHERE token_hash='${hash}'`) };
  };
  const waitDeadline = async (deadline) => {
    await f.waitForSql(`SELECT clock_timestamp()>='${deadline.at}'::timestamptz`, "t");
    assert.equal(f.sql(`SELECT expires_at::text FROM sessions WHERE token_hash='${deadline.hash}'`), deadline.at,
      "session expiry passed naturally without an update during the wait");
    signal.throwIfAborted();
  };

  // Exactly two fixture-local lock targets, with the existing sqlProcess done
  // promise and positive native process/database backend exit evidence.
  async function hold(inviteId) {
    if (inviteId !== undefined) assert.match(inviteId, /^[0-9a-f-]{36}$/i);
    const marker = `invite_identity_${randomUUID().replaceAll("-", "")}`;
    const child = f.sqlProcess(undefined, { interactive: true });
    assert.ok(Number.isInteger(child.pid) && child.pid > 0);
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.on("error", () => {}); // child.done is the authoritative failure.
    const statement = inviteId === undefined
      ? "LOCK TABLE registration_invites IN SHARE MODE"
      : `SELECT id FROM registration_invites WHERE id='${inviteId}' FOR UPDATE`;
    child.stdin.write(`BEGIN; SET LOCAL application_name='${marker}'; SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='15s'; ${statement}; SELECT '${marker}';\n`);
    let releasePromise, holderPid;
    const release = () => {
      if (!releasePromise) releasePromise = (async () => {
        let timer;
        try {
          if (child.exitCode === null && child.signalCode === null)
            child.stdin.end("ROLLBACK;\n\\q\n");
          await Promise.race([
            child.done,
            new Promise((_, reject) => { timer = setTimeout(() => reject(Error("owned_invite_blocker_exit_deadline")), 12000); }),
          ]);
          assert.equal(child.exitCode, 0);
          assert.equal(child.signalCode, null);
          assert.equal(verifyPidAbsent(child.pid), true);
          if (holderPid !== undefined)
            await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE pid=${holderPid}`, "0");
        } catch (error) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          await child.done.catch(() => {});
          throw error;
        } finally { clearTimeout(timer); }
      })();
      return releasePromise;
    };
    try {
      await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${marker}' AND state='idle in transaction'`, "1");
      holderPid = Number(f.sql(`SELECT pid FROM pg_stat_activity WHERE application_name='${marker}' AND state='idle in transaction'`));
      assert.ok(Number.isInteger(holderPid) && holderPid > 0);
      signal.throwIfAborted();
    } catch (error) {
      await release();
      throw error;
    }
    return { holderPid, child, release };
  }
  const linked = (prefix, holderPid, blockedPid) => `SELECT count(*) FROM pg_stat_activity blocked
    WHERE blocked.wait_event_type='Lock' AND blocked.query LIKE '${prefix}'
    AND ${holderPid}=ANY(pg_blocking_pids(blocked.pid))${blockedPid === undefined ? "" : ` AND blocked.pid=${blockedPid}`}`;
  const witness = async (prefix, holderPid) => {
    await f.waitForSql(linked(prefix, holderPid), "1");
    const blockedPid = Number(f.sql(`SELECT blocked.pid FROM pg_stat_activity blocked
      WHERE blocked.wait_event_type='Lock' AND blocked.query LIKE '${prefix}'
      AND ${holderPid}=ANY(pg_blocking_pids(blocked.pid))`));
    assert.ok(Number.isInteger(blockedPid) && blockedPid > 0 && blockedPid !== holderPid);
    return blockedPid;
  };
  report.invite_lock_waits = [];
  try {
    // First HTTP create owns its uncommitted batch while its invite INSERT waits.
    // A second same-body HTTP create must wait on that first HTTP transaction,
    // then preserve the explicit ALREADY_CREATED result after natural expiry.
    const client = await actor();
    const body = { batch_id: randomUUID(), count: 2, valid_days: 7, note: "entry race" };
    const blocker = await hold();
    try {
      const deadline = naturalDeadline(client);
      const first = raw(client, path, { method: "POST", body });
      const firstPid = await witness("INSERT INTO registration_invites%", blocker.holderPid);
      const duplicate = raw(client, path, { method: "POST", body });
      const duplicatePid = await witness("INSERT INTO registration_invite_batches%", firstPid);
      await waitDeadline(deadline);
      assert.equal(f.sql(linked("INSERT INTO registration_invites%", blocker.holderPid, firstPid)), "1");
      assert.equal(f.sql(linked("INSERT INTO registration_invite_batches%", firstPid, duplicatePid)), "1");
      await blocker.release();
      const batch = decode(await first, 201);
      assert.equal(batch.items.length, 2);
      assert.equal(decode(await duplicate, 409).error.code, "REGISTRATION_BATCH_ALREADY_CREATED");
      assert.equal(f.sql(`SELECT count(*) FROM registration_invite_batches WHERE id='${body.batch_id}'`), "1");
      assert.equal(f.sql(`SELECT count(*) FROM registration_invites WHERE batch_id='${body.batch_id}'`), "2");
      await client.request(path, "GET", undefined, 401);
      report.invite_lock_waits.push({
        name: "http_duplicate_batch_and_entry_only_create",
        holder_pid: blocker.holderPid, first_pid: firstPid, duplicate_pid: duplicatePid,
        both_actual_blocker_links_verified: true, natural_expiry_verified: true,
        lock_child_pid: blocker.child.pid, lock_child_exit_code: blocker.child.exitCode,
        lock_child_pid_absent: verifyPidAbsent(blocker.child.pid), database_holder_absent: true,
      });
      check("same_body_http_batch_waits_for_winner_and_preserves_entry_only_create_after_natural_expiry");
    } finally { await blocker.release(); }

    // Revoke checks real clock only after its invite lock wait. Used wins over
    // expiry; revoked is idempotent even after expiry; otherwise expiry rejects.
    for (const state of ["used", "unused", "revoked"]) {
      const batch = await admin.request(path, "POST", { batch_id: randomUUID() }, 201);
      const invitation = batch.items[0];
      if (state === "used")
        f.sql(`UPDATE registration_invites SET used_by='${administrator.id}',used_at=clock_timestamp() WHERE id='${invitation.id}'`);
      if (state === "revoked") await admin.request(`${path}/${invitation.id}`, "DELETE");
      const before = f.sql(`SELECT jsonb_build_array(used_by,used_at,revoked_by,revoked_at) FROM registration_invites WHERE id='${invitation.id}'`);
      const client = await actor();
      f.sql(`UPDATE registration_invites SET expires_at=clock_timestamp()+interval '3 seconds' WHERE id='${invitation.id}'`);
      const inviteExpiresAt = f.sql(`SELECT expires_at::text FROM registration_invites WHERE id='${invitation.id}'`);
      const blocker = await hold(invitation.id);
      try {
        // Invite expiry was committed before the row lock. Both deadlines pass
        // naturally while the original revoke transaction waits for that lock.
        const deadline = naturalDeadline(client);
        const pending = raw(client, `${path}/${invitation.id}`, { method: "DELETE" });
        const blockedPid = await witness("SELECT id FROM registration_invites%FOR UPDATE%", blocker.holderPid);
        await waitDeadline(deadline);
        assert.equal(f.sql(`SELECT clock_timestamp()>='${inviteExpiresAt}'::timestamptz`), "t");
        assert.equal(f.sql(`SELECT expires_at::text FROM registration_invites WHERE id='${invitation.id}'`), inviteExpiresAt,
          "invitation expiry passed naturally without a fixture update while waiting");
        assert.equal(f.sql(linked("SELECT id FROM registration_invites%FOR UPDATE%", blocker.holderPid, blockedPid)), "1");
        if (state === "revoked") {
          f.sql(`UPDATE users SET admin=false WHERE id='${actorRecord.id}'`);
          assert.equal(f.sql(`SELECT admin FROM users WHERE id='${actorRecord.id}'`), "f");
        }
        await blocker.release();
        const response = await pending;
        const value = decode(response, state === "revoked" ? 200 : 409);
        if (state === "used") assert.equal(value.error.code, "REGISTRATION_INVITE_ALREADY_USED");
        if (state === "unused") assert.equal(value.error.code, "REGISTRATION_INVITE_INVALID");
        if (state === "revoked") assert.equal(value.status, "revoked");
        assert.equal(f.sql(`SELECT jsonb_build_array(used_by,used_at,revoked_by,revoked_at) FROM registration_invites WHERE id='${invitation.id}'`), before);
        report.invite_lock_waits.push({
          name: `revoke_${state}_real_clock_and_entry_auth`, holder_pid: blocker.holderPid,
          blocked_pid: blockedPid, actual_blocker_link_at_expiry_verified: true,
          natural_session_expiry_verified: true, natural_invite_expiry_verified: true,
          role_demoted_before_release: state === "revoked",
          lock_child_pid: blocker.child.pid, lock_child_exit_code: blocker.child.exitCode,
          lock_child_pid_absent: verifyPidAbsent(blocker.child.pid), database_holder_absent: true,
        });
        check(`revoke_${state}_after_lock_wait_preserves_real_clock_error_priority_and_entry_only_auth`);
      } finally {
        try { await blocker.release(); }
        finally { if (state === "revoked") f.sql(`UPDATE users SET admin=true WHERE id='${actorRecord.id}'`); }
      }
    }
  } finally {
    await Promise.allSettled(pendingRequests);
  }
});
