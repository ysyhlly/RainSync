import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import WebSocket from "ws";
import { isolatedServer } from "./fixtures/server.mjs";

await isolatedServer("media-titles", async (f) => {
  const admin = f.client(); await admin.login();
  for (const username of ["alice", "bob"]) await admin.request("/users", "POST", { username, password: "Fixture-pass-123" });
  const alice = f.client(), bob = f.client();
  await alice.login("alice", "Fixture-pass-123"); await bob.login("bob", "Fixture-pass-123");
  const source = await admin.request("/sources", "POST", { name: "titles", kind: "local", config: { root: f.root } });
  const clip = Buffer.from(await readFile(new URL("./fixtures/browser-video.base64", import.meta.url), "utf8"), "base64");
  await writeFile(resolve(f.root, "original.mp4"), clip);
  await admin.request(`/sources/${source.id}/test`, "POST");
  const id = (await admin.request("/media"))[0].id;
  const personal = (client, title, revision, status = 200, extra = {}) => client.request(`/media/${id}/personal-title`, "PUT", { title, expected_revision: revision, ...extra }, status);
  const shared = (client, title, revision, status = 200) => client.request(`/admin/media/${id}/shared-title`, "PUT", { title, expected_revision: revision }, status);
  await shared(admin, " 全站名称 🎬 ", "0");
  await personal(alice, "Alice 的影片", "0"); await personal(bob, "Bob 的影片", "0");
  for (const [client, expected] of [[admin, "全站名称 🎬"], [alice, "Alice 的影片"], [bob, "Bob 的影片"]]) {
    const detail = await client.request(`/media/${id}`);
    assert.equal(detail.title, expected); assert.equal(detail.original_title, "original");
    assert.equal(typeof detail.shared_title_revision, "string");
    assert.equal((await client.request(`/media?search=${encodeURIComponent(expected)}`))[0].title, expected);
    assert.equal((await client.raw(`/media/${id}`)).headers.get("cache-control"), "no-store");
  }
  assert.equal((await bob.request("/media?search=Alice")).length, 0);
  assert.equal((await shared(bob, "forbidden", "1", 403)).error.code, "ADMIN_REQUIRED");
  await personal(alice, null, "1");
  assert.equal((await alice.request(`/media/${id}`)).title, "全站名称 🎬");
  assert.equal((await personal(alice, "stale", "0", 409)).error.code, "MEDIA_TITLE_CONFLICT");
  const race = await Promise.all(["one", "two"].map(title => alice.raw(`/media/${id}/personal-title`, { method: "PUT", body: { title, expected_revision: "2" } })));
  assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
  // A first-write race must also have exactly one winner.
  const firstRace = await Promise.all(["one", "two"].map(title => admin.raw(`/media/${id}/personal-title`, { method: "PUT", body: { title, expected_revision: "0" } })));
  assert.deepEqual(firstRace.map(r => r.status).sort(), [200, 409]);
  await personal(admin, null, "1");
  for (const title of ["", "  ", "a\nb", "a\u0000b", "🎬".repeat(201)]) assert.equal((await personal(alice, title, "3", 400)).error.code, "MEDIA_TITLE_INVALID");
  for (const revision of ["-1", "1.0", "900000000000000000000", 3, ""]) await personal(alice, "valid", revision, 400);
  await personal(alice, "injection", "3", 400, { user_id: randomUUID() });
  for (const headers of [{ "x-csrf-token": "bad" }, { Origin: "https://wrong.invalid" }]) {
    const response = await alice.raw(`/media/${id}/personal-title`, { method: "PUT", body: { title: "bad", expected_revision: "3" }, headers });
    assert.equal(response.status, 403);
  }
  await f.client().request(`/media/${id}`, "GET", undefined, 401);
  await alice.request(`/media/${randomUUID()}`, "GET", undefined, 404);
  const room = await admin.request("/rooms", "POST", { name: "title room" });
  await admin.request(`/rooms/${room.id}/playlist`, "POST", { media_id: id });
  await bob.request(`/rooms/${room.id}/playlist`, "GET", undefined, 403);
  const invite = await admin.request(`/rooms/${room.id}/invites`, "POST");
  await bob.request(`/rooms/${room.id}/join`, "POST", { token: invite.token });
  assert.equal((await bob.request(`/rooms/${room.id}/playlist`))[0].title, "Bob 的影片");
  await admin.request(`/sources/${source.id}/test`, "POST");
  assert.equal((await bob.request(`/media/${id}`)).title, "Bob 的影片");
  await f.startServer();
  assert.equal((await bob.request(`/media/${id}`)).title, "Bob 的影片");
  await shared(admin, null, "1");
  assert.equal((await admin.request(`/media/${id}`)).title, "original");
  await personal(bob, "🎬".repeat(200), "1");
  f.sql(`UPDATE media_items SET available=false WHERE id='${id}'`);
  await bob.request(`/media/${id}`, "GET", undefined, 404); await personal(bob, "no", "2", 404);
  assert.equal((await bob.request(`/rooms/${room.id}/playlist`)).length, 0);

  // Exercise real scan/index entry points, not manual title UPDATEs.
  let upstreamTitle = "upstream original";
  const upstream = createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ Items: [{ Id: "fixture-item", Name: upstreamTitle }], TotalRecordCount: 1 })); });
  await new Promise(r => upstream.listen(0, "127.0.0.1", r));
  try {
    for (const kind of ["jellyfin", "emby"]) {
      const s = await admin.request("/sources", "POST", { name: kind, kind, config: { url: `http://127.0.0.1:${upstream.address().port}`, token: "fixture", user_id: "fixture" } });
      await admin.request(`/sources/${s.id}/test`, "POST");
      const mediaId = f.sql(`SELECT id FROM media_items WHERE source_id='${s.id}'`);
      await alice.request(`/media/${mediaId}/personal-title`, "PUT", { title: "preserved", expected_revision: "0" });
      upstreamTitle = "rescanned original";
      await admin.request(`/sources/${s.id}/test`, "POST");
      const detail = await alice.request(`/media/${mediaId}`);
      assert.equal(detail.title, "preserved"); assert.equal(detail.original_title, upstreamTitle);
    }
  } finally { await new Promise(r => upstream.close(r)); }
  const agent = await admin.request("/agents", "POST", { name: "index fixture" });
  const paired = await f.client().request("/agents/pair", "POST", { code: agent.pair_code });
  const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/agents/ws", { headers: { Authorization: `Bearer ${paired.token}` } });
  try {
    await new Promise((r, reject) => { ws.once("open", r); ws.once("error", reject); });
    const index = title => new Promise((r, reject) => {
      const timer = setTimeout(() => reject(new Error("index timeout")), 5000);
      ws.once("message", bytes => { clearTimeout(timer); assert.equal(JSON.parse(bytes).type, "INDEX_ACK"); r(); });
      ws.send(JSON.stringify({ type: "INDEX", items: [{ resource: "nas.mp4", title }], final: true, sequence: 0, snapshot: randomUUID() }));
    });
    await index("NAS original");
    const mediaId = f.sql(`SELECT id FROM media_items WHERE source_id='${agent.id}'`);
    await alice.request(`/media/${mediaId}/personal-title`, "PUT", { title: "NAS alias", expected_revision: "0" });
    await index("NAS rescanned");
    const detail = await alice.request(`/media/${mediaId}`);
    assert.equal(detail.title, "NAS alias"); assert.equal(detail.original_title, "NAS rescanned");
  } finally { ws.terminate(); }
  console.log("PASS: per-viewer titles, scope permissions, CAS including first insert, validation, CSRF, private cache, search, playlist, local/upstream/NAS rescans and restart");
});
