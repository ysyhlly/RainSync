// Fresh owned PostgreSQL + real loopback HTTP reads; no provider network.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { isolatedServer } from "./fixtures/server.mjs";
import { withPlaybackAdmission, testLoginHash } from "./fixtures/playback-admission.mjs";
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const testName =
  "platform_media::delivery::owner::tests::native_delivery_owner_http_fixture";

await isolatedServer("native-delivery-owner", async (f) => {
  const client = f.client(),
    user = await client.login(),
    nonce = randomUUID();
  const records = [];
  const upstream = createServer((request, response) => {
    const name = request.url.split("/").at(-1);
    const record = {
      name,
      method: request.method,
      range: request.headers.range,
      cookie: request.headers.cookie,
      closed: false,
    };
    records.push(record);
    response.once("close", () => {
      record.closed = true;
    });
    if (name.startsWith("send_")) return;
    response.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": "1000000",
    });
    response.flushHeaders();
    response.write(Buffer.alloc(16));
  });
  await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
  try {
    f.sql(
      `CREATE TABLE native_delivery_fixture_identity(id uuid PRIMARY KEY,nonce text NOT NULL);INSERT INTO native_delivery_fixture_identity VALUES('${f.id}','${nonce}');`,
    );
    const cases = [];
    for (const name of [
      "body_close",
      "body_drop",
      "send_get",
      "send_head",
      "send_range_drop",
      "receipt_failure",
      "receipt_suppressed",
      "reject_stopped",
    ]) {
      const room = await client.request("/rooms", "POST", {
        name: `owned native delivery ${name}`,
      });
      const session = randomUUID(),
        media = randomUUID(),
        viewer = randomUUID(),
        token =
          randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
      const login = testLoginHash(f, client);
      f.sql(`INSERT INTO media_items(id,title,resource) VALUES('${media}','平台影片','platform:${media}');
        INSERT INTO room_platform_media(media_id,room_id,provider,content_id,part,cid,title,created_by) VALUES('${media}','${room.id}','bilibili','BV1GJ411x7h7',1,12345,'owned HTTP lifetime fixture','${user.id}');
        UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${media}"'),'{media_generation}','1') WHERE room_id='${room.id}';`);
      const context = {
        version: 1,
        provider: "bilibili",
        media_id: media,
        room_id: room.id,
        user_id: user.id,
        entry_revision: "1",
        credential_mode: "anonymous",
        account_id: null,
        account_revision: null,
      };
      withPlaybackAdmission(
        f,
        { client, user: user.id, room: room.id, session },
        `
        UPDATE playback_requests SET viewer_id='${viewer}',plan_generation=1 WHERE session_id='${session}';
        INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation,auth_login_hash) VALUES('${user.id}','${room.id}','${viewer}',1,'${login}');
        INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,viewer_id,plan_generation,delivery_token_hash,resource,expires_at)
        VALUES('${session}','${user.id}','${room.id}','${media}',1,'${viewer}',1,encode(sha256(convert_to('${token}','UTF8')),'hex'),${quote(JSON.stringify({ encrypted: "owned-native-fixture", native_platform_context: context }))},clock_timestamp()+interval '5 minutes');
      `,
      );
      cases.push({
        name,
        room: room.id,
        session,
        user: user.id,
        login,
        token,
        url: `http://127.0.0.1:${upstream.address().port}/source/${name}`,
      });
    }
    // Each isolatedServer exposes root through its configured owned MEDIA_ROOT.
    const requestFile = resolve(f.env.MEDIA_ROOT, "native-delivery-request.json");
    await writeFile(
      requestFile,
      JSON.stringify({
        id: f.id,
        nonce,
        origin: f.origin,
        cookie: client.cookie,
        csrf: client.csrf,
        cases,
      }),
      "utf8",
    );
    const child = spawn(
      "cargo",
      [
        "test",
        "-p",
        "rainsync-server",
        testName,
        "--",
        "--exact",
        "--ignored",
        "--nocapture",
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...f.env,
          RAINSYNC_ISOLATED_TEST: "1",
          RAINSYNC_NATIVE_DELIVERY_TEST_DATABASE: f.env.DATABASE_URL,
          RAINSYNC_NATIVE_DELIVERY_REQUEST: requestFile,
        },
      },
    );
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    const timeout = setTimeout(() => child.kill(), 180000);
    const result = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    clearTimeout(timeout);
    assert.equal(
      result.code,
      0,
      `native HTTP owner fixture failed: signal=${result.signal}`,
    );
    assert.equal(records.filter((record) => record.name === "reject_stopped").length, 0);
    assert.ok(
      records.every((record) => record.cookie === undefined),
      "loopback native source sees no RainSync login credential",
    );
    assert.ok(
      records.every((record) => record.closed),
      "all owned raw source sockets closed after disposal",
    );
    assert.equal(records.find((record) => record.name === "send_head").method, "HEAD");
    assert.equal(
      records.find((record) => record.name === "send_range_drop").range,
      "bytes=0-31",
    );
    console.log(
      "PASS: real source sockets, deferred HEAD/Range requests, receipt failure/recovery, caller cancellation and denied admission all preserve authoritative room closure",
    );
  } finally {
    upstream.closeAllConnections();
    await new Promise((done) => upstream.close(done));
  }
});
