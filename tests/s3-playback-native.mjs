// Real Server/Worker/PostgreSQL playback against an owned synthetic S3 origin.
// No existing DB/account/media, external S3, presigned URL or object mutation.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

assert.ok(
  process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
  "Use a new owned native PostgreSQL fixture",
);
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "Set an owned artifact directory");
const ACCESS = "SYNTHETICPLAYBACKACCESS",
  SECRET = "synthetic-owned-playback-secret";
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const uri = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const report = {
  schema_version: 1,
  started_at: new Date().toISOString(),
  result: "failed",
  scope:
    "Owned synthetic S3 + actual Server/Worker/native PostgreSQL, generated H264; no real service/account acceptance",
  tests: [],
  requests: [],
};
let fixture,
  upstream,
  upstreamPort,
  peer,
  failure,
  phase = "setup",
  fixtureFailure;
const workerPids = [],
  workerCloseRecords = [],
  timers = new Set();
async function check(name, run) {
  const row = { name, result: "failed" };
  report.tests.push(row);
  const start = Date.now();
  Object.assign(row, await run(), {
    result: "passed",
    elapsed_ms: Date.now() - start,
  });
  console.log(`PASS ${name}`);
}
function verifySigV4(request) {
  const auth = request.headers.authorization ?? "";
  const parsed =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+),SignedHeaders=([^,]+),Signature=([a-f0-9]{64})$/.exec(
      auth,
    );
  if (!parsed || parsed[1] !== ACCESS) return false;
  const date = request.headers["x-amz-date"],
    empty = digest("");
  if (
    !date ||
    parsed[2] !== `${date.slice(0, 8)}/us-east-1/s3/aws4_request` ||
    request.headers["x-amz-content-sha256"] !== empty
  )
    return false;
  const names = parsed[3].split(";");
  if (
    names.join(";") !== [...names].sort().join(";") ||
    !names.includes("host")
  )
    return false;
  const headers = names
    .map(
      (name) =>
        `${name}:${String(request.headers[name] ?? "")
          .trim()
          .replace(/\s+/g, " ")}\n`,
    )
    .join("");
  const url = new URL(request.url, "http://owned.invalid");
  const query = [...url.searchParams]
    .map(([name, value]) => [uri(name), uri(value)])
    .sort((a, b) =>
      a[0] < b[0]
        ? -1
        : a[0] > b[0]
          ? 1
          : a[1] < b[1]
            ? -1
            : a[1] > b[1]
              ? 1
              : 0,
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonical = `${request.method}\n${url.pathname}\n${query}\n${headers}\n${parsed[3]}\n${empty}`;
  const signed = `AWS4-HMAC-SHA256\n${date}\n${parsed[2]}\n${digest(canonical)}`;
  const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
  const key = hmac(
    hmac(hmac(hmac(`AWS4${SECRET}`, date.slice(0, 8)), "us-east-1"), "s3"),
    "aws4_request",
  );
  return createHmac("sha256", key).update(signed).digest("hex") === parsed[4];
}
async function roomControl(f, client, room) {
  const socket = new WebSocket(
    f.origin.replace("http:", "ws:") + "/api/v1/ws",
    { headers: { Origin: f.origin, Cookie: client.cookie } },
  );
  peer = socket;
  const frames = [];
  socket.on("message", (bytes) => frames.push(JSON.parse(bytes)));
  const next = async (type, predicate = () => true) => {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const i = frames.findIndex((v) => v.type === type && predicate(v));
      if (i >= 0) return frames.splice(i, 1)[0];
      await delay(10);
    }
    throw Error(`Missing ${type}: ${JSON.stringify(frames)}`);
  };
  await new Promise((done, reject) => {
    socket.once("open", done);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
  const snapshot = await next("SNAPSHOT");
  let state = snapshot.state;
  return async (media) => {
    const command = {
      protocol_version: 1,
      room_id: room.id,
      command_id: randomUUID(),
      control_epoch: snapshot.control_epoch.id,
      expected_revision: state.revision,
      media_generation: state.media_generation,
      type: "CHANGE_MEDIA",
      payload: { media_id: media.id },
    };
    socket.send(JSON.stringify(command));
    const answer = await next(
      "ACK",
      (v) => v.command_id === command.command_id,
    );
    state = answer.state;
    assert.equal(state.media_id, media.id);
    return state.media_generation;
  };
}
async function errorResponse(response, status, code) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  if (code) assert.equal(body.error.code, code);
  return body;
}

try {
  await isolatedMediaStack(
    "s3-playback-native",
    async (f) => {
      fixture = f;
      try {
        report.fixture = { id: f.id, postgres: f.postgresDiagnostics() };
        report.binaries = await Promise.all(
          ["rainsync-server", "rainsync-media-worker"].map(async (name) => ({
            name,
            path: resolve(f.target, name),
            sha256: await fileDigest(resolve(f.target, name)),
          })),
        );
        report.coordinator_inputs = await Promise.all(
          [
            "tests/s3-playback-native.mjs",
            "tests/fixtures/media-stack.mjs",
            "tests/fixtures/server.mjs",
            "tests/fixtures/postgres.mjs",
            "deploy/owned-process.mjs",
          ].map(async (path) => ({
            path,
            sha256: await fileDigest(resolve(path)),
          })),
        );
        const clip = await readFile(
          await f.makeClip("owned-s3.mp4", { pictureSeconds: 2 }),
        );
        const replacement = Buffer.from(clip),
          header = replacement.indexOf(Buffer.from("mvhd"));
        assert.ok(header > 0);
        replacement[header + 11] ^= 1;
        report.media = {
          generated: true,
          codec: "H264",
          bytes: clip.length,
          sha256: digest(clip),
          replacement_sha256: digest(replacement),
        };
        const objects = new Map(
          [
            "versioned",
            "unversioned",
            "deleted",
            "permission",
            "wrong-version",
            "redirect",
          ].map((name) => [
            `allowed/${name}.mp4`,
            { name, current: "a", deleted: false, denied: false },
          ]),
        );
        let slow = false;
        upstream = createServer((request, response) => {
          try {
            const url = new URL(request.url, "http://owned.invalid"),
              key = decodeURIComponent(
                url.pathname.replace(/^\/synthetic-bucket\//, ""),
              );
            const signed = verifySigV4(request),
              row = {
                phase,
                method: request.method,
                key,
                version_id: url.searchParams.get("versionId"),
                range: request.headers.range ?? null,
                if_match: request.headers["if-match"] ?? null,
                if_range: request.headers["if-range"] ?? null,
                signed,
                status: null,
                body_bytes: 0,
              };
            report.requests.push(row);
            if (!signed) {
              row.status = 403;
              response.writeHead(403, { "Content-Length": 0 });
              response.end();
              return;
            }
            if (url.searchParams.get("list-type") === "2") {
              const entries = [...objects].filter(([, v]) => !v.deleted);
              const xml = `<ListBucketResult><Name>synthetic-bucket</Name><Prefix>allowed%2F</Prefix><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>${entries.map(([key, object]) => `<Contents><Key>${uri(key)}</Key><ETag>"s3-${object.current}"</ETag><Size>${clip.length}</Size><LastModified>2026-10-05T00:00:00Z</LastModified></Contents>`).join("")}</ListBucketResult>`;
              row.status = 200;
              response.writeHead(200, {
                "Content-Type": "application/xml",
                "Content-Length": Buffer.byteLength(xml),
              });
              response.end(xml);
              return;
            }
            const object = objects.get(key);
            if (!object || object.deleted || object.denied) {
              row.status = object?.denied ? 403 : 404;
              response.writeHead(row.status, { "Content-Length": 0 });
              response.end();
              return;
            }
            if (object.name === "redirect" && phase === "redirect-negative") {
              row.status = 307;
              response.writeHead(307, {
                Location: "/synthetic-bucket/allowed/versioned.mp4",
                "Content-Length": 0,
              });
              response.end();
              return;
            }
            const versioned = object.name !== "unversioned",
              selected = url.searchParams.get("versionId");
            let version = selected?.endsWith("b")
              ? "b"
              : selected?.endsWith("a")
                ? "a"
                : object.current;
            const bytes = version === "a" ? clip : replacement,
              etag = `"s3-${version}"`;
            if (row.if_match && row.if_match !== etag) {
              row.status = 412;
              response.writeHead(412, { "Content-Length": 0 });
              response.end();
              return;
            }
            response.setHeader("Content-Type", "video/mp4");
            response.setHeader("Accept-Ranges", "bytes");
            response.setHeader("ETag", etag);
            response.setHeader(
              "Last-Modified",
              "Mon, 05 Oct 2026 00:00:00 GMT",
            );
            if (versioned)
              response.setHeader(
                "x-amz-version-id",
                object.name === "wrong-version" && request.method === "GET"
                  ? "ignored-version-b"
                  : `version-${version}`,
              );
            let start = 0,
              end = bytes.length - 1;
            const range = /^bytes=(\d+)-(\d*)$/.exec(row.range ?? "");
            if (range) {
              start = Number(range[1]);
              end = range[2] ? Math.min(Number(range[2]), end) : end;
              if (start > end) {
                row.status = 416;
                response.writeHead(416, {
                  "Content-Length": 0,
                  "Content-Range": `bytes */${bytes.length}`,
                });
                response.end();
                return;
              }
              response.setHeader(
                "Content-Range",
                `bytes ${start}-${end}/${bytes.length}`,
              );
            }
            row.status = range ? 206 : 200;
            response.writeHead(row.status, {
              "Content-Length": end - start + 1,
            });
            response.flushHeaders();
            if (request.method === "HEAD") {
              response.end();
              return;
            }
            row.seed_present_before_get =
              f.sql(
                `SELECT count(*) FROM playback_http_representations WHERE target_sha256=${quote(digest(`${endpoint}${request.url}`))}`,
              ) !== "0";
            const body = bytes.subarray(start, end + 1);
            if (!slow) {
              const timer = setTimeout(() => {
                timers.delete(timer);
                if (!response.destroyed) {
                  row.body_bytes = body.length;
                  response.end(body);
                }
              }, 80);
              timers.add(timer);
              response.once("close", () => {
                clearTimeout(timer);
                timers.delete(timer);
              });
              return;
            }
            let offset = 0;
            const tick = () => {
              if (response.destroyed) return;
              if (offset >= body.length) {
                response.end();
                return;
              }
              const chunk = body.subarray(offset, offset + 256);
              offset += chunk.length;
              row.body_bytes += chunk.length;
              response.write(chunk);
              const timer = setTimeout(() => {
                timers.delete(timer);
                tick();
              }, 500);
              timers.add(timer);
            };
            response.once("close", () => {
              row.closed = true;
              row.closed_at = new Date().toISOString();
            });
            tick();
          } catch (error) {
            fixtureFailure = error;
            response.destroy(error);
          }
        });
        await new Promise((done, reject) =>
          upstream.once("error", reject).listen(0, "127.0.0.1", done),
        );
        upstreamPort = upstream.address().port;
        const endpoint = `http://127.0.0.1:${upstreamPort}`;
        await f.startWorker();
        workerPids.push(f.workerPid);
        await f.startServer({ WORKER_URL: f.workerOrigin });
        const admin = f.client(),
          owner = await admin.login(),
          viewer = f.client();
        await admin.request("/users", "POST", {
          username: "s3_viewer",
          password: f.password,
        });
        await viewer.login("s3_viewer", f.password);
        const library = await admin.request("/libraries", "POST", {
          name: "Owned synthetic S3 playback",
        });
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
              access_key_id_env: "RAINSYNC_S3_PLAY_ACCESS",
              secret_access_key_env: "RAINSYNC_S3_PLAY_SECRET",
            },
          },
        };
        phase = "scan";
        const source = await admin.request(
          `/libraries/${library.id}/sources`,
          "POST",
          { name: "owned S3 object source", kind: "s3", config },
        );
        const scan = await admin.request(
          `/libraries/${library.id}/sources/${source.id}/scan`,
          "POST",
          { restart: true },
        );
        assert.equal(scan.status, "completed");
        assert.equal(scan.item_count, 6);
        const media = Object.fromEntries(
          (await admin.request(`/libraries/${library.id}/media`)).map((v) => [
            v.title,
            v,
          ]),
        );
        const room = await admin.request("/rooms", "POST", {
            name: "S3 playback fixture",
          }),
          selectInitial = await roomControl(f, admin, room);
        let select = selectInitial;
        // Private media must be explicitly shared into its room even when the
        // room controller also owns the library. Use public grant APIs.
        for (const object of Object.values(media)) {
          const detail = await admin.request(`/libraries/${library.id}`);
          await admin.request(`/libraries/${library.id}/room-shares`, "POST", {
            room_id: room.id,
            media_id: object.id,
            mode: "room_members",
            expires_in_minutes: 60,
            expected_revision: detail.revision,
          });
        }
        let generation = await select(media.versioned);
        const request = (mode = "auto") => ({
          room_id: room.id,
          media_generation: generation,
          position_ms: 0,
          mode,
          idempotency_key: randomUUID(),
        });
        const pins = (id) =>
          JSON.parse(
            f.sql(
              `SELECT COALESCE(json_agg(identity),'[]'::json) FROM playback_http_representations WHERE session_id=${quote(id)}`,
            ),
          );
        const delivery = (plan) => new URL(plan.playback_url, f.workerOrigin);
        let versionPlan, mutablePlan;
        await check(
          "fresh signed HEAD seeds provisional pin before actual Worker probe and final plan",
          async () => {
            phase = "prepare-auto";
            const start = report.requests.length,
              body = request(),
              pending = admin.raw("/playback-sessions", {
                method: "POST",
                body,
              });
            let provisional;
            const until = Date.now() + 15000;
            while (Date.now() < until) {
              const found = f.sql(
                `SELECT json_build_object('id',p.id,'identity',h.identity) FROM playback_requests r JOIN playback_sessions p ON p.id=r.session_id JOIN playback_http_representations h ON h.session_id=p.id WHERE r.user_id=${quote(owner.id)} AND r.idempotency_key=${quote(body.idempotency_key)} AND r.status='pending' LIMIT 1`,
              );
              if (found) {
                provisional = JSON.parse(found);
                break;
              }
              await delay(10);
            }
            const response = await pending;
            assert.equal(response.status, 200, await response.clone().text());
            versionPlan = await response.json();
            assert.ok(provisional);
            assert.equal(provisional.id, versionPlan.session_id);
            assert.equal(provisional.identity.metadata.etag, '"s3-a"');
            assert.equal(versionPlan.delivery_mode, "direct");
            const final = pins(versionPlan.session_id);
            assert.equal(final.length, 1);
            assert.equal(final[0].metadata.size, clip.length);
            assert.equal(final[0].consumed, true);
            assert.equal(final[0].changed, false);
            assert.equal(
              f.sql(
                `SELECT playback_source_allowed(p.media_id,p.resource,p.id) AND playback_library_session_allowed(p.id) AND NOT playback_source_allowed(p.media_id,p.resource) FROM playback_sessions p WHERE p.id=${quote(versionPlan.session_id)}`,
              ),
              "t",
              "private source authority is exact-session bound; unscoped legacy gate stays closed",
            );
            const calls = report.requests.slice(start);
            assert.ok(
              calls.some((v) => v.method === "HEAD" && v.if_match === '"s3-a"'),
            );
            const gets = calls.filter((v) => v.method === "GET");
            assert.ok(
              gets.length &&
                gets.every(
                  (v) =>
                    v.signed &&
                    v.if_match === '"s3-a"' &&
                    v.version_id === "version-a" &&
                    v.seed_present_before_get,
                ),
            );
            const publicPlan = JSON.stringify(versionPlan);
            assert.ok(
              !publicPlan.includes(endpoint) &&
                !publicPlan.includes(SECRET) &&
                !publicPlan.includes("RAINSYNC_S3_"),
            );
            return {
              session_id: versionPlan.session_id,
              provisional_pin: provisional.identity,
              final_pin: final[0],
              signed_probe_gets: gets.length,
              exact_session_authority: true,
              unscoped_private_authority: false,
            };
          },
        );
        await check(
          "selected S3 version survives current-object overwrite and Worker restart with exact Range",
          async () => {
            objects.get("allowed/versioned.mp4").current = "b";
            workerCloseRecords.push(await f.stopWorker());
            await f.startWorker();
            workerPids.push(f.workerPid);
            phase = "version-range";
            const response = await fetch(delivery(versionPlan), {
              headers: { Range: "bytes=128-511", "If-Range": '"s3-a"' },
              signal: AbortSignal.timeout(10000),
            });
            assert.equal(response.status, 206);
            assert.equal(
              response.headers.get("content-range"),
              `bytes 128-511/${clip.length}`,
            );
            assert.deepEqual(
              Buffer.from(await response.arrayBuffer()),
              clip.subarray(128, 512),
            );
            const call = report.requests.at(-1);
            assert.equal(call.version_id, "version-a");
            assert.equal(call.if_match, '"s3-a"');
            assert.equal(call.range, "bytes=128-511");
            assert.ok(call.signed);
            return {
              worker_restart: true,
              bytes: 384,
              requested_version: call.version_id,
            };
          },
        );
        await check(
          "unversioned S3 overwrite returns no replacement bytes and invalidates the durable pin",
          async () => {
            generation = await select(media.unversioned);
            phase = "unversioned-prepare";
            mutablePlan = await admin.request(
              "/playback-sessions",
              "POST",
              request(),
            );
            assert.equal(mutablePlan.delivery_mode, "direct");
            objects.get("allowed/unversioned.mp4").current = "b";
            phase = "unversioned-overwrite";
            await errorResponse(
              await fetch(delivery(mutablePlan), {
                headers: { Range: "bytes=128-511" },
                signal: AbortSignal.timeout(10000),
              }),
              409,
              "SOURCE_CHANGED",
            );
            const call = report.requests.at(-1);
            assert.equal(call.status, 412);
            assert.equal(call.body_bytes, 0);
            assert.equal(pins(mutablePlan.session_id)[0].changed, true);
            return { replacement_bytes: 0, pin_changed: true };
          },
        );
        for (const [name, expected, flag] of [
          ["deleted", 409, "deleted"],
          ["permission", 502, "denied"],
        ])
          await check(
            `${name} object fails fresh preparation before Worker GET`,
            async () => {
              generation = await select(media[name]);
              objects.get(`allowed/${name}.mp4`)[flag] = true;
              phase = `${name}-negative`;
              const start = report.requests.length;
              await errorResponse(
                await admin.raw("/playback-sessions", {
                  method: "POST",
                  body: request(),
                }),
                expected,
              );
              assert.ok(
                report.requests.slice(start).every((v) => v.method === "HEAD"),
              );
              return { status: expected, worker_gets: 0 };
            },
          );
        await check(
          "S3 endpoint redirect is rejected without signed replay",
          async () => {
            generation = await select(media.redirect);
            phase = "redirect-negative";
            const start = report.requests.length;
            await errorResponse(
              await admin.raw("/playback-sessions", {
                method: "POST",
                body: request(),
              }),
              502,
            );
            assert.equal(report.requests.length - start, 1);
            assert.equal(report.requests.at(-1).status, 307);
            return { requests: 1, replayed: false };
          },
        );
        await check(
          "a service ignoring versionId cannot publish a successful playback plan",
          async () => {
            generation = await select(media["wrong-version"]);
            phase = "wrong-version-negative";
            const response = await admin.raw("/playback-sessions", {
              method: "POST",
              body: request(),
            });
            assert.ok(!response.ok);
            const body = await response.json();
            assert.ok(!body.playback_url);
            return { status: response.status, plan_published: false };
          },
        );
        await check(
          "wrong environment credential fails signed fresh HEAD before Worker GET",
          async () => {
            if (peer) {
              peer.terminate();
              peer = null;
              await delay(30);
            }
            await f.startServer({
              WORKER_URL: f.workerOrigin,
              RAINSYNC_S3_PLAY_SECRET: "synthetic-wrong-secret",
            });
            await admin.login();
            select = await roomControl(f, admin, room);
            generation = await select(media.versioned);
            phase = "wrong-credentials-negative";
            const start = report.requests.length;
            await errorResponse(
              await admin.raw("/playback-sessions", {
                method: "POST",
                body: request(),
              }),
              502,
            );
            const calls = report.requests.slice(start);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].method, "HEAD");
            assert.equal(calls[0].signed, false);
            assert.equal(calls[0].status, 403);
            if (peer) {
              peer.terminate();
              peer = null;
              await delay(30);
            }
            await f.startServer({ WORKER_URL: f.workerOrigin });
            await admin.login();
            select = await roomControl(f, admin, room);
            return {
              status: 502,
              worker_gets: 0,
              credential_crypto_check_failed: true,
            };
          },
        );
        await check(
          "private room share allows S3 media bytes but revocation closes live stream and old URL",
          async () => {
            generation = await select(media.versioned);
            const invite = await admin.request(
              `/rooms/${room.id}/invites`,
              "POST",
            );
            await viewer.request(`/rooms/${room.id}/join`, "POST", {
              token: invite.token,
            });
            const details = await admin.request(`/libraries/${library.id}`),
              share = await admin.request(
                `/libraries/${library.id}/room-shares`,
                "POST",
                {
                  room_id: room.id,
                  media_id: media.versioned.id,
                  mode: "room_members",
                  expires_in_minutes: 60,
                  expected_revision: details.revision,
                },
              );
            assert.ok(
              !(await viewer.request("/media")).some(
                (v) => v.id === media.versioned.id,
              ),
            );
            phase = "private-viewer-prepare";
            const plan = await viewer.request(
              "/playback-sessions",
              "POST",
              request(),
            );
            slow = true;
            phase = "private-live-revoke";
            const response = await fetch(delivery(plan), {
              signal: AbortSignal.timeout(15000),
            });
            assert.equal(response.status, 200);
            const reader = response.body.getReader();
            const first = await reader.read();
            assert.ok(first.value?.length);
            let bytes = first.value.length;
            const current = await admin.request(`/libraries/${library.id}`);
            await admin.request(
              `/libraries/${library.id}/room-shares/${share.id}`,
              "DELETE",
              { expected_revision: current.revision },
            );
            const revokedAt = performance.now();
            let terminated = false;
            try {
              while (true) {
                const part = await reader.read();
                if (part.done) {
                  terminated = true;
                  break;
                }
                bytes += part.value.length;
              }
            } catch {
              terminated = true;
            }
            const streamStopAfterRevokeMs = Math.round(
              performance.now() - revokedAt,
            );
            assert.ok(terminated && bytes < clip.length);
            const before = report.requests.length;
            await errorResponse(
              await fetch(delivery(plan), {
                signal: AbortSignal.timeout(10000),
              }),
              401,
              "INVALID_PLAYBACK_SESSION",
            );
            assert.equal(report.requests.length, before);
            slow = false;
            assert.equal(
              f.sql(
                `SELECT stopped FROM playback_sessions WHERE id=${quote(plan.session_id)}`,
              ),
              "t",
            );
            assert.equal(
              f.sql(
                `SELECT NOT playback_source_allowed(p.media_id,p.resource,p.id) AND NOT playback_library_session_allowed(p.id) FROM playback_sessions p WHERE p.id=${quote(plan.session_id)}`,
              ),
              "t",
              "revocation closes both exact private session guards",
            );
            return {
              session_id: plan.session_id,
              stream_bytes_before_stop: bytes,
              whole_object_bytes: clip.length,
              old_url_denied_before_origin: true,
              stream_stop_after_revoke_ms: streamStopAfterRevokeMs,
            };
          },
        );
        assert.ok(!fixtureFailure, String(fixtureFailure));
        assert.ok(
          report.requests.every(
            (v) => v.signed || v.phase === "wrong-credentials-negative",
          ),
        );
        for (const binary of report.binaries)
          assert.equal(
            await fileDigest(binary.path),
            binary.sha256,
            "executed binary stayed unchanged",
          );
        for (const input of report.coordinator_inputs)
          assert.equal(
            await fileDigest(resolve(input.path)),
            input.sha256,
            "executed harness stayed unchanged",
          );
        workerCloseRecords.push(await f.stopWorker());
        assert.ok(
          workerCloseRecords.every(
            (record) => record.observed_close && record.exit_code === 0,
          ),
          "both owned Workers closed gracefully",
        );
      } finally {
        if (peer) {
          peer.terminate();
          peer = null;
          await delay(30);
        }
        if (upstream) upstream.closeAllConnections();
      }
    },
    {
      env: {
        PRIVATE_LIBRARIES_ENABLED: "true",
        RAINSYNC_S3_PLAY_ACCESS: ACCESS,
        RAINSYNC_S3_PLAY_SECRET: SECRET,
      },
    },
  );
  report.result = "passed";
} catch (error) {
  failure = error;
  report.error = error.stack;
} finally {
  if (peer) {
    peer.terminate();
    await delay(30);
  }
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise((done) => upstream.close(done));
  }
  report.cleanup = {
    stack: fixture ? await fixture.verifyStopped() : null,
    workers: workerPids.map((pid) => ({ pid, absent: verifyPidAbsent(pid) })),
    worker_close_records: workerCloseRecords,
    worker_port_closed: fixture
      ? await verifyClosedPort(Number(new URL(fixture.workerOrigin).port))
      : null,
    synthetic_origin_port_closed: upstreamPort
      ? await verifyClosedPort(upstreamPort)
      : null,
  };
  report.finished_at = new Date().toISOString();
  const output = resolve(
    process.env.RAINSYNC_ARTIFACT_DIR,
    "s3-playback-report.json",
  );
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`REPORT ${output}`);
}
if (failure) throw failure;
