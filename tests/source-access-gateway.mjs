// Isolated source-policy regression. Owns real Server, Worker, Agent, PostgreSQL,
// HTTP origins and FFmpeg children; never accepts an existing database URL.
// Run from the checkout with a successful frozen W03_BACKEND_BINDING (or
// RAINSYNC_SOURCE_ACCESS_BINDING_FILE), RAINSYNC_ARTIFACT_DIR, CARGO_TARGET_DIR,
// and optionally RAINSYNC_NATIVE_POSTGRES_BIN. No build/install is performed.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer, request } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bindingFile =
  process.env.W03_BACKEND_BINDING ??
  process.env.RAINSYNC_SOURCE_ACCESS_BINDING_FILE;
assert.ok(
  bindingFile,
  "Set W03_BACKEND_BINDING or RAINSYNC_SOURCE_ACCESS_BINDING_FILE to a successful frozen build binding",
);
const bindingBytes = await readFile(bindingFile);
const binding = JSON.parse(bindingBytes);
assert.equal(
  binding.result,
  "passed",
  "binding must record a successful build",
);
assert.ok(
  Array.isArray(binding.source) && binding.source.length > 0,
  "binding must include source[]",
);
assert.equal(
  digest(Buffer.from(JSON.stringify(binding.source))),
  binding.source_digest,
  "source binding digest",
);
assert.ok(
  binding.source.some(
    (input) =>
      input.path === "migrations/0032_source_access_policy_revisions.sql",
  ),
  "binding must include source-policy migration 0032",
);
assert.equal(
  binding.binaries?.length,
  3,
  "bind all three actual service binaries",
);
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
const suffix = process.platform === "win32" ? ".exe" : "";
for (const name of [
  "rainsync-server",
  "rainsync-media-worker",
  "rainsync-nas-agent",
]) {
  assert.ok(
    binding.binaries.some(
      (binary) => resolve(binary.path) === resolve(target, name + suffix),
    ),
    `binding must describe the executed ${name}`,
  );
}
const coordinatorInputs = [];
for (const path of [
  "tests/source-access-gateway.mjs",
  "tests/fixtures/server.mjs",
  "tests/fixtures/media-stack.mjs",
  "tests/fixtures/postgres.mjs",
]) {
  coordinatorInputs.push({
    path,
    sha256: digest(await readFile(resolve(repo, path))),
  });
}
async function verifyBinding() {
  assert.equal(
    digest(await readFile(bindingFile)),
    digest(bindingBytes),
    "build binding changed during validation",
  );
  for (const input of [...binding.source, ...coordinatorInputs]) {
    assert.equal(
      digest(await readFile(resolve(repo, input.path))),
      input.sha256,
      `source/test changed: ${input.path}`,
    );
  }
  for (const binary of binding.binaries) {
    assert.equal(
      digest(await readFile(binary.path)),
      binary.sha256,
      "executed service binary changed during validation",
    );
  }
}
await verifyBinding();
const tests = [],
  children = new Set(),
  consumers = new Set(),
  listeners = [];
let fixture,
  reportRoot,
  outcome = "failed",
  failure,
  foreignHits = 0;
const subprocesses = [];
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => `${quote(JSON.stringify(value))}::jsonb`;
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(30);
  }
  throw Error(`Deadline: ${label}`);
}
async function scenario(name, run) {
  const record = {
    name,
    result: "failed",
    started_at: new Date().toISOString(),
  };
  tests.push(record);
  const began = Date.now();
  try {
    const evidence = await run();
    assert.equal(
      foreignHits,
      0,
      `${name}: no request reached an ungranted origin`,
    );
    Object.assign(record, {
      result: "passed",
      elapsed_ms: Date.now() - began,
      foreign_hits: foreignHits,
      ...evidence,
    });
    console.log(`PASS ${name}; foreign requests=0`);
  } catch (error) {
    // Assertion descriptions are deliberately free of bearer tokens and ciphertext.
    record.error = error.message;
    throw error;
  }
}
async function listen(handler) {
  const server = createServer(handler);
  await new Promise((done, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", done),
  );
  listeners.push({ server, port: server.address().port });
  return `http://127.0.0.1:${server.address().port}`;
}
async function get(url, options = {}) {
  return fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
    ...options,
  });
}
async function expectStatus(url, status, options = {}) {
  const response = await get(url, options);
  assert.equal(response.status, status, "Worker response status");
  await response.arrayBuffer();
  return response;
}
function references(text) {
  return [
    ...text.split(/\r?\n/).filter((line) => line && !line.startsWith("#")),
    ...[...text.matchAll(/\bURI="([^"]+)"/g)].map((match) => match[1]),
  ];
}
async function decode(url, label) {
  const env = { ...fixture.env };
  for (const key of [
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "FFREPORT",
  ])
    delete env[key];
  const args = [
    "-v",
    "error",
    "-nostdin",
    "-protocol_whitelist",
    "http,tcp,crypto",
    "-format_whitelist",
    "hls,mov,mpegts",
    "-i",
    url,
    "-map",
    "0:v:0",
    "-frames:v",
    "8",
    "-threads",
    "1",
    "-f",
    "framemd5",
    "pipe:1",
  ];
  // Asynchronous: the fixture's loopback HTTP servers must keep servicing FFmpeg.
  const child = spawn("ffmpeg", args, {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const record = { label, pid: child.pid ?? null, closed: false };
  subprocesses.push(record);
  const stdout = [],
    stderr = [];
  let launchError,
    timedOut = false,
    bytes = 0;
  child.once("error", (error) => {
    launchError = error;
  });
  const done = new Promise((done) =>
    child.once("close", (code, signal) => {
      children.delete(child);
      Object.assign(record, { closed: true, exit_code: code, signal });
      done(code);
    }),
  );
  child.done = done;
  for (const [stream, parts] of [
    [child.stdout, stdout],
    [child.stderr, stderr],
  ])
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) child.kill("SIGKILL");
      else parts.push(chunk);
    });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 20000);
  let code;
  try {
    code = await done;
  } finally {
    clearTimeout(timer);
  }
  if (launchError) throw launchError;
  assert.equal(timedOut, false, "FFmpeg decode finished within deadline");
  const output = Buffer.concat(stdout);
  // Do not persist FFmpeg stderr: failure diagnostics can include delivery tokens.
  assert.equal(
    code,
    0,
    `FFmpeg ${label} decode failed; stderr SHA-256=${digest(Buffer.concat(stderr))}`,
  );
  const frames = output
    .toString()
    .split(/\r?\n/)
    .filter((line) => /^\s*0,/.test(line));
  assert.equal(frames.length, 8, "actual FFmpeg decoded eight video frames");
  await writeFile(resolve(reportRoot, `${label}.framemd5`), output);
  return { decoded_frames: frames.length, framemd5_sha256: digest(output) };
}

try {
  await isolatedMediaStack("source-access-gateway", async (f) => {
    fixture = f;
    reportRoot = f.root;
    const admin = f.client(),
      user = await admin.login();
    const encrypt = (value, encoding = "base64") => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"),
        nonce,
      );
      return Buffer.concat([
        nonce,
        cipher.update(JSON.stringify(value)),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString(encoding);
    };
    const decrypt = (encoded) => {
      const bytes = Buffer.from(encoded, "base64url");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"),
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(-16));
      return JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(12, -16)),
          decipher.final(),
        ]),
      );
    };
    await f.makeClip("movie.mp4", { pictureSeconds: 3 });
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-i",
        resolve(f.root, "movie.mp4"),
        "-c",
        "copy",
        "-hls_segment_type",
        "fmp4",
        "-hls_time",
        "1",
        "-hls_segment_filename",
        resolve(f.root, "segment%d.m4s"),
        resolve(f.root, "variant.m3u8"),
      ],
      { timeout: 15000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const media = new Map();
    for (const name of (await readdir(f.root)).filter((name) =>
      /^(movie\.mp4|init\.mp4|segment\d+\.m4s|variant\.m3u8)$/.test(name),
    ))
      media.set(name, await readFile(resolve(f.root, name)));
    const video = media.get("movie.mp4"),
      playlist = media.get("variant.m3u8");
    assert.ok(video?.length > 32 && playlist && media.has("init.mp4"));
    const requests = [],
      originErrors = [],
      slow = new Map();
    const foreignOrigin = await listen((req, res) => {
      foreignHits++;
      res.end(video);
    });
    const badHls = `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\n${foreignOrigin}/video.mp4\n#EXT-X-ENDLIST\n`;
    const dash = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" minBufferTime="PT1S" mediaPresentationDuration="PT3S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="100000"><BaseURL>${foreignOrigin}/video.mp4</BaseURL><SegmentBase><Initialization range="0-100"/></SegmentBase></Representation></AdaptationSet></Period></MPD>`;
    const sendBytes = (req, res, body) => {
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("ETag", '"fixture-version-1"');
      if (req.method === "HEAD") {
        res.setHeader("Content-Length", body.length);
        res.end();
        return;
      }
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      if (range) {
        const start = Number(range[1]),
          end = Math.min(Number(range[2] || body.length - 1), body.length - 1);
        if (start >= body.length || start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${body.length}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${body.length}`,
          "Content-Length": end - start + 1,
        });
        res.end(body.subarray(start, end + 1));
        return;
      }
      res.setHeader("Content-Length", body.length);
      res.end(body);
    };
    const upstreamOrigin = await listen((req, res) => {
      const path = new URL(req.url, "http://fixture").pathname;
      requests.push({
        path,
        method: req.method,
        range: req.headers.range ?? null,
        if_range: req.headers["if-range"] ?? null,
      });
      if (req.headers.authorization !== "Bearer gateway-fixture")
        originErrors.push("source authorization missing or changed");
      res.setHeader("Content-Type", "application/octet-stream");
      if (path === "/hidden.mp4")
        sendBytes(req, res, Buffer.from("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nnested/variant\n"));
      else if (path === "/nested/variant") sendBytes(req, res, playlist);
      else if (path.startsWith("/nested/") && media.has(path.slice(8)))
        sendBytes(req, res, media.get(path.slice(8)));
      else if (path === "/range.mp4") {
        res.setHeader("Content-Type", "video/mp4");
        sendBytes(req, res, video);
      } else if (path === "/bad-range.mp4") {
        res.writeHead(206, { "Content-Length": 32 });
        res.end(video.subarray(0, 32));
      } else if (path === "/redirect.mp4") {
        res.writeHead(302, { Location: `${foreignOrigin}/video.mp4` });
        res.end();
      } else if (path === "/foreign.mp4") sendBytes(req, res, Buffer.from(badHls));
      else if (path === "/foreign-master.mp4")
        sendBytes(req, res, Buffer.from("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nforeign.mp4\n"));
      else if (path === "/dash.mp4") res.end(`<?xml version="1.0"?>${dash}`);
      else if (path === "/latin1-dash.mp4")
        res.end(
          Buffer.from(
            `<?xml version="1.0" encoding="ISO-8859-1"?><!--é-->${dash}`,
            "latin1",
          ),
        );
      else if (path === "/padded-dash.mp4")
        res.end(` ${" ".repeat(1400)}${dash}`);
      else if (path.startsWith("/deep/")) {
        const n = Number(path.slice(6));
        sendBytes(req, res, Buffer.from(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\n${n + 1}\n`));
      } else if (/^\/key-(16|15|17|alias)\.mp4$/.test(path)) {
        const size = path.slice(5, -4),
          key = size === "alias" ? "16" : size;
        sendBytes(req, res, Buffer.from(
          `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-KEY:METHOD=AES-128,URI="key/${key}"\n#EXTINF:3,\n${size === "alias" ? `key/${key}` : "nested/segment0.m4s"}\n#EXT-X-ENDLIST\n`,
        ));
      } else if (/^\/key\/(15|16|17)$/.test(path)) {
        // All bodies begin like HLS; only a typed, exactly 16-byte key may bypass sniffing.
        const body = Buffer.concat([
          Buffer.from("#EXTM3U\n"),
          Buffer.alloc(Number(path.slice(5)) - 8, 0x31),
        ]);
        if (body.length === 16) sendBytes(req, res, body);
        else {
          res.write(body.subarray(0, 8));
          res.end(body.subarray(8));
        }
      } else if (path.startsWith("/paced-manifest/")) {
        const state = { closed: false, chunks: 0 };
        slow.set(path, state);
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        res.write("#EXTM3U\n");
        // Every chunk arrives inside the per-read timeout. Only the total
        // preparation deadline can reject this indefinitely unfinished playlist.
        const timer = setInterval(() => {
          state.chunks++;
          res.write("#still-preparing\n");
        }, 100);
        res.on("close", () => {
          state.closed = true;
          clearInterval(timer);
        });
      } else if (path.startsWith("/slow/")) {
        const state = { closed: false, bytes: 0 };
        slow.set(path, state);
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": 1024 * 1024 * 1024,
        });
        let timer;
        const send = () => {
          if (res.destroyed) return;
          state.bytes += 65536;
          if (res.write(Buffer.alloc(65536))) timer = setTimeout(send, 20);
          else
            res.once("drain", () => {
              timer = setTimeout(send, 20);
            });
        };
        res.on("close", () => {
          state.closed = true;
          clearTimeout(timer);
        });
        send();
      } else {
        originErrors.push(`unexpected owned-origin path ${path}`);
        res.statusCode = 404;
        res.end();
      }
    });
    const policy = {
      schema_version: 1,
      origins: [{ origin: upstreamOrigin, cidrs: ["127.0.0.0/8"] }],
    };
    const config = (path) => ({
      url: upstreamOrigin + path,
      headers: { Authorization: "Bearer gateway-fixture" },
      access_policy: policy,
    });
    async function source(path, { legacy = false } = {}) {
      const sourceConfig = config(path);
      if (legacy) delete sourceConfig.access_policy;
      const created = await admin.request("/sources", "POST", {
        name: `gateway-${path}`,
        kind: "http",
        config: sourceConfig,
      });
      await admin.request(`/sources/${created.id}/test`, "POST");
      const row = JSON.parse(
        f.sql(
          `SELECT row_to_json(m) FROM media_items m WHERE source_id=${quote(created.id)}`,
        ),
      );
      assert.ok(row?.id, "real HTTP source scan materialized its media row");
      return {
        id: created.id,
        media: row.id,
        config: sourceConfig,
        kind: "http",
      };
    }
    // Synthetic grants isolate Worker delivery from candidate negotiation. Their
    // user/room/source/media rows are real; both revision envelopes are exact.
    async function grant(src, overrides = {}) {
      const room = await admin.request("/rooms", "POST", {
        name: `gateway-${randomUUID()}`,
      });
      const revision = Number(
        f.sql(
          `SELECT access_policy_revision FROM sources WHERE id=${quote(src.id)}`,
        ),
      );
      const currentConfig = decrypt(
        f.sql(`SELECT config_encrypted FROM sources WHERE id=${quote(src.id)}`),
      );
      const id = randomUUID(),
        token = randomBytes(32).toString("hex");
      const resource = {
        kind: src.kind,
        url: currentConfig.url,
        source_url: currentConfig.url,
        headers: currentConfig.headers ?? {},
        access_policy: currentConfig.access_policy ?? null,
        ...overrides,
        source_id: src.id,
        source_policy_revision: revision,
      };
      const envelope = {
        encrypted: encrypt(resource),
        source_policy_revision: revision,
      };
      f.sql(
        `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch) SELECT ${quote(id)},${quote(user.id)},r.id,${quote(src.media)},(s.state->>'media_generation')::bigint,${quote(digest(token))},${json(envelope)},now()+interval '1 hour',r.lifecycle_epoch FROM rooms r JOIN room_snapshots s ON s.room_id=r.id WHERE r.id=${quote(room.id)}`,
      );
      assert.equal(
        f.sql(
          `SELECT resource->>'source_policy_revision' FROM playback_sessions WHERE id=${quote(id)}`,
        ),
        String(revision),
      );
      assert.equal(
        decrypt(envelope.encrypted).source_policy_revision,
        revision,
      );
      return {
        id,
        token,
        room: room.id,
        source: src,
        revision,
        url: `${f.workerOrigin}/media-delivery/${id}/source?token=${token}`,
      };
    }
    function inspect(uri, session, kind, depth) {
      const url = new URL(uri, f.workerOrigin);
      assert.equal(
        url.origin,
        f.workerOrigin,
        "rewritten reference remains on Worker origin",
      );
      assert.ok(
        url.pathname.startsWith(`/media-delivery/${session.id}/segment.`),
      );
      assert.equal(url.searchParams.get("token"), session.token);
      const ticket = decrypt(url.searchParams.get("url"));
      assert.deepEqual(Object.keys(ticket).sort(), [
        "depth",
        "kind",
        "policy_revision",
        "session",
        "source",
        "url",
        "version",
      ]);
      assert.equal(ticket.version, 1);
      assert.equal(ticket.session, session.id);
      assert.equal(ticket.source, session.source.id);
      assert.equal(ticket.kind, kind);
      assert.equal(ticket.depth, depth);
      assert.equal(ticket.policy_revision, session.revision);
      return { url: url.toString(), ticket };
    }
    await f.startWorker();
    const primary = await source("/hidden.mp4"),
      old = await grant(primary);
    assert.equal(
      (await admin.request("/sources")).find((src) => src.id === primary.id)
        .access_policy_revision,
      1,
    );
    let oldChild, oldSegment;
    await scenario(
      "hidden HLS, typed extensionless child, fMP4 initialization and real decode",
      async () => {
        const response = await get(old.url);
        assert.equal(response.status, 200, response.status === 200 ? undefined : await response.clone().text());
        assert.match(response.headers.get("content-type"), /mpegurl/);
        const master = await response.text();
        assert.equal(master.includes(upstreamOrigin), false);
        const child = inspect(references(master)[0], old, "playlist", 1);
        oldChild = child.url;
        assert.equal(child.ticket.url, upstreamOrigin + "/nested/variant");
        const nested = await get(child.url);
        assert.equal(nested.status, 200);
        const text = await nested.text();
        const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(text);
        assert.ok(map);
        const init = inspect(map[1], old, "initialization", 2);
        assert.equal(
          new URL(init.url).pathname.endsWith(".mp4"),
          true,
          "safe fMP4 initialization suffix",
        );
        const initResponse = await get(init.url);
        assert.equal(initResponse.status, 200);
        assert.deepEqual(
          Buffer.from(await initResponse.arrayBuffer()),
          media.get("init.mp4"),
        );
        const segment = inspect(
          text.split(/\r?\n/).find((line) => line && !line.startsWith("#")),
          old,
          "segment",
          2,
        );
        oldSegment = segment.url;
        assert.equal(
          new URL(segment.url).pathname.endsWith(".m4s"),
          true,
          "safe fMP4 segment suffix",
        );
        const partial = await get(segment.url, {
          headers: { Range: "bytes=0-31" },
        });
        assert.equal(partial.status, 206);
        assert.equal(partial.headers.get("content-length"), "32");
        const original = media.get(
          new URL(segment.ticket.url).pathname.slice(8),
        );
        assert.equal(
          partial.headers.get("content-range"),
          `bytes 0-31/${original.length}`,
        );
        assert.deepEqual(
          Buffer.from(await partial.arrayBuffer()),
          original.subarray(0, 32),
        );
        const probe = await get(old.url.replace("/source?", "/probe?"));
        assert.equal(probe.status, 200);
        assert.ok(
          (await probe.json()).streams.some(
            (stream) => stream.codec_type === "video",
          ),
        );
        const decoded = await decode(old.url, "hidden-hls");
        for (const path of [
          "/nested/variant",
          "/nested/init.mp4",
          "/nested/segment0.m4s",
        ])
          assert.ok(requests.some((record) => record.path === path));
        return decoded;
      },
    );
    await scenario(
      "primary Range, HEAD, If-Range fallback and invalid partial metadata",
      async () => {
        const ranged = await grant(await source("/range.mp4"));
        let response = await get(ranged.url, {
          headers: { Range: "bytes=0-31" },
        });
        assert.equal(response.status, 206);
        assert.equal(response.headers.get("content-length"), "32");
        assert.equal(
          response.headers.get("content-range"),
          `bytes 0-31/${video.length}`,
        );
        assert.equal(response.headers.get("accept-ranges"), "bytes");
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          video.subarray(0, 32),
        );
        response = await get(ranged.url, {
          method: "HEAD",
          headers: { Range: "bytes=0-31" },
        });
        assert.equal(response.status, 200);
        assert.equal(
          response.headers.get("content-length"),
          String(video.length),
        );
        assert.equal(response.headers.get("content-range"), null);
        assert.equal((await response.arrayBuffer()).byteLength, 0);
        assert.equal(requests.at(-1).method, "HEAD");
        assert.equal(requests.at(-1).range, null);
        response = await get(ranged.url, {
          headers: { Range: "bytes=0-31", "If-Range": '"different-version"' },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-range"), null);
        assert.equal(
          response.headers.get("content-length"),
          String(video.length),
        );
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), video);
        assert.equal(requests.at(-1).range, null);
        assert.equal(requests.at(-1).if_range, null);
        response = await get(ranged.url, {
          headers: { Range: `bytes=${video.length + 1}-` },
        });
        assert.equal(response.status, 416);
        assert.equal(
          response.headers.get("content-range"),
          `bytes */${video.length}`,
        );
        assert.equal((await response.json()).error.code, "RANGE_NOT_SATISFIABLE");
        const invalid = await grant(await source("/bad-range.mp4"));
        await expectStatus(invalid.url, 502, {
          headers: { Range: "bytes=0-31" },
        });
        return {
          full_size: video.length,
          checked_partial_bytes: 32,
          if_range_result: "full-body-200",
        };
      },
    );
    await scenario(
      "cross-origin HLS references, redirects and disguised DASH never escape",
      async () => {
        for (const [path, status] of [
          ["/foreign.mp4", 502],
          ["/redirect.mp4", 302],
          ["/dash.mp4", 502],
          ["/latin1-dash.mp4", 502],
          ["/padded-dash.mp4", 502],
        ]) {
          const session = await grant(await source(path));
          const response = await expectStatus(session.url, status);
          assert.equal(
            response.headers.get("location"),
            null,
            "upstream redirect is never handed to the client",
          );
          assert.equal(foreignHits, 0);
        }
        const nested = await grant(await source("/foreign-master.mp4"));
        const response = await get(nested.url);
        assert.equal(response.status, 200);
        const child = inspect(
          references(await response.text())[0],
          nested,
          "playlist",
          1,
        );
        await expectStatus(child.url, 502);
        // This enters the production FFprobe path, not just a raw proxy assertion.
        await expectStatus(nested.url.replace("/source?", "/probe?"), 502);
        return { rejected_cases: 7 };
      },
    );
    await scenario(
      "typed key exact length, key/media alias and bounded manifest depth",
      async () => {
        for (const size of [16, 15, 17]) {
          const session = await grant(await source(`/key-${size}.mp4`));
          const response = await get(session.url);
          assert.equal(response.status, 200);
          const manifest = await response.text(),
            key = /#EXT-X-KEY:[^\n]*URI="([^"]+)"/.exec(manifest);
          assert.ok(key);
          const ticket = inspect(key[1], session, "key", 1);
          const reply = await get(ticket.url);
          assert.equal(reply.status, size === 16 ? 200 : 502);
          const body = Buffer.from(await reply.arrayBuffer());
          if (size === 16)
            assert.deepEqual(body, Buffer.from("#EXTM3U\n11111111"));
        }
        const alias = await grant(await source("/key-alias.mp4"));
        const before = requests.filter((record) =>
          record.path.startsWith("/key/"),
        ).length;
        await expectStatus(alias.url, 502);
        assert.equal(
          requests.filter((record) => record.path.startsWith("/key/")).length,
          before,
          "ambiguous key/media manifest grants no children",
        );
        const deep = await grant(await source("/deep/0"));
        let next = deep.url,
          visited = 0;
        for (; visited < 6; visited++) {
          const response = await get(next);
          if (response.status !== 200) {
            assert.equal(response.status, 502);
            await response.arrayBuffer();
            break;
          }
          next = new URL(
            references(await response.text())[0],
            f.workerOrigin,
          ).toString();
        }
        assert.equal(
          visited,
          4,
          "four rewritten nesting levels admitted, then fail closed",
        );
        assert.equal(
          requests.some((record) => record.path === "/deep/5"),
          false,
        );
        return {
          valid_key_bytes: 16,
          rejected_key_bytes: [15, 17],
          manifest_depth_limit: 4,
        };
      },
    );
    await scenario(
      "encrypted tickets bind session, resource kind, depth and revision",
      async () => {
        const valid = new URL(oldChild),
          ticket = decrypt(valid.searchParams.get("url"));
        const before = requests.length;
        for (const changed of [
          { ...ticket, session: randomUUID() },
          { ...ticket, source: randomUUID() },
          { ...ticket, source: null },
          { ...ticket, policy_revision: old.revision + 1 },
          { ...ticket, depth: 0 },
          { ...ticket, depth: 5 },
          { ...ticket, kind: "untyped" },
          { ...ticket, version: 2 },
          { ...ticket, url: `${foreignOrigin}/video.mp4` },
        ]) {
          const url = new URL(valid);
          url.searchParams.set("url", encrypt(changed, "base64url"));
          await expectStatus(url, 403);
        }
        const malformed = new URL(valid);
        malformed.searchParams.set(
          "url",
          Buffer.from("unsigned URL").toString("base64url"),
        );
        await expectStatus(malformed, 403);
        assert.equal(
          requests.length,
          before,
          "invalid grants denied before contacting any origin",
        );
        return { rejected_tickets: 10 };
      },
    );
    await scenario(
      "nonadmin and stale mutation roll back; same-policy revision cancels retained grants",
      async () => {
        await admin.request("/users", "POST", {
          username: "gateway-viewer",
          password: "fixture-pass-123",
        });
        const viewer = f.client();
        assert.equal(
          (await viewer.login("gateway-viewer", "fixture-pass-123")).admin,
          false,
        );
        const beforeMutation = () =>
          f.sql(
            `SELECT jsonb_build_object('config',s.config_encrypted,'revision',s.access_policy_revision,'preview',m.preview_generation,'stopped',p.stopped) FROM sources s JOIN media_items m ON m.source_id=s.id JOIN playback_sessions p ON p.media_id=m.id WHERE s.id=${quote(primary.id)} AND p.id=${quote(old.id)}`,
          );
        let baseline = beforeMutation();
        await viewer.request(
          `/sources/${primary.id}/access-policy`,
          "POST",
          { expected_revision: old.revision, policy },
          403,
        );
        assert.equal(
          beforeMutation(),
          baseline,
          "nonadmin mutation leaves source, preview and grants unchanged",
        );
        await admin.request(`/sources/${primary.id}/access-policy`, "POST", { expected_revision: old.revision }, 422);
        assert.equal(beforeMutation(), baseline, "missing policy cannot silently downgrade a strict source");
        const stale = await admin.request(
          `/sources/${primary.id}/access-policy`,
          "POST",
          { expected_revision: old.revision - 1, policy },
          409,
        );
        assert.equal(stale.error.code.toLowerCase(), "source_changed");
        assert.equal(
          beforeMutation(),
          baseline,
          "stale revision rolls back source, preview and grants",
        );
        const path = `/slow/${randomUUID()}`,
          retained = await grant(primary, { url: upstreamOrigin + path });
        const state = {
          response: null,
          aborted: false,
          ended: false,
          bytes: 0,
        };
        const req = request(retained.url, (res) => {
          state.response = res;
          res.on("error", () => {});
          res.on("aborted", () => {
            state.aborted = true;
          });
          res.on("end", () => {
            state.ended = true;
          });
          res.on("data", (chunk) => {
            state.bytes += chunk.length;
          });
          res.pause();
        });
        consumers.add(req);
        req.on("close", () => consumers.delete(req));
        req.on("error", () => {});
        req.end();
        await until(
          () => state.response,
          "retained old-grant response headers",
        );
        assert.equal(state.response.statusCode, 200);
        await delay(250);
        assert.equal(
          slow.get(path)?.closed,
          false,
          "retained upstream starts live",
        );
        const previewBefore = Number(
          f.sql(
            `SELECT preview_generation FROM media_items WHERE id=${quote(primary.media)}`,
          ),
        );
        const began = Date.now();
        const changed = await admin.request(
          `/sources/${primary.id}/access-policy`,
          "POST",
          { expected_revision: old.revision, policy },
        );
        assert.equal(changed.access_policy_revision, old.revision + 1);
        const listed = (await admin.request("/sources")).find(
          (src) => src.id === primary.id,
        );
        assert.equal(listed.access_policy_revision, old.revision + 1);
        assert.ok(
          Number(
            f.sql(
              `SELECT preview_generation FROM media_items WHERE id=${quote(primary.media)}`,
            ),
          ) > previewBefore,
        );
        await until(
          () => slow.get(path)?.closed,
          "old source closes while downstream consumer remains paused",
          10000,
        );
        const sourceReleasedMs = Date.now() - began;
        state.response.resume();
        await until(
          () => state.aborted,
          "retained downstream response aborts",
          Math.max(1, 10000 - (Date.now() - began)),
        );
        assert.equal(state.ended, false);
        assert.ok(state.bytes < 1024 * 1024 * 1024);
        req.destroy();
        const beforeRejected = requests.length;
        for (const url of [old.url, oldChild, oldSegment, retained.url])
          await expectStatus(url, 401);
        assert.equal(
          requests.length,
          beforeRejected,
          "old source revision never opens upstream again",
        );
        assert.equal(
          f.sql(
            `SELECT count(*) FROM playback_sessions WHERE id IN(${quote(old.id)},${quote(retained.id)}) AND stopped`,
          ),
          "2",
        );
        baseline = beforeMutation();
        await admin.request(
          `/sources/${primary.id}/access-policy`,
          "POST",
          { expected_revision: old.revision, policy },
          409,
        );
        assert.equal(
          beforeMutation(),
          baseline,
          "stale post-change retry has no mutation",
        );
        const fresh = await grant(primary);
        assert.equal(fresh.revision, old.revision + 1);
        const response = await get(fresh.url);
        assert.equal(response.status, 200);
        const next = inspect(
          references(await response.text())[0],
          fresh,
          "playlist",
          1,
        );
        await expectStatus(next.url, 200);
        const staleTicket = new URL(next.url),
          payload = decrypt(staleTicket.searchParams.get("url"));
        staleTicket.searchParams.set(
          "url",
          encrypt({ ...payload, policy_revision: old.revision }, "base64url"),
        );
        await expectStatus(staleTicket, 403);
        const decoded = await decode(fresh.url, "fresh-policy-hls");
        return {
          old_revision: old.revision,
          new_revision: fresh.revision,
          source_released_ms: sourceReleasedMs,
          retained_response_aborted: state.aborted,
          retained_received_bytes: state.bytes,
          ...decoded,
        };
      },
    );
    await scenario(
      "missing media or source associations reject legacy revision-zero grants and retain disposal evidence",
      async () => {
        const cases = [];
        for (const missing of [
          "null-media",
          "null-source",
          "deleted-media",
          "deleted-source",
        ]) {
          // Revision zero is essential: the historical COALESCE(missing, 0)
          // check admitted precisely these old grants after association loss.
          const src = await source("/range.mp4", { legacy: true });
          const session = await grant(src);
          assert.equal(session.revision, 0);
          await expectStatus(session.url, 200);
          await until(
            () =>
              f.sql(
                `SELECT count(*) FROM media_executions WHERE session_id=${quote(session.id)} AND reaped_at IS NOT NULL`,
              ) === "1",
            "genuine delivery disposal receipt before association loss",
          );
          const receipts = JSON.parse(
            f.sql(
              `SELECT json_agg(row_to_json(e) ORDER BY e.id) FROM media_executions e WHERE session_id=${quote(session.id)}`,
            ),
          );
          assert.equal(receipts.length, 1);
          const encryptedBefore = f.sql(
            `SELECT resource->>'encrypted' FROM playback_sessions WHERE id=${quote(session.id)}`,
          );
          if (missing === "null-media" || missing === "deleted-media") {
            f.sql(
              `UPDATE playback_sessions SET media_id=NULL WHERE id=${quote(session.id)}`,
            );
            if (missing === "deleted-media")
              f.sql(`DELETE FROM media_items WHERE id=${quote(src.media)}`);
          } else {
            f.sql(
              `UPDATE media_items SET source_id=NULL WHERE id=${quote(src.media)}`,
            );
            if (missing === "deleted-source")
              f.sql(`DELETE FROM sources WHERE id=${quote(src.id)}`);
          }
          const before = requests.length;
          for (const options of [
            {},
            { method: "HEAD" },
            { headers: { Range: "bytes=0-31" } },
          ]) {
            await expectStatus(session.url, 401, options);
          }
          await expectStatus(session.url.replace("/source?", "/probe?"), 401);
          assert.equal(
            requests.length,
            before,
            "missing associations reject before any source request",
          );
          assert.equal(
            f.sql(
              `SELECT stopped FROM playback_sessions WHERE id=${quote(session.id)}`,
            ),
            "f",
            "denial is the association fence, not a manufactured session stop",
          );
          assert.equal(
            f.sql(
              `SELECT resource->>'encrypted' FROM playback_sessions WHERE id=${quote(session.id)}`,
            ),
            encryptedBefore,
            "captured resource remains available for cleanup",
          );
          const preserved = JSON.parse(
            f.sql(
              `SELECT json_agg(row_to_json(e) ORDER BY e.id) FROM media_executions e WHERE id=${quote(receipts[0].id)}`,
            ),
          );
          assert.deepEqual(
            preserved,
            receipts,
            "previous genuine disposal evidence remains unchanged",
          );
          assert.equal(
            f.sql(
              `SELECT count(*) FROM source_access_policy_snapshots WHERE source_id=${quote(src.id)}`,
            ),
            "1",
            "retained cleanup authority cannot substitute for a live playback source",
          );
          cases.push({
            association: missing,
            revision: session.revision,
            rejected_status: 401,
            preserved_delivery_receipts: receipts.length,
          });
        }
        return { cases };
      },
    );
    await scenario(
      "tightened cleanup policy survives source deletion without restoring captured permissive authority",
      async () => {
        // A controlled Jellyfin-style Stop endpoint exercises the actual Server
        // maintenance reporter. Only negotiation is seeded; no claim that this
        // fixture validates a deployed Jellyfin product is made.
        const calls = [],
          stopErrors = [];
        const stopOrigin = await listen((req, res) => {
          const parts = [];
          req.on("data", (bytes) => parts.push(bytes));
          req.on("end", () => {
            let body;
            try {
              body = JSON.parse(Buffer.concat(parts));
            } catch {
              stopErrors.push("invalid Stop JSON");
            }
            if (
              req.method !== "POST" ||
              req.url !== "/Sessions/Playing/Stopped"
            )
              stopErrors.push("unexpected cleanup endpoint");
            if (
              !req.headers.authorization?.includes(
                'Token="cleanup-fixture-token"',
              )
            )
              stopErrors.push("missing captured cleanup credential");
            calls.push({
              sid: body?.PlaySessionId ?? null,
              item: body?.ItemId ?? null,
            });
            res.writeHead(204);
            res.end();
          });
        });
        const cases = [];
        for (const capture of ["legacy-origin-only", "strict-allowed"]) {
          const allowed = {
            schema_version: 1,
            origins: [{ origin: stopOrigin, cidrs: ["127.0.0.0/8"] }],
          };
          const denied = {
            schema_version: 1,
            origins: [{ origin: stopOrigin, cidrs: ["127.0.0.2/32"] }],
          };
          const capturedConfig = {
            url: stopOrigin,
            token: "cleanup-fixture-token",
            user_id: "fixture-user",
            ...(capture === "strict-allowed" ? { access_policy: allowed } : {}),
          };
          const src = await admin.request("/sources", "POST", {
            name: `cleanup-${capture}`,
            kind: "jellyfin",
            config: capturedConfig,
          });
          const mediaId = randomUUID();
          f.sql(
            `INSERT INTO media_items(id,source_id,title,resource) VALUES(${quote(mediaId)},${quote(src.id)},'cleanup fixture','fixture-item')`,
          );
          const room = await admin.request("/rooms", "POST", {
            name: `cleanup-${capture}`,
          });
          const revision = Number(
            f.sql(
              `SELECT access_policy_revision FROM sources WHERE id=${quote(src.id)}`,
            ),
          );
          assert.equal(revision, capture === "strict-allowed" ? 1 : 0);
          const scope = encrypt({
            config: capturedConfig,
            item: "fixture-item",
          });
          const seed = (ready) => {
            const id = randomUUID(),
              sid = `fixture-${id}`;
            // Ledger identities are audit data without FKs by design. This is
            // the minimal received negotiation needed by actual bounded Stop.
            f.sql(`INSERT INTO upstream_reservations(id,user_id,request_key,owner_epoch,room_id,media_id,source_id,generation,kind,device_id,origin_key,scope_encrypted,play_session_id,media_source_id,state,negotiation,cleanup_after,cleanup_deadline,source_policy_revision,lifecycle_epoch)
              SELECT ${quote(id)},${quote(user.id)},${quote(randomUUID())},${quote(randomUUID())},r.id,${quote(mediaId)},${quote(src.id)},(s.state->>'media_generation')::bigint,'jellyfin',${quote(`rainsync-${id}`)},${quote(digest(stopOrigin))},${quote(scope)},${quote(sid)},'fixture-source','closing','received',clock_timestamp()+interval '${ready ? "0" : "3600"} seconds',clock_timestamp()+interval '1 hour',${revision},r.lifecycle_epoch
              FROM rooms r JOIN room_snapshots s ON s.room_id=r.id WHERE r.id=${quote(room.id)}`);
            return { id, sid };
          };
          const row = (id) =>
            JSON.parse(
              f.sql(
                `SELECT row_to_json(u) FROM upstream_reservations u WHERE id=${quote(id)}`,
              ) || "null",
            );
          const control = seed(true);
          await until(
            () => row(control.id)?.state === "closed",
            "real allowed-policy Stop reaches controlled origin and confirms",
            15000,
          );
          assert.equal(row(control.id).stop_confirmed, true);
          assert.equal(
            calls.filter(
              (call) =>
                call.sid === control.sid && call.item === "fixture-item",
            ).length,
            1,
          );
          const pending = seed(false);
          assert.equal(row(pending.id).cleanup_attempts, 0);
          const changed = await admin.request(
            `/sources/${src.id}/access-policy`,
            "POST",
            { expected_revision: revision, policy: denied },
          );
          assert.equal(changed.access_policy_revision, revision + 1);
          const snapshot = JSON.parse(
            f.sql(
              `SELECT row_to_json(s) FROM source_access_policy_snapshots s WHERE source_id=${quote(src.id)}`,
            ),
          );
          assert.equal(snapshot.revision, revision + 1);
          assert.deepEqual(
            decrypt(snapshot.config_encrypted).access_policy,
            denied,
          );
          f.sql(
            `UPDATE media_items SET source_id=NULL WHERE id=${quote(mediaId)}; DELETE FROM sources WHERE id=${quote(src.id)}`,
          );
          assert.equal(
            f.sql(`SELECT count(*) FROM sources WHERE id=${quote(src.id)}`),
            "0",
          );
          assert.deepEqual(
            JSON.parse(
              f.sql(
                `SELECT row_to_json(s) FROM source_access_policy_snapshots s WHERE source_id=${quote(src.id)}`,
              ),
            ),
            snapshot,
            "source deletion retains the exact newer cleanup authority",
          );
          assert.equal(
            row(pending.id).scope_encrypted,
            scope,
            "original cleanup identity remains captured",
          );
          const before = calls.length;
          // Release only after deletion. The genuine reporter must try, deny
          // the now-forbidden IP, and retain failure rather than fabricate drain.
          f.sql(
            `UPDATE upstream_reservations SET cleanup_after=clock_timestamp(),cleanup_deadline=clock_timestamp()+interval '8 seconds' WHERE id=${quote(pending.id)}`,
          );
          await until(
            () => row(pending.id)?.cleanup_attempts > 0,
            "cleanup attempt is actually claimed after source deletion",
            10000,
          );
          await until(
            () => row(pending.id)?.state === "cleanup_failed",
            "denied cleanup reaches its real bounded terminal state",
            15000,
          );
          const result = row(pending.id);
          assert.ok(
            result.cleanup_attempts >= 1 && result.cleanup_attempts <= 5,
          );
          assert.equal(result.stop_confirmed, false);
          assert.equal(result.encoding_stop_confirmed, false);
          assert.equal(result.closed_at, null);
          assert.equal(result.io_claim, null);
          assert.equal(result.source_policy_revision, revision);
          assert.equal(result.scope_encrypted, scope);
          assert.equal(
            calls.length,
            before,
            "no request may reach the previously allowed destination after tightening and deletion",
          );
          assert.equal(
            calls.some((call) => call.sid === pending.sid),
            false,
          );
          assert.equal(
            row(control.id).state,
            "closed",
            "genuine earlier cleanup receipt remains intact",
          );
          assert.deepEqual(
            JSON.parse(
              f.sql(
                `SELECT row_to_json(s) FROM source_access_policy_snapshots s WHERE source_id=${quote(src.id)}`,
              ),
            ),
            snapshot,
          );
          cases.push({
            captured_policy: capture,
            retained_revision: snapshot.revision,
            cleanup_attempts: result.cleanup_attempts,
            terminal_state: result.state,
            last_error: result.last_error,
            forbidden_stop_requests: 0,
            stop_confirmed: false,
          });
        }
        assert.deepEqual(stopErrors, []);
        return { cases, confirmed_control_stops: calls.length };
      },
    );
    await scenario(
      "disguised local and real NAS Agent playlists fail production probe",
      async () => {
        await writeFile(resolve(f.root, "disguised.mp4"), badHls);
        const localSource = await admin.request("/sources", "POST", {
          name: "gateway-local",
          kind: "local",
          config: { root: f.root },
        });
        await admin.request(`/sources/${localSource.id}/test`, "POST");
        const localId = f.sql(
          `SELECT id FROM media_items WHERE source_id=${quote(localSource.id)} AND resource='disguised.mp4'`,
        );
        assert.ok(localId);
        const local = await grant(
          { id: localSource.id, media: localId, kind: "local" },
          { root: f.root, resource: "disguised.mp4" },
        );
        await expectStatus(local.url, 200);
        await expectStatus(local.url.replace("/source?", "/probe?"), 502);
        assert.equal(
          foreignHits,
          0,
          "local source scan and Worker probe never follow playlist URLs",
        );
        const { agentId } = await f.startAgent();
        let indexed;
        await until(
          () => {
            const raw = f.sql(
              `SELECT row_to_json(m) FROM media_items m WHERE source_id=${quote(agentId)} AND resource='disguised.mp4' AND available AND source_version IS NOT NULL`,
            );
            indexed = raw ? JSON.parse(raw) : null;
            return indexed;
          },
          "actual Agent versioned index",
          20000,
        );
        assert.match(indexed.source_version, /^stat-v1:[0-9a-f]{64}$/);
        const agent = await grant(
          { id: agentId, media: indexed.id, kind: "agent" },
          {
            agent_id: agentId,
            resource: "disguised.mp4",
            source_version: indexed.source_version,
          },
        );
        const response = await get(agent.url);
        assert.equal(response.status, 200);
        assert.equal(
          await response.text(),
          badHls,
          "real NAS data transfer served the disguised local bytes",
        );
        await expectStatus(agent.url.replace("/source?", "/probe?"), 502);
        const transfers = Number(
          f.sql(
            `SELECT count(*) FROM agent_transfer_runs WHERE session_id=${quote(agent.id)}`,
          ),
        );
        assert.ok(
          transfers >= 2,
          "raw transfer and actual Worker probe both reached the real Agent",
        );
        await f.stopAgent();
        return {
          local_probe_status: 502,
          actual_agent_probe_status: 502,
          actual_agent_transfers: transfers,
        };
      },
    );
    await scenario(
      "paced unfinished manifest has a total preparation deadline",
      async () => {
        const path = `/paced-manifest/${randomUUID()}`;
        const session = await grant(await source(path));
        const started = Date.now();
        await expectStatus(session.url, 502, {
          signal: AbortSignal.timeout(40000),
        });
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 29000 && elapsed < 36000, "total 30s deadline is bounded");
        await until(() => slow.get(path)?.closed, "unfinished manifest socket closes");
        assert.ok(slow.get(path).chunks >= 200, "upstream stayed active inside its read timeout");
        await until(
          () => f.sql(`SELECT count(*) FROM media_executions WHERE session_id=${quote(session.id)} AND reaped_at IS NOT NULL`) === "1",
          "timed-out preparation persists its actual delivery disposal receipt",
        );
        assert.equal(f.sql(`SELECT count(*) FROM media_executions WHERE session_id=${quote(session.id)} AND reaped_at IS NULL`), "0");
        return { elapsed_ms: elapsed, active_chunks: slow.get(path).chunks, source_closed: true, reaped_delivery_owners: 1, unreaped_delivery_owners: 0 };
      },
    );
    assert.deepEqual(
      originErrors,
      [],
      "all owned-origin requests preserve source authorization and stay within fixture routes",
    );
    assert.equal(foreignHits, 0);
    await writeFile(
      resolve(f.root, "origin-requests.json"),
      JSON.stringify(requests, null, 2) + "\n",
    );
  });
  await verifyBinding();
  outcome = "passed";
} catch (error) {
  failure = error;
  throw error;
} finally {
  for (const req of consumers) req.destroy();
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map((child) => child.done));
  for (const { server } of listeners) server.closeAllConnections();
  await Promise.all(
    listeners.map(({ server }) => new Promise((done) => server.close(done))),
  );
  if (fixture && reportRoot) {
    const cleanup = await fixture.verifyStopped();
    const workerClosed = await verifyClosedPort(
      Number(new URL(fixture.workerOrigin).port),
    );
    assert.equal(workerClosed, true);
    if (fixture.workerPid)
      assert.equal(verifyPidAbsent(fixture.workerPid), true);
    if (fixture.agentPid) assert.equal(verifyPidAbsent(fixture.agentPid), true);
    const originCleanup = [];
    for (const { port } of listeners) {
      const closed = await verifyClosedPort(port);
      assert.equal(closed, true);
      originCleanup.push({ port, closed });
    }
    for (const process of subprocesses) {
      assert.equal(process.closed, true);
      if (process.pid) assert.equal(verifyPidAbsent(process.pid), true);
    }
    let finalBinding = "passed";
    try {
      await verifyBinding();
    } catch (error) {
      finalBinding = "failed";
      outcome = "failed";
      failure ??= error;
    }
    await writeFile(
      resolve(reportRoot, "report.json"),
      JSON.stringify(
        {
          schema_version: 1,
          result: outcome,
          error: failure?.message,
          binding_file: bindingFile,
          binding_sha256: digest(bindingBytes),
          source_digest: binding.source_digest,
          source: binding.source,
          binaries: binding.binaries,
          coordinator_inputs: coordinatorInputs,
          test_sha256: coordinatorInputs.find(
            (input) => input.path === "tests/source-access-gateway.mjs",
          ).sha256,
          final_binding_verification: finalBinding,
          tests,
          foreign_hits: foreignHits,
          cleanup: {
            ...cleanup,
            worker_pid_absent: fixture.workerPid ? true : null,
            worker_port_closed: workerClosed,
            agent_pid_absent: fixture.agentPid ? true : null,
            origins: originCleanup,
            ffmpeg: subprocesses,
          },
          limitations: [
            "Synthetic playback-session grants deliberately bypass candidate negotiation; real fixture auth, source, media, room, Worker and Agent paths are exercised",
            "Source connection closure and response abortion are measured; already-buffered bytes cannot be recalled and no remote drain receipt is invented",
            "Loopback CIDR/origin tests and the controlled Stop endpoint do not simulate DNS rebinding or real external provider negotiation",
          ],
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`Evidence: ${resolve(reportRoot, "report.json")}`);
    if (finalBinding !== "passed") throw failure;
  }
}
