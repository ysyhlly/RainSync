// Concrete RainSync workload for a disposable native fixture. This module never
// builds, launches a browser, accepts a target URL/DB, or claims a native PID is
// a container image. See docs/OWNED_SOAK_ADAPTER.md for remaining formal gates.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, readlink, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { request as httpRequest } from "node:http";
import WebSocket from "ws";
import { boundedCall } from "./acceptance-runtime.mjs";
import { createBrowserMeasurementDriver } from "./acceptance-browser.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const uuid = (value) => {
  assert.match(
    value,
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  );
  return value;
};
const quote = (value) => `'${uuid(value)}'`;
export class SoakPrerequisiteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SoakPrerequisiteError";
    this.code = code;
  }
}
const unsupported = (code, message) => {
  throw new SoakPrerequisiteError(code, message);
};
// Cleanup owns an independent deadline for each resource. A timeout is an
// unconfirmed failure, never proof that an ignoring external driver stopped.
export async function cleanupOwnedResources(tasks, { timeout_ms = 5000 } = {}) {
  const outcomes = await Promise.all(
    tasks.map(async ({ resource, run }) => {
      try {
        const value = await boundedCall({ run }, "run", undefined, {
          timeout_ms,
        });
        return { resource, confirmed: true, value };
      } catch (error) {
        return { resource, confirmed: false, error };
      }
    }),
  );
  return { confirmed: outcomes.every((v) => v.confirmed), outcomes };
}
export function preserveOwnedFailure(
  primary,
  secondary = [],
  message = "Owned soak failed",
) {
  if (!secondary.length) return primary;
  const errors = [...(primary ? [primary] : []), ...secondary];
  const error = new AggregateError(
    errors,
    `${message}: ${primary?.message ?? secondary[0].message}`,
    { cause: primary ?? secondary[0] },
  );
  error.primary_error = primary ?? null;
  error.secondary_errors = secondary;
  return error;
}
const combineSignals = (lifetime, action, timeout_ms = 30000) =>
  AbortSignal.any([
    AbortSignal.timeout(timeout_ms),
    ...(lifetime ? [lifetime] : []),
    ...(action ? [action] : []),
  ]);
export function ownedSoakPreflight(
  { scope = "smoke", kinds = [], faults = [] } = {},
  { presentation = false } = {},
) {
  const missing = [];
  if (scope === "formal")
    missing.push({
      code: "NATIVE_IMAGE_UNOBSERVABLE",
      detail:
        "An owned native process is not a final candidate image; use an authorized isolated image deployment with a measured observer.",
    });
  for (const kind of kinds) {
    if (["loop-playback", "seek"].includes(kind) && !presentation)
      missing.push({
        code: "PRESENTATION_REQUIRED",
        action: kind,
        detail:
          "Supply actual Playwright pages, independent visible-timecode decoding and private frame storage. Browser launch is not performed here.",
      });
    if (kind === "cache-evict")
      missing.push({
        code: "CACHE_EVICTION_UNSUPPORTED",
        action: kind,
        detail:
          "Requires measured quota-pressure eviction plus active-reader survival on an isolated owned cache; deleting files is not an eviction test.",
      });
    if (
      ![
        "phase",
        "slice",
        "join",
        "leave",
        "stop-stream",
        "loop-playback",
        "seek",
        "cache-evict",
        "fault",
      ].includes(kind)
    )
      missing.push({ code: "UNKNOWN_ACTION", action: kind });
  }
  for (const fault of faults)
    if (fault !== "F4")
      missing.push({
        code: "FAULT_UNSUPPORTED",
        fault,
        detail:
          {
            F1: "An external owned-process supervisor and generation/write-fencing witnesses are required.",
            F2: "An isolated database lock-loss driver with independent false-ACK and post-loss write witnesses is required.",
            F3: "A separately approved isolated capacity-limited volume is required; no host disk filling or permission changes are attempted.",
          }[fault] ?? "Unknown fault",
      });
  return {
    supported: missing.length === 0,
    missing,
    accepted: false,
    release_ready: false,
  };
}
export function localDeliveryUrl(value, origin) {
  const base = new URL(origin),
    url = new URL(value, base);
  assert.equal(
    base.hostname,
    "127.0.0.1",
    "only owned loopback fixture origins",
  );
  assert.equal(base.protocol, "http:");
  assert.equal(url.origin, base.origin, "external delivery target rejected");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.hash, "");
  assert.match(
    url.pathname,
    /^\/media-delivery\/[a-f0-9-]{36}\//,
    "only owned delivery API paths",
  );
  return url.href;
}
export function segmentUrls(manifest, playlist, origin) {
  assert.ok(manifest.startsWith("#EXTM3U"), "HLS playlist required");
  assert.ok(
    manifest.includes("#EXTINF:") && !manifest.includes("#EXT-X-STREAM-INF:"),
    "completed media segments required, not a master playlist",
  );
  const values = [];
  for (const line of manifest
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean)) {
    if (line.startsWith("#EXT-X-MAP:")) {
      const match = /URI="([^"]+)"/.exec(line);
      assert.ok(match, "init segment URI required");
      values.push(match[1]);
    } else if (!line.startsWith("#")) values.push(line);
  }
  assert.ok(
    values.length > 0 && values.length <= 256,
    "bounded nonempty media playlist required",
  );
  const parent = new URL(playlist).pathname.replace(/[^/]*$/, "");
  return values.map((value) => {
    const url = localDeliveryUrl(new URL(value, playlist).href, origin);
    assert.ok(
      new URL(url).pathname.startsWith(parent),
      "segment escaped owned output",
    );
    return url;
  });
}
async function until(fn, label, { signal, timeout_ms = 20000 } = {}) {
  const end = performance.now() + timeout_ms;
  while (performance.now() < end) {
    signal?.throwIfAborted();
    const value = await fn();
    signal?.throwIfAborted();
    if (value) return value;
    await sleep(25, undefined, { signal });
  }
  throw Error(`Owned soak deadline: ${label}`);
}
async function bytes(response, limit, signal) {
  assert.ok(response.body, "response body required");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const v = await reader.read();
      if (v.done) break;
      size += v.value.length;
      assert.ok(size <= limit, "owned response exceeded byte bound");
      chunks.push(v.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
function socketFor(f, client, room, signal) {
  signal?.throwIfAborted();
  const socket = new WebSocket(
    f.origin.replace("http:", "ws:") + "/api/v1/ws",
    { headers: { Origin: f.origin, Cookie: client.cookie } },
  );
  const frames = [];
  let failure,
    passive = false;
  socket.on("message", (buffer) => {
    try {
      assert.ok(frames.length < 512, "owned WS inbox overflow");
      const value = JSON.parse(buffer);
      if (!passive) frames.push(value);
    } catch (error) {
      failure = error;
      socket.terminate();
    }
  });
  socket.on("error", (error) => {
    failure = error;
  });
  const closed = new Promise((done) => socket.once("close", done));
  const abort = () => socket.terminate();
  signal?.addEventListener("abort", abort, { once: true });
  const next = (predicate, options = {}) =>
    until(
      () => {
        if (failure) throw failure;
        const index = frames.findIndex(predicate);
        return index < 0 ? null : frames.splice(index, 1)[0];
      },
      "WebSocket reply",
      { signal, ...options },
    );
  return {
    async join({ signal: localSignal = signal } = {}) {
      await until(
        () => {
          if (failure) throw failure;
          return socket.readyState === WebSocket.OPEN;
        },
        "WebSocket open",
        { signal: localSignal },
      );
      socket.send(
        JSON.stringify({ type: "JOIN", room_id: room, presence_version: 1 }),
      );
      return next((v) => v.type === "SNAPSHOT", { signal: localSignal });
    },
    next,
    passive() {
      passive = true;
      frames.length = 0;
    },
    send(value) {
      signal?.throwIfAborted();
      assert.equal(socket.readyState, WebSocket.OPEN);
      socket.send(JSON.stringify(value));
    },
    async close() {
      signal?.removeEventListener("abort", abort);
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      await closed;
    },
  };
}
const online = (presence) =>
  presence.members.filter((v) => v.connection_count > 0).length;

// Reads only the exact process tree descended from captured fixture PIDs.
// Stable /proc start ticks reject PID reuse; socket_count counts socket FDs.
export async function readProcessIdentity(pid, { signal } = {}) {
  signal?.throwIfAborted();
  assert.ok(Number.isSafeInteger(pid) && pid > 1, "owned PID required");
  const stat = await readFile(`/proc/${pid}/stat`, "utf8"),
    fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
  const exe = await readlink(`/proc/${pid}/exe`);
  signal?.throwIfAborted();
  return {
    pid,
    parent_pid: Number(fields[1]),
    start_ticks: fields[19],
    exe,
  };
}
async function processTree(root, signal) {
  signal?.throwIfAborted();
  const pinned = await readProcessIdentity(root.pid, { signal });
  assert.equal(
    pinned.start_ticks,
    root.start_ticks,
    "owned PID generation changed",
  );
  assert.equal(pinned.exe, root.exe, "owned executable changed");
  // Some isolated Linux runtimes expose stat but not task/*/children. Read
  // ancestry from stat, then inspect only descendants of the captured root.
  const rows = [];
  for (const entry of await readdir("/proc"))
    if (/^\d+$/.test(entry)) {
      signal?.throwIfAborted();
      try {
        const stat = await readFile(`/proc/${entry}/stat`, "utf8"),
          fields = stat
            .slice(stat.lastIndexOf(")") + 2)
            .trim()
            .split(/\s+/);
        rows.push({ pid: Number(entry), parent_pid: Number(fields[1]) });
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
      }
    }
  const selected = new Map([[pinned.pid, pinned]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (selected.has(row.parent_pid) && !selected.has(row.pid)) {
        const actual = await readProcessIdentity(row.pid, { signal });
        assert.equal(
          actual.parent_pid,
          row.parent_pid,
          "child ancestry changed",
        );
        selected.set(row.pid, actual);
        changed = true;
      }
  }
  let rss_bytes = 0,
    fd_count = 0,
    socket_count = 0;
  for (const row of selected.values()) {
    signal?.throwIfAborted();
    const status = await readFile(`/proc/${row.pid}/status`, "utf8"),
      rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
    assert.ok(rss, "RSS unavailable");
    rss_bytes += Number(rss[1]) * 1024;
    const fds = await readdir(`/proc/${row.pid}/fd`);
    fd_count += fds.length;
    for (const fd of fds)
      try {
        if (
          (await readlink(`/proc/${row.pid}/fd/${fd}`)).startsWith("socket:[")
        )
          socket_count++;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    const after = await readProcessIdentity(row.pid, { signal });
    assert.equal(
      after.start_ticks,
      row.start_ticks,
      "process changed during sample",
    );
  }
  signal?.throwIfAborted();
  return {
    rss_bytes,
    fd_count,
    socket_count,
    process_count: selected.size,
    pids: [...selected.keys()],
  };
}
async function directoryBytes(root, signal) {
  signal?.throwIfAborted();
  let sum = 0;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(
    (error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  )) {
    signal?.throwIfAborted();
    const path = resolve(root, entry.name),
      info = await lstat(path);
    assert.ok(!info.isSymbolicLink(), "cache symlink unsupported");
    if (info.isDirectory()) sum += await directoryBytes(path, signal);
    else if (info.isFile()) sum += info.size;
    else throw Error("nonregular cache entry");
  }
  signal?.throwIfAborted();
  return sum;
}

// Scope-limited API adapter. fixture must be created by withOwnedNativeSoak;
// presentation is optional and only an actually supplied page driver can report
// presented frames. Synthetic tests explicitly choose mode=synthetic.
export async function createOwnedSoakWorkload({
  fixture: f,
  media,
  mode = "real",
  presentation,
  run_id = randomUUID(),
  signal,
}) {
  assert.ok(["real", "synthetic"].includes(mode));
  uuid(run_id);
  uuid(f.id);
  uuid(media.id);
  assert.equal(
    f.databaseKind,
    "native",
    "Docker/external DB fixtures forbidden",
  );
  for (const origin of [f.origin, f.workerOrigin]) {
    const u = new URL(origin);
    assert.equal(u.origin, origin);
    assert.equal(u.hostname, "127.0.0.1");
    assert.equal(u.protocol, "http:");
  }
  const db = f.postgresDiagnostics();
  assert.equal(db.fixture_id, f.id);
  assert.equal(db.host, "127.0.0.1");
  assert.equal(db.kind, "native");
  assert.equal(
    f.sql("SELECT current_database()"),
    db.database,
    "exact owned database required",
  );
  assert.equal(resolve(db.native.data_directory), resolve(f.root, "postgres"));
  const resource_ids = ["server", "worker", "postgres"].map(
    (role) => `${run_id}:${role}`,
  );
  const roots =
    mode === "real"
      ? await Promise.all(
          [f.serverPid, f.workerPid, db.native.pid].map((pid) =>
            readProcessIdentity(pid, { signal }),
          ),
        )
      : [];
  const client = f.client(),
    sockets = new Set(),
    sessions = new Map(),
    users = [];
  let room,
    snapshot,
    control,
    active = [],
    churn,
    disposed = false,
    phase,
    phaseVersion = 0,
    transitioning = false,
    longStreamInFlight = false,
    cleanupPromise;
  const assertCurrent = (event) => {
    assert.equal(disposed, false);
    assert.equal(event.run_id, run_id, "foreign run");
    assert.deepEqual(
      event.owned_resource_ids,
      resource_ids,
      "foreign resources",
    );
  };
  const api = async (
    c,
    path,
    method = "GET",
    body,
    expected = 200,
    localSignal = signal,
  ) => {
    localSignal?.throwIfAborted();
    const response = await c.raw(path, { method, body, signal: localSignal });
    const value = await response.json();
    assert.equal(
      response.status,
      expected,
      `${method} ${path}: status=${response.status}; error=${value?.error?.code ?? "none"}`,
    );
    return value;
  };
  const user = async (index, localSignal = signal) => {
    localSignal?.throwIfAborted();
    if (users[index]) return users[index];
    const username = `soak_${run_id.slice(0, 8)}_${index}`;
    await api(
      client,
      "/users",
      "POST",
      { username, password: f.password },
      200,
      localSignal,
    );
    const c = f.client();
    c.csrf = (
      await api(
        c,
        "/auth/login",
        "POST",
        { username, password: f.password },
        200,
        localSignal,
      )
    ).csrf;
    const identity = await api(
      c,
      "/auth/me",
      "GET",
      undefined,
      200,
      localSignal,
    );
    const invite = await api(
      client,
      `/rooms/${room.id}/invites`,
      "POST",
      undefined,
      200,
      localSignal,
    );
    await api(
      c,
      `/rooms/${room.id}/join`,
      "POST",
      { token: invite.token },
      200,
      localSignal,
    );
    return (users[index] = {
      client: c,
      user_id: uuid(identity.id),
      client_id: randomUUID(),
      plan_generation: 0,
    });
  };
  const connectChurn = async (localSignal = signal) => {
    const member = await user(100, localSignal);
    localSignal?.throwIfAborted();
    const ws = socketFor(f, member.client, room.id, signal);
    sockets.add(ws);
    let first;
    try {
      first = await ws.join({ signal: localSignal });
      localSignal?.throwIfAborted();
    } catch (error) {
      await ws.close();
      sockets.delete(ws);
      throw error;
    }
    assert.deepEqual(
      first.state,
      snapshot.state,
      "joining peer authority differs",
    );
    ws.passive();
    churn = { ws, first };
    return first;
  };
  const stop = async (session, localSignal = signal) => {
    await api(
      session.client,
      `/playback-sessions/${session.plan.session_id}`,
      "DELETE",
      undefined,
      200,
      localSignal,
    );
    sessions.delete(session.plan.session_id);
  };
  const prepareSession = async (
    member,
    requestedMode,
    position_ms,
    localSignal,
  ) => {
    const response = await member.client.raw("/playback-sessions", {
      method: "POST",
      signal: localSignal,
      body: {
        room_id: room.id,
        media_generation: snapshot.state.media_generation,
        mode: requestedMode,
        position_ms,
        viewer_id: member.client_id,
        plan_generation: ++member.plan_generation,
        idempotency_key: randomUUID(),
      },
    });
    const plan = await response.json();
    if (response.status !== 200) {
      assert.ok(
        [429, 503].includes(response.status) &&
          [
            "TOO_MANY_PLAYBACK_SESSIONS",
            "PLAYBACK_VIEWER_LIMIT_EXCEEDED",
            "RATE_LIMITED",
          ].includes(plan.error?.code),
        "uncontrolled playback rejection",
      );
      return { rejection: { status: response.status, code: plan.error.code } };
    }
    uuid(plan.session_id);
    const source_url = localDeliveryUrl(plan.playback_url, f.workerOrigin);
    assert.ok(
      new URL(source_url).pathname.startsWith(
        `/media-delivery/${plan.session_id}/`,
      ),
      "delivery session identity mismatch",
    );
    const session = { ...member, plan, source_url };
    sessions.set(plan.session_id, session);
    return session;
  };
  const phaseAction = async (event, localSignal) => {
    assert.equal(transitioning, false, "phase transition already active");
    transitioning = true;
    phase = undefined;
    phaseVersion++;
    try {
      await presentation?.dispose();
      for (const s of active) await stop(s, localSignal);
      active = [];
      assert.ok(["direct", "transcode"].includes(event.phase.mode));
      assert.ok(
        Number.isInteger(event.phase.concurrency) &&
          event.phase.concurrency >= 1 &&
          event.phase.concurrency <= 10,
      );
      const rejections = [];
      for (let i = 0; i < event.phase.concurrency; i++) {
        const s = await prepareSession(
          await user(i, localSignal),
          event.phase.mode,
          0,
          localSignal,
        );
        if (s.rejection) rejections.push(s.rejection);
        else {
          assert.equal(s.plan.delivery_mode, event.phase.mode);
          active.push(s);
        }
      }
      if (presentation && active.length)
        await presentation.open({
          streams: active.map((s) => ({
            client_id: s.client_id,
            room: room.id,
            source_url: s.source_url,
            media_origin_ms: s.plan.timeline_origin_ms ?? 0,
            delivery_mode: s.plan.delivery_mode,
          })),
          signal: localSignal,
        });
      // Native mode proves admission + delivered bytes, never presented concurrency.
      for (const s of active) {
        const r = await fetch(s.source_url, {
          headers:
            s.plan.delivery_mode === "direct" ? { Range: "bytes=0-1023" } : {},
          redirect: "error",
          signal: localSignal,
        });
        assert.ok(r.ok);
        const body = await bytes(r, 1024 * 1024, localSignal);
        assert.ok(body.length > 0);
      }
      localSignal.throwIfAborted();
      phase = structuredClone(event.phase);
      return {
        mode: phase.mode,
        requested_concurrency: phase.concurrency,
        active_concurrency: active.length,
        controlled_rejections: rejections.length,
        rejections,
        concurrency_measurement: presentation
          ? "observed-browser-pages"
          : "admitted-sessions-with-delivery-probes",
        session_ids: active.map((s) => s.plan.session_id),
      };
    } finally {
      transitioning = false;
    }
  };
  const slice = async (localSignal) => {
    const member = await user(101, localSignal),
      s = await prepareSession(member, "transcode", 0, localSignal);
    assert.ok(!s.rejection, "slice admission rejected");
    let primary;
    try {
      const r = await fetch(s.source_url, {
        redirect: "error",
        signal: localSignal,
      });
      assert.equal(r.status, 200);
      const manifest = (await bytes(r, 1024 * 1024, localSignal)).toString(
        "utf8",
      );
      const urls = segmentUrls(manifest, s.source_url, f.workerOrigin);
      const segments = [];
      for (const url of urls) {
        const r = await fetch(url, { redirect: "error", signal: localSignal });
        assert.equal(r.status, 200);
        const b = await bytes(r, 8 * 1024 * 1024, localSignal);
        assert.ok(b.length > 0);
        segments.push({
          path: new URL(url).pathname,
          bytes: b.length,
          sha256: sha(b),
        });
      }
      return {
        completed_segments: segments.filter((s) => !s.path.endsWith("init.mp4"))
          .length,
        failed_segments: 0,
        segments,
        manifest_sha256: sha(manifest),
        measurement: "actual-http-segment-bytes",
        session_id: s.plan.session_id,
      };
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      const cleanup = await cleanupOwnedResources([
        {
          resource: `slice-session-${s.plan.session_id}`,
          run: (_, { signal: cleanupSignal }) => stop(s, cleanupSignal),
        },
      ]);
      if (!cleanup.confirmed) {
        const error = preserveOwnedFailure(
          primary,
          cleanup.outcomes.filter((v) => !v.confirmed).map((v) => v.error),
          "Slice cleanup failed",
        );
        error.cleanup = cleanup;
        throw error;
      }
    }
  };
  const membership = async (kind, localSignal) => {
    // These are distinct online members, not durable membership deletion.
    const monitor = socketFor(f, client, room.id, signal);
    sockets.add(monitor);
    try {
      const before = await monitor.join({ signal: localSignal });
      if (kind === "join") {
        assert.ok(!churn, "member already connected");
        await connectChurn(localSignal);
      } else {
        assert.ok(churn, "no online churn member");
        await churn.ws.close();
        sockets.delete(churn.ws);
        churn = null;
      }
      const after = await monitor.next(
        (v) =>
          v.type === "PRESENCE_SNAPSHOT" &&
          online(v) === online(before.presence) + (kind === "join" ? 1 : -1),
        { signal: localSignal },
      );
      localSignal?.throwIfAborted();
      const check = socketFor(f, client, room.id, signal);
      sockets.add(check);
      try {
        const current = await check.join({ signal: localSignal });
        assert.deepEqual(
          current.state,
          before.state,
          "membership changed authority snapshot",
        );
      } finally {
        await check.close();
        sockets.delete(check);
      }
      return {
        members_before: online(before.presence),
        members_after: online(after),
        authority_snapshot_verified: true,
        authority_sha256: sha(JSON.stringify(before.state)),
        membership_measurement: "online-distinct-users",
        room_id: room.id,
      };
    } finally {
      await monitor.close();
      sockets.delete(monitor);
    }
  };
  const revokeAction = async (localSignal, kind = "membership") => {
    // Requires a sample larger than downstream buffers. A short/eager EOF is
    // explicitly rejected, never promoted to revocation evidence.
    const s = await prepareSession(
      await user(102, localSignal),
      "direct",
      0,
      localSignal,
    );
    assert.ok(!s.rejection);
    let req,
      res,
      ended = false,
      received = 0,
      primary;
    const abort = () =>
      req?.destroy(localSignal?.reason ?? Error("long stream interrupted"));
    localSignal?.addEventListener("abort", abort, { once: true });
    try {
      await new Promise((done, fail) => {
        req = httpRequest(s.source_url, (response) => {
          res = response;
          if (res.statusCode !== 200) {
            fail(Error("long stream admission failed"));
            return;
          }
          res.on("error", () => {});
          res.on("end", () => {
            ended = true;
          });
          let first = true;
          res.on("data", (chunk) => {
            received += chunk.length;
            if (first) {
              first = false;
              res.pause();
              done();
            }
          });
        });
        req.once("error", fail);
        req.end();
      });
      assert.ok(
        Number(res.headers["content-length"]) >= 16 * 1024 * 1024,
        "F4 requires a separately owned long fixture (at least 16 MiB)",
      );
      assert.equal(ended, false);
      assert.ok(
        Number(
          f.sql(
            `SELECT count(*) FROM media_executions WHERE session_id=${quote(s.plan.session_id)} AND reaped_at IS NULL`,
          ),
        ) > 0,
        "long stream must have a live owned execution witness",
      );
      const healthy = active.find(
        (value) =>
          value.user_id !== s.user_id && value.plan.delivery_mode === "direct",
      );
      assert.ok(
        healthy,
        "same-room independent direct viewer required for this F4 subcase",
      );
      const probeHealthy = async () => {
        const response = await fetch(healthy.source_url, {
          headers: { Range: "bytes=0-1023" },
          redirect: "error",
          signal: localSignal,
        });
        assert.equal(response.status, 206, "unaffected viewer delivery");
        assert.equal((await bytes(response, 1024, localSignal)).length, 1024);
      };
      await probeHealthy();
      const beforeEpoch = uuid(
        f.sql(
          `SELECT membership_epoch FROM room_members WHERE room_id=${quote(room.id)} AND user_id=${quote(s.user_id)}`,
        ),
      );
      localSignal?.throwIfAborted();
      const injected_at_ms = performance.now();
      if (kind === "membership") {
        assert.equal(
          f.sql(
            `WITH removed AS (DELETE FROM room_members WHERE room_id=${quote(room.id)} AND user_id=${quote(s.user_id)} RETURNING membership_epoch) SELECT membership_epoch FROM removed`,
          ),
          beforeEpoch,
          "exact owned membership row revoked",
        );
      } else await stop(s, localSignal);
      await until(
        () =>
          f.sql(
            `SELECT count(*) FROM media_executions WHERE session_id=${quote(s.plan.session_id)} AND reaped_at IS NULL`,
          ) === "0",
        "owned long-stream execution reaped",
        { signal: localSignal, timeout_ms: 10000 },
      );
      res.resume();
      await until(() => res.destroyed, "revoked long body closed", {
        signal: localSignal,
        timeout_ms: 10000,
      });
      assert.equal(ended, false, "natural EOF is not revocation");
      const recovered_at_ms = performance.now(),
        denied = await fetch(s.source_url, {
          redirect: "error",
          signal: localSignal,
        });
      assert.equal(denied.status, 401);
      await bytes(denied, 65536, localSignal);
      assert.ok(
        recovered_at_ms - injected_at_ms <= 10000,
        "revocation exceeded 10 seconds",
      );
      await probeHealthy();
      let afterEpoch;
      if (kind === "membership") {
        const invite = await api(
          client,
          `/rooms/${room.id}/invites`,
          "POST",
          undefined,
          200,
          localSignal,
        );
        await api(
          s.client,
          `/rooms/${room.id}/join`,
          "POST",
          { token: invite.token },
          200,
          localSignal,
        );
        afterEpoch = uuid(
          f.sql(
            `SELECT membership_epoch FROM room_members WHERE room_id=${quote(room.id)} AND user_id=${quote(s.user_id)}`,
          ),
        );
        assert.notEqual(
          afterEpoch,
          beforeEpoch,
          "rejoin needs a new membership epoch",
        );
        const old = await fetch(s.source_url, {
          redirect: "error",
          signal: localSignal,
        });
        assert.equal(old.status, 401, "rejoin cannot restore old grant");
        await bytes(old, 65536, localSignal);
      }
      return {
        ...(kind === "membership" ? { fault: "F4" } : { check: "stop-stream" }),
        injected_at_ms,
        recovered_at_ms,
        new_requests_denied: kind === "membership" ? 2 : 1,
        long_stream_close_ms: recovered_at_ms - injected_at_ms,
        session_id: s.plan.session_id,
        bytes_before_close: received,
        normal_eof: false,
        revocation:
          kind === "membership"
            ? "owned-membership-sql-fault"
            : "session-delete",
        unaffected_viewer_verified: true,
        ...(kind === "membership"
          ? {
              room_id: room.id,
              user_id: s.user_id,
              membership_epoch_before: beforeEpoch,
              membership_epoch_after: afterEpoch,
              old_grant_denied_after_rejoin: true,
            }
          : {}),
      };
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      localSignal?.removeEventListener("abort", abort);
      req?.destroy();
      if (sessions.has(s.plan.session_id)) {
        const cleanup = await cleanupOwnedResources([
          {
            resource: `revocation-session-${s.plan.session_id}`,
            run: (_, { signal: cleanupSignal }) => stop(s, cleanupSignal),
          },
        ]);
        if (!cleanup.confirmed) {
          const error = preserveOwnedFailure(
            primary,
            cleanup.outcomes.filter((v) => !v.confirmed).map((v) => v.error),
            "Revocation cleanup failed",
          );
          error.cleanup = cleanup;
          throw error;
        }
      }
    }
  };
  // Stop and membership F4 share one stable viewer/session actor. This guard
  // also protects direct harness callers outside the scheduled bridge.
  const revoke = async (localSignal, kind = "membership") => {
    assert.equal(
      longStreamInFlight,
      false,
      "owned long-stream actor already active",
    );
    longStreamInFlight = true;
    try {
      return await revokeAction(localSignal, kind);
    } finally {
      longStreamInFlight = false;
    }
  };
  const dispose = () =>
    (cleanupPromise ??= (async () => {
      disposed = true;
      const outcomes = [];
      const batch = async (tasks) =>
        outcomes.push(...(await cleanupOwnedResources(tasks)).outcomes);
      if (presentation)
        await batch([
          {
            resource: "presentation",
            run: (_, { signal: cleanupSignal }) =>
              presentation.dispose({ signal: cleanupSignal }),
          },
        ]);
      await batch(
        [...sockets].map((ws, index) => ({
          resource: `socket-${index}`,
          run: () => ws.close(),
        })),
      );
      await batch(
        [...sessions.values()].map((session) => ({
          resource: `session-${session.plan.session_id}`,
          run: (_, { signal: cleanupSignal }) => stop(session, cleanupSignal),
        })),
      );
      if (room?.id)
        await batch([
          {
            resource: `room-${room.id}`,
            run: async (_, { signal: cleanupSignal }) => {
              const current = await api(
                client,
                `/rooms/${room.id}/lifecycle`,
                "GET",
                undefined,
                200,
                cleanupSignal,
              );
              if (
                current.lifecycle === "closed" ||
                current.lifecycle === "archived"
              )
                return { lifecycle: current.lifecycle };
              await api(
                client,
                `/rooms/${room.id}/close`,
                "POST",
                { expected_revision: current.state.revision },
                200,
                cleanupSignal,
              );
              const closed = await until(
                async () => {
                  const value = await api(
                    client,
                    `/rooms/${room.id}/lifecycle`,
                    "GET",
                    undefined,
                    200,
                    cleanupSignal,
                  );
                  return value.lifecycle === "closed" ? value : null;
                },
                "owned room cleanup",
                { signal: cleanupSignal, timeout_ms: 4500 },
              );
              return { lifecycle: closed.lifecycle };
            },
          },
        ]);
      const result = {
        confirmed: outcomes.every((v) => v.confirmed),
        outcomes,
      };
      if (!result.confirmed) {
        const error = preserveOwnedFailure(
          null,
          outcomes.filter((v) => !v.confirmed).map((v) => v.error),
          "Owned workload cleanup unconfirmed",
        );
        error.cleanup = result;
        throw error;
      }
      return result;
    })());
  try {
    const initSignal = combineSignals(signal);
    client.csrf = (
      await api(
        client,
        "/auth/login",
        "POST",
        { username: "admin", password: f.password },
        200,
        initSignal,
      )
    ).csrf;
    room = await api(
      client,
      "/rooms",
      "POST",
      { name: `owned soak ${run_id.slice(0, 8)}` },
      200,
      initSignal,
    );
    uuid(room.id);
    initSignal.throwIfAborted();
    control = socketFor(f, client, room.id, signal);
    sockets.add(control);
    snapshot = await control.join({ signal: initSignal });
    const command = {
      protocol_version: 1,
      room_id: room.id,
      command_id: randomUUID(),
      control_epoch: snapshot.control_epoch.id,
      expected_revision: snapshot.state.revision,
      media_generation: snapshot.state.media_generation,
      type: "CHANGE_MEDIA",
      payload: { media_id: media.id },
    };
    initSignal.throwIfAborted();
    control.send(command);
    const ack = await control.next((v) => v.command_id === command.command_id, {
      signal: initSignal,
    });
    assert.equal(ack.type, "ACK");
    assert.equal(ack.state.media_id, media.id);
    snapshot = { ...snapshot, state: ack.state };
    control.passive();
    await connectChurn(initSignal);
    initSignal.throwIfAborted();
  } catch (primary) {
    let cleanup;
    try {
      cleanup = await dispose();
    } catch (error) {
      const failure = preserveOwnedFailure(
        primary,
        [error],
        "Owned workload preparation failed",
      );
      failure.cleanup = error.cleanup;
      throw failure;
    }
    primary.cleanup = cleanup;
    throw primary;
  }
  return {
    schema_version: 1,
    id: "owned-native-rainsync-soak-v1",
    mode,
    run_id,
    owned_resource_ids: [...resource_ids],
    room_id: room.id,
    async perform(event, { signal: localSignal = signal } = {}) {
      assertCurrent(event);
      localSignal = combineSignals(signal, localSignal);
      localSignal.throwIfAborted();
      const gate = ownedSoakPreflight(
        {
          kinds: [event.kind],
          faults: event.kind === "fault" ? [event.fault] : [],
        },
        { presentation: Boolean(presentation) },
      );
      if (!gate.supported)
        unsupported(gate.missing[0].code, gate.missing[0].detail);
      let evidence;
      if (event.kind === "phase")
        evidence = await phaseAction(event, localSignal);
      else if (event.kind === "slice") evidence = await slice(localSignal);
      else if (["join", "leave"].includes(event.kind))
        evidence = await membership(event.kind, localSignal);
      else if (event.kind === "fault") evidence = await revoke(localSignal);
      else if (event.kind === "stop-stream")
        evidence = await revoke(localSignal, "stop");
      else if (event.kind === "loop-playback")
        evidence = await presentation.advance({ signal: localSignal });
      else if (event.kind === "seek")
        evidence = await presentation.seek({
          position_ms: 1000 + (event.ordinal % 3) * 1000,
          signal: localSignal,
        });
      try {
        localSignal.throwIfAborted();
      } catch (error) {
        if (event.kind === "phase") phase = undefined;
        throw error;
      }
      return {
        mode,
        run_id,
        owned_resource_ids: [...resource_ids],
        phase: structuredClone(phase),
        action: event.kind,
        completed: true,
        observation_id: randomUUID(),
        evidence,
      };
    },
    async checkStopStream({ signal: localSignal = signal } = {}) {
      localSignal = combineSignals(signal, localSignal);
      localSignal.throwIfAborted();
      const evidence = await revoke(localSignal, "stop");
      localSignal.throwIfAborted();
      return {
        mode,
        run_id,
        owned_resource_ids: [...resource_ids],
        phase: structuredClone(phase),
        action: "stop-stream",
        completed: true,
        observation_id: randomUUID(),
        evidence,
      };
    },
    async sampleResources(
      { phase: requestedPhase },
      { signal: localSignal = signal } = {},
    ) {
      localSignal = combineSignals(signal, localSignal);
      localSignal.throwIfAborted();
      assert.equal(disposed, false, "workload already disposed");
      assert.ok(phase && !transitioning, "completed stable phase required");
      assert.deepEqual(
        requestedPhase,
        phase,
        "resource phase must equal completed actual phase",
      );
      const capturedPhaseVersion = phaseVersion;
      assert.equal(
        mode,
        "real",
        "synthetic fixture cannot emit real proc observations",
      );
      const cache_bytes = await directoryBytes(
          resolve(f.root, "cache"),
          localSignal,
        ),
        cache_quota_bytes = Number(f.env.CACHE_MAX_BYTES);
      assert.ok(cache_quota_bytes > 0);
      const rows = await Promise.all(
        roots.map(async (root, index) => ({
          entity: resource_ids[index],
          instance_id: `${root.pid}:${root.start_ticks}`,
          phase: requestedPhase.id,
          observation_id: randomUUID(),
          ...(await processTree(root, localSignal)),
          cache_bytes,
          cache_quota_bytes,
          cache_accounting: "shared-owned-cache-not-additive",
          ...(index === 2
            ? {
                database_connections: Number(
                  f.sql(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()",
                  ),
                ),
                queued_jobs: Number(
                  f.sql(
                    "SELECT count(*) FROM media_jobs WHERE status='queued'",
                  ),
                ),
              }
            : {}),
        })),
      );
      localSignal.throwIfAborted();
      assert.ok(
        !transitioning && phaseVersion === capturedPhaseVersion,
        "phase changed during resource sample",
      );
      assert.deepEqual(requestedPhase, phase);
      return rows;
    },
    async nativeIdentity(
      input = {},
      { signal: actionSignal, diagnostic = input.diagnostic === true } = {},
    ) {
      const observedSignal = combineSignals(
        diagnostic ? undefined : signal,
        actionSignal,
      );
      assert.equal(disposed, false, "workload already disposed");
      observedSignal.throwIfAborted();
      const identity = {
        observation_id: randomUUID(),
        fixture_id: f.id,
        database: {
          name: db.database,
          port: db.port,
          data_directory: db.native.data_directory,
        },
        processes: await Promise.all(
          roots.map(async (root) => {
            const actual = await readProcessIdentity(root.pid, {
              signal: observedSignal,
            });
            assert.deepEqual(actual, root, "owned process identity changed");
            return {
              ...actual,
              binary_sha256: sha(await readFile(`/proc/${root.pid}/exe`)),
            };
          }),
        ),
        image_id: null,
      };
      observedSignal.throwIfAborted();
      return identity;
    },
    async artifactIdentity() {
      unsupported(
        "NATIVE_IMAGE_UNOBSERVABLE",
        "Native source/binary/PID identity is available via nativeIdentity(); a running container image cannot be observed. Formal scheduler remains blocked.",
      );
    },
    dispose,
  };
}

// A caller supplies already-owned real Playwright pages. No browser launch or
// fake DOM implementation belongs in real evidence. Unsupported HLS transport
// fails rather than inventing MediaSource capability results.
export function createOwnedPagePresentation({
  pageFactory,
  decodeTimecode,
  saveFrame,
}) {
  assert.equal(typeof pageFactory, "function");
  let driver,
    pages = [],
    identities = [],
    disposal,
    generation = 0;
  const pendingAllocations = new Set();
  const dispose = () =>
    (disposal ??= (async () => {
      generation++;
      const ownedPages = pages,
        ownedDriver = driver,
        ownedAllocations = [...pendingAllocations];
      pages = [];
      identities = [];
      driver = null;
      const result = await cleanupOwnedResources([
        ...(ownedDriver
          ? [{ resource: "browser-observer", run: () => ownedDriver.dispose() }]
          : []),
        ...ownedPages.map((page, index) => ({
          resource: `page-${index}`,
          run: () => page.close(),
        })),
        ...ownedAllocations.map((allocation, index) => ({
          resource: `pending-allocation-${index}`,
          run: async () => {
            const error = await allocation;
            if (error) throw error;
          },
        })),
      ]);
      if (!result.confirmed) {
        const error = preserveOwnedFailure(
          null,
          result.outcomes.filter((v) => !v.confirmed).map((v) => v.error),
          "Page cleanup unconfirmed",
        );
        error.cleanup = result;
        throw error;
      }
      return result;
    })());
  const sample = async () => {
    const value = await driver.sample();
    for (const row of value.clients)
      assert.ok(
        !row.unavailable &&
          row.evidence === "video-frame-callback" &&
          row.foreground,
        "presented frame unavailable",
      );
    return value.clients;
  };
  return {
    dispose,
    async open({ streams, signal }) {
      await dispose();
      disposal = null;
      const openingGeneration = ++generation;
      const assertOpening = () => {
        signal?.throwIfAborted();
        assert.equal(
          generation,
          openingGeneration,
          "presentation disposed during preparation",
        );
      };
      // Track acquisitions before calling an external factory. Disposal cannot
      // confirm an unresolved allocation, and a late result is never adopted.
      const acquire = async (resource, create, retain, close) => {
        let settled, cleanupError;
        const allocation = new Promise((done) => {
          settled = done;
        });
        pendingAllocations.add(allocation);
        try {
          const value = await create();
          try {
            assertOpening();
          } catch (primary) {
            const cleanup = await cleanupOwnedResources([
              { resource, run: () => close(value) },
            ]);
            if (!cleanup.confirmed) {
              cleanupError = preserveOwnedFailure(
                null,
                cleanup.outcomes
                  .filter((v) => !v.confirmed)
                  .map((v) => v.error),
                "Late presentation allocation cleanup unconfirmed",
              );
              cleanupError.cleanup = cleanup;
              throw preserveOwnedFailure(
                primary,
                [cleanupError],
                "Presentation acquisition failed",
              );
            }
            throw primary;
          }
          retain(value);
          return value;
        } finally {
          pendingAllocations.delete(allocation);
          settled(cleanupError);
        }
      };
      assert.ok(streams.length > 0);
      try {
        for (const stream of streams) {
          assertOpening();
          assert.equal(
            stream.delivery_mode,
            "direct",
            "supply a measured native-HLS/MSE page integration for transcoded presentation",
          );
          const page = await acquire(
            `late-page-${stream.client_id}`,
            () => pageFactory({ client_id: stream.client_id, signal }),
            (value) => pages.push(value),
            (value) => value.close(),
          );
          assertOpening();
          await page.setContent(
            '<video muted playsinline preload="auto" style="width:640px;height:360px"></video>',
          );
          assertOpening();
          await page.evaluate((url) => {
            document.querySelector("video").src = url;
          }, stream.source_url);
          assertOpening();
          identities.push({ ...stream, page });
        }
        assertOpening();
        await acquire(
          "late-browser-observer",
          () =>
            createBrowserMeasurementDriver({
              clients: identities,
              decodeTimecode,
              saveFrame,
            }),
          (value) => (driver = value),
          (value) => value.dispose(),
        );
        for (let i = 0; i < pages.length; i++) {
          assertOpening();
          await driver.setPlayIntent(identities[i].client_id, true);
          assertOpening();
          await pages[i].evaluate(() => document.querySelector("video").play());
        }
        await until(
          async () => {
            try {
              return (await sample()).every((r) => r.presented_frames > 0);
            } catch {
              return false;
            }
          },
          "initial actual presented frames",
          { signal },
        );
        assertOpening();
        await driver.timecodeChecks();
        assertOpening();
      } catch (primary) {
        try {
          await dispose();
        } catch (cleanup) {
          throw preserveOwnedFailure(
            primary,
            [cleanup],
            "Page preparation failed",
          );
        }
        throw primary;
      }
    },
    async advance({ signal }) {
      assert.ok(driver);
      signal?.throwIfAborted();
      const prior = await sample();
      for (const page of pages) {
        signal?.throwIfAborted();
        await page.evaluate(() => {
          const v = document.querySelector("video");
          v.loop = true;
          v.currentTime = 0;
          return v.play();
        });
      }
      // A loop resets original coordinates. Observe a new beginning frame
      // before measuring positive advancement; never subtract across the wrap.
      const before = await until(
        async () => {
          const rows = await sample();
          return rows.every(
            (r, i) =>
              r.presented_frames > prior[i].presented_frames &&
              r.original_position_ms >= identities[i].media_origin_ms &&
              r.original_position_ms <= identities[i].media_origin_ms + 500,
          )
            ? rows
            : null;
        },
        "presented loop restart",
        { signal },
      );
      const after = await until(
        async () => {
          const rows = await sample();
          return rows.every(
            (r, i) =>
              r.presented_frames > before[i].presented_frames &&
              r.original_position_ms > before[i].original_position_ms,
          )
            ? rows
            : null;
        },
        "presented advancement",
        { signal },
      );
      await driver.timecodeChecks();
      return {
        presented_frames: after.reduce(
          (n, r, i) => n + r.presented_frames - before[i].presented_frames,
          0,
        ),
        original_advanced_ms: Math.min(
          ...after.map(
            (r, i) => r.original_position_ms - before[i].original_position_ms,
          ),
        ),
        measurement: "requestVideoFrameCallback",
        client_ids: after.map((r) => r.client_id),
      };
    },
    async seek({ position_ms, signal }) {
      signal?.throwIfAborted();
      assert.ok(driver);
      const before = await sample();
      for (let i = 0; i < pages.length; i++) {
        signal?.throwIfAborted();
        const destination =
          (position_ms - identities[i].media_origin_ms) / 1000;
        assert.ok(destination >= 0);
        await pages[i].evaluate((value) => {
          const v = document.querySelector("video");
          if (value >= v.duration) throw Error("seek exceeds owned media");
          v.currentTime = value;
        }, destination);
      }
      const after = await until(
        async () => {
          const rows = await sample();
          return rows.every(
            (r, i) =>
              r.presented_frames > before[i].presented_frames &&
              Math.abs(r.original_position_ms - position_ms) <= 1000,
          )
            ? rows
            : null;
        },
        "presented seek destination",
        { signal },
      );
      await driver.timecodeChecks();
      return {
        requested_original_ms: position_ms,
        presented_original_ms: after[0].original_position_ms,
        presented_frames: after.reduce(
          (n, r, i) => n + r.presented_frames - before[i].presented_frames,
          0,
        ),
        clients: after.map((r) => ({
          client_id: r.client_id,
          presented_original_ms: r.original_position_ms,
        })),
      };
    },
  };
}

// The injectable fixture seam supports filesystem/in-memory lifecycle tests.
// Production createAdapter below always selects the real owned fixture in code.
export function createOwnedNativeSchedulerAdapter(config, { fixtureRunner }) {
  assert.equal(typeof fixtureRunner, "function");
  let workload,
    task,
    release,
    rejectLifetime,
    report,
    finished = false;
  const lifetimeController = new AbortController();
  const relays = [];
  const link = (source) => {
    if (!source) return () => {};
    const abort = () => {
      lifetimeController.abort(source.reason);
    };
    if (source.aborted) abort();
    else source.addEventListener("abort", abort, { once: true });
    const unlink = () => source.removeEventListener("abort", abort);
    relays.push(unlink);
    return unlink;
  };
  return {
    schema_version: 1,
    id: "owned-native-rainsync-soak-v1",
    mode: "real",
    async prepare({ run_id, schedule, lifetime_signal }, { signal } = {}) {
      assert.ok(!task, "adapter already prepared");
      const preflight = ownedSoakPreflight({
        scope: config.scope,
        kinds: [
          ...new Set(
            schedule.events
              .map((event) => event.kind)
              .filter(
                (kind) =>
                  !["verify-identity", "sample-resources"].includes(kind),
              ),
          ),
        ],
        faults: schedule.faults,
      });
      if (!preflight.supported) {
        const error = new SoakPrerequisiteError(
          "OWNED_SOAK_PREFLIGHT",
          preflight.missing
            .map(
              (value) =>
                `${value.code}${value.fault ? `/${value.fault}` : ""}: ${value.detail ?? value.action}`,
            )
            .join("; "),
        );
        error.prerequisites = preflight.missing;
        throw error;
      }
      assert.ok(config.native_binding_path, "native_binding_path required");
      let ready, failed;
      const prepared = new Promise((done, fail) => {
        ready = done;
        failed = fail;
      });
      const lifetime = new Promise((done, fail) => {
        release = done;
        rejectLifetime = fail;
      });
      // Remains linked after boundedCall removes its preparation-only relay.
      link(lifetime_signal);
      const unlinkPrepare = link(signal);
      task = Promise.resolve()
        .then(() =>
          fixtureRunner(
            {
              binding_path: config.native_binding_path,
              signal: lifetimeController.signal,
              run_id,
            },
            async (adapter, initialReport) => {
              lifetimeController.signal.throwIfAborted();
              workload = adapter;
              const native_identity =
                initialReport?.initial_identity ??
                (await adapter.nativeIdentity());
              lifetimeController.signal.throwIfAborted();
              unlinkPrepare();
              ready({
                owned_resource_ids: [...adapter.owned_resource_ids],
                native_identity,
                host_mutations: false,
                isolated_fault_targets: true,
              });
              await lifetime;
            },
          ),
        )
        .then(
          (value) => {
            report = value;
            finished = true;
          },
          (error) => {
            report = error.report ?? report;
            finished = true;
            failed(error);
            throw error;
          },
        )
        .finally(() => {
          for (const unlink of relays) unlink();
        });
      // A timeout may settle the caller before fixture disposal. The task stays
      // owned and cleanup must await it; a late prepare cannot be adopted.
      task.catch(() => {});
      lifetime.catch(() => {});
      return prepared;
    },
    async perform(event, options) {
      assert.ok(workload, "native workload not prepared");
      return workload.perform(event, options);
    },
    async nativeIdentity(input, options) {
      assert.ok(workload, "native workload not prepared");
      return workload.nativeIdentity(input, options);
    },
    async artifactIdentity() {
      unsupported(
        "NATIVE_IMAGE_UNOBSERVABLE",
        "This adapter observes native processes, not a running final-candidate image; use the explicitly non-formal qualification entry.",
      );
    },
    async sampleResources(input, options) {
      assert.ok(workload, "native workload not prepared");
      return workload.sampleResources(input, options);
    },
    async collectArtifacts() {
      return {
        scope: "owned-native-bounded-workload",
        completed: finished,
        report_path: report?.report_path ?? null,
        report: report ?? null,
        remaining_gates: [
          "image-identity",
          "presented-timecode-frames",
          "72h",
          "full-capacity-matrix",
          "phase-matched-resource-trends",
          "cache-eviction",
          "F1",
          "F2",
          "F3",
          "F4",
        ],
      };
    },
    async cleanup({ failure } = {}) {
      if (failure) rejectLifetime?.(failure);
      else release?.();
      if (task) await task;
      return { confirmed: task ? report?.cleanup?.confirmed === true : true };
    },
  };
}

// The standard/formal schedule fails native preflight before starting a fixture.
export async function createAdapter(config) {
  return createOwnedNativeSchedulerAdapter(config, {
    fixtureRunner: async (input, run) => {
      const { withOwnedNativeSoak } =
        await import("../tests/fixtures/owned-native-soak.mjs");
      return withOwnedNativeSoak(input, run);
    },
  });
}
