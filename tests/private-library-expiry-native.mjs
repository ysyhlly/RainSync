// Expiring grants must be checked after lock waits, before committing a mutation.
// Uses only an owned disposable server/database and synthetic fixture data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedServer } from "./fixtures/server.mjs";

await isolatedServer(
  "private-library-expiry",
  async (f) => {
    const admin = f.client(),
      owner = f.client(),
      manager = f.client();
    await admin.login();
    const users = {};
    for (const username of ["expiry-owner", "expiry-manager"])
      users[username] = (
        await admin.request("/users", "POST", {
          username,
          password: f.password,
        })
      ).id;
    await owner.login("expiry-owner", f.password);
    await manager.login("expiry-manager", f.password);
    const library = await owner.request("/libraries", "POST", {
      name: "Expiry library",
    });
    const root = `/libraries/${library.id}`;
    const source = (
      await owner.request(`${root}/sources`, "POST", {
        name: "Original source",
        kind: "http",
        config: { url: "https://fixture.example/original.mp4" },
      })
    ).id;
    const media = randomUUID();
    f.sql(
      `INSERT INTO media_items(id,source_id,title,resource) VALUES('${media}','${source}','Fixture movie','https://fixture.example/original.mp4')`,
    );
    const room = (
      await owner.request("/rooms", "POST", { name: "Expiry room" })
    ).id;
    f.sql(
      `INSERT INTO room_members(room_id,user_id) VALUES('${room}','${users["expiry-manager"]}')`,
    );
    await owner.request(`${root}/grants`, "POST", {
      username: "expiry-manager",
      browse: true,
      play: true,
      share_to_room: true,
      manage: true,
      expires_in_hours: 24,
      expected_revision: (await owner.request(root)).revision,
    });
    const existing = await owner.request(`${root}/room-shares`, "POST", {
      room_id: room,
      media_id: media,
      mode: "library_members",
      expires_in_minutes: 60,
      expected_revision: (await owner.request(root)).revision,
    });
    const failures = [];
    async function check(
      label,
      path,
      method,
      body,
      lockTable,
      lockId,
      blockedQuery,
      state,
    ) {
      const before = f.sql(state);
      const marker = `expiry_lock_${randomUUID().replaceAll("-", "")}`;
      const holder = f.sqlProcess(
        `SET application_name='${marker}'; BEGIN; SELECT id FROM ${lockTable} WHERE id='${lockId}' FOR UPDATE; SELECT pg_sleep(30); COMMIT;`,
      );
      const release = async () => {
        f.sql(
          `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name='${marker}'`,
        );
        await holder.done.catch(() => {});
      };
      try {
        await f.waitForSql(
          `SELECT count(*) FROM pg_stat_activity WHERE application_name='${marker}' AND wait_event='PgSleep'`,
          "1",
        );
        const pending = manager.raw(path, { method, body });
        pending.catch(() => {});
        await f.waitForSql(
          `SELECT count(*)>=1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '${blockedQuery}'`,
          "t",
        );
        f.sql(
          `UPDATE library_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE library_id='${library.id}' AND user_id='${users["expiry-manager"]}'`,
        );
        await release();
        const response = await pending;
        const value = await response.json();
        const after = f.sql(state);
        if (response.status !== 404 || before !== after)
          failures.push({
            label,
            status: response.status,
            error: value.error?.code,
            before,
            after,
          });
      } finally {
        await release();
        f.sql(
          `UPDATE library_grants SET expires_at=clock_timestamp()+interval '24 hours' WHERE library_id='${library.id}' AND user_id='${users["expiry-manager"]}'`,
        );
      }
    }
    await check(
      "rename",
      root,
      "PUT",
      {
        name: "Expired rename",
        expected_revision: (await owner.request(root)).revision,
      },
      "private_libraries",
      library.id,
      "SELECT l.* FROM private_libraries l WHERE l.id=$2%",
      `SELECT name || ':' || revision FROM private_libraries WHERE id='${library.id}'`,
    );
    await check(
      "add source",
      `${root}/sources`,
      "POST",
      {
        name: "Expired source",
        kind: "http",
        config: { url: "https://fixture.example/expired.mp4" },
      },
      "private_libraries",
      library.id,
      "SELECT id FROM private_libraries WHERE id=$1%",
      `SELECT count(*) FROM sources WHERE library_id='${library.id}'`,
    );
    await check(
      "create share",
      `${root}/room-shares`,
      "POST",
      {
        room_id: room,
        media_id: media,
        mode: "room_members",
        expires_in_minutes: 60,
        expected_revision: (await owner.request(root)).revision,
      },
      "sources",
      source,
      "SELECT m.library_source_generation FROM media_items m JOIN sources s%",
      `SELECT count(*) FROM room_media_grants WHERE library_id='${library.id}'`,
    );
    await check(
      "revoke another grantor share",
      `${root}/room-shares/${existing.id}`,
      "DELETE",
      {
        expected_revision: (await owner.request(root)).revision,
      },
      "private_libraries",
      library.id,
      "SELECT * FROM private_libraries WHERE id=$1 AND deleted_at IS NULL%",
      `SELECT (revoked_at IS NULL)::text FROM room_media_grants WHERE id='${existing.id}'`,
    );
    assert.deepEqual(
      failures,
      [],
      "expired permissions must not persist a mutation after waiting for locks",
    );
    const ownShare = await manager.request(`${root}/room-shares`, "POST", {
      room_id: room,
      media_id: media,
      mode: "library_members",
      expires_in_minutes: 60,
      expected_revision: (await owner.request(root)).revision,
    });
    f.sql(
      `UPDATE library_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE library_id='${library.id}' AND user_id='${users["expiry-manager"]}'`,
    );
    await manager.request(`${root}/room-shares/${ownShare.id}`, "DELETE", {
      expected_revision: (await owner.request(root)).revision,
    });
    assert.equal(
      f.sql(
        `SELECT (revoked_at IS NOT NULL)::text FROM room_media_grants WHERE id='${ownShare.id}'`,
      ),
      "true",
      "a grantor can still withdraw their own share after expiry",
    );
    console.log(
      "PASS expired manager/share grants reject rename, source creation, share creation and another grantor's share revocation without persisted changes",
    );
  },
  { env: { PRIVATE_LIBRARIES_ENABLED: "true" } },
);
