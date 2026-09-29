// W07: isolated real NAS Agent -> Server/Worker -> real Web app -> Chromium.
// Default is a genuine 7,200-second decode/transfer run. A shorter duration is
// explicitly labelled a smoke test and can never satisfy the two-hour gate.
// No .env, deployed stack, invented media response, playback loop or clock jump.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer as netServer } from "node:net";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--(duration-seconds|sample-seconds|image)=(.+)$/.exec(arg);
    assert.ok(match, `unknown argument: ${arg}`);
    return [match[1], match[2]];
  }),
);
const duration = Number(options["duration-seconds"] ?? 7200);
const sampleSeconds = Number(
  options["sample-seconds"] ?? (duration < 120 ? 5 : 30),
);
assert.ok(Number.isInteger(duration) && duration >= 10 && duration <= 86400);
assert.ok(
  Number.isInteger(sampleSeconds) && sampleSeconds >= 2 && sampleSeconds <= 30,
);
const candidatePath = process.env.VALIDATION_CANDIDATE
  ? resolve(process.env.VALIDATION_CANDIDATE)
  : resolve("..", "candidate.json");
let candidate;
try {
  candidate = JSON.parse(await readFile(candidatePath, "utf8"));
  assert.equal(candidate.schema_version, 1, "unsupported validation candidate");
  assert.equal(
    candidate.status,
    "built",
    "candidate must be built before validation",
  );
  assert.ok(candidate.image?.id, "candidate has no pinned image");
  assert.equal(
    candidate.source_directory,
    "source",
    "unsupported frozen source directory",
  );
} catch (error) {
  if (process.env.VALIDATION_CANDIDATE || error.code !== "ENOENT") throw error;
}
const candidateSource = candidate
  ? resolve(dirname(candidatePath), candidate.source_directory)
  : undefined;
const normalizedDirectory = (path) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
if (candidate)
  assert.equal(
    normalizedDirectory(process.cwd()),
    normalizedDirectory(candidateSource),
    "run the validation from the candidate's frozen source directory",
  );
if (candidate)
  assert.equal(
    normalizedDirectory(fileURLToPath(import.meta.url)),
    normalizedDirectory(resolve(candidateSource, "tests/nas-soak.mjs")),
    "the running acceptance entry itself must come from the frozen candidate",
  );
const tag =
  options.image ??
  process.env.WORKER_TEST_IMAGE ??
  candidate?.image.id ??
  "rainsync-worker-validation:local";
const name = `rainsync-soak-${randomUUID().slice(0, 8)}`;
const root = resolve(".runtime/nas-soak", name);
const names = Object.fromEntries(
  ["db", "server", "worker", "agent"].map((k) => [k, `${name}-${k}`]),
);
const password = randomBytes(24).toString("hex");
const key = randomBytes(32).toString("base64");
const secrets = [password, key];
function redact(value) {
  let text = String(value);
  for (const secret of secrets)
    if (secret) text = text.split(secret).join("[redacted]");
  return text
    .replace(
      /([?&](?:token|ticket|key|code|csrf|authorization)=)[^\s&"<>]+/gi,
      "$1[redacted]",
    )
    .replace(/Bearer\s+[^\s"<>]+/gi, "Bearer [redacted]")
    .replace(/postgres(?:ql)?:\/\/[^\s"<>]+/gi, "postgres://[redacted]");
}
function docker(...args) {
  return dockerWithin(60000, ...args);
}
function dockerWithin(timeout, ...args) {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      windowsHide: true,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(
      redact(
        `docker ${args.slice(0, 2).join(" ")}: ${error.stderr ?? error.message}`,
      ),
    );
  }
}
const image = docker("image", "inspect", "--format", "{{.Id}}", tag);
const dbImage = docker(
  "image",
  "inspect",
  "--format",
  "{{.Id}}",
  "postgres:17",
);
const temporaryContainers = [];
function fixture(...args) {
  const container = `${name}-fixture-${temporaryContainers.length + 1}`;
  temporaryContainers.push(container);
  return docker(
    "run",
    "--rm",
    "--name",
    container,
    "--label",
    `rainsync.test-run=${name}`,
    ...args,
  );
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function boundedCleanup(description, action) {
  let timer;
  try {
    await Promise.race([
      action(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`cleanup deadline: ${description}`)),
          10000,
        );
      }),
    ]);
  } catch (error) {
    report.cleanup.push({
      kind: description,
      removed: false,
      error: redact(error.message),
    });
  } finally {
    clearTimeout(timer);
  }
}
let interrupted;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = signal;
  });
async function until(check, description, timeout = 60000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    assert.ok(!interrupted, `interrupted by ${interrupted}`);
    const result = await check();
    if (result) return result;
    await delay(250);
  }
  throw new Error(`deadline: ${description}`);
}
async function freePort() {
  const socket = netServer();
  await new Promise((r) => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  return port;
}
const origin = `http://127.0.0.1:${await freePort()}`;
const sql = (query) =>
  docker(
    "exec",
    names.db,
    "psql",
    "-U",
    "rainsync",
    "-d",
    "rainsync",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    query,
  );
const sqlJSON = (query) => JSON.parse(sql(query));
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function webIdentity() {
  const files = candidate
    ? candidate.source_manifest
        .filter(
          (entry) =>
            !entry.deleted &&
            /^(?:apps\/web|packages\/(?:player-core|sync-engine|protocol))\//.test(
              entry.path,
            ),
        )
        .map((entry) => entry.path)
        .sort()
    : execFileSync(
        "git",
        [
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "apps/web",
          "packages/player-core",
          "packages/sync-engine",
          "packages/protocol",
        ],
        { encoding: "utf8", windowsHide: true },
      )
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .sort();
  const hashes = await Promise.all(
    files.map(async (path) => [path, await sha256(path)]),
  );
  return {
    sha256: createHash("sha256").update(JSON.stringify(hashes)).digest("hex"),
    files: hashes,
  };
}
function candidateFile(path) {
  assert.ok(
    typeof path === "string" &&
      path &&
      !isAbsolute(path) &&
      !path.includes("\\") &&
      !path.split("/").includes(".."),
    "unsafe candidate source path",
  );
  assert.ok(
    !path
      .split("/")
      .some(
        (part) =>
          part.startsWith(".env") ||
          [".git", ".runtime", "node_modules"].includes(part),
      ),
    "forbidden candidate source path",
  );
  const target = resolve(candidateSource, path);
  assert.ok(
    !relative(candidateSource, target).startsWith(".."),
    "candidate path escapes frozen source",
  );
  return target;
}
async function verifyCandidateSource() {
  if (!candidate) return;
  const digest = (manifest) =>
    createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  assert.equal(
    digest(candidate.source_manifest),
    candidate.source_manifest_sha256,
    "candidate complete source manifest digest mismatch",
  );
  assert.equal(
    digest(candidate.production_manifest),
    candidate.production_manifest_sha256,
    "candidate production manifest digest mismatch",
  );
  const production = candidate.source_manifest.filter(
    (entry) =>
      ["Cargo.toml", "Cargo.lock"].includes(entry.path) ||
      /^(?:crates|migrations)\//.test(entry.path) ||
      /^apps\/(?:server|media-worker|nas-agent)\//.test(entry.path),
  );
  assert.deepEqual(
    candidate.production_manifest,
    production,
    "production manifest must describe the complete frozen build source",
  );
  const paths = new Set();
  for (const entry of candidate.source_manifest) {
    const target = candidateFile(entry.path);
    assert.ok(
      !paths.has(entry.path.toLowerCase()),
      "duplicate candidate source path",
    );
    paths.add(entry.path.toLowerCase());
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (entry.deleted) {
      assert.ok(!info, `deleted candidate file exists: ${entry.path}`);
      continue;
    }
    assert.ok(
      info?.isFile() && !info.isSymbolicLink(),
      `candidate file missing or redirected: ${entry.path}`,
    );
    assert.equal(
      info.size,
      entry.bytes,
      `candidate file size changed: ${entry.path}`,
    );
    assert.equal(
      await sha256(target),
      entry.sha256,
      `candidate source changed: ${entry.path}`,
    );
  }
  const actualPaths = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        [
          ".runtime",
          "node_modules",
          "target",
          "dist",
          ".git",
          ".cgraphy",
        ].includes(entry.name)
      )
        continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      assert.ok(
        !entry.isSymbolicLink(),
        `frozen source redirects a path: ${path}`,
      );
      if (entry.isDirectory())
        await visit(resolve(directory, entry.name), path);
      else actualPaths.push(path);
    }
  }
  await visit(candidateSource);
  assert.deepEqual(
    actualPaths.sort(),
    candidate.source_manifest
      .filter((entry) => !entry.deleted)
      .map((entry) => entry.path)
      .sort(),
    "frozen source contains missing or additional files",
  );
}
// Main Rust-process RSS and descriptors, including exactly the fixture file.
// /proc is read inside each real Linux container; temporary observer processes
// are excluded. FFmpeg RSS is separately reported as a child-process total.
function resources(container) {
  const output = docker(
    "exec",
    container,
    "sh",
    "-c",
    `
rss=$(awk '/^VmRSS:/ {print $2}' /proc/1/status)
fd=0; sockets=0; media=0
for f in /proc/1/fd/*; do
  [ -L "$f" ] || continue
  fd=$((fd+1)); target=$(readlink "$f" 2>/dev/null || true)
  case "$target" in socket:*) sockets=$((sockets+1));; /media/soak.mp4) media=$((media+1));; esac
done
child=0; children=0
for p in /proc/[0-9]*; do
  [ -r "$p/comm" ] || continue
  comm=$(cat "$p/comm" 2>/dev/null || true)
  if [ "$comm" = ffmpeg ]; then
    part=$(awk '/^VmRSS:/ {print $2}' "$p/status" 2>/dev/null)
    child=$((child+\${part:-0})); children=$((children+1))
  fi
done
printf '%s %s %s %s %s %s\n' "\${rss:-0}" "$fd" "$sockets" "$media" "$child" "$children"
`,
  );
  const [
    rss_kib,
    fd_count,
    socket_count,
    media_handles,
    ffmpeg_rss_kib,
    ffmpeg_count,
  ] = output.split(/\s+/).map(Number);
  assert.ok(
    rss_kib > 0 && fd_count > 0,
    `${container}: process measurement unavailable`,
  );
  return {
    rss_kib,
    fd_count,
    socket_count,
    media_handles,
    ffmpeg_rss_kib,
    ffmpeg_count,
  };
}
const report = {
  schema_version: 1,
  requested_duration_seconds: duration,
  gate:
    duration >= 7200
      ? "two-hour NAS playback"
      : "short smoke only; two-hour gate NOT satisfied",
  image,
  database_image: dbImage,
  started_at: new Date().toISOString(),
  pacing: {
    ffmpeg_input_readrate: 1.05,
    applies_to: "real HLS encoding input only",
  },
  thresholds: {
    maximum_agent_rss_kib: 131072,
    maximum_worker_rss_kib: 524288,
    maximum_server_rss_kib: 262144,
    maximum_ffmpeg_rss_kib: 524288,
    agent_rss_growth_kib: 32768,
    worker_rss_growth_kib: 65536,
    server_rss_growth_kib: 65536,
    maximum_extra_fds: 24,
    maximum_extra_sockets: 8,
    post_stop_extra_agent_sockets: 2,
    maximum_agent_heartbeat_age_seconds: 15,
    maximum_post_stop_seconds: 5,
    maximum_media_lag_seconds: 10,
    maximum_transfer_observation_stall_seconds: 60,
    minimum_media_seconds_per_wall_second: 0.9,
    minimum_decoded_frame_fraction: 0.95,
    maximum_dropped_frame_fraction: 0.02,
  },
  samples: [],
  browser_errors: [],
  media_errors: [],
  delivery: {
    responses: 0,
    announced_bytes: 0,
    received_body_bytes: 0,
    finished_requests: 0,
    non_success: [],
    network_failures: [],
    intentional_cancellations: [],
  },
  control: {
    status_frames_sent: 0,
    clock_frames_sent: 0,
    frames_received: 0,
    websocket_closes: 0,
  },
  renewals: [],
  plans: [],
  api_requests: [],
  diagnostics: {
    path: resolve(root, "playback-diagnostics.jsonl"),
    events: 0,
    noteworthy: [],
  },
  cleanup: [],
};
let browser, context, page, vite, sessionId, api, baseline;
let expectedSessionId;
let observationEnded = false;
let diagnosticWrites = Promise.resolve();
let hlsModuleUrl;
const hlsStops = [];
let stopBegan;
async function stopSnapshot(stage) {
  const sample = {
    stage,
    at: new Date().toISOString(),
    elapsed_seconds: (performance.now() - stopBegan) / 1000,
  };
  sample.database = sqlJSON(
    `SELECT json_build_object('session',(SELECT json_build_object('stopped',stopped,'expires_at',expires_at) FROM playback_sessions WHERE id='${sessionId}'),'job',(SELECT json_build_object('status',status,'attempt',attempt) FROM media_jobs WHERE session_id='${sessionId}'),'transfers',(SELECT coalesce(json_agg(json_build_object('id',id,'status',status,'bytes_delivered',bytes_delivered,'reason',reason,'created_at',created_at,'updated_at',updated_at,'lease_until',lease_until,'finished_at',finished_at)),'[]'::json) FROM agent_transfer_runs WHERE agent_id='${report.agent_id}'))`,
  );
  sample.resources = Object.fromEntries(
    ["agent", "worker", "server"].map((kind) => [kind, resources(names[kind])]),
  );
  sample.measured_at_seconds = (performance.now() - stopBegan) / 1000;
  sample.released =
    sample.database.session?.stopped === true &&
    sample.database.job?.status === "cancelled" &&
    sample.database.transfers.length > 0 &&
    sample.database.transfers.every(
      (t) => t.finished_at && ["completed", "cancelled"].includes(t.status),
    ) &&
    sample.resources.agent.media_handles === 0 &&
    sample.resources.agent.socket_count <=
      baseline.agent.socket_count +
        report.thresholds.post_stop_extra_agent_sockets &&
    sample.resources.worker.ffmpeg_count === 0;
  (report.stop_timeline ??= []).push(sample);
  diagnostic({ kind: "stop_snapshot", ...sample });
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  return sample;
}
async function observeStop(stage, maximumSeconds) {
  while (true) {
    const sample = await stopSnapshot(stage);
    if (
      sample.released ||
      performance.now() - stopBegan >= maximumSeconds * 1000
    )
      return sample;
    // A one-second cadence retains real cancellation timing, including delayed
    // finalization. Resource measurement time counts toward the bound.
    await delay(
      Math.max(
        0,
        1000 - (sample.measured_at_seconds - sample.elapsed_seconds) * 1000,
      ),
    );
  }
}
function diagnostic(event) {
  const entry = JSON.parse(
    redact(
      JSON.stringify({
        at: new Date().toISOString(),
        phase: observationEnded ? "cleanup" : "playback",
        ...event,
      }),
    ),
  );
  report.diagnostics.events++;
  if (entry.kind === "hls_stopLoad") hlsStops.push(entry);
  if (
    /error|reset|loadSource|startLoad|stopLoad|currentTime|pause|play|emptied|loadstart|waiting|seeking/.test(
      entry.kind ?? "",
    )
  )
    report.diagnostics.noteworthy.push(entry);
  diagnosticWrites = diagnosticWrites.then(() =>
    appendFile(report.diagnostics.path, JSON.stringify(entry) + "\n"),
  );
  diagnosticWrites.catch(() => {});
}
let successful = false;
let cookie = "",
  csrf = "";
await mkdir(resolve(root, "media"), { recursive: true });
await mkdir(resolve(root, "fixture"));
await mkdir(resolve(root, "bin"));
await writeFile(
  resolve(root, "bin/ffmpeg"),
  `#!/bin/sh
for last do :; done
case "$last" in
  */index.m3u8) exec /usr/bin/ffmpeg -readrate 1.05 "$@" ;;
  *) exec /usr/bin/ffmpeg "$@" ;;
esac
`,
  { mode: 0o755 },
);
const env = [
  "-e",
  `DATABASE_URL=postgres://rainsync:${password}@db/rainsync`,
  "-e",
  `SOURCE_ENCRYPTION_KEY=${key}`,
  "-e",
  `ADMIN_PASSWORD=${password}`,
  "-e",
  `PUBLIC_ORIGIN=${origin}`,
];
try {
  await verifyCandidateSource();
  if (candidate) {
    assert.equal(
      image,
      candidate.image.id,
      "runtime image must match the frozen candidate",
    );
    const labels = JSON.parse(
      docker("image", "inspect", "--format", "{{json .Config.Labels}}", image),
    );
    assert.equal(
      labels["org.rainsync.source-manifest"],
      candidate.production_manifest_sha256,
      "actual runtime image does not bind the production manifest",
    );
    assert.equal(
      labels["org.rainsync.full-source-manifest"],
      candidate.source_manifest_sha256,
      "actual runtime image does not bind the complete source manifest",
    );
    report.candidate = {
      path: candidatePath,
      id: candidate.id,
      source_manifest_sha256: candidate.source_manifest_sha256,
      production_manifest_sha256: candidate.production_manifest_sha256,
      source_manifest: candidate.source_manifest,
      production_manifest: candidate.production_manifest,
      git: candidate.git,
      image: candidate.image,
    };
  }
  report.runner_sha256 = await sha256("tests/nas-soak.mjs");
  report.web = await webIdentity();
  report.git_head =
    candidate?.git.head ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  report.binaries = fixture(
    image,
    "sh",
    "-c",
    "sha256sum /usr/local/bin/rainsync-server /usr/local/bin/rainsync-media-worker /usr/local/bin/rainsync-nas-agent",
  );
  if (candidate) {
    const measured = Object.fromEntries(
      report.binaries.split(/\r?\n/).map((line) => {
        const match =
          /^([0-9a-f]{64})\s+\/usr\/local\/bin\/(rainsync-[a-z-]+)$/.exec(line);
        assert.ok(match, "invalid runtime binary identity");
        return [match[2], match[1]];
      }),
    );
    assert.deepEqual(
      measured,
      candidate.image.binary_sha256,
      "actual image binaries must match the frozen candidate proof",
    );
  }
  report.ffmpeg_version = fixture(image, "ffmpeg", "-version").split(
    /\r?\n/,
  )[0];
  const mount = ["--mount", `type=bind,source=${root},target=/fixture`];
  fixture(
    ...mount,
    image,
    "ffmpeg",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "10",
    "-c:v",
    "mpeg4",
    "-q:v",
    "7",
    "-g",
    "10",
    "-c:a",
    "aac",
    "-b:a",
    "48k",
    "/fixture/fixture/seed.mp4",
  );
  // This produces a single long, timestamped MP4. The browser never loops or
  // seeks to turn a short clip into an apparent two-hour observation.
  // Even a short smoke fixture must exceed socket/read-ahead buffers, otherwise
  // it would finish NAS transmission before the first browser observation.
  const sampleDuration = Math.max(900, Math.ceil(duration * 1.15 + 60));
  fixture(
    ...mount,
    image,
    "ffmpeg",
    "-v",
    "error",
    "-stream_loop",
    "-1",
    "-i",
    "/fixture/fixture/seed.mp4",
    "-t",
    String(sampleDuration),
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    "/fixture/media/soak.mp4",
  );
  report.sample = {
    sha256: await sha256(resolve(root, "media/soak.mp4")),
    seed_sha256: await sha256(resolve(root, "fixture/seed.mp4")),
    bytes: (await stat(resolve(root, "media/soak.mp4"))).size,
    probe: JSON.parse(
      fixture(
        ...mount,
        image,
        "ffprobe",
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        "/fixture/media/soak.mp4",
      ),
    ),
  };
  assert.ok(
    Number(report.sample.probe.format.duration) >= sampleDuration - 1,
    "fixture really contains the requested long timeline",
  );
  console.log(`Evidence: ${resolve(root, "report.json")}`);
  console.log(
    `${report.gate}; pinned image ${image}; actual MP4 ${report.sample.probe.format.duration}s`,
  );
  docker("network", "create", name);
  docker(
    "run",
    "-d",
    "--name",
    names.db,
    "--network",
    name,
    "--network-alias",
    "db",
    "-e",
    "POSTGRES_USER=rainsync",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    dbImage,
  );
  await until(() => {
    try {
      return docker("exec", names.db, "pg_isready", "-U", "rainsync").includes(
        "accepting connections",
      );
    } catch {
      return false;
    }
  }, "database ready");
  docker(
    "run",
    "-d",
    "--name",
    names.server,
    "--network",
    name,
    "-p",
    "127.0.0.1::8080",
    ...env,
    "-e",
    `WORKER_URL=http://${names.worker}:8081`,
    image,
    "rainsync-server",
  );
  const apiBase = `http://${docker("port", names.server, "8080/tcp")}`;
  await until(async () => {
    try {
      return (
        await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(2000) })
      ).ok;
    } catch {
      return false;
    }
  }, "server ready");
  docker(
    "run",
    "-d",
    "--name",
    names.worker,
    "--network",
    name,
    "-p",
    "127.0.0.1::8081",
    ...env,
    "-e",
    "PATH=/pacing:/usr/local/bin:/usr/bin:/bin",
    "--mount",
    `type=bind,source=${resolve(root, "bin")},target=/pacing,readonly`,
    image,
    "rainsync-media-worker",
  );
  const workerBase = `http://${docker("port", names.worker, "8081/tcp")}`;
  const csp = (await readFile("deploy/Caddyfile", "utf8")).match(
    /Content-Security-Policy "([^"]+)"/,
  )[1];
  vite = await createServer({
    root: resolve("apps/web"),
    envDir: resolve(root, "fixture"),
    configFile: resolve("apps/web/vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port: Number(new URL(origin).port),
      strictPort: true,
      headers: { "Content-Security-Policy": csp },
      proxy: {
        "/api": { target: apiBase, ws: true },
        "/media-delivery": workerBase,
        "/agent-data": { target: workerBase, ws: true },
      },
    },
  });
  await vite.listen();
  api = async (path, method = "GET", body) => {
    const entry = {
      source: "test-api",
      path,
      method,
      began_at: new Date().toISOString(),
    };
    report.api_requests.push(entry);
    const began = performance.now();
    try {
      const response = await fetch(`${origin}/api/v1${path}`, {
        method,
        headers: {
          Origin: origin,
          Cookie: cookie,
          "x-csrf-token": csrf,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(method === "DELETE" ? 5000 : 60000),
      });
      if (response.headers.has("set-cookie")) {
        cookie = response.headers.get("set-cookie").split(";")[0];
        secrets.push(cookie, cookie.slice(cookie.indexOf("=") + 1));
      }
      const value = await response.json();
      entry.status = response.status;
      if (/^\/playback-sessions\//.test(path)) entry.body = value;
      assert.equal(
        response.status,
        200,
        redact(`${method} ${path}: ${JSON.stringify(value)}`),
      );
      return value;
    } catch (error) {
      entry.error = redact(error.message);
      throw error;
    } finally {
      entry.ended_at = new Date().toISOString();
      entry.elapsed_seconds = (performance.now() - began) / 1000;
      diagnostic({ kind: "api", ...entry });
    }
  };
  const login = await api("/auth/login", "POST", {
    username: "admin",
    password,
  });
  csrf = login.csrf;
  secrets.push(csrf);
  const room = await api("/rooms", "POST", {
    name: "NAS sustained playback acceptance",
  });
  const pair = await api("/agents", "POST", {
    name: "Isolated real NAS soak Agent",
  });
  secrets.push(pair.pair_code);
  docker(
    "run",
    "-d",
    "--name",
    names.agent,
    "--network",
    name,
    "-e",
    `SERVER_URL=http://${names.server}:8080`,
    "-e",
    `AGENT_DATA_ORIGIN=http://${names.worker}:8081`,
    "-e",
    `PAIR_CODE=${pair.pair_code}`,
    "-e",
    "MEDIA_ROOT=/media",
    "-e",
    "AGENT_CREDENTIAL_FILE=/tmp/credentials.json",
    "--mount",
    `type=bind,source=${resolve(root, "media")},target=/media,readonly`,
    image,
    "rainsync-nas-agent",
  );
  const indexed = await until(
    () => {
      const rows = sqlJSON(
        `SELECT coalesce(json_agg(json_build_object('id',id,'duration_ms',duration_ms,'source_version',source_version,'metadata',metadata)),'[]'::json) FROM media_items WHERE source_id='${pair.id}' AND available`,
      );
      return rows.length === 1 && rows[0].source_version ? rows[0] : false;
    },
    "real paired Agent completes full available/versioned index",
    120000,
  );
  report.index = indexed;
  report.agent_id = pair.id;
  report.running_containers = Object.fromEntries(
    Object.entries(names).map(([kind, container]) => [
      kind,
      docker("inspect", "--format", "{{.Id}} {{.Image}}", container),
    ]),
  );
  baseline = Object.fromEntries(
    ["agent", "worker", "server"].map((k) => [k, resources(names[k])]),
  );
  report.before_playback = baseline;
  browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  report.browser = browser.version();
  context = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
  });
  await context.addCookies([
    {
      name: cookie.split("=")[0],
      value: cookie.slice(cookie.indexOf("=") + 1),
      url: origin,
    },
  ]);
  page = await context.newPage();
  await page.exposeBinding("__recordNasDiagnostic", (_, event) =>
    diagnostic(event),
  );
  // Select the supported MSE transport through the normal capability detector;
  // media/API responses, clocks and playback progression are untouched.
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      return type.toLowerCase().includes("mpegurl")
        ? ""
        : original.call(this, type);
    };
  });
  page.on("pageerror", (error) =>
    report.browser_errors.push(redact(error.message)),
  );
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      diagnostic({
        kind: "console",
        level: message.type(),
        text: message.text(),
      });
  });
  page.on("websocket", (socket) => {
    if (!new URL(socket.url()).pathname.endsWith("/api/v1/ws")) return;
    socket.on("framesent", ({ payload }) => {
      try {
        const message = JSON.parse(String(payload));
        if (message.type === "CLIENT_STATUS")
          report.control.status_frames_sent++;
        if (message.type === "CLIENT_STATUS")
          diagnostic({ kind: "CLIENT_STATUS", message });
        if (/CLOCK|TIME/.test(message.type)) report.control.clock_frames_sent++;
      } catch {}
    });
    socket.on("framereceived", ({ payload }) => {
      report.control.frames_received++;
      try {
        const message = JSON.parse(String(payload));
        if (/STATE|CLOCK|TIME/.test(message.type))
          diagnostic({ kind: "control_received", message });
      } catch {}
    });
    socket.on("close", () => report.control.websocket_closes++);
  });
  page.on("response", async (response) => {
    try {
      const url = new URL(response.url());
      const method = response.request().method();
      if (/\/node_modules\/\.vite\/deps\/hls[^/]*\.js$/.test(url.pathname))
        hlsModuleUrl = url.href;
      if (/^\/api\/v1\/playback-sessions\/[^/]+$/.test(url.pathname)) {
        const entry = {
          source: "browser",
          method,
          path: url.pathname,
          query: url.search,
          status: response.status(),
          at: new Date().toISOString(),
          body: await response.json(),
        };
        report.api_requests.push(entry);
        diagnostic({ kind: "browser_session_api", ...entry });
      }
      if (
        url.pathname === "/api/v1/playback-sessions" &&
        method === "POST" &&
        response.ok()
      ) {
        const plan = await response.json();
        report.plans.push({
          session_id: plan.session_id,
          delivery_mode: plan.delivery_mode,
          timeline_origin_ms: plan.timeline_origin_ms,
          duration_ms: plan.duration_ms,
          request_mode: response.request().postDataJSON().mode,
        });
        const token = new URL(plan.playback_url, origin).searchParams.get(
          "token",
        );
        if (token) secrets.push(token);
        if (!sessionId) sessionId = plan.session_id;
      } else if (
        /^\/api\/v1\/playback-sessions\/[^/]+$/.test(url.pathname) &&
        method === "POST"
      ) {
        report.renewals.push({
          at: new Date().toISOString(),
          session_id: url.pathname.split("/").at(-1),
          status: response.status(),
        });
      } else if (url.pathname.startsWith("/media-delivery/")) {
        report.delivery.responses++;
        report.delivery.announced_bytes += Number(
          response.headers()["content-length"] ?? 0,
        );
        if (!response.ok())
          report.delivery.non_success.push({
            path: url.pathname,
            status: response.status(),
          });
      }
    } catch (error) {
      report.browser_errors.push(redact(error.message));
    }
  });
  const cdp = await context.newCDPSession(page);
  const deliveryRequests = new Map();
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
    if (new URL(request.url).pathname.startsWith("/media-delivery/"))
      deliveryRequests.set(requestId, {
        path: new URL(request.url).pathname,
        began_at: new Date().toISOString(),
      });
  });
  cdp.on("Network.dataReceived", ({ requestId, dataLength }) => {
    if (deliveryRequests.has(requestId))
      report.delivery.received_body_bytes += dataLength;
  });
  cdp.on("Network.loadingFinished", ({ requestId }) => {
    if (deliveryRequests.delete(requestId)) report.delivery.finished_requests++;
  });
  cdp.on("Network.loadingFailed", ({ requestId, errorText, canceled }) => {
    const request = deliveryRequests.get(requestId);
    if (request) {
      deliveryRequests.delete(requestId);
      const failure = {
        kind: "network_error",
        ...request,
        error: errorText,
        canceled,
        at: new Date().toISOString(),
      };
      diagnostic(failure);
      if (!observationEnded)
        report.delivery.network_failures.push({
          ...failure,
          error: redact(errorText),
          canceled: !!canceled,
        });
    }
  });
  await cdp.send("Network.enable");
  await cdp.send("Media.enable");
  for (const event of [
    "Media.playerEventsAdded",
    "Media.playerMessagesLogged",
    "Media.playerPropertiesChanged",
  ])
    cdp.on(event, (data) => diagnostic({ kind: event, data }));
  cdp.on("Media.playerErrorsRaised", ({ errors }) =>
    report.media_errors.push(
      ...errors.map((error) => ({
        errorType: error.errorType,
        code: error.code,
      })),
    ),
  );
  await page.goto(origin);
  await page
    .locator(".room-card")
    .filter({
      has: page.getByRole("heading", {
        name: "NAS sustained playback acceptance",
        exact: true,
      }),
    })
    .getByRole("button", { name: "进入房间", exact: true })
    .click();
  await page.waitForURL(`${origin}/rooms/${room.id}`);
  await page.locator("video").waitFor();
  assert.ok(
    hlsModuleUrl,
    "observe the actual served Hls module before selecting media",
  );
  await page.evaluate(async (url) => {
    const Hls = (await import(url)).default;
    for (const method of [
      "loadSource",
      "startLoad",
      "stopLoad",
      "attachMedia",
      "detachMedia",
      "recoverMediaError",
    ]) {
      const original = Hls.prototype[method];
      Hls.prototype[method] = function (...args) {
        window.__recordNasDiagnostic({
          kind: `hls_${method}`,
          arguments: args.filter((a) => typeof a !== "object"),
          source: this.url,
          stack: new Error().stack,
        });
        return original.apply(this, args);
      };
    }
    const trigger = Hls.prototype.trigger;
    Hls.prototype.trigger = function (event, data) {
      if (
        [
          Hls.Events.ERROR,
          Hls.Events.MANIFEST_LOADING,
          Hls.Events.MANIFEST_LOADED,
          Hls.Events.MEDIA_ATTACHING,
          Hls.Events.MEDIA_DETACHING,
          Hls.Events.LEVEL_UPDATED,
          Hls.Events.FRAG_BUFFERED,
        ].includes(event)
      ) {
        window.__recordNasDiagnostic({
          kind: event === Hls.Events.ERROR ? "hls_error" : event,
          detail: typeof data?.details === "string" ? data.details : undefined,
          fatal: data?.fatal,
          type: data?.type,
          reason: data?.reason,
          error: data?.error?.message,
          response_code: data?.response?.code,
          fragment: data?.frag && {
            start: data.frag.start,
            duration: data.frag.duration,
            sn: data.frag.sn,
          },
          level:
            data?.details && typeof data.details === "object"
              ? {
                  live: data.details.live,
                  totalduration: data.details.totalduration,
                  startSN: data.details.startSN,
                  endSN: data.details.endSN,
                }
              : undefined,
        });
      }
      return trigger.call(this, event, data);
    };
    const video = document.querySelector("video");
    const stats = (window.__nasSoak = {
      waiting: 0,
      stalled: 0,
      ended: 0,
      errors: 0,
      seeks: 0,
      presented_frames: 0,
      native_total: 0,
      native_dropped: 0,
      quality_resets: [],
      buffer_ms: 0,
      buffer_since: undefined,
      began: performance.now(),
    });
    let quality = video.getVideoPlaybackQuality();
    const readQuality = () => {
      const current = video.getVideoPlaybackQuality();
      if (
        current.totalVideoFrames < quality.totalVideoFrames ||
        current.droppedVideoFrames < quality.droppedVideoFrames
      ) {
        const reset = {
          at_ms: performance.now(),
          media_time: video.currentTime,
          before: {
            total: quality.totalVideoFrames,
            dropped: quality.droppedVideoFrames,
          },
          after: {
            total: current.totalVideoFrames,
            dropped: current.droppedVideoFrames,
          },
          ready_state: video.readyState,
          presented_frames: stats.presented_frames,
        };
        stats.quality_resets.push(reset);
        window.__recordNasDiagnostic({ kind: "quality_reset", ...reset });
        stats.native_total += current.totalVideoFrames;
        stats.native_dropped += current.droppedVideoFrames;
      } else {
        stats.native_total +=
          current.totalVideoFrames - quality.totalVideoFrames;
        stats.native_dropped +=
          current.droppedVideoFrames - quality.droppedVideoFrames;
      }
      quality = current;
      return current;
    };
    window.__nasQuality = readQuality;
    let frameId;
    const arm = () => {
      if (frameId !== undefined) return;
      frameId = video.requestVideoFrameCallback((_, metadata) => {
        frameId = undefined;
        stats.presented_frames++;
        stats.last_presented = {
          media_time: metadata.mediaTime,
          presented_frames: metadata.presentedFrames,
          presentation_time: metadata.presentationTime,
        };
        readQuality();
        arm();
      });
    };
    for (const event of [
      "waiting",
      "stalled",
      "ended",
      "error",
      "seeking",
      "seeked",
      "emptied",
      "loadstart",
      "loadedmetadata",
      "loadeddata",
      "canplay",
      "playing",
      "pause",
      "ratechange",
    ])
      video.addEventListener(event, () => {
        if (event === "waiting") stats.waiting++;
        if (event === "stalled") stats.stalled++;
        if (event === "ended") stats.ended++;
        if (event === "error") stats.errors++;
        if (event === "seeking") stats.seeks++;
        if (
          ["waiting", "stalled"].includes(event) &&
          stats.buffer_since === undefined
        )
          stats.buffer_since = performance.now();
        if (event === "playing" && stats.buffer_since !== undefined) {
          stats.buffer_ms += performance.now() - stats.buffer_since;
          stats.buffer_since = undefined;
        }
        const current = readQuality();
        window.__recordNasDiagnostic({
          kind: `video_${event}`,
          media_time: video.currentTime,
          ready_state: video.readyState,
          paused: video.paused,
          seeking: video.seeking,
          rate: video.playbackRate,
          total_frames: current.totalVideoFrames,
          dropped_frames: current.droppedVideoFrames,
          presented_frames: stats.presented_frames,
          src: video.currentSrc,
        });
        arm();
      });
    for (const method of ["play", "pause", "load"]) {
      const original = video[method];
      video[method] = function (...args) {
        window.__recordNasDiagnostic({
          kind: `video_call_${method}`,
          media_time: video.currentTime,
          stack: new Error().stack,
        });
        return original.apply(this, args);
      };
    }
    const currentTime = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "currentTime",
    );
    Object.defineProperty(video, "currentTime", {
      get() {
        return currentTime.get.call(this);
      },
      set(value) {
        window.__recordNasDiagnostic({
          kind: "video_currentTime",
          from: currentTime.get.call(this),
          to: value,
          stack: new Error().stack,
        });
        return currentTime.set.call(this, value);
      },
    });
    arm();
  }, hlsModuleUrl);
  await page.locator(".video-frame").hover();
  await page.getByRole("button", { name: "播放选项", exact: true }).click();
  await page.getByRole("combobox", { name: "播放方式", exact: true }).click();
  await page.getByRole("option", { name: "自动适配", exact: true }).click();
  await page.getByRole("button", { name: "播放选项", exact: true }).click();
  await page.locator("video").evaluate((v) => {
    v.muted = true;
  });
  await page.getByRole("link", { name: "选择影片", exact: true }).click();
  await page
    .locator(`.media-card[data-media-id="${indexed.id}"]`)
    .getByRole("button", { name: /^播放 / })
    .click();
  await page.waitForURL(`${origin}/rooms/${room.id}`);
  report.frontend_flow = {
    implementation:
      "front/rainsync-implementation modular RoomPage/PlaybackHost/LibraryPage",
    room_entry: "room-card normal Enter room button",
    selection: "normal LibraryPage media-card Play button",
    mode: "normal PlaybackSettings Auto option",
    change_media: "normal room websocket CHANGE_MEDIA",
    preview_requests_included_in_all_transfer_finalization: true,
  };
  await page.waitForFunction(
    () => document.querySelector("video")?.readyState >= 2,
    undefined,
    { timeout: 120000 },
  );
  await until(() => sessionId, "normal auto playback API completes");
  expectedSessionId = sessionId;
  assert.equal(report.plans.length, 1, "one normal API preparation");
  assert.equal(report.plans[0].request_mode, "auto");
  assert.ok(
    report.plans[0].duration_ms >= (sampleDuration - 1) * 1000,
    "normal auto preparation probes the real long NAS sample duration",
  );
  assert.equal(
    report.plans[0].delivery_mode,
    "transcode",
    "unsupported MPEG4 input automatically selects real transcoding",
  );
  // Exercise the real renewal endpoint during smoke tests too. The full run
  // additionally requires the unmodified Web app's ten-minute renewals.
  await api(`/playback-sessions/${sessionId}`, "POST");
  report.initial_manual_renewal = true;
  await page.locator(".video-frame").hover();
  const blockedPlay = page.getByRole("button", {
    name: "点击加入播放",
    exact: true,
  });
  if (await blockedPlay.isVisible()) {
    await blockedPlay.click();
    report.frontend_flow.play_action =
      "normal user gesture joins blocked autoplay";
  } else if (
    await page.getByRole("button", { name: "播放", exact: true }).isVisible()
  ) {
    await page.getByRole("button", { name: "播放", exact: true }).click();
    report.frontend_flow.play_action = "normal room PLAY control";
  } else
    report.frontend_flow.play_action =
      "normal CHANGE_MEDIA automatically starts Playing";
  // Keep the actual player visible after returning from the media library so
  // compositor statistics describe an actual viewing session.
  await page.locator("video").scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () => {
      const v = document.querySelector("video");
      return (
        v?.currentTime > 0.5 &&
        v.getVideoPlaybackQuality().totalVideoFrames > 0 &&
        !v.paused
      );
    },
    undefined,
    { timeout: 30000 },
  );
  const observeVideo = () =>
    page.locator("video").evaluate((v) => {
      const quality = window.__nasQuality();
      const stats = window.__nasSoak;
      const bufferMs =
        stats.buffer_ms +
        (stats.buffer_since === undefined
          ? 0
          : performance.now() - stats.buffer_since);
      return {
        time_seconds: v.currentTime,
        paused: v.paused,
        seeking: v.seeking,
        ready_state: v.readyState,
        frames: stats.presented_frames,
        frame_measurement:
          "requestVideoFrameCallback actually presented callbacks",
        dropped_frames: stats.native_dropped,
        quality_raw: {
          total: quality.totalVideoFrames,
          dropped: quality.droppedVideoFrames,
        },
        quality_cumulative_total: stats.native_total,
        quality_resets: [...stats.quality_resets],
        last_presented: stats.last_presented,
        buffered: Array.from({ length: v.buffered.length }, (_, i) => ({
          start: v.buffered.start(i),
          end: v.buffered.end(i),
        })),
        seekable: Array.from({ length: v.seekable.length }, (_, i) => ({
          start: v.seekable.start(i),
          end: v.seekable.end(i),
        })),
        visibility: (() => {
          const r = v.getBoundingClientRect();
          const visible =
            Math.max(0, Math.min(r.right, innerWidth) - Math.max(0, r.left)) *
            Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(0, r.top));
          return {
            state: document.visibilityState,
            viewport_fraction: visible / Math.max(1, r.width * r.height),
            rect: {
              top: r.top,
              bottom: r.bottom,
              left: r.left,
              right: r.right,
            },
            scroll_y: scrollY,
          };
        })(),
        buffering_seconds: bufferMs / 1000,
        buffering_fraction:
          bufferMs / Math.max(1, performance.now() - stats.began),
        media_error: v.error?.code ?? null,
        source_kind: v.currentSrc.startsWith("blob:") ? "mse" : "native",
        buffering: !!document.querySelector(".buffering"),
        events: {
          waiting: stats.waiting,
          stalled: stats.stalled,
          ended: stats.ended,
          errors: stats.errors,
          seeks: stats.seeks,
        },
      };
    });
  report.initial_video = await observeVideo();
  assert.equal(report.initial_video.source_kind, "mse");
  const began = performance.now();
  report.playback_started_at = new Date().toISOString();
  let previous;
  const takeSample = async (stage) => {
    assert.equal(
      report.plans.length,
      1,
      "continuous playback retains its original prepared plan",
    );
    assert.equal(sessionId, expectedSessionId);
    assert.ok(
      report.renewals.every(
        (renewal) =>
          renewal.session_id === expectedSessionId && renewal.status === 200,
      ),
      "normal Web renewal remains bound to the successful original playback session",
    );
    const video = await observeVideo();
    const elapsed = (performance.now() - began) / 1000;
    report.native_quality_resets = video.quality_resets;
    video.quality_reset_count = video.quality_resets.length;
    video.quality_resets_since_previous = video.quality_resets.slice(
      previous?.video.quality_reset_count ?? 0,
    );
    delete video.quality_resets;
    video.observation_buffering_seconds = Math.max(
      0,
      video.buffering_seconds - report.initial_video.buffering_seconds,
    );
    video.observation_buffering_fraction =
      video.observation_buffering_seconds / Math.max(0.001, elapsed);
    const sample = {
      stage,
      at: new Date().toISOString(),
      elapsed_seconds: elapsed,
      video,
      control: { ...report.control },
      resources: Object.fromEntries(
        ["agent", "worker", "server"].map((k) => [k, resources(names[k])]),
      ),
    };
    sample.database = sqlJSON(
      `SELECT json_build_object('agent_heartbeat_age_seconds',(SELECT extract(epoch FROM now()-last_seen) FROM agents WHERE id='${pair.id}'),'connections',(SELECT count(*) FROM pg_stat_activity WHERE datname='rainsync'),'session_seconds_remaining',(SELECT extract(epoch FROM expires_at-now()) FROM playback_sessions WHERE id='${sessionId}'),'transfers',(SELECT coalesce(json_agg(json_build_object('id',id,'status',status,'bytes_delivered',bytes_delivered,'lease_seconds_remaining',extract(epoch FROM lease_until-now()))),'[]'::json) FROM agent_transfer_runs WHERE agent_id='${pair.id}'),'job',(SELECT json_build_object('status',status,'attempt',attempt,'lease_seconds_remaining',extract(epoch FROM lease_until-now())) FROM media_jobs WHERE session_id='${sessionId}'))`,
    );
    sample.transmitted_bytes = sample.database.transfers.reduce(
      (n, t) => n + t.bytes_delivered,
      0,
    );
    report.samples.push(sample);
    await appendFile(
      resolve(root, "samples.jsonl"),
      JSON.stringify(sample) + "\n",
    );
    assert.equal(video.media_error, null);
    assert.equal(
      video.events.ended,
      0,
      "sample must be long enough for continuous observation",
    );
    assert.equal(video.events.errors, 0);
    assert.equal(
      report.control.websocket_closes,
      0,
      "control connection remains established",
    );
    assert.ok(
      sample.database.agent_heartbeat_age_seconds <=
        report.thresholds.maximum_agent_heartbeat_age_seconds,
      "real Agent keeps sending control heartbeats",
    );
    assert.ok(
      sample.database.session_seconds_remaining > 0,
      "playback session remains valid",
    );
    assert.equal(
      sample.database.job.status,
      "running",
      "paced real transcode remains active",
    );
    assert.equal(
      sample.database.job.attempt,
      1,
      "no hidden worker retry during playback",
    );
    assert.ok(
      sample.database.job.lease_seconds_remaining > 0,
      "real worker renews its execution lease",
    );
    assert.ok(
      sample.database.connections <= 25,
      "database connection count stays bounded",
    );
    for (const [kind, resource] of Object.entries(sample.resources)) {
      assert.ok(
        resource.rss_kib <= report.thresholds[`maximum_${kind}_rss_kib`],
        `${kind} RSS exceeds absolute budget`,
      );
      assert.ok(
        resource.fd_count <=
          baseline[kind].fd_count + report.thresholds.maximum_extra_fds,
        `${kind} descriptors grow beyond one active playback budget`,
      );
      assert.ok(
        resource.socket_count <=
          baseline[kind].socket_count + report.thresholds.maximum_extra_sockets,
        `${kind} sockets grow beyond one active playback budget`,
      );
      assert.ok(
        resource.ffmpeg_rss_kib <= report.thresholds.maximum_ffmpeg_rss_kib,
        "encoder RSS exceeds absolute budget",
      );
    }
    assert.ok(
      sample.resources.agent.media_handles >= 1,
      "actual NAS file remains open while streamed",
    );
    assert.ok(
      sample.database.transfers.some((t) => t.status === "streaming"),
      "actual NAS data connection is streaming",
    );
    assert.ok(
      sample.database.transfers
        .filter((t) => t.status === "streaming")
        .every((t) => t.lease_seconds_remaining > 0),
      "live NAS data connections keep a valid transfer lease",
    );
    if (previous && elapsed - previous.elapsed_seconds >= 2) {
      const period = elapsed - previous.elapsed_seconds;
      assert.ok(
        video.frames > previous.video.frames,
        "Chromium decodes fresh video frames throughout observation",
      );
      assert.ok(
        video.time_seconds - previous.video.time_seconds >=
          period * report.thresholds.minimum_media_seconds_per_wall_second - 2,
        "actual video timeline keeps advancing with wall time",
      );
      assert.ok(
        video.time_seconds - previous.video.time_seconds <= period * 1.1 + 2,
        "observation contains no large forward seek or accelerated playback",
      );
      assert.ok(
        sample.transmitted_bytes >= previous.transmitted_bytes,
        "persisted NAS byte count is monotonic",
      );
    }
    // The production transfer owner persists counters every ten seconds, and
    // TCP/FFmpeg read-ahead can be bursty. Check a bounded observation window
    // instead of wrongly requiring a database update in every five-second poll.
    const windowStart = report.samples.findLast(
      (s) =>
        s.elapsed_seconds <=
        elapsed - report.thresholds.maximum_transfer_observation_stall_seconds,
    );
    if (windowStart)
      assert.ok(
        sample.transmitted_bytes > windowStart.transmitted_bytes,
        "real NAS data makes progress throughout each sixty-second playback window",
      );
    if (windowStart)
      assert.ok(
        sample.control.frames_received > windowStart.control.frames_received,
        "normal browser clock/control responses continue during playback",
      );
    assert.ok(
      elapsed - (video.time_seconds - report.initial_video.time_seconds) <=
        report.thresholds.maximum_media_lag_seconds,
      "cumulative buffering exceeds allowed budget",
    );
    assert.deepEqual(report.browser_errors, []);
    assert.deepEqual(report.media_errors, []);
    assert.deepEqual(report.delivery.non_success, []);
    // Hls deliberately aborts the old EVENT-playlist request in its observed
    // waitForGenerated path. Correlate the exact canceled request with that real
    // player call, retaining both records; unrelated network failures still fail.
    report.delivery.intentional_cancellations =
      report.delivery.network_failures.filter(
        (failure) =>
          failure.canceled &&
          failure.error === "net::ERR_ABORTED" &&
          hlsStops.some(
            (stop) =>
              /waitForGenerated/.test(stop.stack ?? "") &&
              Math.abs(Date.parse(stop.at) - Date.parse(failure.at)) <= 1000 &&
              stop.source &&
              new URL(stop.source, origin).pathname === failure.path,
          ),
      );
    assert.deepEqual(
      report.delivery.network_failures.filter(
        (failure) =>
          !report.delivery.intentional_cancellations.includes(failure),
      ),
      [],
    );
    assert.equal(
      video.visibility.state,
      "visible",
      "browser remains in the foreground throughout actual playback",
    );
    assert.ok(
      video.visibility.viewport_fraction >= 0.99,
      "the actual video remains visible to Chromium's compositor",
    );
    assert.equal(await page.getByRole("alert").count(), 0);
    previous = sample;
    await writeFile(
      resolve(root, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      `${stage}: ${elapsed.toFixed(1)}s wall / ${(video.time_seconds - report.initial_video.time_seconds).toFixed(1)}s decoded, ${sample.transmitted_bytes} NAS bytes, Agent ${sample.resources.agent.rss_kib} KiB / ${sample.resources.agent.fd_count} FD / ${sample.resources.agent.socket_count} sockets`,
    );
    return sample;
  };
  await takeSample("playing");
  const hardDeadline =
    began +
    (duration + report.thresholds.maximum_media_lag_seconds + 30) * 1000;
  while (
    (performance.now() - began) / 1000 < duration ||
    previous.video.time_seconds - report.initial_video.time_seconds < duration
  ) {
    assert.ok(!interrupted, `interrupted by ${interrupted}`);
    assert.ok(
      performance.now() < hardDeadline,
      "continuous decode did not reach required duration within bounded deadline",
    );
    await delay(
      Math.min(
        sampleSeconds * 1000,
        Math.max(1000, duration * 1000 - (performance.now() - began)),
      ),
    );
    await takeSample("playing");
  }
  report.playback_finished_at = new Date().toISOString();
  report.observed_wall_seconds = (performance.now() - began) / 1000;
  report.observed_media_seconds =
    previous.video.time_seconds - report.initial_video.time_seconds;
  assert.ok(
    previous.transmitted_bytes > report.samples[0].transmitted_bytes,
    "real NAS data advances between the first and final observation",
  );
  const videoStream = report.sample.probe.streams.find(
    (stream) => stream.codec_type === "video",
  );
  const [numerator, denominator] = videoStream.avg_frame_rate
    .split("/")
    .map(Number);
  const sourceFps = numerator / denominator;
  const frameDelta = previous.video.frames - report.initial_video.frames;
  const droppedDelta =
    previous.video.dropped_frames - report.initial_video.dropped_frames;
  report.decode = {
    source_fps: sourceFps,
    frames: frameDelta,
    dropped_frames: droppedDelta,
    expected_frames: duration * sourceFps,
    buffering_seconds: previous.video.observation_buffering_seconds,
    buffering_fraction: previous.video.observation_buffering_fraction,
    quality_resets: report.native_quality_resets,
  };
  assert.ok(
    frameDelta >=
      duration * sourceFps * report.thresholds.minimum_decoded_frame_fraction,
    "Chromium actually displays the required duration of decoded frames",
  );
  assert.ok(
    droppedDelta / (frameDelta + droppedDelta) <=
      report.thresholds.maximum_dropped_frame_fraction,
    "decoded frame-drop fraction stays within the quality budget",
  );
  const warm = report.samples.filter(
    (s) => s.elapsed_seconds >= Math.min(60, duration / 4),
  );
  const section = Math.max(1, Math.floor(warm.length / 4));
  const mean = (items, read) =>
    items.reduce((n, item) => n + read(item), 0) / items.length;
  report.trends = {};
  for (const kind of ["agent", "worker", "server"]) {
    const first = mean(
      warm.slice(0, section),
      (s) => s.resources[kind].rss_kib,
    );
    const last = mean(warm.slice(-section), (s) => s.resources[kind].rss_kib);
    const growth = last - first;
    report.trends[kind] = {
      first_quartile_mean_rss_kib: first,
      final_quartile_mean_rss_kib: last,
      rss_growth_kib: growth,
      first_fd_count: warm[0].resources[kind].fd_count,
      final_fd_count: warm.at(-1).resources[kind].fd_count,
    };
    assert.ok(
      growth <=
        Math.max(report.thresholds[`${kind}_rss_growth_kib`], first * 0.25),
      `${kind} warm RSS shows unbounded growth`,
    );
    assert.ok(
      warm.at(-1).resources[kind].fd_count <=
        warm[0].resources[kind].fd_count + 4,
      `${kind} steady descriptors did not plateau`,
    );
  }
  assert.ok(
    report.control.status_frames_sent >= Math.floor(duration / 7),
    "normal browser control heartbeats continue throughout playback",
  );
  if (duration >= 7200)
    assert.ok(
      report.renewals.filter((r) => r.status === 200).length >=
        Math.floor(duration / 600) - 1,
      "normal Web app renews the thirty-minute playback lease throughout two hours",
    );
  await page.screenshot({
    path: resolve(root, "completed.png"),
    fullPage: true,
  });
  assert.equal(
    report.plans.length,
    1,
    "whole observation preserves one auto playback plan",
  );
  assert.ok(
    report.delivery.received_body_bytes > 0 &&
      report.delivery.finished_requests > 0,
    "Chromium receives complete real media-delivery response bodies",
  );
  report.control_before_stop = { ...report.control };
  observationEnded = true;
  stopBegan = performance.now();
  await api(`/playback-sessions/${sessionId}`, "DELETE");
  let closeTimer;
  try {
    await Promise.race([
      context.close(),
      new Promise((_, reject) => {
        closeTimer = setTimeout(
          () => reject(new Error("browser context stop deadline")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(closeTimer);
  }
  context = undefined;
  page = undefined;
  const terminal = await observeStop(
    "normal-stop",
    report.thresholds.maximum_post_stop_seconds,
  );
  report.stop_release_seconds = terminal.measured_at_seconds;
  assert.ok(
    terminal.released,
    "stopping playback closes NAS file/data sockets, reaps the encoder and finalizes every persisted transfer",
  );
  assert.ok(
    report.stop_release_seconds <= report.thresholds.maximum_post_stop_seconds,
    "NAS cancellation releases handles and data connections within five seconds",
  );
  report.after_stop = Object.fromEntries(
    ["agent", "worker", "server"].map((k) => [k, resources(names[k])]),
  );
  report.final_transfers = sqlJSON(
    `SELECT coalesce(json_agg(json_build_object('id',id,'status',status,'bytes_delivered',bytes_delivered,'reason',reason,'created_at',created_at,'finished_at',finished_at)),'[]'::json) FROM agent_transfer_runs WHERE agent_id='${pair.id}'`,
  );
  report.final_job = sqlJSON(
    `SELECT json_build_object('status',status,'attempt',attempt) FROM media_jobs WHERE session_id='${sessionId}'`,
  );
  assert.equal(report.final_job.status, "cancelled");
  assert.ok(
    report.final_transfers.length > 0 &&
      report.final_transfers.every(
        (t) => t.finished_at && ["completed", "cancelled"].includes(t.status),
      ),
    "all probe and playback transfers reach a non-failed terminal state",
  );
  assert.equal(
    report.after_stop.worker.ffmpeg_count,
    0,
    "real encoder is reaped on stop",
  );
  assert.equal(
    (await webIdentity()).sha256,
    report.web.sha256,
    "Web/client source stays fixed for the whole run",
  );
  await verifyCandidateSource();
  report.sample.final_sha256 = await sha256(resolve(root, "media/soak.mp4"));
  assert.equal(
    report.sample.final_sha256,
    report.sample.sha256,
    "actual NAS source stays byte-identical throughout the observation",
  );
  report.two_hour_gate_passed =
    duration >= 7200 &&
    report.observed_wall_seconds >= 7200 &&
    report.observed_media_seconds >= 7200;
  report.result = "passed";
  successful = true;
} catch (error) {
  report.result = "failed";
  report.two_hour_gate_passed = false;
  report.failure = redact(error.stack ?? error);
  if (page) {
    report.failure_video = await page
      .locator("video")
      .evaluate((v) => ({
        time: v.currentTime,
        paused: v.paused,
        ready_state: v.readyState,
        media_error: v.error?.code,
        frames: v.getVideoPlaybackQuality().totalVideoFrames,
      }))
      .catch(() => null);
    await page
      .screenshot({ path: resolve(root, "failure.png"), fullPage: true })
      .catch(() => {});
  }
  for (const kind of ["agent", "worker", "server"]) {
    try {
      await writeFile(
        resolve(root, `${kind}.log`),
        redact(docker("logs", "--tail", "200", names[kind])),
      );
    } catch {}
  }
  console.error(redact(error.stack ?? error));
  process.exitCode = 1;
} finally {
  // Names are generated by this test only; cleanup never targets Compose or
  // an existing service. Every Docker operation has a bounded deadline.
  observationEnded = true;
  if (sessionId && api && !successful) {
    stopBegan ??= performance.now();
    await boundedCleanup("playback session", () =>
      api(`/playback-sessions/${sessionId}`, "DELETE"),
    );
  }
  if (context) await boundedCleanup("browser context", () => context.close());
  if (!successful && report.agent_id && sessionId && baseline) {
    try {
      stopBegan ??= performance.now();
      const sample = await observeStop("failure-stop", 30);
      report.failure_cleanup_transfers = sample.database.transfers;
      report.failure_cleanup_resources = sample.resources;
      report.failure_cleanup_database = {
        session: sample.database.session,
        job: sample.database.job,
      };
      report.failure_cleanup_released = sample.released;
      report.failure_cleanup_elapsed_seconds = sample.measured_at_seconds;
      if (
        !sample.released ||
        sample.measured_at_seconds > report.thresholds.maximum_post_stop_seconds
      )
        report.cleanup.push({
          kind: "playback resource release",
          removed: sample.released,
          within_deadline: false,
          error:
            "playback resources exceeded the five-second cancellation budget; diagnostic observation retained up to thirty seconds",
        });
    } catch (error) {
      report.failure_cleanup_observation_error = redact(error.message);
    }
  }
  if (browser) await boundedCleanup("browser", () => browser.close());
  if (vite) await boundedCleanup("web proxy", () => vite.close());
  for (const kind of ["agent", "worker", "server", "db"]) {
    try {
      dockerWithin(10000, "rm", "-f", "-v", names[kind]);
      report.cleanup.push({ kind, removed: true });
    } catch (error) {
      report.cleanup.push({
        kind,
        removed: false,
        error: redact(error.message),
      });
    }
  }
  for (const container of temporaryContainers) {
    try {
      dockerWithin(10000, "inspect", "--format", "{{.Id}}", container);
      dockerWithin(10000, "rm", "-f", "-v", container);
      report.cleanup.push({ kind: container, removed: true });
    } catch (error) {
      const absent = /No such (?:object|container)/i.test(error.message);
      report.cleanup.push({
        kind: container,
        removed: absent,
        ...(absent
          ? { already_removed: true }
          : { error: redact(error.message) }),
      });
    }
  }
  try {
    dockerWithin(10000, "network", "rm", name);
    report.cleanup.push({ kind: "test network", removed: true });
  } catch (error) {
    report.cleanup.push({
      kind: "test network",
      removed: false,
      error: redact(error.message),
    });
  }
  if (successful && report.cleanup.some((entry) => !entry.removed)) {
    report.result = "failed";
    report.two_hour_gate_passed = false;
    report.failure = "isolated test resources did not finish cleanup";
    successful = false;
    process.exitCode = 1;
  }
  report.finished_at = new Date().toISOString();
  await diagnosticWrites.catch((error) => {
    report.diagnostics.write_error = redact(error.message);
    report.result = "failed";
    report.two_hour_gate_passed = false;
    successful = false;
    process.exitCode = 1;
  });
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    `${successful ? "PASS" : "FAIL"}: ${report.gate}; evidence ${resolve(root, "report.json")}`,
  );
}
