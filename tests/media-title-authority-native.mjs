// Identical original/candidate assertions; no baseline mode or production hooks.
// Real HTTP + owned native PostgreSQL; synthetic rows, no media/provider I/O.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { catalogFixture } from "./fixtures/catalog-evidence.mjs";
import { testLoginHash } from "./fixtures/playback-admission.mjs";
import { verifyPidAbsent } from "./fixtures/postgres.mjs";

assert.equal(process.argv.length, 2, "this fixture has no baseline special case");
assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, "owned native PostgreSQL required");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const uuid = (value) => { assert.match(value, uuidPattern); return quote(value); };

await catalogFixture({
  name: "media-title-authority-native",
  coordinator: "tests/media-title-authority-native.mjs",
  timeout: 180000,
  env: { PRIVATE_LIBRARIES_ENABLED: "true" },
  limitations: [
    "Owned synthetic private catalog rows and actual title HTTP operations only; no guest, FFmpeg or provider coverage.",
    "The existing coordinator bounds execution at 180 seconds; owned cleanup is still awaited on failure or interruption.",
  ],
}, async (f, report, signal) => {
  assert.equal(f.postgresDiagnostics().kind, "native");
  const progressPath = resolve(f.root, "title-authority-progress.json");
  const phase = async (value) => {
    signal.throwIfAborted();
    report.active_case.phase = value;
    await writeFile(progressPath, JSON.stringify({ active_case: report.active_case, checks: report.checks }, null, 2) + "\n");
  };
  async function check(name, run) {
    report.active_case = { name, phase: "setup", result: "running" };
    await phase("setup");
    const evidence = await run();
    signal.throwIfAborted();
    report.checks.push({ name, result: "passed", ...evidence });
    report.active_case.result = "passed";
    await phase("completed");
    delete report.active_case;
  }
  const abortable = (work, milliseconds = 12000) => new Promise((done, reject) => {
    let timer;
    const finish = (fn, value) => { clearTimeout(timer); signal.removeEventListener("abort", abort); fn(value); };
    const abort = () => finish(reject, signal.reason);
    timer = setTimeout(() => finish(reject, new Error("owned title fixture step deadline")), milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(work).then((value) => finish(done, value), (error) => finish(reject, error));
  });
  async function waitSql(query, expected = "t") {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (f.sql(query) === expected) return;
      await abortable(new Promise((done) => setTimeout(done, 30)), 1000);
    }
    throw new Error("owned title SQL witness deadline");
  }
  // Fixed, fixture-local lock targets. No arbitrary SQL/table framework.
  async function hold(table, id) {
    assert.ok(table === "media_items" || table === "users");
    const marker = `title_authority_${randomUUID().replaceAll("-", "")}`;
    const child = f.sqlProcess(undefined, { interactive: true });
    assert.ok(Number.isInteger(child.pid) && child.pid > 0);
    let output = "", releasePromise;
    const ready = new Promise((done, reject) => {
      child.stdout.on("data", (bytes) => { output += bytes; if (output.includes(marker + "_ready")) done(); });
      child.once("error", reject);
      child.done.then(() => reject(new Error("owned title blocker exited before readiness")), reject);
    });
    // User target models a real uncommitted demotion: request entry sees the old
    // role, while transaction admission waits and then sees the committed role.
    const statement = table === "users"
      ? `UPDATE users SET admin=false WHERE id=${uuid(id)}`
      : `SELECT id FROM media_items WHERE id=${uuid(id)} FOR UPDATE`;
    child.stdin.on("error", () => {}); // child.done remains the authoritative failure.
    child.stdin.write(`BEGIN; SET LOCAL application_name=${quote(marker)}; SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='15s'; ${statement};\n\\echo ${marker}_ready\n`);
    const release = () => {
      if (!releasePromise) releasePromise = (async () => {
        // Cleanup deliberately is not raced against the aborted execution signal.
        child.stdin.end("COMMIT;\n\\q\n");
        let timer;
        try {
          await Promise.race([child.done, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("owned title blocker close deadline")), 12000);
          })]);
        } finally { clearTimeout(timer); }
        assert.equal(child.exitCode, 0, "owned psql committed and exited successfully");
        assert.equal(verifyPidAbsent(child.pid), true, "owned psql PID absent");
      })();
      return releasePromise;
    };
    try { await abortable(ready); }
    catch (error) {
      try { await release(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "owned title blocker setup and release failed"); }
      throw error;
    }
    const prefix = table === "users"
      ? "SELECT admin FROM users WHERE id=%FOR SHARE"
      : "SELECT m.id FROM media_items m JOIN sources s%FOR UPDATE OF m";
    const witness = `SELECT EXISTS(SELECT 1 FROM pg_stat_activity blocked WHERE blocked.wait_event_type='Lock' AND blocked.query LIKE ${quote(prefix)} AND EXISTS(SELECT 1 FROM pg_stat_activity holder WHERE holder.application_name=${quote(marker)} AND holder.pid=ANY(pg_blocking_pids(blocked.pid))))`;
    return { release, witness, pid: child.pid };
  }
  async function lockedRequest(blocker, start, whileWaiting) {
    let pending, failure, value;
    const cleanupErrors = [];
    try {
      await phase("http_pending");
      pending = start(); pending.catch(() => {});
      await waitSql(blocker.witness);
      await phase("blocking_pid_witnessed");
      await whileWaiting();
      await phase("blocker_release");
      await blocker.release();
      await phase("http_response");
      value = await abortable(pending);
    } catch (error) { failure = error; }
    finally {
      try { await blocker.release(); } catch (error) { cleanupErrors.push(error); }
      // Await the actual pending request on every failure/interruption too.
      if (pending && failure) { try { await pending; } catch {} }
    }
    if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "owned title request release failed");
    if (failure) throw failure;
    return value;
  }
  async function denied(response, status, code) {
    const body = await response.json();
    report.active_case.observed = { status: response.status, error_code: body?.error?.code ?? null };
    await phase("denied_response_observed");
    assert.equal(response.status, status);
    assert.equal(body.error.code, code);
    assert.equal(body.title, undefined);
    assert.equal(body.original_title, undefined);
    assert.doesNotMatch(JSON.stringify(body), /Owned private title/);
    return { status: response.status, error_code: body.error.code };
  }
  const owner = f.client(), ownerLive = f.client();
  const ownerId = (await owner.login()).id;
  await ownerLive.login();
  const actorName = "title-authority-viewer", operatorName = "title-authority-operator";
  const actorId = (await owner.request("/users", "POST", { username: actorName, password: f.password })).id;
  const operatorId = (await owner.request("/users", "POST", { username: operatorName, password: f.password })).id;
  f.sql(`UPDATE users SET admin=true WHERE id=${uuid(operatorId)}`);
  const actor = f.client(), actorLive = f.client(), operator = f.client();
  await actor.login(actorName); await actorLive.login(actorName); await operator.login(operatorName);
  function scope(viewer = actorId) {
    const library = randomUUID(), source = randomUUID(), media = randomUUID();
    f.sql(`INSERT INTO private_libraries(id,name,owner_id,visibility) VALUES(${uuid(library)},'Owned title library',${uuid(ownerId)},'private');
      INSERT INTO sources(id,name,kind,config_encrypted,library_id) VALUES(${uuid(source)},'Owned title source','local','owned-unused-cipher',${uuid(library)});
      INSERT INTO media_items(id,source_id,title,resource) VALUES(${uuid(media)},${uuid(source)},'Owned private title','owned-synthetic-title.mp4');
      INSERT INTO library_grants(library_id,user_id,browse,play,manage,expires_at,created_by) VALUES(${uuid(library)},${uuid(viewer)},true,true,true,clock_timestamp()+interval '1 hour',${uuid(ownerId)});`);
    const snapshot = () => f.sql(`SELECT jsonb_build_object('media',to_jsonb(m),'user_titles',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.user_id) FROM media_user_titles t WHERE t.media_id=m.id),'[]'::jsonb))::text FROM media_items m WHERE m.id=${uuid(media)}`);
    return { library, source, media, snapshot, personal: `/media/${media}/personal-title`, shared: `/admin/media/${media}/shared-title`, detail: `/media/${media}` };
  }
  const invalid = { title: "", expected_revision: "-1" };
  const ingress = scope();
  for (const entry of [
    { name: "request login failure precedes invalid title validation", client: f.client(), path: ingress.personal, status: 401, code: "LOGIN_REQUIRED" },
    { name: "shared preliminary administrator failure precedes invalid title validation", client: actor, path: ingress.shared, status: 403, code: "ADMIN_REQUIRED" },
    { name: "request CSRF failure precedes invalid title validation", client: actor, path: ingress.personal, headers: { "x-csrf-token": "owned-bad-csrf" }, status: 403, code: "CSRF_REJECTED" },
    { name: "request Origin failure precedes invalid title validation", client: actor, path: ingress.personal, headers: { Origin: "https://owned-wrong.invalid" }, status: 403, code: "ORIGIN_REJECTED" },
    { name: "Origin failure precedes CSRF failure and invalid title validation", client: actor, path: ingress.personal, headers: { Origin: "https://owned-wrong.invalid", "x-csrf-token": "owned-bad-csrf" }, status: 403, code: "ORIGIN_REJECTED" },
  ]) {
    await check(entry.name, async () => {
      const before = ingress.snapshot(); await phase("http_response");
      const result = await denied(await entry.client.raw(entry.path, { method: "PUT", body: invalid, headers: entry.headers }), entry.status, entry.code);
      await phase("rollback_snapshot"); assert.equal(ingress.snapshot(), before);
      return { ...result, rows_unchanged: true };
    });
  }
  for (const expiry of ["login", "grant", "login_and_grant", "shared_manage_grant"]) {
    await check(`${expiry} expires naturally across witnessed media row lock`, async () => {
      const shared = expiry === "shared_manage_grant";
      const viewer = shared ? operatorId : actorId;
      const client = shared ? operator : actor;
      await client.login(shared ? operatorName : actorName);
      const target = scope(viewer), before = target.snapshot();
      const login = testLoginHash(f, client);
      const blocker = await hold("media_items", target.media);
      try {
        // Set expiries before the request locks these rows; never UPDATE a
        // locked grant to manufacture passage of time.
        if (expiry === "login" || expiry === "login_and_grant")
          f.sql(`UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE token_hash=${quote(login)}`);
        if (expiry !== "login")
          f.sql(`UPDATE library_grants SET expires_at=clock_timestamp()+interval '3 seconds' WHERE library_id=${uuid(target.library)} AND user_id=${uuid(viewer)}`);
        const response = await lockedRequest(blocker,
          () => client.raw(shared ? target.shared : target.personal, { method: "PUT", body: { title: "must roll back", expected_revision: "0" } }),
          async () => {
            await phase("natural_expiry_wait");
            if (expiry === "login" || expiry === "login_and_grant")
              await waitSql(`SELECT expires_at<=clock_timestamp() FROM sessions WHERE token_hash=${quote(login)}`);
            if (expiry !== "login")
              await waitSql(`SELECT expires_at<=clock_timestamp() FROM library_grants WHERE library_id=${uuid(target.library)} AND user_id=${uuid(viewer)}`);
          });
        // The original response projection checks BROWSE before final login
        // admission. When both expire, that earlier read returns 404.
        const loginExpired = expiry === "login";
        const result = await denied(response, loginExpired ? 401 : 404, loginExpired ? "SESSION_EXPIRED" : "MEDIA_NOT_FOUND");
        await phase("rollback_snapshot"); assert.equal(target.snapshot(), before, "media and all title rows unchanged after denied admission");
        await phase("independent_live_control");
        assert.equal((await ownerLive.request(target.detail)).title, "Owned private title");
        // The separate actor login was never expired. Renew only the synthetic
        // grant after the denied request has settled, then prove actual use.
        if (expiry !== "login")
          f.sql(`UPDATE library_grants SET expires_at=clock_timestamp()+interval '1 hour' WHERE library_id=${uuid(target.library)} AND user_id=${uuid(viewer)}`);
        const liveClient = shared ? ownerLive : actorLive;
        assert.equal((await liveClient.request(target.detail)).title, "Owned private title");
        const valid = await liveClient.request(target.personal, "PUT", { title: "valid independent title", expected_revision: "0" });
        assert.equal(valid.title, "valid independent title");
        return { ...result, blocking_pid_witnessed: true, natural_expiry_observed: true, rows_unchanged: true, independent_live_control: true, psql_exit_code: 0, psql_pid_absent: true };
      } finally {
        // Even a setup SQL failure before lockedRequest must release and await.
        await blocker.release();
      }
    });
  }
  await check("committed administrator demotion across witnessed user admission lock rolls back shared title", async () => {
    const target = scope(operatorId), before = target.snapshot();
    const blocker = await hold("users", operatorId);
    try {
      const response = await lockedRequest(blocker,
        () => operator.raw(target.shared, { method: "PUT", body: { title: "must roll back", expected_revision: "0" } }),
        async () => { await phase("demotion_uncommitted_witness"); assert.equal(f.sql(`SELECT admin FROM users WHERE id=${uuid(operatorId)}`), "t"); });
      const result = await denied(response, 403, "ADMIN_REQUIRED");
      await phase("rollback_snapshot"); assert.equal(target.snapshot(), before);
      assert.equal(f.sql(`SELECT admin FROM users WHERE id=${uuid(operatorId)}`), "f");
      await phase("independent_owner_control");
      const value = await ownerLive.request(target.shared, "PUT", { title: "valid owner shared title", expected_revision: "0" });
      assert.equal(value.title, "valid owner shared title");
      return { ...result, blocking_pid_witnessed: true, demotion_committed: true, rows_unchanged: true, independent_live_control: true, psql_exit_code: 0, psql_pid_absent: true };
    } finally {
      await blocker.release();
      f.sql(`UPDATE users SET admin=true WHERE id=${uuid(operatorId)}`);
    }
  });
});
