// W03 real-product matrix. No route mocks, existing upstreams, .env, or user media.
// Requires a fresh W03_BACKEND_BINDING; preparation alone never proves decoding.
// Usage: W03_BACKEND_BINDING=<absolute binding.json> node
// tests/upstream-real-playback.mjs [--kind=jellyfin|emby|all]. This entry and the
// 90s/frame-clock/nonadmin helper extensions have only syntax/static validation
// at this checkpoint. Fixed-version REST, decode, audio/subtitle/timeline gates
// and lifecycle/cleanup must run before a playback compatibility claim.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createServer as netServer } from "node:net";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { createServer as viteServer } from "vite";
import { Client } from "./fixtures/server.mjs";
import { isolatedUpstreamReal } from "./fixtures/upstream-real.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(
  process.env.RAINSYNC_RUNTIME_ROOT ?? resolve(root, ".runtime"),
);
const entry = fileURLToPath(import.meta.url);
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--(kind)=(jellyfin|emby|all)$/.exec(arg);
    assert.ok(match, "Only --kind=jellyfin|emby|all is supported");
    return [match[1], match[2]];
  }),
);
const kinds =
  args.kind && args.kind !== "all" ? [args.kind] : ["jellyfin", "emby"];
const runId = `rainsync-upstream-playback-${randomUUID().slice(0, 8)}`;
const evidence = resolve(runtime, "upstream-real-playback", runId);
const reportPath = resolve(evidence, "report.json");
const activityPath = resolve(evidence, "activity.jsonl");
const execute = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const digest = async (path) => hash(await readFile(path));
const control = new AbortController();
const secrets = new Set();
const childEnvironment = Object.fromEntries(
  [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "PATH",
    "PATHEXT",
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
  ]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
const interrupt = () =>
  control.abort(new Error("Owned real matrix interrupted"));
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const report = {
  schema_version: 1,
  run_id: runId,
  result: "running",
  started_at: new Date().toISOString(),
  scope:
    "Pinned isolated Jellyfin/Emby, real native Server/Worker/PostgreSQL, current Vue app and real Chromium decode; short phase matrix, no soak claim",
  limits: {
    ready_seconds: 120,
    playing_seconds: 30,
    phase_seconds: 8,
    minimum_frame_fraction: 0.95,
    stop_seconds: 15,
    native_cleanup_seconds: 5,
  },
  timeline_contract:
    "Fixed grant origin + actual media-element/rVFC time must match source pixels; API 204 is insufficient",
  primary_contracts: [
    "https://github.com/jellyfin/jellyfin/blob/v10.11.0/Jellyfin.Api/Controllers/PlaystateController.cs",
    "https://dev.emby.media/doc/restapi/Playback-Check-ins.html",
    "https://dev.emby.media/reference/RestAPI/UserService/postUsersAuthenticatebyname.html",
  ],
  products: [],
  failures: [],
  cleanup: [],
  provenance: {},
};
await mkdir(evidence, { recursive: true });
const redact = (value) => {
  let text = String(value);
  for (const secret of secrets)
    if (secret) text = text.replaceAll(secret, "[redacted]");
  return text
    .replace(
      /([?&](?:api_key|token|access_token|delivery_token)=)[^&#\s]+/gi,
      "$1[redacted]",
    )
    .replace(/Token="[^"]+"/g, 'Token="[redacted]"');
};
const save = () =>
  writeFile(reportPath, redact(JSON.stringify(report, null, 2)) + "\n");
const activity = (event, label, fields = {}) =>
  appendFile(
    activityPath,
    JSON.stringify({
      event,
      utc: new Date().toISOString(),
      kind: "upstream_real_playback",
      run_id: runId,
      label,
      ...fields,
    }) + "\n",
  );
const delay = (ms) =>
  new Promise((done, reject) => {
    control.signal.throwIfAborted();
    const stop = () => {
      clearTimeout(timer);
      reject(control.signal.reason);
    };
    const timer = setTimeout(() => {
      control.signal.removeEventListener("abort", stop);
      done();
    }, ms);
    control.signal.addEventListener("abort", stop, { once: true });
  });
async function bounded(promise, seconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`deadline: ${label}`)),
          seconds * 1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(check, label, seconds = 15, interruptible = true) {
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    if (interruptible) control.signal.throwIfAborted();
    const value = await check();
    if (value) return value;
    if (interruptible) await delay(100);
    else await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`deadline: ${label}`);
}
async function command(binary, argv, options = {}) {
  await activity("start", options.label ?? binary, { argv });
  try {
    const result = await execute(binary, argv, {
      timeout: options.timeout ?? 30000,
      windowsHide: true,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      encoding: options.encoding ?? "utf8",
      env: options.env,
      ...options.exec,
    });
    await activity("end", options.label ?? binary, { exit_code: 0 });
    return result;
  } catch (error) {
    await activity("end", options.label ?? binary, {
      exit_code: typeof error.code === "number" ? error.code : null,
      failed: true,
    });
    throw new Error(
      `${options.label ?? binary} failed; ${redact(error.stderr ?? error.message).slice(0, 2000)}`,
    );
  }
}
const docker = async (...argv) => (await command("docker", argv)).stdout.trim();
const uuid = (value) => {
  assert.match(value, /^[0-9a-f-]{36}$/);
  return `'${value}'`;
};
const inside = (parent, path) => {
  const r = relative(parent, path);
  assert.ok(
    !isAbsolute(r) && !r.startsWith(".."),
    "Owned path remains within its root",
  );
  return path;
};
async function port() {
  const socket = netServer();
  await new Promise((done, reject) =>
    socket.once("error", reject).listen(0, "127.0.0.1", done),
  );
  const value = socket.address().port;
  await new Promise((done) => socket.close(done));
  return value;
}
async function cleanup(label, action) {
  const step = {
    label,
    started_at: new Date().toISOString(),
    result: "running",
  };
  report.cleanup.push(step);
  try {
    await action(step);
    step.result = "passed";
  } catch (error) {
    step.result = "failed";
    step.error = redact(error.stack ?? error);
    report.failures.push({ cleanup: label, error: step.error });
    report.result = "failed";
  }
  step.finished_at = new Date().toISOString();
  await save();
}

let binding, bindingPath, binaryCopies, originalProof;
async function provenance() {
  assert.ok(
    process.env.W03_BACKEND_BINDING &&
      isAbsolute(process.env.W03_BACKEND_BINDING),
    "Set an absolute fresh W03_BACKEND_BINDING before real native validation",
  );
  bindingPath = inside(
    await realpath(resolve(runtime, "w03-viewer-backend")),
    await realpath(process.env.W03_BACKEND_BINDING),
  );
  binding = JSON.parse(await readFile(bindingPath, "utf8"));
  assert.ok(
    binding.source.some((file) => /^migrations[\\/]0026_/.test(file.path)),
    "Binding includes v1 observation migration 26",
  );
  const files = new Map();
  for (const file of binding.source) {
    const path = inside(
      await realpath(root),
      await realpath(inside(root, resolve(root, file.path))),
    );
    assert.equal(
      await digest(path),
      file.sha256,
      `Bound native input ${file.path}`,
    );
    files.set(path, file.sha256);
  }
  const listing = (
    await command(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "apps/web",
        "packages/player-core",
        "packages/sync-engine",
        "packages/protocol",
        "package.json",
        "package-lock.json",
      ],
      { exec: { cwd: root }, label: "frontend source inventory" },
    )
  ).stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  for (const path of [
    ...listing.map((file) => resolve(root, file)),
    entry,
    resolve(root, "tests/fixtures/upstream-real.mjs"),
    resolve(root, "tests/fixtures/server.mjs"),
    bindingPath,
  ])
    files.set(path, await digest(path));
  binaryCopies = new Map();
  for (const binary of binding.binaries) {
    assert.ok(isAbsolute(binary.path));
    inside(
      await realpath(
        resolve(process.env.CARGO_TARGET_DIR ?? resolve(root, "target")),
      ),
      await realpath(binary.path),
    );
    assert.equal(
      await digest(binary.path),
      binary.sha256,
      `Bound binary ${binary.name}`,
    );
    files.set(binary.path, binary.sha256);
    const copy = resolve(
      evidence,
      "native",
      `${binary.name}${process.platform === "win32" ? ".exe" : ""}`,
    );
    await mkdir(dirname(copy), { recursive: true });
    await copyFile(binary.path, copy);
    assert.equal(await digest(copy), binary.sha256);
    files.set(copy, binary.sha256);
    binaryCopies.set(binary.name, copy);
  }
  for (const name of ["rainsync-server", "rainsync-media-worker"])
    assert.ok(binaryCopies.has(name), `Binding includes ${name}`);
  const executable =
    process.env.RAINSYNC_CHROMIUM_EXECUTABLE ?? chromium.executablePath();
  files.set(executable, await digest(executable));
  originalProof = files;
  const entries = [...files].map(([path, sha256]) => ({ path, sha256 }));
  report.provenance = {
    binding_path: bindingPath,
    binding_sha256: files.get(bindingPath),
    backend_source_digest: binding.source_digest,
    actual_binaries: binding.binaries,
    source_and_binary_manifest: entries,
    manifest_sha256: hash(JSON.stringify(entries)),
    chromium_executable: executable,
    chromium_sha256: files.get(executable),
  };
  await save();
}
async function reverify() {
  assert.ok(
    originalProof?.size,
    "A complete provenance manifest was captured before any service starts",
  );
  for (const [path, sha256] of originalProof ?? [])
    assert.equal(
      await digest(path),
      sha256,
      `Source/binary remained unchanged: ${relative(root, path)}`,
    );
  report.provenance.unchanged_after = true;
}

function publicUrl(value, base) {
  if (!value) return null;
  const url = new URL(value, base);
  const allowed = new Set([
    "starttimeticks",
    "audiostreamindex",
    "subtitlestreamindex",
    "videocodec",
    "audiocodec",
    "container",
    "segmentcontainer",
    "transcodingcontainer",
    "static",
    "playsessionid",
    "deviceid",
    "mediasourceid",
    "startposition",
    "offset",
  ]);
  return {
    origin: url.origin,
    pathname: url.pathname,
    time_and_selection_parameters: Object.fromEntries(
      [...url.searchParams].filter(([key]) => allowed.has(key.toLowerCase())),
    ),
  };
}
function publicPlan(plan) {
  return Object.fromEntries(
    [
      "session_id",
      "media_id",
      "media_generation",
      "delivery_mode",
      "transport",
      "timeline_origin_ms",
      "duration_ms",
      "expires_in_seconds",
      "rebuild_on_seek",
      "observation_version",
      "observation_seq",
      "audio_tracks",
      "subtitle_tracks",
    ].map((key) => [
      key,
      key === "subtitle_tracks"
        ? plan[key]?.map((track) => ({
            ...track,
            url: publicUrl(track.url, "http://fixture.invalid"),
          }))
        : plan[key],
    ]),
  );
}
function publicLedger(row) {
  return Object.fromEntries(
    [
      "id",
      "user_id",
      "room_id",
      "generation",
      "kind",
      "device_id",
      "play_session_id",
      "media_source_id",
      "play_method",
      "state",
      "negotiation",
      "start_reported",
      "last_report_at",
      "io_uncertain",
      "io_kind",
      "io_observation_seq",
      "io_observation",
      "observation_version",
      "stop_confirmed",
      "encoding_stop_confirmed",
      "closed_at",
      "close_reason",
      "last_error",
    ].map((key) => [key, row[key] ?? null]),
  );
}
function publicSession(row) {
  const play = (state) =>
    Object.fromEntries(
      [
        "PositionTicks",
        "IsPaused",
        "IsMuted",
        "CanSeek",
        "AudioStreamIndex",
        "SubtitleStreamIndex",
        "MediaSourceId",
        "PlayMethod",
        "PlaybackRate",
      ].map((key) => [key, state?.[key] ?? null]),
    );
  return {
    Id: row.Id,
    DeviceId: row.DeviceId,
    UserId: row.UserId,
    LastActivityDate: row.LastActivityDate,
    NowPlayingItem: row.NowPlayingItem
      ? {
          Id: row.NowPlayingItem.Id,
          RunTimeTicks: row.NowPlayingItem.RunTimeTicks,
        }
      : null,
    PlayState: play(row.PlayState),
    TranscodingInfo: row.TranscodingInfo
      ? Object.fromEntries(
          [
            "VideoCodec",
            "AudioCodec",
            "Container",
            "Framerate",
            "CompletionPercentage",
            "TranscodeReasons",
          ].map((key) => [key, row.TranscodingInfo[key] ?? null]),
        )
      : null,
    PlaySessions: row.PlaySessions?.map((item) => ({
      Id: item.Id,
      PlayState: play(item.PlayState),
      NowPlayingItem: item.NowPlayingItem
        ? { Id: item.NowPlayingItem.Id }
        : null,
    })),
  };
}
function decryptOwned(value, key) {
  const bytes = Buffer.from(value, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64"),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(12, -16)),
      decipher.final(),
    ]).toString("utf8"),
  );
}

async function nativeStack(upstream, product, run) {
  const id = randomUUID();
  const container = `rainsync-real-player-pg-${id.slice(0, 8)}`;
  const stackRoot = resolve(evidence, upstream.kind, "native");
  await mkdir(stackRoot, { recursive: true });
  await mkdir(resolve(stackRoot, "empty-env"), { recursive: true });
  const password = randomBytes(24).toString("hex"),
    sourceKey = randomBytes(32).toString("base64");
  secrets.add(password);
  secrets.add(sourceKey);
  const webOrigin = `http://127.0.0.1:${await port()}`,
    origin = `http://127.0.0.1:${await port()}`,
    workerOrigin = `http://127.0.0.1:${await port()}`;
  let databaseStarted = false,
    databaseId,
    volumes = [],
    dev,
    browser,
    browserServer;
  const children = [],
    logs = new Set();
  const fixture = {
    origin,
    password,
    root: stackRoot,
    sourceKey,
    webOrigin,
    workerOrigin,
    env: {},
    cleanupClients: new Map(),
    client() {
      return new Client(fixture);
    },
    async sql(query) {
      assert.ok(databaseStarted);
      const result = await execute(
        "docker",
        [
          "exec",
          container,
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
        ],
        {
          timeout: 3000,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
        },
      );
      return result.stdout.trim();
    },
  };
  const log = async (name, chunk) => {
    const path = resolve(stackRoot, `${name}.log`);
    const pending = appendFile(path, redact(chunk.toString()));
    logs.add(pending);
    pending.finally(() => logs.delete(pending)).catch(() => {});
  };
  async function start(name, env) {
    const binary = binaryCopies.get(name);
    await activity("start", name, {
      binary,
      sha256: await digest(binary),
      upstream_kind: upstream.kind,
    });
    const child = spawn(binary, [], {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.failure = null;
    child.once("error", (error) => {
      child.failure = error;
    });
    child.done = new Promise((done) =>
      child.once("close", (code, signal) => {
        child.closed = true;
        void activity("end", name, {
          exit_code: code,
          signal,
          upstream_kind: upstream.kind,
        });
        done();
      }),
    );
    child.stdout.on("data", (chunk) => void log(name, chunk));
    child.stderr.on("data", (chunk) => void log(name, chunk));
    children.push(child);
    return child;
  }
  const health = async (base, child) =>
    until(
      async () => {
        if (child.failure || child.closed)
          throw new Error("Owned native service exited before readiness");
        try {
          return (
            await fetch(base + "/health", { signal: AbortSignal.timeout(500) })
          ).ok;
        } catch {
          return false;
        }
      },
      "native health",
      30,
    );
  try {
    const image = JSON.parse(
      await docker("image", "inspect", "postgres:17", "--format", "{{json .}}"),
    );
    product.postgres_image = { id: image.Id, repo_digests: image.RepoDigests };
    databaseId = (
      await command(
        "docker",
        [
          "run",
          "--detach",
          "--name",
          container,
          "--label",
          `rainsync.fixture=${id}`,
          "--cpus",
          "1",
          "--memory",
          "512m",
          "--pids-limit",
          "128",
          "--publish",
          "127.0.0.1::5432",
          "-e",
          "POSTGRES_USER=rainsync",
          "-e",
          "POSTGRES_DB=rainsync",
          "-e",
          "POSTGRES_PASSWORD",
          "postgres:17",
        ],
        { env: { ...childEnvironment, POSTGRES_PASSWORD: password } },
      )
    ).stdout.trim();
    databaseStarted = true;
    volumes = JSON.parse(
      await docker(
        "container",
        "inspect",
        container,
        "--format",
        "{{json .Mounts}}",
      ),
    )
      .filter((mount) => mount.Type === "volume")
      .map((mount) => mount.Name);
    const mapping = await docker("port", container, "5432/tcp");
    assert.match(mapping, /^127\.0\.0\.1:\d+$/);
    await until(
      async () => {
        try {
          return (await fixture.sql("SELECT 1")) === "1";
        } catch {
          return false;
        }
      },
      "owned PostgreSQL starts",
      15,
    );
    const ffmpegBin = dirname(
      upstream.metadata.ffmpeg.find((tool) => tool.tool === "ffmpeg").path,
    );
    fixture.env = {
      ...childEnvironment,
      DATABASE_URL: `postgres://rainsync:${password}@${mapping}/rainsync?sslmode=disable`,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: password,
      SOURCE_ENCRYPTION_KEY: sourceKey,
      BIND: new URL(origin).host,
      PUBLIC_ORIGIN: webOrigin,
      WORKER_URL: workerOrigin,
      WORKER_BIND: new URL(workerOrigin).host,
      MEDIA_ROOT: stackRoot,
      CACHE_ROOT: resolve(stackRoot, "cache"),
      RUST_LOG: "warn",
      TRUSTED_PROXY_CIDRS: "",
      PATH: `${ffmpegBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    };
    const server = await start("rainsync-server", fixture.env);
    await health(origin, server);
    const worker = await start("rainsync-media-worker", fixture.env);
    await health(workerOrigin, worker);
    product.native = {
      fixture_id: id,
      container,
      container_id: databaseId,
      origin,
      worker_origin: workerOrigin,
      web_origin: webOrigin,
      postgres_version: await fixture.sql("SELECT version()"),
      migration: await fixture.sql(
        "SELECT max(version) FROM _sqlx_migrations WHERE success",
      ),
    };
    const migrations = binding.source
      .map((file) => /^migrations[\\/](\d+)_.*\.sql$/.exec(file.path))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    assert.equal(product.native.migration, String(Math.max(...migrations)));
    assert.equal(
      await fixture.sql(
        `SELECT count(*) FROM _sqlx_migrations WHERE success AND version IN (${migrations.join(",")})`,
      ),
      String(migrations.length),
      "Every migration in the frozen backend binding is applied",
    );
    dev = await viteServer({
      root: resolve(root, "apps/web"),
      envDir: resolve(stackRoot, "empty-env"),
      configFile: resolve(root, "apps/web/vite.config.ts"),
      cacheDir: resolve(stackRoot, "vite-cache"),
      logLevel: "warn",
      server: {
        host: "127.0.0.1",
        port: Number(new URL(webOrigin).port),
        strictPort: true,
        proxy: {
          "/api": { target: origin, ws: true },
          "/media-delivery": workerOrigin,
          "/agent-data": { target: workerOrigin, ws: true },
        },
      },
    });
    await dev.listen();
    browserServer = await chromium.launchServer({
      headless: true,
      executablePath: process.env.RAINSYNC_CHROMIUM_EXECUTABLE,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
      ],
    });
    browser = await chromium.connect(browserServer.wsEndpoint());
    product.chromium = {
      version: browser.version(),
      executable_sha256: report.provenance.chromium_sha256,
      pid: browserServer.process().pid,
    };
    fixture.browser = browser;
    await run(fixture);
  } finally {
    // Attempt product stops before removing processes, including on failed decode.
    if (databaseStarted)
      await cleanup(
        `${upstream.kind}: all remaining grant stops`,
        async (step) => {
          const grants = JSON.parse(
            await fixture.sql(
              "SELECT coalesce(json_agg(json_build_object('id',id,'user_id',user_id)),'[]') FROM playback_sessions WHERE NOT stopped",
            ),
          );
          step.remaining_before = grants;
          if (grants.length) {
            for (const grant of grants) {
              const client = fixture.cleanupClients.get(grant.user_id);
              assert.ok(
                client,
                "Cleanup uses the actual grant owner's authenticated client",
              );
              const response = await client.raw(
                `/playback-sessions/${grant.id}`,
                { method: "DELETE", signal: AbortSignal.timeout(3000) },
              );
              step.responses ??= [];
              step.responses.push({ id: grant.id, status: response.status });
              await response.arrayBuffer();
              assert.equal(
                response.status,
                200,
                "Owned grant DELETE succeeded",
              );
            }
          }
          await until(
            async () =>
              (await fixture.sql(
                "SELECT count(*) FROM upstream_reservations WHERE state NOT IN ('closed')",
              )) === "0",
            "every real upstream reservation closes",
            15,
            false,
          );
          step.ledger_final = JSON.parse(
            await fixture.sql(
              "SELECT coalesce(json_agg(json_build_object('id',id,'state',state,'device_id',device_id,'play_session_id',play_session_id,'stop_confirmed',stop_confirmed,'encoding_stop_confirmed',encoding_stop_confirmed,'closed_at',closed_at)),'[]') FROM upstream_reservations",
            ),
          );
          assert.equal(
            await fixture.sql(
              "SELECT count(*) FROM media_jobs WHERE status IN ('queued','running')",
            ),
            "0",
            "No owned local encoder job remains",
          );
        },
      );
    if (browser)
      await cleanup(`${upstream.kind}: Chromium connection`, () =>
        bounded(browser.close(), 5, "browser closes"),
      );
    if (browserServer)
      await cleanup(`${upstream.kind}: Chromium process`, async (step) => {
        const child = browserServer.process();
        try {
          await bounded(
            browserServer.close(),
            5,
            "owned Chromium process closes",
          );
        } catch (error) {
          if (process.platform === "win32" && child.exitCode === null)
            await command("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
          else child.kill("SIGKILL");
          throw error;
        }
        step.exit_code = child.exitCode;
        step.signal = child.signalCode;
        assert.ok(
          child.exitCode !== null || child.signalCode !== null,
          "Owned Chromium process is gone",
        );
      });
    if (dev)
      await cleanup(`${upstream.kind}: Vite`, async () => {
        try {
          await bounded(dev.close(), 5, "owned Vite closes");
        } catch (error) {
          dev.httpServer?.closeAllConnections();
          throw error;
        }
      });
    for (const child of children.reverse())
      await cleanup(
        `${upstream.kind}: native PID ${child.pid}`,
        async (step) => {
          if (!child.closed && child.pid) {
            if (process.platform === "win32")
              await command(
                "taskkill",
                ["/PID", String(child.pid), "/T", "/F"],
                { timeout: 5000 },
              );
            else child.kill("SIGKILL");
            await bounded(child.done, 5, "owned native process tree closes");
          }
          step.exited = child.closed;
          assert.ok(child.closed);
        },
      );
    await bounded(Promise.allSettled([...logs]), 5, "owned log writes settle");
    await cleanup(
      `${upstream.kind}: PostgreSQL and anonymous volumes`,
      async (step) => {
        const names = await docker(
          "ps",
          "-a",
          "--filter",
          `name=^/${container}$`,
          "--format",
          "{{.Names}}",
        );
        if (names) {
          assert.equal(names, container);
          assert.equal(
            await docker(
              "container",
              "inspect",
              container,
              "--format",
              '{{index .Config.Labels "rainsync.fixture"}}',
            ),
            id,
          );
          if (databaseId)
            assert.equal(
              await docker(
                "container",
                "inspect",
                container,
                "--format",
                "{{.Id}}",
              ),
              databaseId,
            );
          const remainingMounts = JSON.parse(
            await docker(
              "container",
              "inspect",
              container,
              "--format",
              "{{json .Mounts}}",
            ),
          );
          volumes = [
            ...new Set([
              ...volumes,
              ...remainingMounts
                .filter((mount) => mount.Type === "volume")
                .map((mount) => mount.Name),
            ]),
          ];
          await docker("rm", "-f", "-v", container);
        }
        assert.equal(
          await docker(
            "ps",
            "-a",
            "--filter",
            `name=^/${container}$`,
            "--format",
            "{{.Names}}",
          ),
          "",
        );
        step.container_absent = true;
        step.volumes = [];
        for (const volume of volumes) {
          assert.match(volume, /^[A-Za-z0-9_.-]+$/);
          const found = await docker(
            "volume",
            "ls",
            "--filter",
            `name=^${volume}$`,
            "--format",
            "{{.Name}}",
          );
          if (found) {
            assert.equal(found, volume);
            await docker("volume", "rm", volume);
          }
          assert.equal(
            await docker(
              "volume",
              "ls",
              "--filter",
              `name=^${volume}$`,
              "--format",
              "{{.Name}}",
            ),
            "",
          );
          step.volumes.push({ name: volume, absent: true });
        }
      },
    );
  }
}

// Each callback is emitted by the real decoder. Counters never use room time.
function installFrameProbe(clock) {
  const stats = {
    frames: 0,
    first_frame: null,
    latest: null,
    events: [],
    quality_resets: [],
    buffer_started: null,
    buffer_ms: 0,
    last_quality: 0,
  };
  window.__upstreamFrames = stats;
  let current;
  function attach() {
    const video = document.querySelector("video");
    if (!video || current === video) return;
    current = video;
    video.muted = true;
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 18;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const clockCanvas = document.createElement("canvas");
    clockCanvas.width = 320;
    clockCanvas.height = 180;
    const clockContext = clockCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    const receive = (now, metadata) => {
      if (!video.isConnected) return;
      stats.frames++;
      if (!stats.first_frame)
        stats.first_frame = {
          at: new Date().toISOString(),
          media_time: metadata.mediaTime,
          presented_frames: metadata.presentedFrames,
        };
      let rgb,
        error,
        sourceFrameIndex = 0,
        clockCells;
      try {
        context.drawImage(video, 0, 0, 32, 18);
        const rgba = context.getImageData(0, 0, 32, 18).data;
        rgb = [];
        for (let i = 0; i < rgba.length; i += 4)
          rgb.push(rgba[i], rgba[i + 1], rgba[i + 2]);
        clockContext.drawImage(video, 0, 0, 320, 180);
        clockCells = [];
        for (let bit = 0; bit < clock.bits; bit++) {
          const x = clock.x + bit * clock.cell_width + 2,
            y = clock.y + 3;
          const pixels = clockContext.getImageData(x, y, 4, 6).data;
          let luminance = 0;
          for (let i = 0; i < pixels.length; i += 4)
            luminance += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
          luminance /= pixels.length / 4;
          clockCells.push(luminance);
          if (luminance >= 128) sourceFrameIndex += 2 ** bit;
        }
      } catch (cause) {
        error = cause.name;
      }
      stats.latest = {
        at: new Date().toISOString(),
        now_ms: now,
        media_time: metadata.mediaTime,
        presented_frames: metadata.presentedFrames,
        dom_current_time: video.currentTime,
        rgb,
        source_frame_index: sourceFrameIndex,
        source_frame_clock_cells: clockCells,
        pixel_error: error,
      };
      const quality = video.getVideoPlaybackQuality();
      if (quality.totalVideoFrames < stats.last_quality)
        stats.quality_resets.push({
          at: new Date().toISOString(),
          previous: stats.last_quality,
          current: quality.totalVideoFrames,
        });
      stats.last_quality = quality.totalVideoFrames;
      video.requestVideoFrameCallback(receive);
    };
    video.requestVideoFrameCallback(receive);
    for (const event of [
      "playing",
      "canplay",
      "waiting",
      "stalled",
      "seeking",
      "seeked",
      "pause",
      "ended",
      "emptied",
      "error",
    ])
      video.addEventListener(event, () => {
        stats.events.push({
          at: new Date().toISOString(),
          event,
          current_time: video.currentTime,
          ready_state: video.readyState,
          paused: video.paused,
          error_code: video.error?.code ?? null,
        });
        if (stats.events.length > 500) stats.events.shift();
        if (
          ["waiting", "stalled"].includes(event) &&
          stats.buffer_started === null
        )
          stats.buffer_started = performance.now();
        if (
          ["playing", "canplay"].includes(event) &&
          stats.buffer_started !== null
        ) {
          stats.buffer_ms += performance.now() - stats.buffer_started;
          stats.buffer_started = null;
        }
      });
  }
  new MutationObserver(attach).observe(document, {
    childList: true,
    subtree: true,
  });
  document.addEventListener("DOMContentLoaded", attach);
}
async function sample(viewer) {
  return viewer.page.evaluate(() => {
    const video = document.querySelector("video"),
      stats = window.__upstreamFrames;
    const quality = video?.getVideoPlaybackQuality();
    return {
      sampled_at: new Date().toISOString(),
      window_clock_ms: performance.now(),
      visibility: document.visibilityState,
      frames: stats.frames,
      first_frame: stats.first_frame,
      latest: stats.latest,
      events: stats.events,
      quality_resets: stats.quality_resets,
      buffer_ms:
        stats.buffer_ms +
        (stats.buffer_started === null
          ? 0
          : performance.now() - stats.buffer_started),
      dom: video
        ? {
            current_time: video.currentTime,
            paused: video.paused,
            seeking: video.seeking,
            ready_state: video.readyState,
            ended: video.ended,
            playback_rate: video.playbackRate,
            video_width: video.videoWidth,
            video_height: video.videoHeight,
            error_code: video.error?.code ?? null,
            quality: {
              totalVideoFrames: quality.totalVideoFrames,
              droppedVideoFrames: quality.droppedVideoFrames,
              corruptedVideoFrames: quality.corruptedVideoFrames,
            },
            text_tracks: Array.from(video.textTracks).map((track) => ({
              label: track.label,
              language: track.language,
              mode: track.mode,
              cues: track.cues?.length ?? 0,
              active_cues: Array.from(track.activeCues ?? []).map((cue) => ({
                start_time: cue.startTime,
                end_time: cue.endTime,
                text: cue.text,
              })),
            })),
          }
        : null,
    };
  });
}
async function sourceFrames(upstream, product) {
  const ffmpeg = upstream.metadata.ffmpeg.find(
    (tool) => tool.tool === "ffmpeg",
  );
  const references = new Map();
  for (const sample of upstream.metadata.samples) {
    inside(await realpath(upstream.root), await realpath(sample.path));
    assert.equal(await digest(sample.path), sample.sha256);
    const result = await command(
      ffmpeg.path,
      [
        "-v",
        "error",
        "-nostdin",
        "-i",
        sample.path,
        "-an",
        "-sn",
        "-vf",
        "fps=10,scale=32:18:flags=bilinear",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      {
        label: "actual source frame reference",
        timeout: 60000,
        encoding: "buffer",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const bytes = result.stdout;
    assert.equal(bytes.length % 1728, 0);
    const count = bytes.length / 1728;
    assert.ok(
      count >= 899,
      "90-second actual fixture covers all matrix phases",
    );
    const path = resolve(
      evidence,
      upstream.kind,
      `${sample.codec}-source-rgb24.bin`,
    );
    await writeFile(path, bytes);
    references.set(sample.codec, { bytes, count, fps: 10, sample });
    product.frame_references ??= [];
    product.frame_references.push({
      codec: sample.codec,
      source_sha256: sample.sha256,
      path,
      sha256: hash(bytes),
      frames: count,
      fps: 10,
      size: [32, 18],
      pixel_format: "rgb24",
    });
  }
  return references;
}
function compareFrame(frame, plan, reference) {
  assert.ok(
    frame?.rgb?.length === 1728 && !frame.pixel_error,
    "Read real decoded pixels through same-origin delivery",
  );
  const expectedSeconds = plan.timeline_origin_ms / 1000 + frame.media_time;
  const distances = [];
  for (let n = 0; n < reference.count; n++) {
    let sum = 0;
    const offset = n * 1728;
    for (let i = 0; i < 1728; i++)
      sum += Math.abs(frame.rgb[i] - reference.bytes[offset + i]);
    distances.push({
      source_seconds: n / 10,
      mean_absolute_rgb_error: sum / 1728,
    });
  }
  distances.sort(
    (a, b) => a.mean_absolute_rgb_error - b.mean_absolute_rgb_error,
  );
  const best = distances[0];
  const expected = distances
    .filter(
      (candidate) =>
        Math.abs(candidate.source_seconds - expectedSeconds) <= 0.5,
    )
    .sort((a, b) => a.mean_absolute_rgb_error - b.mean_absolute_rgb_error)[0];
  const distant = distances.find(
    (candidate) =>
      Math.abs(candidate.source_seconds - best.source_seconds) >= 1,
  );
  const clockSeconds = frame.source_frame_index / reference.fps;
  const proof = {
    presented_at: frame.at,
    rVFC_media_time: frame.media_time,
    dom_current_time_at_presentation: frame.dom_current_time,
    grant_timeline_origin_ms: plan.timeline_origin_ms,
    expected_source_seconds: expectedSeconds,
    decoded_source_frame_index: frame.source_frame_index,
    decoded_source_seconds: clockSeconds,
    source_clock_cells: frame.source_frame_clock_cells,
    nearest_source_frame: best,
    closest_contract_frame: expected,
    closest_frame_at_least_one_second_away: distant,
    decoded_rgb_sha256: hash(Buffer.from(frame.rgb)),
    absolute_timeline_error_seconds: Math.abs(clockSeconds - expectedSeconds),
    clock_cell_contrast_valid:
      frame.source_frame_clock_cells?.length === 16 &&
      frame.source_frame_clock_cells.every(
        (value) => value <= 64 || value >= 192,
      ),
  };
  proof.matches_fixed_grant =
    proof.clock_cell_contrast_valid &&
    Number.isInteger(frame.source_frame_index) &&
    frame.source_frame_index < reference.count &&
    proof.absolute_timeline_error_seconds <= 0.21 &&
    expected?.mean_absolute_rgb_error <= 18;
  return proof;
}

async function actualMatrix(upstream, product, fixture) {
  const references = await sourceFrames(upstream, product);
  const admin = fixture.client();
  const ownerUser = await admin.login();
  secrets.add(admin.cookie);
  secrets.add(admin.csrf);
  fixture.cleanupClients.set(ownerUser.id, admin);
  const guestName = `real-${randomUUID().slice(0, 8)}`,
    guestPassword = randomBytes(24).toString("hex");
  secrets.add(guestPassword);
  await admin.request("/users", "POST", {
    username: guestName,
    password: guestPassword,
  });
  const guest = fixture.client();
  const guestUser = await guest.login(guestName, guestPassword);
  secrets.add(guest.cookie);
  secrets.add(guest.csrf);
  fixture.cleanupClients.set(guestUser.id, guest);
  const source = await upstream.addRainSyncSource(admin);
  await admin.request(`/sources/${source.id}/test`, "POST");
  const media = await until(
    async () => {
      const result = JSON.parse(
        await fixture.sql(
          `SELECT coalesce(json_agg(json_build_object('id',id,'resource',resource,'title',title)),'[]') FROM media_items WHERE source_id=${uuid(source.id)} AND available`,
        ),
      );
      return result.length === 2 ? result : null;
    },
    "complete actual source scan",
    30,
  );
  for (const item of upstream.items)
    assert.ok(
      media.some((candidate) => candidate.resource === item.Id),
      "Normal RainSync scan indexed each real upstream item",
    );
  product.source = {
    id: source.id,
    indexed: media,
    pagination: upstream.metadata.pagination,
    anonymous_status: upstream.metadata.anonymous_status,
  };
  const room = await admin.request("/rooms", "POST", {
    name: `Owned real ${upstream.kind} ${runId}`,
  });
  const invite = await admin.request(`/rooms/${room.id}/invites`, "POST");
  secrets.add(invite.token);
  await guest.request(`/rooms/${room.id}/join`, "POST", {
    token: invite.token,
  });
  const viewers = [];
  const ledger = async (id) =>
    JSON.parse(
      await fixture.sql(
        `SELECT row_to_json(u) FROM upstream_reservations u WHERE id=${uuid(id)}`,
      ),
    );
  const observation = async (id) =>
    JSON.parse(
      await fixture.sql(
        `SELECT row_to_json(o) FROM playback_observations o WHERE session_id=${uuid(id)}`,
      ),
    );
  const sessions = async () => {
    const rows = await upstream.admin.api(
      "/Sessions?IncludeAllSessionsIfAdmin=true",
    );
    assert.ok(Array.isArray(rows));
    const selected = rows
      .filter((row) => row.DeviceId?.startsWith("rainsync-"))
      .map(publicSession);
    product.upstream_sessions.push({
      sampled_at: new Date().toISOString(),
      sessions: selected,
    });
    return selected;
  };
  async function rememberNegotiation(viewer, plan) {
    const row = await ledger(plan.session_id);
    assert.ok(row.response_encrypted && row.play_session_id && row.device_id);
    const response = decryptOwned(row.response_encrypted, fixture.sourceKey);
    const encrypted = JSON.parse(
      await fixture.sql(
        `SELECT resource FROM playback_sessions WHERE id=${uuid(plan.session_id)}`,
      ),
    );
    const resource = decryptOwned(encrypted.encrypted, fixture.sourceKey);
    for (const value of Object.values(resource.headers ?? {})) {
      const token = /Token="([^"]+)"/.exec(String(value))?.[1];
      if (token) secrets.add(token);
    }
    const answer = {
      viewer: viewer.name,
      recorded_at: new Date().toISOString(),
      plan: publicPlan(plan),
      ledger: publicLedger(row),
      negotiation: {
        PlaySessionId: response.PlaySessionId,
        MediaSources: response.MediaSources?.map((source) => ({
          Id: source.Id,
          RunTimeTicks: source.RunTimeTicks,
          SupportsDirectPlay: source.SupportsDirectPlay,
          SupportsDirectStream: source.SupportsDirectStream,
          SupportsTranscoding: source.SupportsTranscoding,
          TranscodingUrl: publicUrl(source.TranscodingUrl, upstream.base + "/"),
          MediaStreams: source.MediaStreams?.map((stream) =>
            Object.fromEntries(
              [
                "Index",
                "Type",
                "Codec",
                "Language",
                "IsExternal",
                "IsTextSubtitleStream",
                "DisplayTitle",
              ].map((key) => [key, stream[key]]),
            ),
          ),
        })),
      },
      actual_delivery: publicUrl(resource.url, upstream.base + "/"),
    };
    product.negotiations.push(answer);
    assert.equal(response.PlaySessionId, row.play_session_id);
    assert.equal(resource.upstream_session, row.play_session_id);
    assert.equal(resource.upstream_device, row.device_id);
    return answer;
  }
  async function openViewer(name, username, password, client, user) {
    const context = await fixture.browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    assert.equal(upstream.metadata.frame_clock?.bits, 16);
    assert.equal(upstream.metadata.frame_clock?.fps, 10);
    await page.addInitScript(installFrameProbe, upstream.metadata.frame_clock);
    const viewer = {
      name,
      context,
      page,
      client,
      user,
      plans: [],
      current: null,
      pending: new Set(),
      errors: [],
      observations: [],
      deletes: [],
    };
    viewers.push(viewer);
    page.on("pageerror", (error) => viewer.errors.push(redact(error.message)));
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        /\/playback-sessions\/[^/]+\/observations$/.test(path) &&
        request.method() === "POST"
      )
        viewer.observations.push({
          at: new Date().toISOString(),
          session_id: path.split("/").at(-2),
          body: request.postDataJSON(),
        });
      if (
        /\/playback-sessions\/[^/]+$/.test(path) &&
        request.method() === "DELETE"
      )
        viewer.deletes.push({
          at: new Date().toISOString(),
          path,
          final: request.postDataJSON(),
        });
    });
    page.on("response", (response) => {
      const request = response.request(),
        path = new URL(response.url()).pathname;
      if (
        path === "/api/v1/playback-sessions" &&
        request.method() === "POST" &&
        response.status() === 200
      ) {
        const pending = (async () => {
          const plan = await response.json();
          assert.equal(plan.observation_version, 1);
          assert.equal(plan.observation_seq, 0);
          const grant = {
            at: new Date().toISOString(),
            request: request.postDataJSON(),
            plan: Object.freeze(plan),
          };
          viewer.plans.push(grant);
          viewer.current = grant;
        })();
        viewer.pending.add(pending);
        pending
          .finally(() => viewer.pending.delete(pending))
          .catch((error) => viewer.errors.push(redact(error.message)));
      }
      const entry = viewer.deletes.findLast(
        (entry) => entry.path === path && !entry.status,
      );
      if (entry && request.method() === "DELETE")
        entry.status = response.status();
    });
    await page.goto(fixture.webOrigin + "/login");
    await page.getByLabel("登录账号", { exact: true }).fill(username);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("heading", { name: "放映室", exact: true }).waitFor();
    await enter(viewer);
    return viewer;
  }
  async function enter(viewer) {
    await viewer.page.goto(`${fixture.webOrigin}/rooms/${room.id}`);
    await viewer.page
      .locator(".room-information")
      .filter({ hasText: "房间连接正常" })
      .waitFor();
    await viewer.page.locator("video").waitFor();
    await viewer.page.locator("video").evaluate((video) => {
      video.muted = true;
    });
  }
  async function playing(viewer, label = viewer.name) {
    await until(
      () => viewer.current,
      `${label} real preparation response`,
      120,
    );
    await viewer.page.waitForFunction(
      () => document.querySelector("video")?.readyState >= 2,
      undefined,
      { timeout: 120000 },
    );
    const join = viewer.page.getByRole("button", {
      name: "点击加入播放",
      exact: true,
    });
    if (await join.isVisible()) await join.click();
    const before = await sample(viewer);
    await until(
      async () => {
        const value = await sample(viewer);
        return value.dom &&
          !value.dom.paused &&
          !value.dom.seeking &&
          value.frames > before.frames + 3 &&
          value.latest
          ? value
          : null;
      },
      `${label} actual fresh decoder frames`,
      30,
    );
    assert.equal((await sample(viewer)).visibility, "visible");
  }
  async function setting(viewer, label, option, reload = false) {
    const page = viewer.page;
    await page.locator("video").hover();
    const trigger = page.getByRole("button", { name: "播放选项", exact: true });
    if (
      !(await page
        .locator("details.playback-options")
        .evaluate((details) => details.open))
    )
      await trigger.click();
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: option }).click();
    if (reload)
      await page.getByRole("button", { name: "重新加载", exact: true }).click();
    if (
      await page
        .locator("details.playback-options")
        .evaluate((details) => details.open)
    )
      await trigger.click();
  }
  async function choose(owner, codec, collection = media) {
    const item = upstream.items.find((item) =>
      item.MediaSources.some((source) =>
        source.MediaStreams.some(
          (stream) => stream.Type === "Video" && stream.Codec === codec,
        ),
      ),
    );
    assert.ok(item);
    const local = collection.find(
      (candidate) => candidate.resource === item.Id,
    );
    assert.ok(
      local,
      "The chosen real upstream item belongs to this scanned source",
    );
    await owner.page
      .getByRole("link", { name: "选择影片", exact: true })
      .click();
    await owner.page
      .locator(`.media-card[data-media-id="${local.id}"]`)
      .getByRole("button", { name: /^播放 / })
      .click();
    await owner.page.waitForURL(`${fixture.webOrigin}/rooms/${room.id}`);
    return local;
  }
  async function decodedWindow(label, selected, codec, seconds = 8) {
    const phase = {
      name: label,
      started_at: new Date().toISOString(),
      result: "running",
      viewers: [],
    };
    product.phases.push(phase);
    await save();
    for (const viewer of selected) await playing(viewer);
    const starts = await Promise.all(
      selected.map(async (viewer) => ({
        viewer,
        snapshot: await sample(viewer),
        grant: viewer.current,
        plan_count: viewer.plans.length,
        observation: await observation(viewer.current.plan.session_id),
      })),
    );
    const negotiated = await Promise.all(
      starts.map(({ viewer, grant }) =>
        rememberNegotiation(viewer, grant.plan),
      ),
    );
    assert.equal(
      new Set(negotiated.map((row) => row.ledger.device_id)).size,
      selected.length,
      "Each real viewer has an independent upstream DeviceId",
    );
    assert.equal(
      new Set(negotiated.map((row) => row.ledger.play_session_id)).size,
      selected.length,
      "Each real viewer has an independent negotiated SID",
    );
    await delay(seconds * 1000);
    const ends = await Promise.all(selected.map(sample));
    phase.raw_window_samples = starts.map(({ viewer, snapshot, grant }, i) => ({
      viewer: viewer.name,
      session_id: grant.plan.session_id,
      before: {
        ...snapshot,
        latest: snapshot.latest && { ...snapshot.latest, rgb: undefined },
      },
      after: {
        ...ends[i],
        latest: ends[i].latest && { ...ends[i].latest, rgb: undefined },
      },
    }));
    await save();
    for (let i = 0; i < starts.length; i++) {
      const {
          viewer,
          snapshot: start,
          grant,
          plan_count,
          observation: previous,
        } = starts[i],
        end = ends[i],
        plan = grant.plan;
      assert.equal(
        viewer.current,
        grant,
        "No hidden replan during stable decode phase",
      );
      assert.equal(viewer.plans.length, plan_count);
      assert.equal(end.visibility, "visible");
      assert.equal(end.dom.error_code, null);
      assert.ok(
        !end.dom.paused && !end.dom.seeking && end.dom.ready_state >= 2,
      );
      const windowSeconds =
          (end.window_clock_ms - start.window_clock_ms) / 1000,
        fresh = end.frames - start.frames,
        expected = windowSeconds * 10;
      assert.ok(
        fresh >= expected * 0.95,
        `Actual full-window rVFC fraction >= 95% (${fresh}/${expected})`,
      );
      const row = await until(
        async () => {
          const value = await ledger(plan.session_id);
          return value.start_reported ? value : null;
        },
        "actual upstream Start acknowledged",
        5,
      );
      const currentObservation = await until(
        async () => {
          const value = await observation(plan.session_id);
          return value.seq > previous.seq &&
            value.reported_seq > previous.reported_seq &&
            value.has_played
            ? value
            : null;
        },
        "actual browser Progress accepted and reported",
        5,
      );
      const reported = viewer.observations.findLast(
        (entry) =>
          entry.session_id === plan.session_id &&
          entry.body.seq === currentObservation.reported_seq,
      );
      assert.ok(
        reported,
        "The acknowledged sequence was emitted by this real browser's native observation sender",
      );
      const actualSessions = await sessions();
      const actual = actualSessions.find(
        (session) =>
          session.DeviceId === row.device_id && session.NowPlayingItem,
      );
      assert.ok(
        actual,
        "Real upstream Sessions shows this independent playing device",
      );
      const positionSeconds = Number(actual.PlayState.PositionTicks) / 10000000;
      assert.ok(
        Number.isFinite(positionSeconds),
        "Actual upstream PositionTicks is finite",
      );
      assert.ok(
        Math.abs(
          positionSeconds -
            (plan.timeline_origin_ms + reported.body.media_time_ms) / 1000,
        ) <= 2,
        "Fresh upstream position agrees with the same acknowledged native observation sequence",
      );
      assert.equal(
        currentObservation.timeline_origin_ms,
        plan.timeline_origin_ms,
        "Stored grant origin remains fixed",
      );
      const pixels = compareFrame(end.latest, plan, references.get(codec));
      phase.viewers.push({
        viewer: viewer.name,
        grant: publicPlan(plan),
        request: grant.request,
        ledger: publicLedger(row),
        fresh_rVFC_frames: fresh,
        actual_frame_window_seconds: windowSeconds,
        expected_frames: expected,
        expected_formula: "actual_frame_window_seconds * source_fps(10)",
        frame_fraction: fresh / expected,
        before: {
          ...start,
          latest: start.latest && { ...start.latest, rgb: undefined },
        },
        after: { ...end, latest: { ...end.latest, rgb: undefined } },
        accepted_observation: currentObservation,
        acknowledged_native_observation: reported,
        actual_upstream_session: actual,
        source_frame_comparison: pixels,
      });
      await save();
      assert.ok(
        pixels.matches_fixed_grant,
        `Decoded original-source frame time matches the immutable grant origin + rVFC (delta=${pixels.absolute_timeline_error_seconds.toFixed(3)}s)`,
      );
      assert.equal(
        viewer.errors.length,
        0,
        "No real page error during playback",
      );
    }
    phase.result = "passed";
    phase.finished_at = new Date().toISOString();
    await save();
    return phase;
  }
  async function seek(owner, target) {
    const original = viewers.map((viewer) => ({
      viewer,
      grant: viewer.current,
    }));
    const action = {
      at: new Date().toISOString(),
      type: "normal room seek",
      target_seconds: target,
      before: original.map(({ viewer, grant }) => ({
        viewer: viewer.name,
        session_id: grant?.plan.session_id,
      })),
    };
    product.actions.push(action);
    await owner.page.locator("video").hover();
    const slider = owner.page.getByRole("slider", {
      name: "播放进度",
      exact: true,
    });
    const box = await slider.boundingBox(),
      maximum = Number(await slider.getAttribute("max"));
    assert.ok(
      box && maximum > target && target > 0,
      "The actual range has a seekable source duration",
    );
    // Trusted pointer input invokes Vue's normal range/room SEEK path.
    // Never assign video.currentTime or inject a room clock from the test.
    await slider.click({
      position: { x: (box.width * target) / maximum, y: box.height / 2 },
    });
    for (const { viewer, grant } of original) {
      if (!grant) continue;
      if (grant.plan.rebuild_on_seek)
        await until(
          () =>
            viewer.current &&
            viewer.current.plan.session_id !== grant.plan.session_id,
          "normal seek rebuilds this immutable grant",
          120,
        );
      await until(
        async () => {
          const value = await sample(viewer);
          return (
            value.latest &&
            Math.abs(
              viewer.current.plan.timeline_origin_ms / 1000 +
                value.latest.media_time -
                target,
            ) <= 4 &&
            !value.dom.seeking
          );
        },
        "actual decoder reaches random seek position",
        30,
      );
    }
    action.after = original.map(({ viewer }) => ({
      viewer: viewer.name,
      session_id: viewer.current?.plan.session_id,
    }));
    await save();
  }
  async function stopped(viewer, id, label) {
    const began = performance.now();
    const row = await until(
      async () => {
        const value = await ledger(id);
        return value.state === "closed" &&
          value.stop_confirmed &&
          (upstream.kind === "jellyfin" || value.encoding_stop_confirmed)
          ? value
          : null;
      },
      label,
      report.limits.stop_seconds,
    );
    const remaining = await until(
      async () => {
        const value = await sessions();
        return value.some(
          (session) =>
            session.DeviceId === row.device_id && session.NowPlayingItem,
        )
          ? null
          : value;
      },
      "stopped upstream device has no playing item",
      5,
    );
    const seconds = (performance.now() - began) / 1000;
    assert.ok(
      seconds <= report.limits.stop_seconds,
      "The entire observed upstream stop window stays bounded",
    );
    return {
      id,
      actual_stop_seconds: seconds,
      ledger: publicLedger(row),
      actual_upstream_sessions_after: remaining,
      final_observation: await observation(id),
      real_delete_requests: viewer.deletes.filter((entry) =>
        entry.path.endsWith(id),
      ),
    };
  }
  product.phases = [];
  product.actions = [];
  product.negotiations = [];
  product.upstream_sessions = [];
  try {
    const owner = await openViewer(
      "owner",
      "admin",
      fixture.password,
      admin,
      ownerUser,
    );
    const viewer = await openViewer(
      "viewer",
      guestName,
      guestPassword,
      guest,
      guestUser,
    );
    await setting(owner, "播放方式", "自动适配");
    await setting(viewer, "播放方式", "自动适配");
    await choose(owner, "h264");
    await decodedWindow(
      "H264 auto / independent Start and Progress",
      viewers,
      "h264",
    );
    assert.ok(
      viewers.every((viewer) => viewer.current.plan.delivery_mode === "direct"),
      "Compatible H264 auto actually direct plays",
    );
    const seed = randomBytes(4).readUInt32LE();
    product.random_seek_seed = seed;
    const target = 5 + (seed % 100) / 10;
    await seek(owner, target);
    await decodedWindow("H264 random normal room seek", viewers, "h264");
    const otherGrant = owner.current,
      stoppedId = viewer.current.plan.session_id;
    await viewer.page
      .getByRole("button", { name: "离开观看", exact: true })
      .click();
    product.actions.push({
      type: "one real viewer leaves; the other continues",
      stopped: await stopped(
        viewer,
        stoppedId,
        "individual real upstream Stop completes",
      ),
      surviving_session_id: otherGrant.plan.session_id,
    });
    viewer.current = null;
    await decodedWindow(
      "Stopping one viewer preserves the other grant and decode",
      [owner],
      "h264",
    );
    assert.equal(owner.current, otherGrant);
    await enter(viewer);
    for (const viewer of viewers) {
      const old = viewer.current;
      await setting(viewer, "播放方式", "直接播放", true);
      await until(
        () => viewer.current && viewer.current !== old,
        "normal direct option publishes a fresh grant",
        120,
      );
    }
    await decodedWindow(
      "H264 explicitly requested direct playback",
      viewers,
      "h264",
    );
    await seek(owner, 6 + (seed % 40) / 10);
    for (const viewer of viewers) {
      const old = viewer.current;
      await setting(viewer, "播放方式", "转封装", true);
      await until(
        () => viewer.current && viewer.current !== old,
        "normal remux option publishes a fresh grant",
        120,
      );
    }
    await decodedWindow(
      "Requested remux / actual upstream negotiated delivery",
      viewers,
      "h264",
    );
    assert.ok(
      viewers.every((viewer) => viewer.current.plan.transport === "hls"),
      "Requested remux actually exercises upstream HLS",
    );
    for (const viewer of viewers) await setting(viewer, "播放方式", "兼容转码");
    await choose(owner, "hevc");
    await decodedWindow(
      "HEVC explicitly requested transcode / independent devices",
      viewers,
      "hevc",
    );
    await seek(owner, 7 + (seed % 80) / 10);
    await decodedWindow(
      "HEVC nonzero-start random seek / fixed-origin source-frame check",
      viewers,
      "hevc",
    );
    for (const entry of product.negotiations.slice(-viewers.length)) {
      const parameters = entry.actual_delivery.time_and_selection_parameters;
      assert.ok(
        Object.entries(parameters).some(
          ([key, value]) =>
            key.toLowerCase() === "starttimeticks" && Number(value) > 0,
        ),
        "This phase actually negotiated a nonzero upstream StartTimeTicks",
      );
    }
    const beforeAudio = owner.current;
    const alternate = beforeAudio.plan.audio_tracks.find((track) =>
      /jpn/i.test(track.language),
    );
    assert.ok(alternate, "Real HEVC has a Japanese alternate AAC track");
    await setting(owner, "音轨", new RegExp(alternate.language));
    await until(
      () => owner.current && owner.current !== beforeAudio,
      "normal audio switch publishes a distinct grant",
      120,
    );
    await decodedWindow(
      "Changing one viewer audio track does not change the other grant",
      viewers,
      "hevc",
    );
    assert.equal(owner.current.request.audio_index, alternate.index);
    // Actual browser audio, silent destination: no device sound and no mock PCM.
    const audio = await owner.page.evaluate(async () => {
      const video = document.querySelector("video");
      const context = new AudioContext();
      const source = context.createMediaElementSource(video),
        analyser = context.createAnalyser(),
        gain = context.createGain();
      analyser.fftSize = 8192;
      gain.gain.value = 0;
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(context.destination);
      video.muted = false;
      await context.resume();
      await new Promise((done) => setTimeout(done, 750));
      const values = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(values);
      const peak = (frequency) => {
        const middle = Math.round(
          frequency / (context.sampleRate / analyser.fftSize),
        );
        return Math.max(...values.slice(middle - 2, middle + 3));
      };
      const result = {
        sample_rate: context.sampleRate,
        fft_size: analyser.fftSize,
        peak_440_dB: peak(440),
        peak_880_dB: peak(880),
        context_state: context.state,
      };
      video.muted = true;
      await context.close();
      return result;
    });
    assert.ok(
      Number.isFinite(audio.peak_880_dB) &&
        audio.peak_880_dB >= audio.peak_440_dB + 12,
      "Actual decoded alternate track contains the fixture's 880Hz audio, not the 440Hz default",
    );
    product.actions.push({
      type: "actual alternate AAC decode",
      selected_audio_index: alternate.index,
      audio,
    });
    const subtitle = owner.current.plan.subtitle_tracks.find((track) =>
      /eng/i.test(track.language),
    );
    assert.ok(
      subtitle?.url,
      "Real upstream text subtitle has authorized delivery URL",
    );
    const subtitleGrant = owner.current;
    await seek(owner, 2.5);
    await setting(owner, "字幕", new RegExp(subtitle.language));
    const rendered = await until(
      async () => {
        const value = await sample(owner);
        return value.dom.text_tracks.find(
          (track) =>
            track.mode === "showing" &&
            track.cues > 0 &&
            track.active_cues.some((cue) =>
              /RainSync isolated subtitle|Second subtitle cue/.test(cue.text),
            ),
        )
          ? value
          : null;
      },
      "real fetched subtitle cue active on native video timeline",
      15,
    );
    await owner.page.screenshot({
      path: resolve(evidence, upstream.kind, "subtitle-visible.png"),
    });
    product.actions.push({
      type: "actual subtitle enable",
      sample: { ...rendered, latest: { ...rendered.latest, rgb: undefined } },
      screenshot: resolve(evidence, upstream.kind, "subtitle-visible.png"),
      immutable_origin_ms: owner.current.plan.timeline_origin_ms,
      pre_seek_origin_ms: subtitleGrant.plan.timeline_origin_ms,
    });
    await setting(owner, "字幕", "关闭");
    assert.ok(
      (await sample(owner)).dom.text_tracks.every(
        (track) => track.mode === "disabled",
      ),
    );
    // No member-removal endpoint exists. This explicitly controlled DB fault tests
    // the real downstream authorization/Stop path, not an upstream policy endpoint.
    const revokedId = viewer.current.plan.session_id,
      survivor = owner.current;
    await fixture.sql(
      `DELETE FROM room_members WHERE room_id=${uuid(room.id)} AND user_id=${uuid(guestUser.id)}`,
    );
    const denied = await guest.raw(`/playback-sessions/${revokedId}/renew`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    });
    const deniedStatus = denied.status;
    await denied.arrayBuffer();
    assert.ok(
      [403, 410].includes(deniedStatus),
      "Actual revoked room member cannot renew its grant",
    );
    product.actions.push({
      type: "controlled RainSync membership revocation",
      mechanism:
        "DELETE owned row in isolated DB; not a membership-removal API claim",
      denied_status: deniedStatus,
      stopped: await stopped(
        viewer,
        revokedId,
        "real revoked member's upstream Stop completes",
      ),
    });
    viewer.current = null;
    await decodedWindow(
      "Revoking one viewer preserves the other device",
      [owner],
      "hevc",
    );
    assert.equal(owner.current, survivor);
    const last = owner.current.plan.session_id;
    await owner.page
      .getByRole("button", { name: "离开观看", exact: true })
      .click();
    product.actions.push({
      type: "final actual viewer Stop",
      stopped: await stopped(owner, last, "final real upstream Stop completes"),
    });
    owner.current = null;
    // Separate real upstream entitlement case. Revocation does not invent an
    // automatic push notification to RainSync: new upstream playback is denied,
    // then the real app explicitly stops the already-issued owned grant.
    const restricted = await upstream.client({ restricted: true });
    const restrictedSource = await upstream.addRainSyncSource(
      admin,
      restricted,
    );
    await admin.request(`/sources/${restrictedSource.id}/test`, "POST");
    const restrictedMedia = await until(
      async () => {
        const value = JSON.parse(
          await fixture.sql(
            `SELECT coalesce(json_agg(json_build_object('id',id,'resource',resource,'title',title)),'[]') FROM media_items WHERE source_id=${uuid(restrictedSource.id)} AND available`,
          ),
        );
        return value.length === 2 ? value : null;
      },
      "owned nonadmin source scan completes",
      30,
    );
    await enter(owner);
    await setting(owner, "播放方式", "自动适配");
    await choose(owner, "h264", restrictedMedia);
    await decodedWindow(
      "Owned nonadmin upstream entitlement actually decodes",
      [owner],
      "h264",
    );
    const restrictedGrant = owner.current.plan.session_id;
    const revokedPolicy = await upstream.revokeClient(restricted);
    const upstreamItem = restrictedMedia.find(
      (item) => item.id === owner.current.plan.media_id,
    ).resource;
    const revoked = await restricted.raw(
      `/Items/${encodeURIComponent(upstreamItem)}/PlaybackInfo?UserId=${encodeURIComponent(restricted.userId)}`,
      {
        method: "POST",
        body: {
          UserId: restricted.userId,
          StartTimeTicks: 0,
          IsPlayback: true,
          EnableDirectPlay: true,
          EnableDirectStream: true,
          EnableTranscoding: true,
        },
      },
    );
    const upstreamDenied = revoked.status;
    await revoked.arrayBuffer();
    assert.ok(
      [401, 403].includes(upstreamDenied),
      "Actual upstream playback entitlement rejects a new negotiation after revocation",
    );
    await owner.page
      .getByRole("button", { name: "离开观看", exact: true })
      .click();
    product.actions.push({
      type: "real upstream nonadmin policy revocation",
      policy: revokedPolicy,
      actual_denied_playback_info_status: upstreamDenied,
      automatic_existing_grant_revocation_claim: false,
      explicit_app_stop: await stopped(
        owner,
        restrictedGrant,
        "owned nonadmin grant stops after actual policy revocation",
      ),
    });
    product.real_clients = viewers.map((viewer) => ({
      viewer: viewer.name,
      user_id: viewer.user.id,
      granted_sessions: viewer.plans.map((entry) => ({
        requested_mode: entry.request.mode,
        requested_audio_index: entry.request.audio_index,
        requested_position_ms: entry.request.position_ms,
        plan: publicPlan(entry.plan),
      })),
      native_observation_requests: viewer.observations,
      final_delete_requests: viewer.deletes,
      page_errors: viewer.errors,
    }));
  } finally {
    product.final_browser_samples = await Promise.all(
      viewers.map(async (viewer) => {
        try {
          return {
            viewer: viewer.name,
            sample: await bounded(
              sample(viewer),
              3,
              "final browser diagnostic",
            ),
          };
        } catch (error) {
          return { viewer: viewer.name, unavailable: redact(error.message) };
        }
      }),
    );
    product.real_clients ??= viewers.map((viewer) => ({
      viewer: viewer.name,
      user_id: viewer.user.id,
      granted_sessions: viewer.plans.map((entry) => ({
        request: entry.request,
        plan: publicPlan(entry.plan),
      })),
      native_observation_requests: viewer.observations,
      final_delete_requests: viewer.deletes,
      page_errors: viewer.errors,
    }));
    for (const viewer of viewers)
      await cleanup(`${upstream.kind}: ${viewer.name} page context`, () =>
        bounded(viewer.context.close(), 5, "owned browser context closes"),
      );
    await save();
  }
}

try {
  await provenance();
  for (const kind of kinds) {
    const product = {
      kind,
      result: "running",
      started_at: new Date().toISOString(),
    };
    report.products.push(product);
    await save();
    const result = await isolatedUpstreamReal(
      kind,
      async (upstream) => {
        product.upstream = upstream.metadata;
        for (const tool of upstream.metadata.ffmpeg)
          originalProof.set(tool.path, tool.sha256);
        await nativeStack(upstream, product, (fixture) =>
          actualMatrix(upstream, product, fixture),
        );
      },
      {
        artifactRoot: resolve(evidence, kind, "upstream"),
        activityPath,
        durationSeconds: 90,
        ffmpegBin: process.env.RAINSYNC_FFMPEG_BIN,
        concurrentRuns:
          "Sequential isolated product matrix; any unrelated host load remains external",
      },
    );
    product.setup_report_path = result.reportPath;
    product.setup_cleanup = result.metadata.cleanup;
    assert.equal(result.metadata.result, "passed");
    assert.ok(
      result.metadata.cleanup.container &&
        result.metadata.cleanup.network &&
        result.metadata.cleanup.volumes.every((volume) => volume.absent),
    );
    assert.ok(
      product.phases.length >= 10 &&
        product.phases.every((phase) => phase.result === "passed"),
      "Each product completed actual decode phases rather than setup only",
    );
    product.result = "passed";
    product.finished_at = new Date().toISOString();
    await reverify();
    await save();
  }
  await reverify();
  assert.ok(report.cleanup.every((step) => step.result === "passed"));
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  process.exitCode = 1;
  report.failures.push(redact(error.stack ?? error));
} finally {
  await cleanup(
    "all bound sources and actual binaries unchanged after run",
    reverify,
  );
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  report.finished_at = new Date().toISOString();
  await save();
  console.log(`${report.result.toUpperCase()}: ${reportPath}`);
  if (report.result !== "passed") process.exitCode = 1;
}
