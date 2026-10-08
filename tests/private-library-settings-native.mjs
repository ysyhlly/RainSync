// Private settings/deletion authority matrix against an owned disposable server.
// No production DB, remote source I/O or user media is used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { isolatedServer } from "./fixtures/server.mjs";
import { withPlaybackAdmission } from "./fixtures/playback-admission.mjs";

await isolatedServer(
  "private-library-settings",
  async (f) => {
    const admin = f.client(),
      owner = f.client(),
      manager = f.client(),
      stranger = f.client();
    const adminIdentity = await admin.login();
    const users = {};
    for (const name of [
      "settings-owner",
      "settings-manager",
      "settings-stranger",
    ])
      users[name] = (
        await admin.request("/users", "POST", {
          username: name,
          password: f.password,
        })
      ).id;
    await owner.login("settings-owner", f.password);
    await manager.login("settings-manager", f.password);
    await stranger.login("settings-stranger", f.password);
    const lib = await owner.request("/libraries", "POST", {
      name: "Private settings",
    });
    const root = `/libraries/${lib.id}`;
    const source = (
      await owner.request(`${root}/sources`, "POST", {
        name: "Private HTTP",
        kind: "http",
        config: {
          url: "https://fixture.example/movie.mp4",
          headers: { Authorization: "synthetic-secret-never-returned" },
        },
      })
    ).id;
    const sourcePath = `${root}/sources/${source}`;
    const media = randomUUID();
    f.sql(
      `INSERT INTO media_items(id,source_id,title,resource) VALUES('${media}','${source}','History identity','https://fixture.example/movie.mp4')`,
    );
    const original = `${f.root}/original-owned-fixture.mp4`;
    await writeFile(original, "original bytes must remain untouched");
    let detail = await owner.request(root);
    await owner.request(`${root}/grants`, "POST", {
      username: "settings-manager",
      browse: true,
      play: true,
      share_to_room: true,
      manage: true,
      expires_in_hours: 24,
      expected_revision: detail.revision,
    });
    detail = await owner.request(root);
    await manager.request(
      root,
      "DELETE",
      { expected_revision: detail.revision },
      403,
    );
    await stranger.request(
      root,
      "DELETE",
      { expected_revision: detail.revision },
      404,
    );
    await admin.request(root, "GET", undefined, 404);
    await stranger.request(sourcePath, "GET", undefined, 404);
    let settings = await manager.request(sourcePath);
    assert.equal(settings.credentials.headers_configured, true);
    assert.equal(
      JSON.stringify(settings).includes("synthetic-secret-never-returned"),
      false,
    );
    async function expiresDuringSourceWait(method, body) {
      const marker = `private_settings_lock_${randomUUID().replaceAll("-", "")}`;
      const holder = f.sqlProcess(
        `SET application_name='${marker}'; BEGIN; SELECT id FROM sources WHERE id='${source}' FOR UPDATE; SELECT pg_sleep(30); COMMIT;`,
      );
      await f.waitForSql(
        `SELECT count(*) FROM pg_stat_activity WHERE application_name='${marker}' AND wait_event='PgSleep'`,
        "1",
      );
      const release = async () => {
        f.sql(
          `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name='${marker}'`,
        );
        await holder.done.catch(() => {});
      };
      try {
        const request = manager.request(sourcePath, method, body, 404);
        request.catch(() => {});
        await f.waitForSql(
          "SELECT count(*)>=1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT * FROM sources WHERE id=$1 AND library_id=$2%'",
          "t",
        );
        f.sql(
          `UPDATE library_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE library_id='${lib.id}' AND user_id='${users["settings-manager"]}'`,
        );
        await release();
        await request;
        assert.equal(
          f.sql(
            `SELECT name || ':' || (deleted_at IS NULL) FROM sources WHERE id='${source}'`,
          ),
          "Private HTTP:true",
        );
      } finally {
        await release();
        f.sql(
          `UPDATE library_grants SET expires_at=clock_timestamp()+interval '24 hours' WHERE library_id='${lib.id}' AND user_id='${users["settings-manager"]}'`,
        );
      }
    }
    await expiresDuringSourceWait("GET");
    await expiresDuringSourceWait("PATCH", {
      expected_revision: settings.revision,
      name: "Denied after expiry",
    });
    await expiresDuringSourceWait("DELETE", {
      expected_revision: settings.revision,
      expected_library_revision: detail.revision,
    });
    const epoch = f.sql(
      `SELECT permission_epoch FROM private_libraries WHERE id='${lib.id}'`,
    );
    settings = await manager.request(sourcePath, "PATCH", {
      name: "Renamed private HTTP",
      expected_revision: settings.revision,
    });
    assert.equal(settings.config_changed, false);
    assert.equal(settings.credentials.headers_configured, true);
    assert.equal(
      f.sql(
        `SELECT permission_epoch FROM private_libraries WHERE id='${lib.id}'`,
      ),
      epoch,
    );
    await manager.request(
      sourcePath,
      "PATCH",
      { name: "stale", expected_revision: "1" },
      409,
    );
    await manager.request(
      sourcePath,
      "PATCH",
      { config: { access_policy: null }, expected_revision: settings.revision },
      403,
    );
    await manager.request(
      sourcePath,
      "PATCH",
      {
        config: { url: "https://untrusted.example/movie.mp4" },
        expected_revision: settings.revision,
      },
      400,
    );
    // Explicit clearing is necessary to carry a connection to another origin.
    settings = await manager.request(sourcePath, "PATCH", {
      config: { url: "https://other.example/movie.mp4", headers: {} },
      expected_revision: settings.revision,
    });
    assert.equal(settings.credentials.headers_configured, false);
    assert.equal(settings.rescan_required, true);
    assert.equal(
      f.sql(
        `SELECT id || ':' || available FROM media_items WHERE source_id='${source}'`,
      ),
      `${media}:false`,
    );
    assert.equal(
      f.sql(`SELECT resource FROM media_items WHERE id='${media}'`),
      "https://other.example/movie.mp4",
    );
    f.sql(`UPDATE media_items SET available=true WHERE id='${media}'`);

    const room = (
      await owner.request("/rooms", "POST", { name: "Share settings" })
    ).id;
    f.sql(
      `INSERT INTO room_members(room_id,user_id) VALUES('${room}','${users["settings-manager"]}')`,
    );
    const share = async () => {
      detail = await owner.request(root);
      return owner.request(`${root}/room-shares`, "POST", {
        room_id: room,
        media_id: media,
        mode: "room_members",
        expires_in_minutes: 60,
        expected_revision: detail.revision,
      });
    };
    const first = await share(),
      second = await share();
    detail = await owner.request(root);
    const current = detail.room_shares.find((item) => item.id === first.id);
    await owner.request(
      `${root}/room-shares/${first.id}`,
      "PATCH",
      {
        mode: "library_members",
        expires_at: current.max_expires_at + 60_000,
        expected_revision: detail.revision,
      },
      400,
    );
    await owner.request(`${root}/room-shares/${first.id}`, "PATCH", {
      mode: "library_members",
      expires_at: Date.now() + 30 * 60_000,
      expected_revision: detail.revision,
    });
    const updated = await owner.request(root);
    assert.equal(
      updated.room_shares.find((item) => item.id === first.id).mode,
      "library_members",
    );
    assert.equal(
      updated.room_shares.find((item) => item.id === first.id).active,
      true,
    );
    assert.equal(
      updated.room_shares.find((item) => item.id === second.id).active,
      true,
      "editing one share does not invalidate another current share",
    );
    assert.equal(
      BigInt(updated.permission_epoch),
      BigInt(detail.permission_epoch) + 1n,
    );
    await owner.request(
      `${root}/room-shares/${first.id}`,
      "PATCH",
      {
        mode: "room_members",
        expires_at: Date.now() + 60_000,
        expected_revision: detail.revision,
      },
      409,
    );
    await owner.request(`${root}/room-shares/${second.id}`, "DELETE", {
      expected_revision: updated.revision,
    });
    detail = await owner.request(root);
    await owner.request(
      `${root}/room-shares/${second.id}`,
      "PATCH",
      {
        mode: "room_members",
        expires_at: Date.now() + 60_000,
        expected_revision: detail.revision,
      },
      409,
    );

    // A manager can delete source configuration but never promote its media to shared scope.
    settings = await manager.request(sourcePath);
    await manager.request(
      sourcePath,
      "DELETE",
      { expected_revision: "1", expected_library_revision: detail.revision },
      409,
    );
    const sourceCiphertext = f.sql(
      `SELECT config_encrypted FROM sources WHERE id='${source}'`,
    );
    await manager.request(sourcePath, "DELETE", {
      expected_revision: settings.revision,
      expected_library_revision: detail.revision,
    });
    assert.equal(
      f.sql(
        `SELECT library_id || ':' || (deleted_at IS NOT NULL) FROM sources WHERE id='${source}'`,
      ),
      `${lib.id}:true`,
    );
    assert.notEqual(
      f.sql(`SELECT config_encrypted FROM sources WHERE id='${source}'`),
      sourceCiphertext,
    );
    assert.equal(
      f.sql(
        `SELECT source_id || ':' || available FROM media_items WHERE id='${media}'`,
      ),
      `${source}:false`,
    );
    assert.equal(
      f.sql(
        `SELECT library_media_allowed('${users["settings-owner"]}','${media}','play',NULL)`,
      ),
      "f",
    );
    assert.throws(
      () => f.sql(`UPDATE media_items SET available=true WHERE id='${media}'`),
      /source_deleted/,
    );
    assert.throws(
      () =>
        f.sql(
          `UPDATE sources SET library_id='00000000-0000-0000-0000-000000000001' WHERE id='${source}'`,
        ),
      /source_deleted/,
    );
    await owner.request(sourcePath, "GET", undefined, 404);
    assert.equal((await owner.request(root)).sources.length, 0);
    assert.equal(
      (await admin.request("/sources")).some((item) => item.id === source),
      false,
    );
    await owner.request(`${sourcePath}/scan`, "POST", { restart: true }, 404);

    const liveSource = (
      await owner.request(`${root}/sources`, "POST", {
        name: "Remaining source",
        kind: "http",
        config: { url: "https://fixture.example/another.mp4" },
      })
    ).id;
    const liveMedia = randomUUID();
    f.sql(
      `INSERT INTO media_items(id,source_id,title,resource) VALUES('${liveMedia}','${liveSource}','Retained movie','https://fixture.example/another.mp4')`,
    );
    detail = await owner.request(root);
    await owner.request(root, "DELETE", { expected_revision: "1" }, 409);
    await owner.request(root, "DELETE", { expected_revision: detail.revision });
    await owner.request(root, "GET", undefined, 404);
    await manager.request(root, "GET", undefined, 404);
    assert.equal(
      (await owner.request("/libraries")).items.some(
        (item) => item.id === lib.id,
      ),
      false,
    );
    assert.equal(
      f.sql(
        `SELECT count(*) FROM private_libraries WHERE id='${lib.id}' AND deleted_at IS NOT NULL`,
      ),
      "1",
    );
    assert.equal(
      f.sql(
        `SELECT count(*) FROM sources WHERE library_id='${lib.id}' AND deleted_at IS NOT NULL`,
      ),
      "2",
    );
    assert.equal(
      f.sql(
        `SELECT count(*) FROM library_permission_audit WHERE library_id='${lib.id}' AND action='library_deleted'`,
      ),
      "1",
    );
    assert.equal(
      f.sql(`SELECT count(*) FROM library_grants WHERE library_id='${lib.id}'`),
      "0",
    );
    assert.equal(
      f.sql(
        `SELECT library_allowed('${users["settings-owner"]}','${lib.id}','manage')`,
      ),
      "f",
    );
    assert.equal(
      await readFile(original, "utf8"),
      "original bytes must remain untouched",
    );
    assert.throws(
      () =>
        f.sql(
          `UPDATE private_libraries SET deleted_at=NULL WHERE id='${lib.id}'`,
        ),
      /library_deleted/,
    );
    assert.throws(
      () =>
        f.sql(`UPDATE media_items SET available=true WHERE id='${liveMedia}'`),
      /source_deleted/,
    );
    const shared = await admin.request(
      "/libraries/00000000-0000-0000-0000-000000000001",
    );
    await admin.request(
      "/libraries/00000000-0000-0000-0000-000000000001",
      "DELETE",
      { expected_revision: shared.revision },
      409,
    );
    const blocked = await admin.request("/libraries", "POST", {
      name: "Managed dependency",
    });
    const agent = randomUUID();
    f.sql(
      `INSERT INTO agents(id,name) VALUES('${agent}','Live device'); INSERT INTO sources(id,name,kind,config_encrypted,library_id) VALUES('${agent}','Managed NAS','agent','fixture-not-a-real-credential','${blocked.id}')`,
    );
    await admin.request(
      `/libraries/${blocked.id}`,
      "DELETE",
      { expected_revision: blocked.revision },
      409,
    );
    assert.equal(f.sql(`SELECT revoked FROM agents WHERE id='${agent}'`), "f");
    assert.equal(
      f.sql(`SELECT deleted_at IS NULL FROM sources WHERE id='${agent}'`),
      "t",
    );
    // A cleanup owner retains its destination until the reservation is settled.
    const cleanupLib = await admin.request("/libraries", "POST", {
      name: "Upstream cleanup",
    });
    const upstream = (
      await admin.request("/sources", "POST", {
        name: "Cleanup fixture",
        kind: "jellyfin",
        config: {
          url: "https://cleanup.example",
          token: "synthetic-cleanup-token",
          user_id: "fixture-user",
        },
      })
    ).id;
    await admin.request(`/libraries/${cleanupLib.id}/attach-source`, "POST", {
      source_id: upstream,
      expected_revision: cleanupLib.revision,
    });
    const cleanupDetail = await admin.request(`/libraries/${cleanupLib.id}`);
    const reservation = randomUUID(),
      requestKey = randomUUID(),
      cleanupMedia = randomUUID();
    const cleanupRoom = (
      await admin.request("/rooms", "POST", { name: "Owned upstream cleanup" })
    ).id;
    f.sql(
      `INSERT INTO media_items(id,source_id,title,resource) VALUES('${cleanupMedia}','${upstream}','Cleanup fixture media','fixture-item')`,
    );
    withPlaybackAdmission(
      f,
      {
        client: admin,
        user: adminIdentity.id,
        room: cleanupRoom,
        session: reservation,
        key: requestKey,
      },
      `INSERT INTO upstream_reservations(id,user_id,request_key,owner_epoch,room_id,media_id,source_id,generation,kind,device_id,origin_key,scope_encrypted,state,negotiation,cleanup_after) SELECT '${reservation}','${adminIdentity.id}','${requestKey}',owner_epoch,'${cleanupRoom}','${cleanupMedia}','${upstream}',1,'jellyfin','fixture-${randomUUID()}','https://cleanup.example','synthetic-scope','closing','not_sent',clock_timestamp()+interval '1 hour' FROM playback_requests WHERE session_id='${reservation}'`,
    );
    const retained = f.sql(
      `SELECT config_encrypted FROM sources WHERE id='${upstream}'`,
    );
    await admin.request(
      `/libraries/${cleanupLib.id}`,
      "DELETE",
      { expected_revision: cleanupDetail.revision },
      409,
    );
    assert.equal(
      f.sql(`SELECT config_encrypted FROM sources WHERE id='${upstream}'`),
      retained,
    );
    f.sql(
      `UPDATE upstream_reservations SET state='cleanup_failed',io_uncertain=true WHERE id='${reservation}'`,
    );
    const uncertain = await admin.request(
      `/libraries/${cleanupLib.id}`,
      "DELETE",
      { expected_revision: cleanupDetail.revision },
      409,
    );
    assert.equal(uncertain.error.code, "SOURCE_CLEANUP_UNCONFIRMED");
    f.sql(
      `UPDATE upstream_reservations SET state='closed',io_uncertain=false,closed_at=clock_timestamp() WHERE id='${reservation}'`,
    );
    await admin.request(`/libraries/${cleanupLib.id}`, "DELETE", {
      expected_revision: cleanupDetail.revision,
    });
    assert.equal(
      f.sql(
        `SELECT deleted_at IS NOT NULL FROM sources WHERE id='${upstream}'`,
      ),
      "t",
    );
    assert.notEqual(
      f.sql(
        `SELECT config_encrypted FROM source_access_policy_snapshots WHERE source_id='${upstream}'`,
      ),
      retained,
    );
    // Tombstones cannot trap the former owner in an undeletable account.
    const exitedLibrary = await stranger.request("/libraries", "POST", {
      name: "Exit after library removal",
    });
    await stranger.request(`/libraries/${exitedLibrary.id}`, "DELETE", {
      expected_revision: exitedLibrary.revision,
    });
    const exit = await stranger.request("/users/me/deletion");
    assert.equal(exit.libraries.length, 0);
    assert.equal(exit.can_delete, true);
    await stranger.request("/users/me/deletion", "POST", {
      password: f.password,
      confirmation: "DELETE",
    });
    assert.equal(
      f.sql(
        `SELECT count(*) FROM account_exits WHERE user_id='${users["settings-stranger"]}'`,
      ),
      "1",
    );
    console.log(
      "PASS private library/source CAS, permission and tombstone matrix; share expiry/mode edit retains other shares and fences prior epoch; original bytes retained",
    );
  },
  { env: { PRIVATE_LIBRARIES_ENABLED: "true" } },
);
