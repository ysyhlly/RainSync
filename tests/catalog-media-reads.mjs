// The same ordinary HTTP/DB matrix runs on the pre-move and extracted backend.
// All writes below arrange owned synthetic rows; no provider or playback runs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { catalogFixture } from "./fixtures/catalog-evidence.mjs";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

await catalogFixture({
  name: "catalog-media-reads",
  coordinator: "tests/catalog-media-reads.mjs",
  timeout: 120000,
  env: { PRIVATE_LIBRARIES_ENABLED: "true" },
  limitations: ["Owned synthetic catalog reads only; no remote provider, media playback, scan, preview queue or held-lock experiment"],
}, async (f, report, signal) => {
  const record = (name) => report.checks.push({ name, result: "passed" });
  const admin = f.client();
  await admin.login();
  const users = {}, clients = {};
  for (const name of ["owner", "browser", "play-only", "room-only", "revoked", "stranger"]) {
    const username = `catalog-read-${name}`;
    users[name] = (await admin.request("/users", "POST", { username, password: f.password })).id;
    clients[name] = f.client();
    await clients[name].login(username);
  }
  const owner = clients.owner;
  const library = await owner.request("/libraries", "POST", { name: "Private catalog read fixture" });
  const otherLibrary = await owner.request("/libraries", "POST", { name: "Other private read fixture" });
  const privateSource = (await owner.request(`/libraries/${library.id}/sources`, "POST", {
    name: "Private read source", kind: "http",
    config: { url: "https://media.example.test/fixture.mp4", headers: { "X-Fixture": "catalog-configuration-must-stay-private" } },
  })).id;
  const otherSource = (await owner.request(`/libraries/${otherLibrary.id}/sources`, "POST", {
    name: "Other private read source", kind: "http", config: { url: "https://media.example.test/other.mp4" },
  })).id;
  const sharedSource = randomUUID(), agent = randomUUID(), unavailable = randomUUID(), revokedMedia = randomUUID(), otherMedia = randomUUID();
  f.sql(`INSERT INTO sources(id,name,kind,config_encrypted) VALUES(${quote(sharedSource)},'Shared read source','local','owned-unused-config'),(${quote(agent)},'Revoked read agent','agent','owned-unused-config');
    INSERT INTO agents(id,name,revoked) VALUES(${quote(agent)},'Revoked read agent',true);
    INSERT INTO media_items(id,source_id,title,resource) SELECT gen_random_uuid(),${quote(privateSource)},'catalog-paging-private-'||n,'private-'||n||'.mp4' FROM generate_series(1,350) n;
    INSERT INTO media_items(id,source_id,title,resource) SELECT gen_random_uuid(),${quote(sharedSource)},'shared-visible-'||n,'shared-'||n||'.mp4' FROM generate_series(1,17) n;
    INSERT INTO media_items(id,source_id,title,resource,available) VALUES(${quote(unavailable)},${quote(privateSource)},'catalog-paging-private-unavailable','unavailable.mp4',false),(${quote(revokedMedia)},${quote(agent)},'revoked-agent-sentinel','revoked.mp4',true),(${quote(otherMedia)},${quote(otherSource)},'other-library-sentinel','other.mp4',true);
    INSERT INTO library_grants(library_id,user_id,browse,play,expires_at,created_by) VALUES
      (${quote(library.id)},${quote(users.browser)},true,false,clock_timestamp()+interval '1 hour',${quote(users.owner)}),
      (${quote(library.id)},${quote(users["play-only"])},false,true,clock_timestamp()+interval '1 hour',${quote(users.owner)}),
      (${quote(library.id)},${quote(users.revoked)},true,false,clock_timestamp()+interval '1 hour',${quote(users.owner)});`);
  const privateIds = JSON.parse(f.sql(`SELECT json_agg(id ORDER BY id) FROM media_items WHERE source_id=${quote(privateSource)} AND available`));
  const sharedIds = JSON.parse(f.sql(`SELECT json_agg(id ORDER BY id) FROM media_items WHERE source_id=${quote(sharedSource)} AND available`));
  assert.equal(privateIds.length, 350);
  assert.equal(sharedIds.length, 17);
  const media = privateIds[0], privatePath = `/libraries/${library.id}/media`;
  const params = (values = {}) => new URLSearchParams(values).toString();
  const list = (client, path, values = {}, status = 200) => client.request(path + (Object.keys(values).length ? `?${params(values)}` : ""), "GET", undefined, status);
  const ids = (rows) => rows.map((row) => row.id);
  const safe = (value) => assert.ok(!JSON.stringify(value).includes("catalog-configuration-must-stay-private"));

  for (const path of ["/media", privatePath]) {
    assert.equal((await list(owner, path)).length, 100);
    assert.equal((await list(owner, path, { limit: "9999" })).length, 200);
    for (const limit of ["0", "-5", "1"]) assert.equal((await list(owner, path, { limit })).length, 1);
    record(`${path === "/media" ? "flat" : "private"} listing keeps default/max/min page bounds`);
    const seen = [];
    let after;
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      signal.throwIfAborted();
      const rows = await list(owner, path, { search: "CATALOG-PAGING-PRIVATE", limit: "100", ...(after ? { after } : {}) });
      safe(rows);
      assert.ok(rows.length <= 100);
      seen.push(...ids(rows));
      if (rows.length < 100) break;
      after = rows.at(-1).id;
    }
    assert.deepEqual(seen, privateIds);
    assert.equal(new Set(seen).size, 350);
    assert.deepEqual(await list(owner, path, { search: "catalog-paging-private", after: privateIds.at(-1) }), []);
    record(`${path === "/media" ? "flat" : "private"} search and UUID pages are stable without omissions or duplicates`);
  }
  assert.deepEqual(ids(await list(owner, privatePath, { limit: "200" })), privateIds.slice(0, 200));
  assert.ok(!(await list(owner, privatePath, { search: "other-library-sentinel" })).length);
  record("private listing stays within the requested library");

  const room = await owner.request("/rooms", "POST", { name: "Read-only visibility room" });
  f.sql(`INSERT INTO room_members(room_id,user_id) VALUES(${quote(room.id)},${quote(users["room-only"])});`);
  await owner.request(`/libraries/${library.id}/room-shares`, "POST", {
    room_id: room.id, media_id: media, mode: "room_members", expires_in_minutes: 60,
    expected_revision: (await owner.request(`/libraries/${library.id}`)).revision,
  });
  assert.equal(f.sql(`SELECT library_media_allowed(${quote(users["room-only"])},${quote(media)},'play',${quote(room.id)})`), "t");
  assert.equal(f.sql(`SELECT library_media_allowed(${quote(users["play-only"])},${quote(media)},'play',NULL)`), "t");
  assert.equal(f.sql(`SELECT library_media_allowed(${quote(users.browser)},${quote(media)},'play',NULL)`), "f");
  for (const [name, reader] of [["administrator", admin], ["stranger", clients.stranger], ["play-only", clients["play-only"]], ["room-share-only", clients["room-only"]]]) {
    assert.deepEqual(ids(await list(reader, "/media", { limit: "200" })), sharedIds);
    const denied = await list(reader, privatePath, {}, 404);
    assert.equal(denied.error.code, "LIBRARY_NOT_FOUND");
    const hidden = await reader.request(`/media/${media}`, "GET", undefined, 404);
    assert.equal(hidden.error.code, "MEDIA_NOT_FOUND");
    safe(denied); safe(hidden);
    record(`${name} cannot enumerate or read private catalog media`);
  }
  assert.deepEqual(ids(await list(clients.stranger, "/media", { user_id: users.owner, limit: "200" })), sharedIds);
  await list(clients.stranger, privatePath, { user_id: users.owner }, 404);
  await clients.stranger.request(`/media/${media}?user_id=${users.owner}`, "GET", undefined, 404);
  record("caller-supplied user IDs never select another viewer's catalog");
  assert.equal((await list(clients.browser, privatePath)).length, 100);
  assert.equal((await clients.browser.request(`/media/${media}`)).id, media);
  record("browse-only permission opens catalog reads without requiring play");

  f.sql(`UPDATE media_items SET shared_title='shared-title-choice',shared_title_revision=1 WHERE id=${quote(media)};
    INSERT INTO media_user_titles(user_id,media_id,title,revision) VALUES(${quote(users.browser)},${quote(media)},'viewer-only-choice',1);`);
  for (const path of ["/media", privatePath]) {
    const ownView = await list(clients.browser, path, { search: "VIEWER-ONLY-CHOICE" });
    assert.deepEqual(ids(ownView), [media]);
    assert.equal(ownView[0].title, "viewer-only-choice");
    assert.deepEqual(await list(owner, path, { search: "viewer-only-choice" }), []);
    const sharedView = await list(owner, path, { search: "shared-title-choice" });
    assert.deepEqual(ids(sharedView), [media]);
    assert.equal(sharedView[0].title, "shared-title-choice");
  }
  const personalDetail = await clients.browser.request(`/media/${media}`), ownerDetail = await owner.request(`/media/${media}`);
  assert.equal(personalDetail.personal_title, "viewer-only-choice");
  assert.equal(personalDetail.personal_title_revision, "1");
  assert.equal(ownerDetail.personal_title, null);
  assert.equal(ownerDetail.shared_title_revision, "1");
  safe(personalDetail); safe(ownerDetail);
  record("flat/private search and detail preserve viewer-specific title precedence");
  for (const path of ["/media", privatePath, `/media/${media}`]) {
    const response = await owner.raw(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    await response.arrayBuffer();
  }
  record("all three read routes preserve private no-store responses");

  for (const path of ["/media", privatePath, `/media/${media}`]) await f.client().request(path, "GET", undefined, 401);
  await owner.request(`/libraries/${randomUUID()}/media`, "GET", undefined, 404);
  await owner.request(`/media/${randomUUID()}`, "GET", undefined, 404);
  await owner.request(`/media/${unavailable}`, "GET", undefined, 404);
  await owner.request(`/media/${revokedMedia}`, "GET", undefined, 404);
  assert.deepEqual(await list(owner, "/media", { search: "revoked-agent-sentinel" }), []);
  assert.deepEqual(await list(owner, privatePath, { search: "unavailable" }), []);
  record("unauthenticated, absent, unavailable and revoked-agent reads remain denied");

  assert.equal((await clients.revoked.request(`/media/${media}`)).id, media);
  f.sql(`DELETE FROM library_grants WHERE library_id=${quote(library.id)} AND user_id=${quote(users.revoked)};`);
  await list(clients.revoked, privatePath, {}, 404);
  await clients.revoked.request(`/media/${media}`, "GET", undefined, 404);
  assert.deepEqual(await list(clients.revoked, "/media", { search: "catalog-paging-private" }), []);
  record("grant revocation fences all subsequent read surfaces");

  f.sql(`UPDATE library_grants SET expires_at=clock_timestamp()+interval '3 seconds' WHERE library_id=${quote(library.id)} AND user_id=${quote(users.browser)};`);
  assert.equal((await clients.browser.request(`/media/${media}`)).id, media);
  await f.waitForSql(`SELECT expires_at<=clock_timestamp() FROM library_grants WHERE library_id=${quote(library.id)} AND user_id=${quote(users.browser)}`, "t", 10000);
  await list(clients.browser, privatePath, {}, 404);
  await clients.browser.request(`/media/${media}`, "GET", undefined, 404);
  assert.deepEqual(await list(clients.browser, "/media", { search: "viewer-only-choice" }), []);
  record("natural grant expiry is observed on fresh list and detail requests");

  const physical = f.sql(`SELECT count(*) FROM media_items WHERE source_id IN(${quote(privateSource)},${quote(otherSource)})`);
  f.sql(`UPDATE sources SET deleted_at=clock_timestamp() WHERE id=${quote(privateSource)};`);
  assert.deepEqual(await list(owner, privatePath), []);
  await owner.request(`/media/${media}`, "GET", undefined, 404);
  assert.deepEqual(await list(owner, "/media", { search: "catalog-paging-private" }), []);
  record("source tombstones hide indexed media without changing private-library existence");
  f.sql(`UPDATE private_libraries SET deleted_at=clock_timestamp() WHERE id=${quote(otherLibrary.id)};`);
  await owner.request(`/libraries/${otherLibrary.id}/media`, "GET", undefined, 404);
  await owner.request(`/media/${otherMedia}`, "GET", undefined, 404);
  assert.deepEqual(await list(owner, "/media", { search: "other-library-sentinel" }), []);
  assert.equal(f.sql(`SELECT count(*) FROM media_items WHERE source_id IN(${quote(privateSource)},${quote(otherSource)})`), physical);
  record("library tombstones hide reads while media identities remain stored");
  assert.equal(f.sql("SELECT count(*) FROM playback_sessions"), "0");
  assert.equal(f.sql("SELECT count(*) FROM media_jobs"), "0");
  assert.equal(f.sql("SELECT count(*) FROM media_previews"), "0");
  record("catalog reads create no playback, media-job or preview work");
});
