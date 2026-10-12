import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";

// P20 draft: these assert actual HTTP JSON, not production source strings.
const wireUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const exactKeys = (value, keys) => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
const expectedCover = (mediaId, status, revision) => ({
  status,
  revision,
  url: status === "ready" && revision !== null
    ? `/api/v1/media/${mediaId}/cover?revision=${revision}`
    : null,
  retry_after_ms: status === "queued" || status === "running" ? 2000
    : status === "unavailable" ? 60000 : null,
});
const checkCover = (cover, mediaId, status, revision) => {
  exactKeys(cover, ["status", "revision", "url", "retry_after_ms"]);
  if (revision !== null) assert.match(revision, wireUuid);
  assert.deepEqual(cover, expectedCover(mediaId, status, revision));
};
const checkStates = (value, expected) => {
  exactKeys(value, ["items"]);
  assert.ok(Array.isArray(value.items));
  for (const item of value.items) {
    exactKeys(item, ["media_id", "cover"]);
    assert.match(item.media_id, wireUuid);
    const wanted = expected.get(item.media_id);
    assert.ok(wanted, "response must not add a requested-but-invisible or unrelated ID");
    checkCover(item.cover, item.media_id, wanted.status, wanted.revision);
  }
  const ids = value.items.map(item => item.media_id);
  assert.equal(new Set(ids).size, ids.length, "each visible ID appears once");
  // No ORDER BY exists in this endpoint. Compare sets and per-ID associations;
  // never prescribe input order or UUID order as a new public guarantee.
  assert.deepEqual([...ids].sort(), [...expected.keys()].sort());
};
const checkedJson = async (client, path, options = {}, expectedStatus = 200) => {
  const response = await client.raw(path, options);
  const value = await response.json();
  assert.equal(response.status, expectedStatus);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-request-id") ?? "", wireUuid);
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("retry-after"), null);
  return { value, response };
};
const checkedError = async (client, path, options, status, code) => {
  const { value, response } = await checkedJson(client, path, options, status);
  exactKeys(value, ["error"]);
  exactKeys(value.error, ["code", "message", "retryable", "request_id"]);
  assert.equal(value.error.code, code);
  assert.equal(typeof value.error.message, "string");
  assert.ok(value.error.message.length > 0);
  // Existing dedicated preview queue-full errors are not automatically retryable.
  assert.equal(value.error.retryable, false);
  assert.equal(value.error.request_id, response.headers.get("x-request-id"));
  return value;
};
const coverRevision = (fixture, mediaId) => fixture.sql(
  `SELECT result_revision::text FROM media_previews WHERE media_id='${mediaId}'`,
);

await isolatedMediaStack("media-previews", async f => {
  const admin = f.client(); await admin.login();
  await f.makeClip("first.mp4", { blackSeconds: 2 });
  await f.makeClip("second.mp4"); await f.makeClip("third.mp4");
  const source = await admin.request("/sources", "POST", { name: "preview", kind: "local", config: { root: f.root } });
  await admin.request(`/sources/${source.id}/test`, "POST");
  const media = await admin.request("/media"); const [a,b,c] = media.map(m => m.id);
  const request = ids => admin.request("/media/previews", "POST", { media_ids: ids });
  const before = f.sql("SELECT count(*) FROM playback_sessions");

  // P20-A: validate shape and explicit nulls before any preview job exists.
  const missing = await checkedJson(admin, `/media/previews?ids=${a}`);
  checkStates(missing.value, new Map([[a, { status: "missing", revision: null }]]));
  for (const path of ["/media/previews", "/media/previews?ids="]) {
    checkStates((await checkedJson(admin, path)).value, new Map());
  }
  checkStates((await checkedJson(admin, "/media/previews", {
    method: "POST", body: { media_ids: [] },
  })).value, new Map());

  // P20-B: limit applies to distinct IDs before visibility filtering, for both methods.
  const absentIds = Array.from({ length: 25 }, randomUUID);
  const postIds = ids => checkedJson(admin, "/media/previews", {
    method: "POST", body: { media_ids: ids },
  });
  checkStates((await postIds(absentIds.slice(0, 24))).value, new Map());
  checkStates((await checkedJson(admin, `/media/previews?ids=${absentIds.slice(0, 24).join(",")}`)).value, new Map());
  // 48 input entries but only 24 distinct IDs still pass; a raw-length cap is a regression.
  checkStates((await postIds([...absentIds.slice(0, 24), ...absentIds.slice(0, 24)])).value, new Map());
  checkStates((await checkedJson(admin, `/media/previews?ids=${[...absentIds.slice(0, 24), ...absentIds.slice(0, 24)].join(",")}`)).value, new Map());
  await checkedError(admin, "/media/previews", { method: "POST", body: { media_ids: absentIds } }, 400, "INVALID_REQUEST");
  await checkedError(admin, `/media/previews?ids=${absentIds.join(",")}`, {}, 400, "INVALID_REQUEST");

  // P20-C: real extractor/admission errors keep their existing status and envelope.
  await checkedError(admin, "/media/previews?ids=not-a-uuid", {}, 400, "INVALID_REQUEST");
  await checkedError(admin, `/media/previews?ids=${a},`, {}, 400, "INVALID_REQUEST");
  for (const body of [{}, { media_ids: ["not-a-uuid"] }, { media_ids: [], unexpected: true }]) {
    await checkedError(admin, "/media/previews", { method: "POST", body }, 422, "INVALID_REQUEST");
  }
  await checkedError(admin, "/media/previews", {
    method: "POST", body: new TextEncoder().encode('{"media_ids":'),
  }, 400, "INVALID_REQUEST");
  await checkedError(admin, "/media/previews", {
    method: "POST", body: { media_ids: [] }, headers: { "Content-Type": "text/plain" },
  }, 415, "UNSUPPORTED_MEDIA_TYPE");
  await checkedError(f.client(), `/media/previews?ids=${a}`, {}, 401, "LOGIN_REQUIRED");
  await checkedError(f.client(), "/media/previews", { method: "POST", body: { media_ids: [a] } }, 401, "LOGIN_REQUIRED");
  for (const [headers, code] of [
    [{ "x-csrf-token": "wrong" }, "CSRF_REJECTED"],
    [{ Origin: "https://wrong.invalid" }, "ORIGIN_REJECTED"],
  ]) {
    await checkedError(admin, "/media/previews", { method: "POST", body: { media_ids: [a] }, headers }, 403, code);
  }
  assert.equal(f.sql("SELECT count(*) FROM media_previews"), "0", "empty/hidden/invalid/denied inputs created no queue work");
  assert.equal((await admin.request(`/media/previews?ids=${a}`)).items[0].cover.status, "missing");
  const concurrent = await Promise.all(Array.from({length: 8}, () => request([a,a,randomUUID()])));
  assert.ok(concurrent.every(v => v.items.length === 1 && v.items[0].cover.status === "queued"));
  assert.equal(f.sql("SELECT count(*) FROM media_previews"), "1");

  // P20-D: POST and GET agree on the actual queued revision and null URL.
  const aRevision = coverRevision(f, a);
  for (const value of concurrent) checkStates(value, new Map([[a, { status: "queued", revision: aRevision }]]));
  checkStates((await checkedJson(admin, "/media/previews", {
    method: "POST", body: { media_ids: Array(30).fill(a) },
  })).value, new Map([[a, { status: "queued", revision: aRevision }]]));
  assert.equal(coverRevision(f, a), aRevision, "duplicate enqueue must not replace the current result identity");
  await request([b]);

  // P20-E: shuffled/duplicate/missing requests preserve per-ID results, without an order promise.
  const queuedExpected = new Map([
    [a, { status: "queued", revision: aRevision }],
    [b, { status: "queued", revision: coverRevision(f, b) }],
  ]);
  const firstOrder = (await checkedJson(admin, `/media/previews?ids=${[b, a, b, absentIds[0]].join(",")}`)).value;
  const reverseOrder = (await checkedJson(admin, `/media/previews?ids=${[a, b, a].join(",")}`)).value;
  checkStates(firstOrder, queuedExpected); checkStates(reverseOrder, queuedExpected);
  checkStates((await checkedJson(admin, "/media/previews", {
    method: "POST", body: { media_ids: [b, a, b, absentIds[0]] },
  })).value, queuedExpected);
  assert.equal(f.sql("SELECT count(*) FROM media_previews"), "2");
  await checkedError(admin, "/media/previews", { method: "POST", body: { media_ids: [c] } }, 503, "MEDIA_PREVIEW_QUEUE_FULL");
  assert.equal(f.sql(`SELECT count(*) FROM media_previews WHERE media_id='${c}'`), "0", "full queue remains atomic");
  assert.equal((await admin.request("/media/previews", "POST", {media_ids:[c]}, 503)).error.code, "MEDIA_PREVIEW_QUEUE_FULL");
  await admin.request("/media/previews", "POST", {media_ids:Array.from({length:25},randomUUID)},400);
  await f.client().request(`/media/${a}/cover?revision=${randomUUID()}`,"GET",undefined,401);
  await f.startWorker();
  const cover = await f.waitForPreview(a);
  await f.waitForPreview(b);

  // P20-F: verify exact shared cover projection through preview GET and existing media reads.
  checkCover(cover, a, "ready", coverRevision(f, a));
  checkStates((await checkedJson(admin, `/media/previews?ids=${a}`)).value,
    new Map([[a, { status: "ready", revision: cover.revision }]]));
  const readyDetail = await checkedJson(admin, `/media/${a}`);
  assert.deepEqual(readyDetail.value.cover, cover);
  const readyList = await checkedJson(admin, "/media");
  assert.deepEqual(readyList.value.find(item => item.id === a)?.cover, cover);
  assert.match(cover.url, /^\/api\/v1\/media\/[0-9a-f-]+\/cover\?revision=[0-9a-f-]+$/);
  const image = await admin.raw(cover.url.replace("/api/v1", ""));
  assert.equal(image.status,200); assert.equal(image.headers.get("content-type"),"image/webp");
  assert.equal(image.headers.get("cache-control"),"private, no-cache");

  assert.equal(image.headers.get("etag"), `"${f.sql(`SELECT image_sha256 FROM media_previews WHERE media_id='${a}'`)}"`);
  assert.match(image.headers.get("x-request-id") ?? "", wireUuid);
  const bytes=Buffer.from(await image.arrayBuffer());
  assert.equal(bytes.toString("ascii",0,4),"RIFF"); assert.equal(bytes.readUInt32LE(4)+8,bytes.length); assert.ok(bytes.length<=262144);
  assert.equal((await admin.raw(cover.url.replace("/api/v1",""),{headers:{"If-None-Match":image.headers.get("etag")}})).status,304);
  assert.equal((await f.client().raw(cover.url.replace("/api/v1",""),{headers:{"If-None-Match":image.headers.get("etag")}})).status,401);
  await admin.request(`/media/${a}/cover?revision=${randomUUID()}`,"GET",undefined,409);

  // P20-G: conditional image response still authenticates before returning 304.
  const notModified = await admin.raw(cover.url.replace("/api/v1", ""), { headers: { "If-None-Match": image.headers.get("etag") } });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get("etag"), image.headers.get("etag"));
  assert.equal(notModified.headers.get("cache-control"), "private, no-cache");
  assert.equal((await notModified.arrayBuffer()).byteLength, 0);
  await checkedError(f.client(), cover.url.replace("/api/v1", ""),
    { headers: { "If-None-Match": image.headers.get("etag") } }, 401, "LOGIN_REQUIRED");
  await checkedError(admin, `/media/${a}/cover?revision=${randomUUID()}`, {}, 409, "MEDIA_PREVIEW_STALE");
  assert.equal(f.sql("SELECT count(*) FROM playback_sessions"),before);
  assert.equal(f.sql("SELECT count(*) FROM media_jobs"),"0");
  const generation = f.sql(`SELECT preview_generation FROM media_items WHERE id='${a}'`);
  await admin.request(`/media/${a}/personal-title`,"PUT",{title:"alias",expected_revision:"0"});
  assert.equal(f.sql(`SELECT preview_generation FROM media_items WHERE id='${a}'`),generation);
  await request([c]); await f.waitForPreview(c);
  await f.stopWorker();
  // An expired attempt is reclaimable; no input grant is valid without an owned execution.
  const oldAttempt=randomUUID();
  f.sql(`UPDATE media_previews SET status='running',image=NULL,image_sha256=NULL,owner_id='${randomUUID()}',attempt_id='${oldAttempt}',lease_until=now()-interval '1 second' WHERE media_id='${a}'`);

  // P20-H: reuse the original expired-running fixture; no new owner or status is forged here.
  checkStates((await checkedJson(admin, `/media/previews?ids=${a}`)).value,
    new Map([[a, { status: "running", revision: coverRevision(f, a) }]]));
  await f.startWorker(); await f.waitForPreview(a);
  assert.notEqual(f.sql(`SELECT attempt_id FROM media_previews WHERE media_id='${a}'`),oldAttempt);
  assert.equal((await fetch(`${f.workerOrigin}/preview-input/${oldAttempt}/source`)).status,401);
  f.sql(`UPDATE media_items SET preview_generation=preview_generation+1 WHERE id='${a}'`);
  await admin.request(cover.url.replace("/api/v1",""),"GET",undefined,409);
  assert.equal((await admin.request(`/media/previews?ids=${a}`)).items[0].cover.status,"missing");

  // The stale join must produce explicit nulls, not leak the old result revision.
  checkStates((await checkedJson(admin, `/media/previews?ids=${a}`)).value,
    new Map([[a, { status: "missing", revision: null }]]));
  await request([a]); await f.waitForPreview(a);
  await f.startServer(); assert.equal((await admin.request(`/media/${a}`)).cover.status,"ready");
  await f.stopWorker();
  console.log(execFileSync(resolve(f.target,"examples",`preview_queue${process.platform==="win32"?".exe":""}`),[],{env:{...process.env,RAINSYNC_ISOLATED_TEST:"1",RAINSYNC_FIXTURE_DATABASE:f.env.DATABASE_URL},encoding:"utf8",windowsHide:true,timeout:30000}));

  // P20-I: the existing production preview_queue example ends with an unavailable
  // oversized-output result. Read that real result through HTTP; do not invent an image.
  const unavailableId = f.sql(`SELECT p.media_id::text FROM media_previews p JOIN media_items m ON m.id=p.media_id WHERE m.source_id='${source.id}' AND m.resource='replacement' AND p.status='unavailable'`);
  assert.match(unavailableId, wireUuid);
  checkStates((await checkedJson(admin, `/media/previews?ids=${unavailableId}`)).value,
    new Map([[unavailableId, { status: "unavailable", revision: coverRevision(f, unavailableId) }]]));
  assert.equal(f.sql("SELECT count(*) FROM playback_sessions"), before);
  assert.equal(f.sql("SELECT count(*) FROM media_jobs"), "0");
  console.log("PASS: authenticated queue dedup, capacity, independent Worker decoding, private images/ETag, expired lease recovery, source invalidation, restart, no playback sessions");
}, {env:{MEDIA_PREVIEW_QUEUE_LIMIT:"2"}});
