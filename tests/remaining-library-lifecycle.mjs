// Ordinary lifecycle regressions on owned disposable PostgreSQL + Server and a
// synthetic loopback S3 endpoint. No user credentials, buckets, media or DB.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { isolatedServer } from "./fixtures/server.mjs";
import { verifyClosedPort } from "./fixtures/postgres.mjs";

let version = "v1",
  failList = false,
  holdList;
const upstream = createServer((req, res) => {
  const url = new URL(req.url, "http://owned.invalid");
  const respond = () => {
    if (failList) {
      res.writeHead(503);
      res.end("synthetic failure");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(
      `<ListBucketResult><Name>synthetic-bucket</Name><Prefix>allowed%2F</Prefix><IsTruncated>false</IsTruncated><KeyCount>1</KeyCount><EncodingType>url</EncodingType><Contents><Key>allowed%2Fmovie.mp4</Key><ETag>"${version}"</ETag><Size>4</Size><LastModified>2026-10-05T00:00:00Z</LastModified></Contents></ListBucketResult>`,
    );
  };
  if (url.searchParams.get("list-type") === "2") {
    if (holdList) {
      const hold = holdList;
      holdList = undefined;
      hold(respond);
    } else respond();
    return;
  }
  res.writeHead(200, {
    ETag: `"${version}"`,
    "Content-Length": "4",
    "Last-Modified": "Mon, 05 Oct 2026 00:00:00 GMT",
    "x-amz-version-id": version,
  });
  res.end(req.method === "HEAD" ? undefined : "test");
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const port = upstream.address().port;
const endpoint = `http://127.0.0.1:${port}`;
const config = {
  url: endpoint,
  access_policy: {
    schema_version: 1,
    origins: [{ origin: endpoint, cidrs: ["127.0.0.1/32"] }],
  },
  s3: {
    region: "us-east-1",
    bucket: "synthetic-bucket",
    prefix: "allowed/",
    addressing_style: "path",
    credential_ref: {
      access_key_id_env: "RAINSYNC_S3_LIFECYCLE_ACCESS",
      secret_access_key_env: "RAINSYNC_S3_LIFECYCLE_SECRET",
    },
  },
};
let fixture,
  completed = false;
const evidence = [];
try {
  await isolatedServer(
    "remaining-library-lifecycle",
    async (f) => {
      fixture = f;
      const admin = f.client(),
        manager = f.client(),
        viewer = f.client();
      await admin.login();
      const managerId = (
        await admin.request("/users", "POST", {
          username: "lifecycle-manager",
          password: f.password,
        })
      ).id;
      await admin.request("/users", "POST", {
        username: "lifecycle-viewer",
        password: f.password,
      });
      await manager.login("lifecycle-manager", f.password);
      await viewer.login("lifecycle-viewer", f.password);
      const library = await admin.request("/libraries", "POST", {
        name: "Owned lifecycle",
      });
      const root = `/libraries/${library.id}`;
      const detail = () => admin.request(root);
      async function grant(manage = true) {
        return admin.request(`${root}/grants`, "POST", {
          username: "lifecycle-manager",
          browse: true,
          play: true,
          share_to_room: true,
          manage,
          expires_in_hours: 24,
          expected_revision: (await detail()).revision,
        });
      }
      await grant();
      async function add(root, kind = "s3") {
        return (
          await admin.request(`${root}/sources`, "POST", {
            name: `Owned ${kind}`,
            kind,
            config:
              kind === "s3"
                ? config
                : { url: "https://fixture.example/movie.mp4" },
          })
        ).id;
      }
      const shared = `/libraries/${(await admin.request("/libraries")).items.find((item) => item.visibility === "instance_shared").id}`;
      for (const kind of ["http", "s3"]) {
        const source = await add(shared, kind),
          path = `${shared}/sources/${source}`;
        const media = randomUUID();
        f.sql(
          `INSERT INTO media_items(id,source_id,title,resource) VALUES('${media}','${source}','Shared fixture','${kind === "s3" ? "allowed/movie.mp4" : "https://fixture.example/movie.mp4"}')`,
        );
        const result = await admin.raw(path);
        assert.equal(result.status, 200);
        assert.match(result.headers.get("cache-control"), /no-store/);
        const settings = await result.json();
        const saved = await admin.request(path, "PATCH", {
          name: "Shared renamed",
          expected_revision: settings.revision,
        });
        assert.equal(saved.config_changed, false);
        assert.equal(
          f.sql(`SELECT library_id||':'||id FROM sources WHERE id='${source}'`),
          `${shared.split("/").at(-1)}:${source}`,
        );
        await viewer.request(path, "GET", undefined, 404);
        await admin.request(path, "DELETE", {
          expected_revision: saved.revision,
          expected_library_revision: (await admin.request(shared)).revision,
        });
        assert.equal(
          f.sql(
            `SELECT id||':'||available FROM media_items WHERE id='${media}'`,
          ),
          `${media}:false`,
        );
        assert.equal(
          f.sql(
            `SELECT deleted_at IS NOT NULL FROM sources WHERE id='${source}'`,
          ),
          "t",
        );
      }
      const moved = await add(root);
      await admin.request(`${shared}/attach-source`, "POST", {
        source_id: moved,
        expected_revision: (await admin.request(shared)).revision,
      });
      const movedPath = `${shared}/sources/${moved}`,
        movedSettings = await admin.request(movedPath);
      const movedSaved = await admin.request(movedPath, "PATCH", {
        name: "Moved S3 renamed",
        expected_revision: movedSettings.revision,
      });
      await admin.request(movedPath, "DELETE", {
        expected_revision: movedSaved.revision,
        expected_library_revision: (await admin.request(shared)).revision,
      });
      evidence.push(
        "Shared HTTP/S3 create, redacted/no-store detail, edit and tombstone retain scope/media identity; private-to-shared S3 remains manageable",
      );

      const http = await add(root, "http"),
        httpPath = `${root}/sources/${http}/scan`;
      await admin.request(httpPath, "POST", { restart: true });
      const httpMedia = f.sql(
        `SELECT id FROM media_items WHERE source_id='${http}'`,
      );
      f.sql(
        `UPDATE media_items SET duration_ms=90000,metadata=metadata||'{"probe":"old"}'::jsonb WHERE id='${httpMedia}'`,
      );
      async function expireDuringMediaWait(path, media, table = "media_items") {
        const marker = `library_lifecycle_${randomUUID().replaceAll("-", "")}`;
        const lock = f.sqlProcess(
          `SET application_name='${marker}'; BEGIN; SELECT id FROM ${table} WHERE id='${media}' FOR UPDATE; SELECT pg_sleep(30); COMMIT;`,
        );
        await f.waitForSql(
          `SELECT count(*) FROM pg_stat_activity WHERE application_name='${marker}' AND wait_event='PgSleep'`,
          "1",
        );
        const release = async () => {
          f.sql(
            `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name='${marker}'`,
          );
          await lock.done.catch(() => {});
        };
        try {
          f.sql(
            `UPDATE library_grants SET expires_at=clock_timestamp()+interval '2 seconds' WHERE library_id='${library.id}' AND user_id='${managerId}'`,
          );
          const request = manager.request(path, "POST", { restart: true }, 404);
          request.catch(() => {});
          await f.waitForSql(
            table === "media_items"
              ? "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'INSERT INTO media_items%')"
              : "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT kind,config_encrypted,access_policy_revision FROM sources%')",
            "t",
          );
          await f.waitForSql(
            `SELECT expires_at<=clock_timestamp() FROM library_grants WHERE library_id='${library.id}' AND user_id='${managerId}'`,
            "t",
          );
          await release();
          await request;
        } finally {
          await release();
          f.sql(
            `UPDATE library_grants SET expires_at=clock_timestamp()+interval '24 hours' WHERE library_id='${library.id}' AND user_id='${managerId}'`,
          );
        }
      }
      const httpSnapshot = f.sql(
        `SELECT row_to_json(m) FROM media_items m WHERE id='${httpMedia}'`,
      );
      const httpGeneration = f.sql(
        `SELECT generation FROM source_scans WHERE source_id='${http}'`,
      );
      await expireDuringMediaWait(httpPath, httpMedia);
      assert.equal(
        f.sql(
          `SELECT row_to_json(m) FROM media_items m WHERE id='${httpMedia}'`,
        ),
        httpSnapshot,
      );
      assert.equal(
        f.sql(`SELECT generation FROM source_scans WHERE source_id='${http}'`),
        httpGeneration,
      );
      await manager.request(httpPath, "POST", { restart: true });
      assert.equal(
        f.sql(
          `SELECT duration_ms IS NULL AND NOT(metadata ? 'probe') FROM media_items WHERE id='${httpMedia}'`,
        ),
        "t",
      );
      evidence.push(
        "HTTP manager expiry during publication rolls back media and generation; unexpired manager scan succeeds and clears orphaned probe duration",
      );

      const s3 = await add(root),
        s3Path = `${root}/sources/${s3}/scan`;
      await expireDuringMediaWait(s3Path, s3, "sources");
      assert.equal(
        f.sql(`SELECT count(*) FROM s3_index_scans WHERE source_id='${s3}'`),
        "0",
      );
      assert.equal(
        f.sql(`SELECT count(*) FROM source_scans WHERE source_id='${s3}'`),
        "0",
      );
      evidence.push(
        "S3 manager expiry during initial source lock rolls back checkpoint and scan generation creation",
      );
      await admin.request(s3Path, "POST", { restart: true });
      const s3Media = f.sql(
        `SELECT id FROM media_items WHERE source_id='${s3}'`,
      );
      f.sql(
        `UPDATE media_items SET duration_ms=123000,metadata=metadata||'{"probe":"keep"}'::jsonb WHERE id='${s3Media}'`,
      );
      await admin.request(s3Path, "POST", { restart: true });
      assert.equal(
        f.sql(
          `SELECT duration_ms||':'||(metadata->>'probe') FROM media_items WHERE id='${s3Media}'`,
        ),
        "123000:keep",
      );
      version = "v2";
      await admin.request(s3Path, "POST", { restart: true });
      assert.equal(
        f.sql(
          `SELECT id||':'||(duration_ms IS NULL AND NOT(metadata ? 'probe')) FROM media_items WHERE id='${s3Media}'`,
        ),
        `${s3Media}:true`,
      );
      const unseen = randomUUID();
      f.sql(
        `INSERT INTO media_items(id,source_id,title,resource) VALUES('${unseen}','${s3}','Unseen retained on failed publication','allowed/unseen.mp4')`,
      );
      const before = f.sql(
        `SELECT row_to_json(m) FROM media_items m WHERE id='${s3Media}'`,
      );
      version = "v3";
      await expireDuringMediaWait(s3Path, s3Media);
      assert.equal(
        f.sql(`SELECT row_to_json(m) FROM media_items m WHERE id='${s3Media}'`),
        before,
      );
      assert.equal(
        f.sql(`SELECT available FROM media_items WHERE id='${unseen}'`),
        "t",
      );
      assert.equal(
        f.sql(
          `SELECT page_count||':'||item_count||':'||status FROM s3_index_scans WHERE source_id='${s3}'`,
        ),
        "0:0:running",
      );
      assert.equal(
        f.sql(
          `SELECT count(*) FROM s3_index_scan_seen WHERE source_id='${s3}'`,
        ),
        "0",
      );
      await manager.request(s3Path, "POST", { restart: false });
      assert.equal(
        f.sql(`SELECT available FROM media_items WHERE id='${unseen}'`),
        "f",
      );
      evidence.push(
        "S3 same-version rescan keeps duration, replacement clears it without changing media ID; expired page publication rolls back index/checkpoint/downlisting and valid manager resumes",
      );

      let releaseFetch;
      const held = new Promise((resolve) => {
        holdList = (release) => {
          releaseFetch = release;
          resolve();
        };
      });
      f.sql(
        `UPDATE library_grants SET expires_at=clock_timestamp()+interval '2 seconds' WHERE library_id='${library.id}' AND user_id='${managerId}'`,
      );
      const failedRequest = manager.request(
        s3Path,
        "POST",
        { restart: true },
        404,
      );
      failedRequest.catch(() => {});
      await held;
      await f.waitForSql(
        `SELECT expires_at<=clock_timestamp() FROM library_grants WHERE library_id='${library.id}' AND user_id='${managerId}'`,
        "t",
      );
      failList = true;
      releaseFetch();
      await failedRequest;
      failList = false;
      assert.equal(
        f.sql(
          `SELECT status||':'||page_count FROM s3_index_scans WHERE source_id='${s3}'`,
        ),
        "running:0",
      );
      f.sql(
        `UPDATE library_grants SET expires_at=clock_timestamp()+interval '24 hours' WHERE library_id='${library.id}' AND user_id='${managerId}'`,
      );
      evidence.push(
        "A failed S3 fetch cannot write a checkpoint failure after the caller's manage grant expires",
      );

      const room = (
        await manager.request("/rooms", "POST", { name: "Owned share room" })
      ).id;
      const ownerRoom = (
        await admin.request("/rooms", "POST", { name: "Owner share room" })
      ).id;
      async function share(client, roomId) {
        return client.request(`${root}/room-shares`, "POST", {
          room_id: roomId,
          media_id: httpMedia,
          mode: "room_members",
          expires_in_minutes: 60,
          expected_revision: (await detail()).revision,
        });
      }
      const stale = await share(admin, ownerRoom);
      const staleEpoch = (await detail()).permission_epoch;
      await grant(false);
      const mine = await share(manager, room),
        other = await share(admin, ownerRoom);
      const managerDetail = await manager.request(root);
      assert.deepEqual(
        managerDetail.room_shares.map((item) => item.id),
        [mine.id],
      );
      assert.equal(managerDetail.sources, undefined);
      assert.equal(managerDetail.grants, undefined);
      let own = await manager.request("/libraries/issued-shares");
      assert.deepEqual(
        own.items.map((item) => item.id),
        [mine.id],
      );
      assert.equal(own.has_more, false);
      assert.deepEqual(
        (await viewer.request("/libraries/issued-shares")).items,
        [],
      );
      const epoch = (await detail()).permission_epoch;
      await manager.request(`${root}/room-shares/${mine.id}`, "DELETE", {
        expected_revision: own.items[0].revision,
      });
      assert.equal(
        f.sql(
          `SELECT revoked_at IS NOT NULL FROM room_media_grants WHERE id='${mine.id}'`,
        ),
        "t",
      );
      assert.equal(
        f.sql(
          `SELECT g.permission_epoch=l.permission_epoch AND g.permission_epoch>${epoch}::bigint AND g.revoked_at IS NULL FROM room_media_grants g JOIN private_libraries l ON l.id=g.library_id WHERE g.id='${other.id}'`,
        ),
        "t",
      );
      assert.equal(
        (await detail()).room_shares.find((item) => item.id === other.id)
          .active,
        true,
      );
      assert.equal(
        f.sql(
          `SELECT permission_epoch FROM room_media_grants WHERE id='${stale.id}'`,
        ),
        staleEpoch,
      );
      assert.equal(
        (await detail()).room_shares.find((item) => item.id === stale.id)
          .active,
        false,
      );
      const later = await share(manager, room);
      f.sql(
        `UPDATE library_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE library_id='${library.id}' AND user_id='${managerId}'`,
      );
      await manager.request(root, "GET", undefined, 404);
      own = await manager.request("/libraries/issued-shares");
      assert.deepEqual(
        own.items.map((item) => item.id),
        [later.id],
      );
      assert.equal(own.items[0].title, null);
      assert.equal(own.items[0].active, false);
      assert.deepEqual(
        (await manager.request(`/libraries/issued-shares?after=${later.id}`))
          .items,
        [],
      );
      await manager.request(`${root}/room-shares/${later.id}`, "DELETE", {
        expected_revision: own.items[0].revision,
      });
      assert.equal(
        (await manager.request("/libraries/issued-shares")).items.length,
        0,
      );
      assert.equal(
        (await detail()).room_shares.find((item) => item.id === other.id)
          .active,
        true,
      );
      evidence.push(
        "Non-manager sees only own shares; targeted revoke preserves other current share epochs; after browse expiry own listing redacts title and still permits withdrawal",
      );

      await grant(false);
      await share(manager, room);
      const destination = await admin.request("/libraries", "POST", {
        name: "Separate private destination",
      });
      await admin.request(
        `/libraries/${destination.id}/attach-source`,
        "POST",
        { source_id: http, expected_revision: destination.revision },
      );
      f.sql(
        `UPDATE media_items SET title='New title only in separate private destination' WHERE id='${httpMedia}'`,
      );
      const historical = await manager.request("/libraries/issued-shares");
      assert.equal(
        historical.items.every((item) => item.title === null),
        true,
      );
      assert.equal(
        (await manager.request(root)).room_shares.every(
          (item) => item.title === "已移出或删除的影片",
        ),
        true,
      );
      evidence.push(
        "Historical shares do not expose the new title after their source moves to an inaccessible library",
      );

      const plugin = "/admin/plugins/metadata.duration-badge";
      const pluginBody = (revision, format) => ({
        version: "1.0.0",
        enabled: true,
        config: { format },
        granted_permissions: ["metadata:read"],
        expected_revision: revision,
      });
      await admin.request(plugin, "PUT", pluginBody("0", "clock"));
      const configured = await admin.request(
        plugin,
        "PUT",
        pluginBody("1", "minutes"),
      );
      const auditBefore = f.sql("SELECT count(*) FROM rainsync_plugin_audit");
      const unchanged = await admin.request(
        plugin,
        "PUT",
        pluginBody("2", "minutes"),
      );
      assert.deepEqual(unchanged, configured);
      assert.equal(
        f.sql("SELECT count(*) FROM rainsync_plugin_audit"),
        auditBefore,
      );
      await admin.request(plugin, "PUT", pluginBody("1", "minutes"), 409);
      const restored = await admin.request(`${plugin}/rollback`, "POST", {
        expected_revision: "2",
      });
      assert.equal(restored.config.format, "clock");
      assert.equal(restored.revision, "3");
      evidence.push(
        "Plugin A→B→unchanged B preserves rollback to A, revision/receipt/audit and stale-CAS rejection",
      );
      completed = true;
      for (const name of evidence) console.log(`PASS ${name}`);
    },
    {
      env: {
        PRIVATE_LIBRARIES_ENABLED: "true",
        RAINSYNC_S3_LIFECYCLE_ACCESS: "SYNTHETICLIFECYCLE",
        RAINSYNC_S3_LIFECYCLE_SECRET: "synthetic-owned-secret",
      },
    },
  );
} finally {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  assert.equal(await verifyClosedPort(port), true);
  if (fixture) {
    const cleanup = await fixture.verifyStopped();
    await writeFile(
      `${fixture.root}/lifecycle-report.json`,
      JSON.stringify(
        {
          passed: completed,
          evidence,
          cleanup,
          upstream_port: port,
          upstream_port_closed: true,
        },
        null,
        2,
      ),
    );
    console.log(
      `Owned fixture evidence: ${fixture.root}/lifecycle-report.json`,
    );
  }
}
