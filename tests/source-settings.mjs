// Real isolated PostgreSQL + Server. Never accepts an existing database URL.
// Build the server first; this fixture performs no builds or installations.
import assert from "node:assert/strict";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedServer } from "./fixtures/server.mjs";
import { withPlaybackAdmission } from "./fixtures/playback-admission.mjs";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const shared = "00000000-0000-0000-0000-000000000001";
let releaseScan;
let reachedScan;
const scanReached = new Promise((done) => (reachedScan = done));
const upstream = createServer(async (_request, response) => {
  reachedScan();
  await new Promise((done) => (releaseScan = done));
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify({
      Items: [{ Id: "late-item", Name: "late scan result" }],
      TotalRecordCount: 1,
    }),
  );
});
await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
const checks = [];
try {
  await isolatedServer("source-settings", async (f) => {
    const admin = f.client();
    const me = await admin.login();
    const ciphertext = (id) =>
      f.sql(`SELECT config_encrypted FROM sources WHERE id=${quote(id)}`);
    const decrypt = (id) => {
      const bytes = Buffer.from(ciphertext(id), "base64");
      const decoder = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"),
        bytes.subarray(0, 12),
      );
      decoder.setAuthTag(bytes.subarray(-16));
      return JSON.parse(
        Buffer.concat([
          decoder.update(bytes.subarray(12, -16)),
          decoder.final(),
        ]),
      );
    };
    const url = "https://media.example.test/old.mp4?signature=never-echo-this";
    const source = await admin.request("/sources", "POST", {
      name: "Original source",
      kind: "http",
      config: {
        url,
        headers: { Authorization: "Bearer fixture-secret" },
        advanced_assets: { schema_version: 1, subtitles: [], fonts: [] },
      },
    });
    const path = `/sources/${source.id}`;
    await admin.request(`/sources/${source.id}/test`, "POST");
    const media = f.sql(
      `SELECT id FROM media_items WHERE source_id=${quote(source.id)}`,
    );
    const baseline = () =>
      JSON.parse(
        f.sql(
          `SELECT jsonb_build_object('cipher',s.config_encrypted,'revision',s.settings_revision,'policy',s.access_policy_revision,'preview',m.preview_generation,'generation',m.library_source_generation,'scan',scan.generation) FROM sources s JOIN media_items m ON m.source_id=s.id JOIN source_scans scan ON scan.source_id=s.id WHERE s.id=${quote(source.id)}`,
        ),
      );
    let detail = await admin.request(path);
    assert.equal(detail.revision, "1");
    assert.equal(detail.library_id, shared);
    assert.equal(detail.credentials.headers_configured, true);
    assert.deepEqual(detail.credentials.header_names, ["Authorization"]);
    assert.equal(detail.credentials.url_redacted, true);
    assert.equal(detail.credentials.url_configured, true);
    assert.equal(Object.hasOwn(detail.config, "url"), false);
    assert.equal(Object.hasOwn(detail.config, "headers"), false);
    assert.equal(Object.hasOwn(detail.config, "token"), false);
    assert.doesNotMatch(
      JSON.stringify(detail),
      /fixture-secret|never-echo-this/,
    );
    const read = await admin.raw(path);
    assert.match(read.headers.get("cache-control"), /no-store/);
    checks.push(
      "detail redacts token, all header values and signed URL queries; no-store response",
    );

    await f.client().request(path, "GET", undefined, 401);
    await f
      .client()
      .request(path, "PATCH", { expected_revision: "1", name: "bad" }, 401);
    await admin.request(
      path,
      "PATCH",
      { expected_revision: "1", name: "bad" },
      403,
      { "x-csrf-token": "" },
    );
    await admin.request(
      path,
      "PATCH",
      { expected_revision: "1", name: "bad" },
      403,
      { Origin: "https://foreign.test" },
    );
    await admin.request("/users", "POST", {
      username: "settings.viewer",
      password: f.password,
    });
    const viewer = f.client();
    await viewer.login("settings.viewer");
    await viewer.request(path, "GET", undefined, 403);
    await viewer.request(
      path,
      "PATCH",
      { expected_revision: "1", name: "bad" },
      403,
    );
    await admin.request(`/sources/${randomUUID()}`, "GET", undefined, 404);
    checks.push("detail and writes enforce login/admin, write CSRF and origin");

    const room = await admin.request("/rooms", "POST", {
      name: "settings references",
    });
    const playlist = randomUUID();
    const session = randomUUID();
    const policy = detail.access_policy_revision;
    withPlaybackAdmission(
      f,
      { client: admin, user: me.id, room: room.id, session },
      `INSERT INTO playlist_items(id,room_id,media_id,sort_order) VALUES(${quote(playlist)},${quote(room.id)},${quote(media)},0); INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES(${quote(session)},${quote(me.id)},${quote(room.id)},${quote(media)},0,${quote(createHash("sha256").update(randomUUID()).digest("hex"))},${quote(JSON.stringify({ source_id: source.id, source_policy_revision: policy }))}::jsonb,clock_timestamp()+interval '10 minutes');`,
    );
    const beforeRename = baseline();
    detail = await admin.request(path, "PATCH", {
      expected_revision: detail.revision,
      name: "  Renamed source  ",
    });
    assert.equal(detail.name, "Renamed source");
    assert.equal(detail.revision, "2");
    assert.equal(detail.config_changed, false);
    assert.equal(detail.rescan_required, false);
    const afterRename = baseline();
    assert.deepEqual(
      { ...afterRename, revision: beforeRename.revision },
      beforeRename,
    );
    assert.equal(
      f.sql(`SELECT stopped FROM playback_sessions WHERE id=${quote(session)}`),
      "f",
    );
    const noop = await admin.request(path, "PATCH", {
      expected_revision: detail.revision,
      name: detail.name,
      config: { advanced_assets: detail.config.advanced_assets },
    });
    assert.equal(noop.revision, detail.revision);
    assert.equal(noop.config_changed, false);
    assert.deepEqual(baseline(), afterRename);
    const stale = await admin.request(
      path,
      "PATCH",
      { expected_revision: "1", name: "Stale tab" },
      409,
    );
    assert.equal(stale.error.code, "SOURCE_CHANGED");
    assert.deepEqual(baseline(), afterRename);
    checks.push(
      "rename preserves ciphertext/playback/cache/scan; exact no-op changes no revisions; stale rename rejected",
    );

    const replacement =
      "https://media.example.test/new.mp4?signature=another-private-value";
    detail = await admin.request(path, "PATCH", {
      expected_revision: detail.revision,
      config: { url: replacement, advanced_assets: null },
    });
    assert.equal(detail.config_changed, true);
    assert.equal(detail.rescan_required, true);
    assert.equal(detail.access_policy_revision, policy + 1);
    assert.equal(detail.config.advanced_assets, null);
    assert.doesNotMatch(
      JSON.stringify(detail),
      /fixture-secret|another-private-value/,
    );
    assert.equal(decrypt(source.id).url, replacement);
    assert.equal(
      decrypt(source.id).headers.Authorization,
      "Bearer fixture-secret",
    );
    assert.equal(
      f.sql(`SELECT resource FROM media_items WHERE id=${quote(media)}`),
      replacement,
    );
    assert.equal(
      f.sql(`SELECT source_id FROM media_items WHERE id=${quote(media)}`),
      source.id,
    );
    assert.equal(
      f.sql(`SELECT media_id FROM playlist_items WHERE id=${quote(playlist)}`),
      media,
    );
    assert.equal(
      f.sql(`SELECT stopped FROM playback_sessions WHERE id=${quote(session)}`),
      "t",
    );
    assert.notEqual(baseline().scan, beforeRename.scan);
    assert.ok(baseline().preview > beforeRename.preview);
    assert.ok(baseline().generation > beforeRename.generation);
    await admin.request(`/sources/${source.id}/test`, "POST");
    assert.equal(
      f.sql(
        `SELECT id FROM media_items WHERE source_id=${quote(source.id)} AND available`,
      ),
      media,
    );
    checks.push(
      "HTTP URL edit keeps source/media/playlist IDs and credentials, retires old playback, fences caches and scans",
    );

    detail = await admin.request(path, "PATCH", {
      expected_revision: detail.revision,
      config: { headers: {} },
    });
    assert.equal(detail.credentials.headers_configured, false);
    assert.deepEqual(decrypt(source.id).headers, {});
    const beforeInvalid = ciphertext(source.id);
    for (const config of [
      { token: "wrong-kind" },
      { headers: null },
      { url: "https://u:p@example.test/video.mp4" },
      { headers: { Host: "forbidden.test" } },
      { advanced_assets: { schema_version: 2, subtitles: [], fonts: [] } },
    ]) {
      await admin.request(
        path,
        "PATCH",
        { expected_revision: detail.revision, config },
        400,
      );
      assert.equal(ciphertext(source.id), beforeInvalid);
    }
    const unknown = await admin.raw(path, {
      method: "PATCH",
      body: { expected_revision: detail.revision, kind: "local" },
    });
    assert.equal(unknown.status, 422);
    const move = await admin.raw(path, {
      method: "PATCH",
      body: { expected_revision: detail.revision, library_id: randomUUID() },
    });
    assert.equal(move.status, 422);
    checks.push(
      "explicit header clear works; malformed or cross-kind config and kind/library mutation rejected atomically",
    );

    const concurrent = await Promise.all(
      ["First editor", "Second editor"].map((name) =>
        admin.raw(path, {
          method: "PATCH",
          body: { expected_revision: detail.revision, name },
        }),
      ),
    );
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
    checks.push(
      "concurrent settings writers produce one winner and one stale conflict",
    );

    const beforePolicy = await admin.request(path);
    await admin.request(`${path}/access-policy`, "POST", {
      expected_revision: beforePolicy.access_policy_revision,
      policy: null,
    });
    const afterPolicy = await admin.request(path);
    assert.equal(
      BigInt(afterPolicy.revision),
      BigInt(beforePolicy.revision) + 1n,
    );
    await admin.request(
      path,
      "PATCH",
      {
        expected_revision: beforePolicy.revision,
        name: "stale before policy change",
      },
      409,
    );
    checks.push(
      "access-policy edits share the settings optimistic-concurrency fence",
    );

    const emby = await admin.request("/sources", "POST", {
      name: "Upstream credentials",
      kind: "emby",
      config: {
        url: "https://emby.example.test",
        user_id: "viewer",
        token: "initial-token",
      },
    });
    const embyPath = `/sources/${emby.id}`;
    let embyDetail = await admin.request(embyPath);
    assert.equal(embyDetail.config.url, "https://emby.example.test");
    assert.equal(embyDetail.credentials.token_configured, true);
    embyDetail = await admin.request(embyPath, "PATCH", {
      expected_revision: embyDetail.revision,
      config: { user_id: "viewer-two" },
    });
    assert.equal(decrypt(emby.id).token, "initial-token");
    embyDetail = await admin.request(embyPath, "PATCH", {
      expected_revision: embyDetail.revision,
      config: { token: "replacement-token" },
    });
    assert.equal(decrypt(emby.id).token, "replacement-token");
    assert.doesNotMatch(JSON.stringify(embyDetail), /replacement-token/);
    embyDetail = await admin.request(embyPath, "PATCH", {
      expected_revision: embyDetail.revision,
      config: { token: "" },
    });
    assert.equal(embyDetail.credentials.token_configured, false);
    assert.equal(decrypt(emby.id).token, "");
    checks.push(
      "upstream tokens support explicit keep/replace/clear without ever echoing secrets",
    );

    const rootA = resolve(f.root, "source-a"),
      rootB = resolve(f.root, "source-b");
    await mkdir(rootA);
    await mkdir(rootB);
    await writeFile(resolve(rootA, "same.mp4"), "fixture");
    await writeFile(resolve(rootB, "same.mp4"), "fixture");
    const local = await admin.request("/sources", "POST", {
      name: "Local folder",
      kind: "local",
      config: { root: rootA },
    });
    await admin.request(`/sources/${local.id}/test`, "POST");
    const localMedia = f.sql(
      `SELECT id FROM media_items WHERE source_id=${quote(local.id)}`,
    );
    let localDetail = await admin.request(`/sources/${local.id}`);
    await admin.request(
      `/sources/${local.id}`,
      "PATCH",
      { expected_revision: localDetail.revision, config: { root: "/etc" } },
      403,
    );
    localDetail = await admin.request(`/sources/${local.id}`, "PATCH", {
      expected_revision: localDetail.revision,
      config: { root: rootB },
    });
    assert.equal(
      f.sql(`SELECT available FROM media_items WHERE id=${quote(localMedia)}`),
      "f",
    );
    await admin.request(`/sources/${local.id}/test`, "POST");
    assert.equal(
      f.sql(
        `SELECT id FROM media_items WHERE source_id=${quote(local.id)} AND available`,
      ),
      localMedia,
    );
    checks.push(
      "local roots enforce MEDIA_ROOT; changed catalogs require rescan and retain matching media IDs",
    );

    const managed = await admin.request("/sources", "POST", {
      name: "Managed agent",
      kind: "agent",
      config: { agent_id: randomUUID() },
    });
    assert.equal(
      (await admin.request(`/sources/${managed.id}`, "GET", undefined, 409))
        .error.code,
      "SOURCE_MANAGED_ELSEWHERE",
    );
    await admin.request(
      `/sources/${managed.id}`,
      "PATCH",
      { expected_revision: "1", name: "no" },
      409,
    );
    const library = randomUUID();
    f.sql(
      `INSERT INTO private_libraries(id,name,owner_id,visibility) VALUES(${quote(library)},'private settings fixture',${quote(me.id)},'private'); UPDATE sources SET library_id=${quote(library)} WHERE id=${quote(emby.id)}`,
    );
    await admin.request(embyPath, "GET", undefined, 409);
    await admin.request(
      embyPath,
      "PATCH",
      { expected_revision: embyDetail.revision, name: "no" },
      409,
    );
    checks.push(
      "shared settings do not edit NAS-managed or private-library sources",
    );

    const delayed = await admin.request("/sources", "POST", {
      name: "Delayed scan",
      kind: "jellyfin",
      config: {
        url: upstreamOrigin,
        user_id: "viewer",
        token: "old-token",
        access_policy: {
          schema_version: 1,
          origins: [{ origin: upstreamOrigin, cidrs: ["127.0.0.1/32"] }],
        },
      },
    });
    const pending = admin.raw(`/sources/${delayed.id}/test`, {
      method: "POST",
    });
    await Promise.race([
      scanReached,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("provider scan did not arrive")), 10000),
      ),
    ]);
    const delayedDetail = await admin.request(`/sources/${delayed.id}`);
    await admin.request(`/sources/${delayed.id}`, "PATCH", {
      expected_revision: delayedDetail.revision,
      config: { token: "new-token" },
    });
    releaseScan();
    const late = await pending;
    assert.equal(late.status, 409);
    assert.equal(
      f.sql(
        `SELECT count(*) FROM media_items WHERE source_id=${quote(delayed.id)}`,
      ),
      "0",
    );
    checks.push(
      "in-flight pre-edit provider scan cannot publish stale results after save",
    );

    await writeFile(
      resolve(f.root, "source-settings-results.json"),
      JSON.stringify({ result: "passed", checks }, null, 2),
    );
    console.log(JSON.stringify({ result: "passed", checks, root: f.root }));
  });
} finally {
  releaseScan?.();
  upstream.closeAllConnections();
  await new Promise((done) => upstream.close(done));
}
