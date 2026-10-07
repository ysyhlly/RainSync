// Admitted writes serialize revocation; denied/expired authority never commits.
// Real HTTP and PostgreSQL only, against a new process-owned disposable fixture.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedServer, delay } from "./fixtures/server.mjs";

const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const digest = value => createHash("sha256").update(value).digest("hex");
const root = resolve(import.meta.dirname, "..");
const report = { schema_version: 1, result: "running", checks: [], scope: "Owned latest Server/PostgreSQL source policy/removal and private personal-title authority; no Worker/browser claim" };
let fixture;
async function bounded(work, name, ms = 10000) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out: ${name}`)), ms); })]);
  } finally { clearTimeout(timer); }
}
function tracked(work) {
  const value = { settled: false, work };
  work.then(() => { value.settled = true; }, () => { value.settled = true; });
  return value;
}
async function hold(f, sql) {
  const marker = `authority_lock_${randomUUID().replaceAll("-", "")}`;
  const child = f.sqlProcess(undefined, { interactive: true });
  let output = "";
  const ready = new Promise((resolveReady, reject) => {
    child.stdout.on("data", bytes => { output += bytes; if (output.includes(marker)) resolveReady(); });
    child.once("error", reject);
    child.done.then(() => reject(Error("Lock holder exited before its ready marker")), reject);
  });
  child.stdin.write(`BEGIN; SET LOCAL statement_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='15s'; ${sql};\n\\echo ${marker}\n`);
  try { await bounded(ready, "SQL blocker admission"); }
  catch (failure) { child.stdin.end("ROLLBACK;\n\\q\n"); throw failure; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    child.stdin.end("COMMIT;\n\\q\n");
    await bounded(child.done, "SQL blocker release");
  };
}
async function blocked(f, queryPrefix) {
  await f.waitForSql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE ${quote(`${queryPrefix}%`)})`, "t", 7000);
}
async function status(work, expected) {
  const response = await bounded(work, "HTTP completion");
  const value = await response.json();
  assert.equal(response.status, expected, `HTTP ${response.status}, expected ${expected}; code=${value.error?.code ?? "none"}`);
  return value;
}
function record(name) { report.checks.push({ name, result: "passed" }); }

try {
  await isolatedServer("source-mutation-authority", async f => {
    fixture = f;
    report.binary_sha256 = digest(await readFile(resolve(f.target, process.platform === "win32" ? "rainsync-server.exe" : "rainsync-server")));
    report.coordinator_sha256 = digest(await readFile(new URL(import.meta.url)));
    report.source = await Promise.all(["apps/server/src/admin_settings.rs", "apps/server/src/source_access.rs", "apps/server/src/media.rs", "apps/server/src/media_titles.rs"].map(async path => ({ path, sha256: digest(await readFile(resolve(root, path))) })));
    const admin = f.client();
    const identity = await admin.login();
    const loginHash = client => digest(client.cookie.slice(client.cookie.indexOf("=") + 1));
    async function source(name) {
      return admin.request("/sources", "POST", { name, kind: "http", config: { url: "https://example.test/fixture.mp4" } });
    }
    function requestMutation(sourceId, kind) {
      return kind === "policy"
        ? admin.raw(`/sources/${sourceId}/access-policy`, { method: "POST", body: { expected_revision: 0, policy: { schema_version: 1, origins: [{ origin: "https://example.test", cidrs: ["0.0.0.0/0", "::/0"] }] } } })
        : admin.raw(`/sources/${sourceId}`, { method: "DELETE" });
    }
    const sourceWait = kind => kind === "policy" ? "SELECT kind,config_encrypted,access_policy_revision FROM sources" : "SELECT kind,library_id FROM sources";
    function state(sourceId, kind) {
      return f.sql(kind === "policy" ? `SELECT access_policy_revision FROM sources WHERE id=${quote(sourceId)}` : `SELECT EXISTS(SELECT 1 FROM sources WHERE id=${quote(sourceId)})`);
    }
    for (const kind of ["policy", "remove"]) {
      for (const revocation of ["demotion", "logout"]) {
        report.active_case = `${kind}: admitted ${revocation}`;
        const target = await source(`Admitted ${kind} ${revocation}`);
        const before = state(target.id, kind);
        const release = await hold(f, `SELECT id FROM sources WHERE id=${quote(target.id)} FOR UPDATE`);
        let revoke;
        try {
          const mutation = tracked(requestMutation(target.id, kind));
          await blocked(f, sourceWait(kind));
          assert.equal(mutation.settled, false);
          if (revocation === "demotion") {
            const marker = `authority_demote_${randomUUID().replaceAll("-", "")}`;
            const child = f.sqlProcess(`SET application_name=${quote(marker)}; SET statement_timeout='8s'; UPDATE users SET admin=false WHERE id=${quote(identity.id)}`);
            revoke = tracked(child.done);
            await f.waitForSql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=${quote(marker)} AND wait_event_type='Lock')`, "t", 7000);
          } else {
            revoke = tracked(admin.raw("/auth/logout", { method: "POST" }));
            await blocked(f, "DELETE FROM sessions WHERE token_hash=");
          }
          assert.equal(revoke.settled, false, "revocation must wait behind admitted authority locks");
          assert.equal(state(target.id, kind), before, "source remains unchanged while blocked");
          await release();
          await status(mutation.work, 200);
          if (revocation === "logout") await status(revoke.work, 200);
          else await bounded(revoke.work, "demotion completion");
          assert.equal(state(target.id, kind), kind === "policy" ? "1" : "f");
          record(`${kind}: ${revocation} serializes after admitted write`);
        } finally {
          await release();
          if (revoke) await bounded(revoke.work, "revocation cleanup").catch(() => {});
          f.sql(`UPDATE users SET admin=true WHERE id=${quote(identity.id)}`);
          await admin.login();
        }
      }
      const expiryTarget = await source(`Expired ${kind}`);
      report.active_case = `${kind}: natural session expiry`;
      const before = state(expiryTarget.id, kind), hash = loginHash(admin);
      f.sql(`UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=${quote(hash)}`);
      const releaseExpiry = await hold(f, `SELECT id FROM sources WHERE id=${quote(expiryTarget.id)} FOR UPDATE`);
      try {
        const mutation = requestMutation(expiryTarget.id, kind);
        mutation.catch(() => {});
        await blocked(f, sourceWait(kind));
        await f.waitForSql(`SELECT expires_at<=clock_timestamp() FROM sessions WHERE token_hash=${quote(hash)}`, "t", 7000);
        await releaseExpiry();
        await status(mutation, 401);
        assert.equal(state(expiryTarget.id, kind), before);
        record(`${kind}: natural session expiry during source wait rolls back`);
      } finally { await releaseExpiry(); await admin.login(); }

      const deniedTarget = await source(`Logged out before admission ${kind}`);
      report.active_case = `${kind}: logout before admission`;
      const deniedBefore = state(deniedTarget.id, kind);
      const releaseUser = await hold(f, `SELECT id FROM users WHERE id=${quote(identity.id)} FOR UPDATE`);
      try {
        const mutation = requestMutation(deniedTarget.id, kind);
        mutation.catch(() => {});
        await blocked(f, "SELECT admin FROM users WHERE id=");
        await admin.request("/auth/logout", "POST");
        await releaseUser();
        await status(mutation, 401);
        assert.equal(state(deniedTarget.id, kind), deniedBefore);
        record(`${kind}: logout before login lock rejects queued write`);
      } finally { await releaseUser(); await admin.login(); }
    }

    const principal = await admin.request("/users", "POST", { username: "authority-member", password: f.password });
    const member = f.client();
    await member.login("authority-member", f.password);
    const library = await admin.request("/libraries", "POST", { name: "Authority private library" });
    const privateSource = await admin.request(`/libraries/${library.id}/sources`, "POST", { name: "Private title source", kind: "http", config: { url: "https://example.test/private.mp4" } });
    async function grant() {
      f.sql(`INSERT INTO library_grants(library_id,user_id,browse,play,manage,expires_at,created_by) VALUES(${quote(library.id)},${quote(principal.id)},true,true,false,clock_timestamp()+interval '1 hour',${quote(identity.id)}) ON CONFLICT(library_id,user_id) DO UPDATE SET expires_at=excluded.expires_at,browse=true,play=true`);
    }
    function media() {
      const id = randomUUID();
      f.sql(`INSERT INTO media_items(id,source_id,resource,title) VALUES(${quote(id)},${quote(privateSource.id)},'https://example.test/private.mp4','Synthetic title fixture')`);
      return id;
    }
    const titleCount = id => f.sql(`SELECT count(*) FROM media_user_titles WHERE user_id=${quote(principal.id)} AND media_id=${quote(id)}`);
    const rename = id => member.raw(`/media/${id}/personal-title`, { method: "PUT", body: { title: "admitted-personal-title", expected_revision: "0" } });
    await grant();
    report.active_case = "title: revocation after media wait";
    const admitted = media();
    const releaseMedia = await hold(f, `SELECT id FROM media_items WHERE id=${quote(admitted)} FOR UPDATE`);
    let revokeGrant;
    try {
      const mutation = tracked(rename(admitted));
      await blocked(f, "SELECT m.id FROM media_items m JOIN sources s ON s.id=m.source_id WHERE");
      const marker = `authority_revoke_${randomUUID().replaceAll("-", "")}`;
      const child = f.sqlProcess(`SET application_name=${quote(marker)}; SET statement_timeout='8s'; DELETE FROM library_grants WHERE library_id=${quote(library.id)} AND user_id=${quote(principal.id)}`);
      revokeGrant = tracked(child.done);
      await f.waitForSql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=${quote(marker)} AND wait_event_type='Lock')`, "t", 7000);
      assert.equal(revokeGrant.settled, false);
      assert.equal(titleCount(admitted), "0");
      await releaseMedia();
      const body = await status(mutation.work, 200);
      assert.equal(body.personal_title, "admitted-personal-title", "response snapshot survives later revocation");
      await bounded(revokeGrant.work, "grant revocation completion");
      assert.equal(titleCount(admitted), "1");
      assert.equal(f.sql(`SELECT library_media_allowed(${quote(principal.id)},${quote(admitted)},'browse',NULL)`), "f");
      record("title: revocation serializes after admitted write and response remains 200");
    } finally { await releaseMedia(); if (revokeGrant) await bounded(revokeGrant.work, "grant cleanup").catch(() => {}); }

    await grant();
    report.active_case = "title: natural grant expiry";
    const expired = media();
    f.sql(`UPDATE library_grants SET expires_at=clock_timestamp()+interval '2 seconds' WHERE library_id=${quote(library.id)} AND user_id=${quote(principal.id)}`);
    const releaseExpired = await hold(f, `SELECT id FROM media_items WHERE id=${quote(expired)} FOR UPDATE`);
    try {
      const mutation = rename(expired);
      mutation.catch(() => {});
      await blocked(f, "SELECT m.id FROM media_items m JOIN sources s ON s.id=m.source_id WHERE");
      await f.waitForSql(`SELECT expires_at<=clock_timestamp() FROM library_grants WHERE library_id=${quote(library.id)} AND user_id=${quote(principal.id)}`, "t", 7000);
      await releaseExpired();
      await status(mutation, 404);
      assert.equal(titleCount(expired), "0", "expired grant cannot commit a title before returning 404");
      record("title: natural grant expiry during media wait returns 404 without write");
    } finally { await releaseExpired(); }

    await grant();
    report.active_case = "title: revocation before admission";
    const denied = media();
    const releaseTitleUser = await hold(f, `SELECT id FROM users WHERE id=${quote(principal.id)} FOR UPDATE`);
    try {
      const mutation = rename(denied);
      mutation.catch(() => {});
      await blocked(f, "SELECT admin FROM users WHERE id=");
      f.sql(`DELETE FROM library_grants WHERE library_id=${quote(library.id)} AND user_id=${quote(principal.id)}`);
      await releaseTitleUser();
      await status(mutation, 404);
      assert.equal(titleCount(denied), "0");
      record("title: grant revoked before admission rejects queued write");
    } finally { await releaseTitleUser(); }
    const preRevoked = media();
    report.active_case = "title: already revoked grant";
    await status(rename(preRevoked), 404);
    assert.equal(titleCount(preRevoked), "0");
    record("title: already revoked grant rejects without mutation");
  }, { env: { PRIVATE_LIBRARIES_ENABLED: "true" } });
  report.result = "passed";
  delete report.active_case;
} catch (failure) {
  report.result = "failed";
  report.error = failure instanceof Error ? failure.message : String(failure);
  process.exitCode = 1;
} finally {
  if (fixture) {
    try { report.cleanup = await fixture.verifyStopped(); }
    catch (failure) { report.cleanup_error = failure.message; report.result = "failed"; process.exitCode = 1; }
  }
  if (process.env.RAINSYNC_ARTIFACT_DIR) await writeFile(resolve(process.env.RAINSYNC_ARTIFACT_DIR, "source-mutation-authority.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
