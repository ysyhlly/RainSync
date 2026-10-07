// Actual HTTP/SQL matrix on a new, process-owned disposable native cluster.
// Requires installed PostgreSQL binaries + pg module and a locally built Server.
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { verifyClosedPort } from "./fixtures/postgres.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { Client } from "./fixtures/server.mjs";
const pgPath = process.env.RAINSYNC_PG_MODULE,
  bin = process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
  artifacts = process.env.RAINSYNC_ARTIFACT_DIR;
assert.ok(
  pgPath && bin && artifacts,
  "Set native PostgreSQL/pg module/artifact paths; never pass a user DATABASE_URL",
);
const { default: pg } = await import(pathToFileURL(resolve(pgPath)).href);
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(resolve(artifacts, "private-library-"));
async function port() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const p = l.address().port;
  await new Promise((r) => l.close(r));
  return p;
}
const pgPort = await port(),
  httpPort = await port(),
  origin = `http://127.0.0.1:${httpPort}`;
const init = spawnSync(
  resolve(bin, "initdb"),
  [
    "-D",
    root + "/data",
    "-A",
    "trust",
    "-U",
    "postgres",
    "--no-locale",
    "--encoding=UTF8",
  ],
  { encoding: "utf8", timeout: 60000 },
);
assert.equal(init.status, 0, init.stderr);
const database = spawn(
  resolve(bin, "postgres"),
  ["-D", root + "/data", "-h", "127.0.0.1", "-p", String(pgPort), "-k", ""],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let dbLog = "",
  serverLog = "",
  client,
  server;
database.stdout.on("data", (b) => (dbLog += b));
database.stderr.on("data", (b) => (dbLog += b));
const password = randomBytes(24).toString("hex");
let objectEndpoint;
let assertions = 0;
const report = {
  started_at: new Date().toISOString(),
  scope:
    "Synthetic private-library matrix: owned actual PostgreSQL + Server, no existing database/media/credentials",
  passed: false,
};
function check(condition, message) {
  assert.ok(condition, message);
  assertions++;
}
try {
  for (let n = 0; n < 100; n++) {
    const c = new pg.Client({
      host: "127.0.0.1",
      port: pgPort,
      user: "postgres",
      database: "postgres",
      connectionTimeoutMillis: 500,
    });
    try {
      await c.connect();
      client = c;
      break;
    } catch {
      await c.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  check(client, "native PostgreSQL ready");
  await client.query("CREATE DATABASE rainsync_private_fixture");
  await client.end();
  client = new pg.Client({
    host: "127.0.0.1",
    port: pgPort,
    user: "postgres",
    database: "rainsync_private_fixture",
  });
  await client.connect();
  const env = {
    ...process.env,
    DATABASE_URL: `postgres://postgres@127.0.0.1:${pgPort}/rainsync_private_fixture`,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: password,
    SOURCE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    PUBLIC_ORIGIN: origin,
    BIND: `127.0.0.1:${httpPort}`,
    MEDIA_ROOT: root,
    CACHE_ROOT: root + "-cache",
    PRIVATE_LIBRARIES_ENABLED: "true",
    RAINSYNC_S3_SYNTH_ACCESS: "SYNTHETICACCESS",
    RAINSYNC_S3_SYNTH_SECRET: "synthetic-owned-local-secret",
    RUST_LOG: "warn",
  };
  report.fixture_paths = { artifacts: root, media: env.MEDIA_ROOT, cache: env.CACHE_ROOT, retention: "owned fixture directories retained as evidence" };
  const serverBinary =
    process.env.RAINSYNC_SERVER_BINARY ||
    resolve(
      process.env.CARGO_TARGET_DIR || "target",
      "debug",
      "rainsync-server",
    );
  const binaryHash = createHash("sha256");
  for await (const chunk of createReadStream(serverBinary))
    binaryHash.update(chunk);
  report.server_binary = {
    path: serverBinary,
    sha256: binaryHash.digest("hex"),
  };
  server = spawn(serverBinary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (b) => (serverLog += b));
  server.stderr.on("data", (b) => (serverLog += b));
  for (let n = 0; n < 200; n++) {
    if (server.exitCode !== null) throw Error("Server stopped: " + serverLog);
    try {
      if (
        (await fetch(origin + "/health", { signal: AbortSignal.timeout(500) }))
          .ok
      )
        break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const f = { origin, password, env },
    admin = new Client(f),
    a = new Client(f),
    b = new Client(f),
    c = new Client(f);
  await admin.login();
  const people = {};
  for (const username of ["owner_a", "host_b", "viewer_c"])
    people[username] = (
      await admin.request("/users", "POST", { username, password })
    ).id;
  await a.login("owner_a", password);
  await b.login("host_b", password);
  await c.login("viewer_c", password);
  const lib = await a.request("/libraries", "POST", { name: "私人合成测试库" });
  check(lib.owner_id === people.owner_a, "library owner");
  await admin.request("/libraries/" + lib.id, "GET", undefined, 404);
  await b.request("/libraries/" + lib.id, "GET", undefined, 404);
  const source = (
    await a.request(`/libraries/${lib.id}/sources`, "POST", {
      name: "私有HTTP",
      kind: "http",
      config: { url: "https://fixture.example/media.mp4" },
    })
  ).id;
  await a.request(
    `/libraries/${lib.id}/sources`,
    "POST",
    {
      name: "forbidden-lan-policy",
      kind: "http",
      config: {
        url: "http://127.0.0.1/file.mp4",
        access_policy: {
          schema_version: 1,
          origins: [{ origin: "http://127.0.0.1", cidrs: ["127.0.0.1/32"] }],
        },
      },
    },
    403,
  );
  const media = randomUUID();
  await client.query(
    "INSERT INTO media_items(id,source_id,title,resource) VALUES($1,$2,$3,$4)",
    [media, source, "绝不泄露的合成标题", "https://fixture.example/media.mp4"],
  );
  check(
    (await a.request("/media")).some((v) => v.id === media),
    "owner browses own media",
  );
  for (const reader of [admin, b, c]) {
    check(
      !(await reader.request("/media")).some((v) => v.id === media),
      "no implicit private enumeration",
    );
    await reader.request("/media/" + media, "GET", undefined, 404);
    await reader.request(
      "/media/" + media + "/plugin-metadata",
      "GET",
      undefined,
      404,
    );
    check(
      (await reader.request("/media/previews?ids=" + media)).items.length === 0,
      "no preview state leak",
    );
    check(
      (await reader.request("/media/previews", "POST", { media_ids: [media] }))
        .items.length === 0,
      "no unauthorized preview queue",
    );
  }
  const room = (await b.request("/rooms", "POST", { name: "B 的合成房间" })).id;
  await client.query(
    "INSERT INTO room_members(room_id,user_id) VALUES($1,$2),($1,$3)",
    [room, people.owner_a, people.viewer_c],
  );
  await b.request(`/rooms/${room}/playlist`, "POST", { media_id: media }, 404);
  let detail = await a.request("/libraries/" + lib.id);
  const share = await a.request(`/libraries/${lib.id}/room-shares`, "POST", {
    room_id: room,
    media_id: media,
    mode: "room_members",
    expires_in_minutes: 60,
    expected_revision: detail.revision,
  });
  await b.request(`/rooms/${room}/playlist`, "POST", { media_id: media });
  check(
    (await c.request(`/rooms/${room}/playlist`)).some(
      (v) => v.media_id === media,
    ),
    "room viewer sees explicitly shared item",
  );
  check(
    !(await c.request("/media")).some((v) => v.id === media),
    "room sharing does not grant catalog browse",
  );
  await client.query(
    "UPDATE room_snapshots SET state=jsonb_set(state,'{media_id}',to_jsonb($2::text)) WHERE room_id=$1",
    [room, media],
  );
  const session = randomUUID(),
    login = createHash("sha256").update(c.cookie.split("=")[1]).digest("hex");
  const membership = (
    await client.query(
      "SELECT membership_epoch FROM room_members WHERE room_id=$1 AND user_id=$2",
      [room, people.viewer_c],
    )
  ).rows[0].membership_epoch;
  await client.query(
    "INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,room_id,auth_login_hash,auth_membership_epoch) VALUES($1,$2,$3,$4,$5,'pending',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 hour',$6,$7,$8)",
    [
      people.viewer_c,
      randomUUID(),
      "synthetic-private-test",
      session,
      randomUUID(),
      room,
      login,
      membership,
    ],
  );
  await client.query(
    "INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES($1,$2,$3,$4,0,$5,$6,clock_timestamp()+interval '30 minutes')",
    [
      session,
      people.viewer_c,
      room,
      media,
      "synthetic-delivery-" + randomUUID(),
      {
        encrypted: "synthetic-authority-only",
        source_policy_revision: 0,
        account_policy_generation: null,
      },
    ],
  );
  const binding = (
    await client.query(
      "SELECT library_id,library_permission_epoch,resource,playback_library_session_allowed(id) AS allowed FROM playback_sessions WHERE id=$1",
      [session],
    )
  ).rows[0];
  check(
    binding.library_id === lib.id && binding.allowed,
    "private playback is immutably DB-bound",
  );
  check(
    !("library_context" in binding.resource),
    "frozen resource JSON is unchanged by library binding",
  );
  await client.query(
    "UPDATE media_items SET metadata=metadata||'{\"technical_probe\":true}'::jsonb WHERE id=$1",
    [media],
  );
  check(
    (
      await client.query(
        "SELECT playback_library_session_allowed(id) AS ok FROM playback_sessions WHERE id=$1",
        [session],
      )
    ).rows[0].ok,
    "technical probe metadata does not revoke the private playback/share",
  );
  await assert.rejects(
    client.query(
      "UPDATE playback_sessions SET library_permission_epoch=library_permission_epoch+1 WHERE id=$1",
      [session],
    ),
    /private_playback_binding_immutable/,
  );
  await client.query(
    "INSERT INTO media_previews(media_id,source_generation,recipe_version,status,result_revision,image,image_sha256,generated_at) SELECT id,preview_generation,2,'ready',$2,$3,$4,clock_timestamp() FROM media_items WHERE id=$1",
    [
      media,
      randomUUID(),
      Buffer.from("synthetic-cover-authorization-bytes"),
      createHash("sha256")
        .update("synthetic-cover-authorization-bytes")
        .digest("hex"),
    ],
  );
  const preview = (await a.request("/media/" + media)).cover;
  const cover = await a.raw(preview.url.slice("/api/v1".length));
  check(cover.status === 200, "owner can read cached cover");
  const etag = cover.headers.get("etag");
  await cover.arrayBuffer();
  check(
    (
      await c.raw(preview.url.slice("/api/v1".length) + "&room_id=" + room, {
        headers: { "If-None-Match": etag },
      })
    ).status === 304,
    "authorized room viewer revalidates cached cover",
  );
  for (const reader of [b, admin])
    check(
      (
        await reader.raw(preview.url.slice("/api/v1".length), {
          headers: { "If-None-Match": etag },
        })
      ).status === 404,
      "cached ETag never bypasses browse authorization",
    );
  // Model a committed epoch change before asynchronous session retirement.
  await client.query(
    "UPDATE private_libraries SET permission_epoch=permission_epoch+1 WHERE id=$1",
    [lib.id],
  );
  detail = await a.request("/libraries/" + lib.id);
  await a.request(`/libraries/${lib.id}/room-shares`, "POST", {
    room_id: room,
    media_id: media,
    mode: "room_members",
    expires_in_minutes: 60,
    expected_revision: detail.revision,
  });
  const secondSession = randomUUID();
  await client.query(
    "INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,room_id,auth_login_hash,auth_membership_epoch) VALUES($1,$2,$3,$4,$5,'pending',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 hour',$6,$7,$8)",
    [
      people.viewer_c,
      randomUUID(),
      "same-resource-regression",
      secondSession,
      randomUUID(),
      room,
      login,
      membership,
    ],
  );
  await client.query(
    "INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES($1,$2,$3,$4,0,$5,$6,clock_timestamp()+interval '30 minutes')",
    [
      secondSession,
      people.viewer_c,
      room,
      media,
      "synthetic-delivery-" + randomUUID(),
      binding.resource,
    ],
  );
  const identities = (
    await client.query(
      "SELECT id,playback_library_session_allowed(id) AS allowed FROM playback_sessions WHERE id=ANY($1)",
      [[session, secondSession]],
    )
  ).rows;
  check(
    identities.find((v) => v.id === session).allowed === false &&
      identities.find((v) => v.id === secondSession).allowed === true,
    "same frozen resource cannot make an old epoch session inherit new session authority",
  );
  check(
    !(
      await client.query(
        "SELECT playback_library_request_allowed($1) AS allowed",
        [session],
      )
    ).rows[0].allowed,
    "pending original request cannot inherit a later re-share",
  );
  check(
    (
      await client.query(
        "SELECT playback_library_request_allowed($1) AS allowed",
        [secondSession],
      )
    ).rows[0].allowed,
    "new request owns the current immutable library epoch",
  );
  const retired = await client.query(
    "UPDATE playback_sessions SET stopped=true WHERE id=ANY($1) AND NOT playback_library_session_allowed(id) RETURNING id",
    [[session, secondSession]],
  );
  check(
    retired.rows.length === 1 && retired.rows[0].id === session,
    "exact-id retirement stops only the invalid old session",
  );
  const librarySourceGeneration = (
    await client.query(
      "SELECT library_source_generation FROM media_items WHERE id=$1",
      [media],
    )
  ).rows[0].library_source_generation;
  await assert.rejects(
    client.query(
      "UPDATE playback_requests SET library_source_generation=$2 WHERE session_id=$1",
      [secondSession, Number(librarySourceGeneration) + 1],
    ),
    /private_request_binding_immutable/,
  );
  const scoped = (
    await client.query(
      "SELECT id,playback_source_allowed(media_id,resource,id) AS allowed FROM playback_sessions WHERE id=ANY($1)",
      [[session, secondSession]],
    )
  ).rows;
  check(
    scoped.find((v) => v.id === session).allowed === false &&
      scoped.find((v) => v.id === secondSession).allowed === true,
    "exact source gate rejects old identical resource while retaining new authority",
  );
  check(
    !(
      await client.query(
        "SELECT playback_source_allowed(media_id,resource) AS allowed FROM playback_sessions WHERE id=$1",
        [secondSession],
      )
    ).rows[0].allowed,
    "unscoped legacy source reader cannot read private media",
  );
  async function hasExactLibraryFloor(helper, seen = new Set()) {
    if (seen.has(helper)) return false;
    seen.add(helper);
    const body = (
      await client.query(
        "SELECT pg_get_functiondef($1::regprocedure) AS body",
        [helper + "(uuid)"],
      )
    ).rows[0].body;
    if (body.includes("playback_library_session_allowed(")) return true;
    // Later feature wrappers retain their original authority by delegation.
    for (const match of body.matchAll(/([a-z_]+_pre_[a-z_]+)\(\$1\)/g)) {
      if (await hasExactLibraryFloor(match[1], seen)) return true;
    }
    return false;
  }
  for (const helper of [
    "static_hls_parent_authority_allowed",
    "static_hls_session_authority_allowed",
    "owned_http_representation_authority_allowed",
    "local_hls_ladder_session_allowed",
  ]) {
    check(
      await hasExactLibraryFloor(helper),
      "direct specialized source authority has an exact library floor: " +
        helper,
    );
  }
  const allowed = await client.query(
    "SELECT library_media_allowed($1,$2,'play',$3) AS ok,library_media_allowed($1,$2,'browse',NULL) AS browse",
    [people.viewer_c, media, room],
  );
  check(
    allowed.rows[0].ok && !allowed.rows[0].browse,
    "play and browse remain separate",
  );
  detail = await a.request("/libraries/" + lib.id);
  await b.request(
    `/libraries/${lib.id}/room-shares`,
    "POST",
    {
      room_id: room,
      media_id: media,
      mode: "room_members",
      expires_in_minutes: 60,
      expected_revision: detail.revision,
    },
    404,
  );
  await a.request(`/libraries/${lib.id}/room-shares/${share.id}`, "DELETE", {
    expected_revision: detail.revision,
  });
  check(
    !(
      await client.query(
        "SELECT library_media_allowed($1,$2,'play',$3) AS ok",
        [people.viewer_c, media, room],
      )
    ).rows[0].ok,
    "revocation cuts room play",
  );
  check(
    !(
      await client.query(
        "SELECT playback_library_session_allowed(id) AS allowed FROM playback_sessions WHERE id=$1",
        [session],
      )
    ).rows[0].allowed,
    "revocation rejects frozen active-session resource",
  );
  check(
    (
      await client.query("SELECT stopped FROM playback_sessions WHERE id=$1", [
        session,
      ])
    ).rows[0].stopped,
    "revoke stops owned playback session",
  );
  check(
    (
      await c.raw(preview.url.slice("/api/v1".length) + "&room_id=" + room, {
        headers: { "If-None-Match": etag },
      })
    ).status === 404,
    "revoked share cannot read hot cover cache",
  );

  check(
    (await c.request(`/rooms/${room}/playlist`)).length === 0,
    "revoked room playlist hides title",
  );
  detail = await a.request("/libraries/" + lib.id);
  const revised = await a.request(`/libraries/${lib.id}/grants`, "POST", {
    username: "host_b",
    browse: false,
    play: true,
    share_to_room: false,
    manage: false,
    expires_in_hours: 1,
    expected_revision: detail.revision,
  });
  check(
    (
      await client.query(
        "SELECT library_media_allowed($1,$2,'play',NULL) AS ok,library_media_allowed($1,$2,'browse',NULL) AS browse",
        [people.host_b, media],
      )
    ).rows[0].ok,
    "explicit play grant",
  );
  await b.request("/media/" + media, "GET", undefined, 404);
  await a.request(
    `/libraries/${lib.id}`,
    "PUT",
    { name: "stale", expected_revision: detail.revision },
    409,
  );
  const latest = await a.request("/libraries/" + lib.id);
  await a.request(`/libraries/${lib.id}/transfer`, "POST", {
    username: "host_b",
    expected_revision: latest.revision,
  });
  await a.request("/libraries/" + lib.id, "GET", undefined, 404);
  check(
    (await b.request("/libraries/" + lib.id)).owner_id === people.host_b,
    "ownership transfer",
  );
  check(
    (await client.query("SELECT owner_id FROM rooms WHERE id=$1", [room]))
      .rows[0].owner_id === people.host_b,
    "media transfer does not change room owner",
  );
  const concurrentRevision = (await b.request("/libraries/" + lib.id)).revision;
  const updates = await Promise.all(
    ["并发一", "并发二"].map((name) =>
      b.raw("/libraries/" + lib.id, {
        method: "PUT",
        body: { name, expected_revision: concurrentRevision },
      }),
    ),
  );
  check(
    updates
      .map((r) => r.status)
      .sort()
      .join(",") === "200,409",
    "concurrent same-revision writes admit only one mutation",
  );
  await Promise.all(updates.map((r) => r.arrayBuffer()));
  const bDetails = await b.request("/libraries/" + lib.id);
  await b.request(`/libraries/${lib.id}/grants`, "POST", {
    username: "viewer_c",
    browse: true,
    play: true,
    share_to_room: false,
    manage: false,
    expires_in_hours: 1,
    expected_revision: bDetails.revision,
  });
  check(
    (await c.request("/media")).some((v) => v.id === media),
    "explicit browse grant opens only authorized catalog item",
  );
  await client.query(
    "UPDATE library_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE library_id=$1 AND user_id=$2",
    [lib.id, people.viewer_c],
  );
  check(
    !(await c.request("/media")).some((v) => v.id === media),
    "expired library grant closes catalog without requiring manual revoke",
  );
  const currentLibrary = await b.request("/libraries/" + lib.id);
  const replacementShare = await b.request(
    `/libraries/${lib.id}/room-shares`,
    "POST",
    {
      room_id: room,
      media_id: media,
      mode: "room_members",
      expires_in_minutes: 60,
      expected_revision: currentLibrary.revision,
    },
  );
  check(
    (
      await client.query(
        "SELECT library_media_allowed($1,$2,'play',$3) AS ok",
        [people.viewer_c, media, room],
      )
    ).rows[0].ok,
    "new owner explicitly authorizes a fresh share",
  );
  await client.query("UPDATE media_items SET source_version=$2 WHERE id=$1", [
    media,
    "synthetic-new-version",
  ]);
  check(
    !(
      await client.query(
        "SELECT library_media_allowed($1,$2,'play',$3) AS ok",
        [people.viewer_c, media, room],
      )
    ).rows[0].ok,
    "actual source-version replacement invalidates prior room share",
  );
  // Real signed S3 HTTP + durable Server page checkpoints, with owned synthetic objects.
  let failNextPage = true,
    objects = Array.from(
      { length: 101 },
      (_, i) => `allowed/media-${String(i).padStart(3, "0")}.mp4`,
    ),
    signedRequests = 0;
  objectEndpoint = createHttpServer((req, res) => {
    if (!req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) {
      res.writeHead(403);
      res.end();
      return;
    }
    signedRequests++;
    const url = new URL(req.url, "http://fixture.invalid");
    if (url.searchParams.get("list-type") === "2") {
      const start = Number(url.searchParams.get("continuation-token") || 0);
      if (start === 100 && failNextPage) {
        failNextPage = false;
        res.writeHead(503);
        res.end("synthetic-page-failure");
        return;
      }
      const slice = objects.slice(start, start + 100),
        next = start + slice.length,
        more = next < objects.length;
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(
        `<ListBucketResult><Name>synthetic-bucket</Name><Prefix>allowed%2F</Prefix><IsTruncated>${more}</IsTruncated><KeyCount>${slice.length}</KeyCount><EncodingType>url</EncodingType>${slice.map((key) => `<Contents><Key>${encodeURIComponent(key)}</Key><ETag>\"synthetic-etag\"</ETag><Size>4</Size><LastModified>2026-10-05T00:00:00Z</LastModified></Contents>`).join("")}${more ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`,
      );
      return;
    }
    const key = decodeURIComponent(
      url.pathname.replace("/synthetic-bucket/", ""),
    );
    if (!objects.includes(key)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      ETag: '\"synthetic-etag\"',
      "Content-Length": "4",
      "Last-Modified": "Mon, 05 Oct 2026 00:00:00 GMT",
      "x-amz-version-id": "synthetic-version-v1",
    });
    res.end(req.method === "HEAD" ? undefined : "test");
  });
  await new Promise((r) => objectEndpoint.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${objectEndpoint.address().port}`;
  const s3config = {
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
        access_key_id_env: "RAINSYNC_S3_SYNTH_ACCESS",
        secret_access_key_env: "RAINSYNC_S3_SYNTH_SECRET",
      },
    },
  };
  const adminLib = await admin.request("/libraries", "POST", {
    name: "管理员合成S3库",
  });
  await b.request(
    `/libraries/${lib.id}/sources`,
    "POST",
    { name: "attempted-binding", kind: "s3", config: s3config },
    403,
  );
  const s3source = (
    await admin.request(`/libraries/${adminLib.id}/sources`, "POST", {
      name: "Synthetic S3",
      kind: "s3",
      config: s3config,
    })
  ).id;
  const first = await admin.request(
    `/libraries/${adminLib.id}/sources/${s3source}/scan`,
    "POST",
    { restart: true },
  );
  check(
    first.item_count === 100 && first.status === "running",
    "first S3 page atomically checkpointed",
  );
  const stale = randomUUID();
  await client.query(
    "INSERT INTO media_items(id,source_id,title,resource) VALUES($1,$2,$3,$4)",
    [stale, s3source, "preexisting-unseen", "allowed/deleted.mp4"],
  );
  await admin.request(
    `/libraries/${adminLib.id}/sources/${s3source}/scan`,
    "POST",
    { restart: false },
    502,
  );
  const failed = await admin.request(
    `/libraries/${adminLib.id}/sources/${s3source}/scan`,
  );
  check(
    failed.item_count === 100 && failed.status === "failed",
    "failed page preserves resumable committed count",
  );
  check(
    (
      await client.query("SELECT available FROM media_items WHERE id=$1", [
        stale,
      ])
    ).rows[0].available,
    "partial failure does not remove old unseen object",
  );
  const done = await admin.request(
    `/libraries/${adminLib.id}/sources/${s3source}/scan`,
    "POST",
    { restart: false },
  );
  check(
    done.item_count === 101 &&
      done.page_count === 2 &&
      done.status === "completed",
    "same scan resumes after failed page",
  );
  check(
    !(
      await client.query("SELECT available FROM media_items WHERE id=$1", [
        stale,
      ])
    ).rows[0].available,
    "completed S3 scan retires genuinely unseen old object",
  );
  check(
    signedRequests >= 104,
    "S3 listing and object metadata requests actually signed",
  );
  check(
    !JSON.stringify(await admin.request("/libraries/" + adminLib.id)).includes(
      "synthetic-owned-local-secret",
    ),
    "credential secret never returned by private library management",
  );
  const audits = await client.query(
    "SELECT action FROM library_permission_audit WHERE library_id=$1",
    [lib.id],
  );
  check(audits.rows.length >= 5, "permission operations audited");
  report.passed = true;
  report.assertions = assertions;
  console.log(`PASS ${assertions} private library matrix assertions`);
} catch (e) {
  report.error = e.stack;
  report.assertions = assertions;
  throw e;
} finally {
  if (objectEndpoint) await new Promise((r) => objectEndpoint.close(r));
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  await client?.end().catch(() => {});
  database.kill("SIGTERM");
  await once(database, "exit");
  report.finished_at = new Date().toISOString();
  report.cleanup = {
    server_closed: !server || server.exitCode !== null,
    postgres_closed: database.exitCode !== null,
    server_port_closed: await verifyClosedPort(httpPort),
    postgres_port_closed: await verifyClosedPort(pgPort),
  };
  await writeFile(root + "/server.log", serverLog);
  await writeFile(root + "/postgres.log", dbLog);
  await writeFile(
    root + "/report.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log("REPORT " + root + "/report.json");
}
