// Confirmed library writes must not become false failures during refresh/retirement.
// Only disposable PostgreSQL, the bound Server, and synthetic metadata are used.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { withPlaybackAdmission, testLoginHash } from "./fixtures/playback-admission.mjs";
import { catalogFixture, holdLibraryDetailProjection } from "./fixtures/catalog-evidence.mjs";

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--reproduce-before"));
const baseline = args.length > 0;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
await catalogFixture({
  name: "private-library-committed-change", coordinator: "tests/private-library-committed-change.mjs",
  baseline, baselineResult: "baseline_false_failures_reproduced", timeout: 180000,
  env: { PRIVATE_LIBRARIES_ENABLED: "true" },
  limitations: ["No remote providers, real media, physical cleanup or unknown-COMMIT transport fault is exercised"],
}, async (f, report, signal) => {
    const admin = f.client(), owner = f.client();
    await admin.login();
    const ownerId = (await admin.request("/users", "POST", { username: "commit-owner", password: f.password })).id;
    const targetId = (await admin.request("/users", "POST", { username: "commit-target", password: f.password })).id;
    await owner.login("commit-owner");
    const revision = (id) => f.sql(`SELECT revision FROM private_libraries WHERE id=${quote(id)}`);
    const sourceRevision = (id) => f.sql(`SELECT settings_revision FROM sources WHERE id=${quote(id)}`);
    const create = (name) => owner.request("/libraries", "POST", { name });
    async function response(name, request, committed, shape) {
      report.active_case = name;
      const raw = await request;
      const value = await raw.json();
      assert.doesNotMatch(JSON.stringify(value), /owned_(?:retirement|refresh|commit)_failure|synthetic-secret/);
      assert.equal(await committed(), true, `${name}: mutation committed`);
      assert.equal(raw.status, baseline ? 500 : 200, `${name}: committed response status`);
      if (!baseline && shape) shape(value);
      report.checks.push({ name, status: raw.status, committed: true });
      return value;
    }
    function detailShape(value) {
      assert.equal(value.owner_id, ownerId);
      assert.equal(value.visibility, "private");
      for (const field of ["sources", "grants", "audit", "room_shares"]) assert.ok(Array.isArray(value[field]), field);
      assert.ok(value.permissions.manage);
      assert.equal(typeof value.revision, "string");
    }
    function installRefreshFault() {
      f.sql(`CREATE TABLE fixture_library_commit(id uuid PRIMARY KEY,write_tx bigint NOT NULL);
        CREATE FUNCTION fixture_record_library_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.name LIKE 'commit-detail-%' THEN INSERT INTO fixture_library_commit VALUES(NEW.id,txid_current()) ON CONFLICT(id) DO UPDATE SET write_tx=EXCLUDED.write_tx; END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER fixture_record_library_commit AFTER INSERT OR UPDATE ON private_libraries FOR EACH ROW EXECUTE FUNCTION fixture_record_library_commit();
        ALTER FUNCTION library_allowed(uuid,uuid,text) RENAME TO fixture_original_library_allowed;
        CREATE FUNCTION library_allowed(principal uuid,library uuid,action text) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$ BEGIN
          IF EXISTS(SELECT 1 FROM fixture_library_commit WHERE id=library AND write_tx<>txid_current()) THEN RAISE EXCEPTION 'owned_refresh_failure'; END IF;
          RETURN fixture_original_library_allowed(principal,library,action); END $$;`);
    }
    function removeRefreshFault() {
      f.sql(`DROP FUNCTION library_allowed(uuid,uuid,text); ALTER FUNCTION fixture_original_library_allowed(uuid,uuid,text) RENAME TO library_allowed;
        DROP TRIGGER fixture_record_library_commit ON private_libraries; DROP FUNCTION fixture_record_library_commit(); DROP TABLE fixture_library_commit;`);
    }
    installRefreshFault();
    try {
      await response("create survives a post-commit-only projection fault", owner.raw("/libraries", { method: "POST", body: { name: "commit-detail-create" } }),
        () => f.sql("SELECT count(*) FROM private_libraries WHERE name='commit-detail-create'") === "1", detailShape);
    } finally { removeRefreshFault(); }
    const renamed = await create("before rename");
    installRefreshFault();
    try {
      await response("rename survives a post-commit-only projection fault", owner.raw(`/libraries/${renamed.id}`, { method: "PUT", body: { name: "commit-detail-rename", expected_revision: renamed.revision } }),
        () => f.sql(`SELECT name FROM private_libraries WHERE id=${quote(renamed.id)}`) === "commit-detail-rename", detailShape);
    } finally { removeRefreshFault(); }

    async function retirementFault(name, request, committed, shape) {
      f.sql(`CREATE FUNCTION fixture_library_retirement_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned_retirement_failure'; END $$;
        CREATE TRIGGER fixture_library_retirement_failure BEFORE UPDATE ON playback_sessions FOR EACH STATEMENT EXECUTE FUNCTION fixture_library_retirement_failure();`);
      try { return await response(name, request(), committed, shape); }
      finally { f.sql("DROP TRIGGER fixture_library_retirement_failure ON playback_sessions; DROP FUNCTION fixture_library_retirement_failure()"); }
    }
    async function scope(name) {
      const lib = await create(name);
      const source = await owner.request(`/libraries/${lib.id}/sources`, "POST", { name: "Synthetic HTTP source", kind: "http", config: { url: "https://media.example.test/fixture.mp4", headers: { "X-Fixture": "synthetic-secret" } } });
      const media = randomUUID();
      f.sql(`INSERT INTO media_items(id,source_id,title,resource) VALUES(${quote(media)},${quote(source.id)},'Owned metadata only','https://media.example.test/fixture.mp4')`);
      const room = await owner.request("/rooms", "POST", { name });
      const share = await owner.request(`/libraries/${lib.id}/room-shares`, "POST", { room_id: room.id, media_id: media, mode: "room_members", expires_in_minutes: 60, expected_revision: revision(lib.id) });
      return { lib: lib.id, source: source.id, media, room: room.id, share: share.id };
    }
    const granting = await scope("grant receipt");
    const session = randomUUID();
    f.sql(`UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}',${quote(JSON.stringify(granting.media))}::jsonb),'{media_generation}','1') WHERE room_id=${quote(granting.room)}`);
    withPlaybackAdmission(f, { client: owner, user: ownerId, room: granting.room, session },
      `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES(${quote(session)},${quote(ownerId)},${quote(granting.room)},${quote(granting.media)},1,${quote(hash(randomUUID()))},'{"owned_fixture":true}'::jsonb,clock_timestamp()+interval '10 minutes')`);
    assert.equal(f.sql(`SELECT playback_library_session_allowed(${quote(session)})`), "t", "positive control starts with valid library authority");
    if (!baseline) {
      f.sql(`CREATE TABLE fixture_library_retirement_ticks(n bigint NOT NULL); INSERT INTO fixture_library_retirement_ticks VALUES(0);
        CREATE FUNCTION fixture_observe_library_retirement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF current_query() LIKE '%NOT playback_library_session_allowed(id)%' THEN UPDATE fixture_library_retirement_ticks SET n=n+1; END IF; RETURN NULL; END $$;
        CREATE TRIGGER fixture_observe_library_retirement BEFORE UPDATE ON playback_sessions FOR EACH STATEMENT EXECUTE FUNCTION fixture_observe_library_retirement();`);
    }
    const authorityState = () => f.sql(`SELECT json_build_object('epoch',l.permission_epoch,'policy',s.access_policy_revision,'source_generation',m.library_source_generation,'preview_generation',m.preview_generation,'encrypted',s.config_encrypted) FROM private_libraries l JOIN sources s ON s.library_id=l.id JOIN media_items m ON m.source_id=s.id WHERE m.id=${quote(granting.media)}`);
    async function metadataControl(name, change) {
      report.active_case = name;
      const before = authorityState();
      const ticks = baseline ? 0 : Number(f.sql("SELECT n FROM fixture_library_retirement_ticks"));
      await change();
      if (!baseline) await f.waitForSql(`SELECT n>${ticks} FROM fixture_library_retirement_ticks`, "t", 8000);
      assert.equal(authorityState(), before, "metadata changes retain credential and permission identities");
      assert.equal(f.sql(`SELECT NOT stopped AND playback_library_session_allowed(id) FROM playback_sessions WHERE id=${quote(session)}`), "t");
      report.checks.push({ name, current_session_retained: true, autonomous_retirement_observed: !baseline });
    }
    try {
      await metadataControl("library rename preserves a valid session", () => owner.request(`/libraries/${granting.lib}`, "PUT", { name: "Grant receipt renamed", expected_revision: revision(granting.lib) }));
      await metadataControl("source rename preserves ciphertext and source authority", () => owner.request(`/libraries/${granting.lib}/sources/${granting.source}`, "PATCH", { name: "Renamed source", expected_revision: sourceRevision(granting.source) }));
      const noOpRevision = sourceRevision(granting.source);
      await metadataControl("semantic source no-op survives a maintenance attempt", () => owner.request(`/libraries/${granting.lib}/sources/${granting.source}`, "PATCH", { expected_revision: noOpRevision, config: {} }));
      assert.equal(sourceRevision(granting.source), noOpRevision, "semantic no-op preserves settings revision too");
    } finally {
      if (!baseline) f.sql("DROP TRIGGER fixture_observe_library_retirement ON playback_sessions; DROP FUNCTION fixture_observe_library_retirement(); DROP TABLE fixture_library_retirement_ticks");
    }
    // Keep another cleanup path failing while the library retry recovers.
    // Statement-level faults work even when no source-policy row needs updating.
    if (!baseline) f.sql(`CREATE FUNCTION fixture_source_retirement_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_query() LIKE 'UPDATE playback_sessions p SET stopped=true FROM media_items m JOIN sources s%' THEN RAISE EXCEPTION 'owned_retirement_failure'; END IF; RETURN NULL; END $$;
      CREATE TRIGGER fixture_source_retirement_failure BEFORE UPDATE ON playback_sessions FOR EACH STATEMENT EXECUTE FUNCTION fixture_source_retirement_failure();`);
    await retirementFault("grant commits with retirement deferred", () => owner.raw(`/libraries/${granting.lib}/grants`, { method: "POST", body: { username: "commit-target", browse: true, play: true, share_to_room: false, manage: false, expires_in_hours: 24, expected_revision: revision(granting.lib) } }),
      () => f.sql(`SELECT count(*) FROM library_grants WHERE library_id=${quote(granting.lib)} AND user_id=${quote(targetId)}`) === "1", detailShape);
    assert.equal(f.sql(`SELECT playback_library_session_allowed(${quote(session)})`), "f", "committed epoch already fences the old session");
    if (!baseline) {
      try {
        await f.waitForSql(`SELECT stopped FROM playback_sessions WHERE id=${quote(session)}`, "t", 8000);
        report.checks.push({ name: "library maintenance recovers while source-policy cleanup is still faulted", retired: true });
      } finally { f.sql("DROP TRIGGER fixture_source_retirement_failure ON playback_sessions; DROP FUNCTION fixture_source_retirement_failure()"); }
    }
    await owner.request(`/libraries/${granting.lib}/room-shares`, "POST", { room_id: granting.room, media_id: granting.media, mode: "room_members", expires_in_minutes: 60, expected_revision: revision(granting.lib) });
    const revokedSession = randomUUID();
    withPlaybackAdmission(f, { client: owner, user: ownerId, room: granting.room, session: revokedSession },
      `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES(${quote(revokedSession)},${quote(ownerId)},${quote(granting.room)},${quote(granting.media)},1,${quote(hash(randomUUID()))},'{"owned_fixture":true}'::jsonb,clock_timestamp()+interval '10 minutes')`);
    assert.equal(f.sql(`SELECT playback_library_session_allowed(${quote(revokedSession)})`), "t");
    await retirementFault("revoke commits with retirement deferred", () => owner.raw(`/libraries/${granting.lib}/grants/${targetId}`, { method: "DELETE", body: { expected_revision: revision(granting.lib) } }),
      () => f.sql(`SELECT count(*) FROM library_grants WHERE library_id=${quote(granting.lib)}`) === "0", detailShape);
    assert.equal(f.sql(`SELECT playback_library_session_allowed(${quote(revokedSession)})`), "f", "real grant revocation immediately fences the prior session");
    if (!baseline) {
      await f.waitForSql(`SELECT stopped FROM playback_sessions WHERE id=${quote(revokedSession)}`, "t", 8000);
      report.checks.push({ name: "autonomous retirement recovers after actual grant revocation", retired: true });
    }
    const removed = await create("remove receipt");
    await retirementFault("library deletion commits with retirement deferred", () => owner.raw(`/libraries/${removed.id}`, { method: "DELETE", body: { expected_revision: revision(removed.id) } }),
      () => f.sql(`SELECT deleted_at IS NOT NULL FROM private_libraries WHERE id=${quote(removed.id)}`) === "t", (value) => assert.deepEqual(value, { id: removed.id, deleted: true }));
    const transferred = await create("transfer receipt");
    await retirementFault("ownership transfer commits with retirement deferred", () => owner.raw(`/libraries/${transferred.id}/transfer`, { method: "POST", body: { username: "commit-target", expected_revision: revision(transferred.id) } }),
      () => f.sql(`SELECT owner_id FROM private_libraries WHERE id=${quote(transferred.id)}`) === targetId, (value) => assert.deepEqual(value, { id: transferred.id, owner_id: targetId, transferred: true }));
    const sharing = await scope("room share receipt");
    await retirementFault("share update commits with retirement deferred", () => owner.raw(`/libraries/${sharing.lib}/room-shares/${sharing.share}`, { method: "PATCH", body: { mode: "library_members", expires_at: Date.now() + 30 * 60 * 1000, expected_revision: revision(sharing.lib) } }),
      () => f.sql(`SELECT mode FROM room_media_grants WHERE id=${quote(sharing.share)}`) === "library_members", (value) => { assert.equal(value.id, sharing.share); assert.equal(value.revision, revision(sharing.lib)); });
    await retirementFault("share revocation commits with retirement deferred", () => owner.raw(`/libraries/${sharing.lib}/room-shares/${sharing.share}`, { method: "DELETE", body: { expected_revision: revision(sharing.lib) } }),
      () => f.sql(`SELECT revoked_at IS NOT NULL FROM room_media_grants WHERE id=${quote(sharing.share)}`) === "t", (value) => assert.deepEqual(value, { ok: true }));
    const changed = await scope("source change receipt");
    await retirementFault("private-source change commits with retirement deferred", () => owner.raw(`/libraries/${changed.lib}/sources/${changed.source}`, { method: "PATCH", body: { expected_revision: sourceRevision(changed.source), config: { url: "https://media.example.test/changed.mp4" } } }),
      () => f.sql(`SELECT available FROM media_items WHERE id=${quote(changed.media)}`) === "f", (value) => { assert.equal(value.id, changed.source); assert.equal(value.config_changed, true); assert.equal(value.rescan_required, true); });
    const sourceRemoved = await scope("source removal receipt");
    await retirementFault("private-source deletion commits with retirement deferred", () => owner.raw(`/libraries/${sourceRemoved.lib}/sources/${sourceRemoved.source}`, { method: "DELETE", body: { expected_revision: sourceRevision(sourceRemoved.source), expected_library_revision: revision(sourceRemoved.lib) } }),
      () => f.sql(`SELECT deleted_at IS NOT NULL FROM sources WHERE id=${quote(sourceRemoved.source)}`) === "t", (value) => assert.deepEqual(value, { id: sourceRemoved.source, deleted: true }));
    const attached = await create("attach receipt");
    const sharedSource = await admin.request("/sources", "POST", { name: "Shared source", kind: "http", config: { url: "https://media.example.test/shared.mp4" } });
    await retirementFault("operator attachment commits with retirement deferred", () => admin.raw(`/libraries/${attached.id}/attach-source`, { method: "POST", body: { source_id: sharedSource.id, expected_revision: revision(attached.id) } }),
      () => f.sql(`SELECT library_id FROM sources WHERE id=${quote(sharedSource.id)}`) === attached.id, (value) => assert.deepEqual(value, { ok: true, library_id: attached.id, source_id: sharedSource.id }));

    // Acceptance-only ordering regressions. The before mode reproduces false
    // post-commit failures; it does not assert this new transaction-local ordering.
    if (!baseline) {
      const waiting = await create("projection wait must roll back");
      const manager = f.client(), independentManagerLogin = f.client();
      await manager.login("commit-target"); await independentManagerLogin.login("commit-target");
      const login = testLoginHash(f, manager);
      const unchanged = () => f.sql(`SELECT json_build_object('name',l.name,'revision',l.revision,'audit_count',(SELECT count(*) FROM library_permission_audit WHERE library_id=l.id)) FROM private_libraries l WHERE l.id=${quote(waiting.id)}`);
      for (const expiry of ["grant", "login"]) {
        signal.throwIfAborted();
        report.active_case = `${expiry} expires during the transaction-local detail projection`;
        await owner.request(`/libraries/${waiting.id}/grants`, "POST", { username: "commit-target", browse: true, play: true, share_to_room: true, manage: true, expires_in_hours: 24, expected_revision: revision(waiting.id) });
        const before = unchanged(), expected = revision(waiting.id);
        const release = await holdLibraryDetailProjection(f, signal);
        try {
          const expired = expiry === "grant"
            ? `SELECT expires_at<=clock_timestamp() FROM library_grants WHERE library_id=${quote(waiting.id)} AND user_id=${quote(targetId)}`
            : `SELECT expires_at<=clock_timestamp() FROM sessions WHERE token_hash=${quote(login)}`;
          f.sql(expiry === "grant"
            ? `UPDATE library_grants SET expires_at=clock_timestamp()+interval '3 seconds' WHERE library_id=${quote(waiting.id)} AND user_id=${quote(targetId)}`
            : `UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE token_hash=${quote(login)}`);
          const pending = manager.raw(`/libraries/${waiting.id}`, { method: "PUT", body: { name: "must not commit", expected_revision: expected } });
          pending.catch(() => {});
          await f.waitForSql("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id,name,kind,access_policy_revision,settings_revision FROM sources WHERE library_id=%'", "1", 8000);
          await f.waitForSql(expired, "t", 8000);
          await release();
          const response = await pending, value = await response.json();
          assert.equal(response.status, expiry === "grant" ? 404 : 401);
          assert.equal(value.error.code, expiry === "grant" ? "LIBRARY_NOT_FOUND" : "SESSION_EXPIRED");
          for (const field of ["name", "permissions", "sources", "grants", "audit", "room_shares"]) assert.equal(value[field], undefined, "denied receipt contains no private projection");
          assert.doesNotMatch(JSON.stringify(value), /synthetic-secret/);
          assert.equal(unchanged(), before, "name, revision and audit must roll back after the projection wait");
          report.checks.push({ name: report.active_case, status: response.status, committed: false, sensitive_projection_returned: false });
        } finally { await release(); }
        if (expiry === "login") {
          const live = await independentManagerLogin.request(`/libraries/${waiting.id}`);
          assert.equal(live.name, "projection wait must roll back");
          assert.equal(live.revision, expected);
          report.checks.push({ name: "independent exact login remains authorized after the denied receipt", verified: true });
        }
      }
    }

    const guarded = await create("unchanged after commit rejection");
    const before = f.sql(`SELECT row_to_json(l) FROM private_libraries l WHERE id=${quote(guarded.id)}`);
    f.sql(`CREATE FUNCTION fixture_library_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${quote(guarded.id)} THEN RAISE EXCEPTION 'owned_commit_failure'; END IF; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER fixture_library_commit_failure AFTER UPDATE ON private_libraries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_library_commit_failure();`);
    try {
      await owner.request(`/libraries/${guarded.id}`, "PUT", { name: "rejected change", expected_revision: revision(guarded.id) }, 500);
      assert.equal(f.sql(`SELECT row_to_json(l) FROM private_libraries l WHERE id=${quote(guarded.id)}`), before);
      report.checks.push({ name: "a rejected COMMIT never creates a success receipt", status: 500, committed: false });
    } finally { f.sql("DROP TRIGGER fixture_library_commit_failure ON private_libraries; DROP FUNCTION fixture_library_commit_failure()"); }
    await owner.request(`/libraries/${guarded.id}`, "PUT", { name: "stale revision", expected_revision: "999999" }, 409);
    assert.equal(f.sql(`SELECT row_to_json(l) FROM private_libraries l WHERE id=${quote(guarded.id)}`), before);
    report.checks.push({ name: "CAS conflict remains a pre-commit failure", status: 409, committed: false });
});
