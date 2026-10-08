import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  cleanupOwnedResources,
  ownedSoakPreflight,
  localDeliveryUrl,
  segmentUrls,
  readProcessIdentity,
  createOwnedPagePresentation,
  createOwnedSoakWorkload,
} from "../scripts/acceptance-owned-soak.mjs";
const origin = "http://127.0.0.1:12345",
  id = randomUUID(),
  playlist = `${origin}/media-delivery/${id}/hls/index.m3u8?token=secret`;
test("native preflight preserves every unmet formal prerequisite", () => {
  const result = ownedSoakPreflight({
    scope: "formal",
    kinds: [
      "phase",
      "loop-playback",
      "slice",
      "seek",
      "join",
      "leave",
      "cache-evict",
      "fault",
    ],
    faults: ["F1", "F2", "F3", "F4"],
  });
  assert.equal(result.supported, false);
  assert.equal(result.accepted, false);
  assert.equal(result.release_ready, false);
  assert.deepEqual(
    result.missing.map((v) => v.code),
    [
      "NATIVE_IMAGE_UNOBSERVABLE",
      "PRESENTATION_REQUIRED",
      "PRESENTATION_REQUIRED",
      "CACHE_EVICTION_UNSUPPORTED",
      "FAULT_UNSUPPORTED",
      "FAULT_UNSUPPORTED",
      "FAULT_UNSUPPORTED",
    ],
  );
});
test("bounded native subset and explicitly supplied presentation have separate gates", () => {
  assert.equal(
    ownedSoakPreflight({
      kinds: ["phase", "slice", "join", "leave", "fault"],
      faults: ["F4"],
    }).supported,
    true,
  );
  assert.equal(
    ownedSoakPreflight(
      { kinds: ["loop-playback", "seek"] },
      { presentation: true },
    ).supported,
    true,
  );
  assert.equal(
    ownedSoakPreflight({ scope: "formal" }, { presentation: true }).supported,
    false,
  );
  assert.equal(
    ownedSoakPreflight({ kinds: ["invented"] }).missing[0].code,
    "UNKNOWN_ACTION",
  );
});
test("delivery URLs retain private signed parameters only in memory", () => {
  const value = localDeliveryUrl(
    `/media-delivery/${id}/source?token=private`,
    origin,
  );
  assert.equal(new URL(value).search, "?token=private");
});
test("unowned delivery destinations and credentials fail before fetch", () => {
  for (const value of [
    "https://example.com/x",
    `http://localhost:12345/media-delivery/${id}/source`,
    `http://127.0.0.1:12346/media-delivery/${id}/source`,
    `http://user:pass@127.0.0.1:12345/media-delivery/${id}/source`,
    `/api/v1/users`,
    `/media-delivery/${id}/source#fragment`,
  ])
    assert.throws(() => localDeliveryUrl(value, origin));
  assert.throws(() =>
    localDeliveryUrl(`/media-delivery/${id}/source`, "http://example.com"),
  );
});
test("HLS parser checks init and media bytes but prohibits output escape", () => {
  const values = segmentUrls(
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4?token=s"\n#EXTINF:2,\nindex0.m4s?token=s\n',
    playlist,
    origin,
  );
  assert.equal(values.length, 2);
  assert.ok(
    values.every((v) =>
      new URL(v).pathname.startsWith(`/media-delivery/${id}/hls/`),
    ),
  );
  for (const value of [
    "https://example.com/payload",
    `/media-delivery/${randomUUID()}/hls/segment.m4s`,
    "../source",
  ])
    assert.throws(() =>
      segmentUrls(`#EXTM3U\n#EXTINF:2,\n${value}\n`, playlist, origin),
    );
});
test("empty, malformed and unbounded HLS lists are rejected", () => {
  for (const value of [
    "not-hls",
    "#EXTM3U\n",
    "#EXTM3U\n#EXT-X-MAP:broken\n",
    "#EXTM3U\n#EXTINF:2,\n" + "a.m4s\n".repeat(257),
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia.m3u8",
  ])
    assert.throws(() => segmentUrls(value, playlist, origin));
});
test("Linux process identity is observed and PID input is bounded", async () => {
  const a = await readProcessIdentity(process.pid),
    b = await readProcessIdentity(process.pid);
  assert.deepEqual(a, b);
  assert.equal(a.pid, process.pid);
  assert.ok(a.exe && a.start_ticks);
  for (const value of [0, 1, -1, 1.5, "123", NaN])
    await assert.rejects(readProcessIdentity(value));
});
test("page integration never launches browsers and rejects unproved HLS before opening page", async () => {
  let calls = 0;
  const presentation = createOwnedPagePresentation({
    pageFactory: () => {
      calls++;
      throw Error("must not be called");
    },
  });
  await assert.rejects(
    presentation.open({ streams: [{ delivery_mode: "transcode" }] }),
    /native-HLS/,
  );
  assert.equal(calls, 0);
  await presentation.dispose();
  await assert.rejects(presentation.advance({}));
  await assert.rejects(presentation.seek({ position_ms: 1000 }));
});
test("partially created pages close when actual page preparation fails", async () => {
  let closed = 0;
  const presentation = createOwnedPagePresentation({
    pageFactory: async () => ({
      async setContent() {
        throw Error("page preparation failed");
      },
      async close() {
        closed++;
      },
    }),
  });
  await assert.rejects(
    presentation.open({
      streams: [{ delivery_mode: "direct", client_id: "owned" }],
    }),
    /page preparation failed/,
  );
  assert.equal(closed, 1);
  await presentation.dispose();
  assert.equal(closed, 1);
});
test("no arbitrary Docker, external origin or database target can reach workload setup", async () => {
  const f = { id: randomUUID(), databaseKind: "docker" };
  await assert.rejects(
    createOwnedSoakWorkload({
      fixture: f,
      media: { id: randomUUID() },
      mode: "synthetic",
    }),
    /Docker/,
  );
  f.databaseKind = "native";
  f.origin = "https://example.com";
  f.workerOrigin = origin;
  await assert.rejects(
    createOwnedSoakWorkload({
      fixture: f,
      media: { id: randomUUID() },
      mode: "synthetic",
    }),
  );
  f.origin = origin;
  f.postgresDiagnostics = () => ({
    fixture_id: randomUUID(),
    host: "127.0.0.1",
    kind: "native",
  });
  await assert.rejects(
    createOwnedSoakWorkload({
      fixture: f,
      media: { id: randomUUID() },
      mode: "synthetic",
    }),
  );
});

test("scheduler entry rejects missing gates before any fixture or binding access", async () => {
  const { createAdapter } =
    await import("../scripts/acceptance-owned-soak.mjs");
  const adapter = await createAdapter({
    scope: "formal",
    native_binding_path: "/must-not-be-opened",
  });
  await assert.rejects(
    adapter.prepare({
      run_id: randomUUID(),
      schedule: {
        events: [{ kind: "cache-evict" }],
        faults: ["F1", "F2", "F3", "F4"],
      },
    }),
    (error) =>
      error.code === "OWNED_SOAK_PREFLIGHT" &&
      error.prerequisites.some((p) => p.code === "NATIVE_IMAGE_UNOBSERVABLE"),
  );
  assert.deepEqual(await adapter.cleanup(), { confirmed: true });
  await assert.rejects(adapter.artifactIdentity(), {
    code: "NATIVE_IMAGE_UNOBSERVABLE",
  });
});

async function syntheticOwnedFixture() {
  const { WebSocketServer } = await import("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((done) => server.once("listening", done));
  const ownedOrigin = `http://127.0.0.1:${server.address().port}`,
    room = randomUUID(),
    media = randomUUID(),
    fixtureId = randomUUID(),
    epoch = randomUUID();
  let state = { revision: 0, media_generation: 0, media_id: null };
  server.on("connection", (ws) =>
    ws.on("message", (buffer) => {
      const value = JSON.parse(buffer);
      if (value.type === "JOIN")
        ws.send(
          JSON.stringify({
            type: "SNAPSHOT",
            state,
            control_epoch: { id: epoch },
            presence: { members: [{ user_id: "owner", connection_count: 1 }] },
          }),
        );
      else if (value.type === "CHANGE_MEDIA") {
        state = { revision: 1, media_generation: 1, media_id: media };
        ws.send(
          JSON.stringify({ type: "ACK", command_id: value.command_id, state }),
        );
      }
    }),
  );
  const accounts = new Map([["admin", randomUUID()]]),
    calls = [];
  let abortCreate = false,
    closedRoom = false,
    failCreate = false,
    failClose = false;
  const controller = new AbortController();
  const fixture = {
    id: fixtureId,
    origin: ownedOrigin,
    workerOrigin: ownedOrigin,
    databaseKind: "native",
    root: "/tmp/owned-synthetic-only",
    password: "synthetic-not-a-real-login",
    postgresDiagnostics: () => ({
      fixture_id: fixtureId,
      host: "127.0.0.1",
      kind: "native",
      database: "synthetic_owned_db",
      native: { data_directory: "/tmp/owned-synthetic-only/postgres" },
    }),
    sql: (query) => {
      assert.equal(query, "SELECT current_database()");
      return "synthetic_owned_db";
    },
    client() {
      return {
        cookie: "",
        csrf: "",
        username: "admin",
        async login() {
          return { id: accounts.get(this.username) };
        },
        async request(path, method = "GET", body) {
          return (await this.raw(path, { method, body })).json();
        },
        async raw(path, { method = "GET", body, signal } = {}) {
          signal?.throwIfAborted();
          calls.push({ path, method });
          let value = {};
          if (path === "/rooms" && method === "POST") value = { id: room };
          else if (path === "/users") {
            if (failCreate)
              return new Response(
                JSON.stringify({ error: { code: "SYNTHETIC_INIT_FAILURE" } }),
                { status: 503 },
              );
            accounts.set(body.username, randomUUID());
            if (abortCreate)
              controller.abort(Error("synthetic mid-operation cancellation"));
          } else if (path === "/auth/login") {
            this.username = body.username;
            value = { csrf: "synthetic" };
          } else if (path === "/auth/me")
            value = { id: accounts.get(this.username) };
          else if (path.endsWith("/invites"))
            value = { token: "synthetic-invite" };
          else if (path.endsWith("/lifecycle"))
            value = { lifecycle: closedRoom ? "closed" : "active", state };
          else if (path.endsWith("/close")) {
            if (failClose) throw Error("synthetic room cleanup failure");
            closedRoom = true;
          }
          return new Response(JSON.stringify(value), { status: 200 });
        },
      };
    },
  };
  return {
    fixture,
    media,
    accounts,
    calls,
    controller,
    server,
    setAbortCreate() {
      abortCreate = true;
    },
    setFailCreate() {
      failCreate = true;
    },
    setFailClose() {
      failClose = true;
    },
    roomClosed: () => closedRoom,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise((done) => server.close(done));
    },
  };
}

test("synthetic mid-user-create cancellation stops new API actions and tears down owned sockets", async () => {
  const owned = await syntheticOwnedFixture();
  const { fixture, media, accounts, calls, controller, server } = owned;
  let adapter;
  try {
    adapter = await createOwnedSoakWorkload({
      fixture,
      media: { id: media },
      mode: "synthetic",
    });
    const before = calls.length;
    owned.setAbortCreate();
    await assert.rejects(
      adapter.perform(
        {
          run_id: adapter.run_id,
          owned_resource_ids: adapter.owned_resource_ids,
          kind: "phase",
          phase: { id: "direct-1", mode: "direct", concurrency: 1 },
          ordinal: 0,
        },
        { signal: controller.signal },
      ),
      /synthetic mid-operation cancellation/,
    );
    assert.deepEqual(
      calls.slice(before),
      [{ path: "/users", method: "POST" }],
      "already-issued creation is retained but no login/invite/session action follows abort",
    );
    assert.equal(
      accounts.size,
      3,
      "acknowledge the already-created synthetic account until fixture disposal",
    );
    await adapter.dispose();
    assert.equal(owned.roomClosed(), true);
    // This fake fixture owns the entire simulated DB, just as the native helper
    // verifies destruction of its disposable cluster. No real fault evidence.
    accounts.clear();
    assert.equal(accounts.size, 0);
  } finally {
    await adapter?.dispose();
    for (const socket of server.clients) socket.terminate();
    await new Promise((done) => server.close(done));
  }
});

test("synthetic cancellation after page allocation closes it before any page mutation", async () => {
  const controller = new AbortController();
  let mutations = 0,
    closed = 0;
  const presentation = createOwnedPagePresentation({
    pageFactory: async () => {
      controller.abort(Error("synthetic allocation cancelled"));
      return {
        async setContent() {
          mutations++;
        },
        async close() {
          closed++;
        },
      };
    },
  });
  await assert.rejects(
    presentation.open({
      signal: controller.signal,
      streams: [{ client_id: "synthetic", delivery_mode: "direct" }],
    }),
    /synthetic allocation cancelled/,
  );
  assert.equal(mutations, 0);
  assert.equal(closed, 1);
});

test("synthetic disposal waits for a pending page factory and closes its late owned page", async () => {
  const controller = new AbortController(),
    primary = Error("synthetic pending allocation cancelled");
  let release,
    allocated,
    mutations = 0,
    closed = 0,
    disposalSettled = false;
  const started = new Promise((done) => (allocated = done));
  const presentation = createOwnedPagePresentation({
    pageFactory: () => {
      allocated();
      return new Promise((done) => (release = done));
    },
  });
  const opening = presentation.open({
    signal: controller.signal,
    streams: [{ client_id: "pending", delivery_mode: "direct" }],
  });
  opening.catch(() => {});
  await started;
  controller.abort(primary);
  const disposing = presentation.dispose();
  disposing.then(() => (disposalSettled = true));
  await new Promise((done) => setImmediate(done));
  assert.equal(
    disposalSettled,
    false,
    "pending allocation cannot confirm cleanup",
  );
  release({
    async setContent() {
      mutations++;
    },
    async close() {
      closed++;
    },
  });
  await assert.rejects(opening, (error) => error === primary);
  assert.equal((await disposing).confirmed, true);
  assert.equal(mutations, 0);
  assert.equal(closed, 1);
});

test("synthetic timed-out allocation remains unconfirmed and its eventual page closes independently", async () => {
  const controller = new AbortController(),
    primary = Error("synthetic late factory cancelled");
  let release,
    allocated,
    closed = 0,
    mutations = 0;
  const started = new Promise((done) => (allocated = done));
  const presentation = createOwnedPagePresentation({
    pageFactory: () => {
      allocated();
      return new Promise((done) => (release = done));
    },
  });
  const opening = presentation.open({
    signal: controller.signal,
    streams: [{ client_id: "late", delivery_mode: "direct" }],
  });
  opening.catch(() => {});
  await started;
  controller.abort(primary);
  let cleanupError;
  await assert.rejects(presentation.dispose(), (error) => {
    cleanupError = error;
    return error.cleanup?.confirmed === false;
  });
  release({
    async setContent() {
      mutations++;
    },
    async close() {
      closed++;
    },
  });
  await assert.rejects(
    opening,
    (error) =>
      error.cause === primary && error.secondary_errors.includes(cleanupError),
  );
  assert.equal(mutations, 0);
  assert.equal(closed, 1);
  await assert.rejects(
    presentation.dispose(),
    (error) => error === cleanupError,
  );
});

test("synthetic partial initialization closes the already-created room and control socket", async () => {
  const owned = await syntheticOwnedFixture();
  owned.setFailCreate();
  try {
    await assert.rejects(
      createOwnedSoakWorkload({
        fixture: owned.fixture,
        media: { id: owned.media },
        mode: "synthetic",
      }),
      (error) =>
        error.message.includes("SYNTHETIC_INIT_FAILURE") &&
        error.cleanup?.confirmed === true,
    );
    assert.equal(owned.roomClosed(), true);
    await new Promise((done) => setImmediate(done));
    assert.equal(owned.server.clients.size, 0);
  } finally {
    await owned.close();
  }
});

test("synthetic aborted lifetime cannot be replaced by an action signal and cleanup has its own signal", async () => {
  const owned = await syntheticOwnedFixture(),
    lifetime = new AbortController(),
    action = new AbortController();
  let adapter;
  try {
    adapter = await createOwnedSoakWorkload({
      fixture: owned.fixture,
      media: { id: owned.media },
      mode: "synthetic",
      signal: lifetime.signal,
    });
    lifetime.abort(Error("synthetic lifetime cancelled"));
    const event = {
      run_id: adapter.run_id,
      owned_resource_ids: adapter.owned_resource_ids,
      kind: "phase",
      phase: { id: "direct-1", mode: "direct", concurrency: 1 },
    };
    for (const run of [
      () => adapter.perform(event, { signal: action.signal }),
      () => adapter.checkStopStream({ signal: action.signal }),
      () =>
        adapter.sampleResources(
          { phase: event.phase },
          { signal: action.signal },
        ),
      () => adapter.nativeIdentity({}, { signal: action.signal }),
    ])
      await assert.rejects(run, /synthetic lifetime cancelled/);
    const cleanup = await adapter.dispose();
    assert.equal(cleanup.confirmed, true);
    assert.equal(owned.roomClosed(), true);
    assert.deepEqual(
      await adapter.dispose(),
      cleanup,
      "repeat disposal retains the measured result",
    );
  } finally {
    await owned.close();
  }
});

test("synthetic cleanup failures do not skip other resources or become successful on retry", async () => {
  const owned = await syntheticOwnedFixture();
  let adapter;
  try {
    adapter = await createOwnedSoakWorkload({
      fixture: owned.fixture,
      media: { id: owned.media },
      mode: "synthetic",
      presentation: {
        async dispose() {
          throw Error("synthetic presentation cleanup failure");
        },
      },
    });
    owned.setFailClose();
    let failure;
    try {
      await adapter.dispose();
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.equal(failure.cleanup.confirmed, false);
    assert.ok(
      failure.cleanup.outcomes
        .filter((v) => v.resource.startsWith("socket-"))
        .every((v) => v.confirmed),
    );
    assert.ok(
      failure.cleanup.outcomes.some(
        (v) => v.resource.startsWith("room-") && !v.confirmed,
      ),
    );
    await assert.rejects(adapter.dispose(), (error) => error === failure);
  } finally {
    await owned.close();
  }
});

test("synthetic page setup primary failure survives a close failure and every page is attempted", async () => {
  const closed = [];
  let allocated = 0;
  const presentation = createOwnedPagePresentation({
    pageFactory: async () => {
      const index = allocated++;
      return {
        async setContent() {
          if (index === 1) throw Error("synthetic primary page failure");
        },
        async evaluate() {},
        async close() {
          closed.push(index);
          if (index === 0) throw Error("synthetic close failure");
        },
      };
    },
  });
  await assert.rejects(
    presentation.open({
      streams: [
        { client_id: "a", delivery_mode: "direct" },
        { client_id: "b", delivery_mode: "direct" },
      ],
    }),
    (error) =>
      error.cause?.message === "synthetic primary page failure" &&
      error.secondary_errors?.length === 1,
  );
  assert.deepEqual(closed.sort(), [0, 1]);
  await assert.rejects(presentation.dispose(), /Page cleanup unconfirmed/);
});

test("synthetic failing report sink preserves primary and cleanup failures with truthful confirmation", async () => {
  const { finalizeOwnedNativeResult } =
    await import("./fixtures/owned-native-soak.mjs");
  const primary = Error("synthetic primary workload error"),
    cleanup = Error("synthetic cleanup error"),
    sink = Error("synthetic sink error");
  const result = { cleanup: { confirmed: false }, accepted: false };
  await assert.rejects(
    finalizeOwnedNativeResult(result, {
      primary,
      secondary: [cleanup],
      sink: async () => {
        throw sink;
      },
    }),
    (error) =>
      error.cause === primary &&
      error.errors.includes(cleanup) &&
      error.errors.includes(sink) &&
      error.report === result &&
      error.report.cleanup.confirmed === false &&
      error.report.result === "failed",
  );
  await assert.rejects(
    finalizeOwnedNativeResult(
      { cleanup: { confirmed: true } },
      {
        sink: async () => {
          throw sink;
        },
      },
    ),
    (error) => error.report.result === "failed",
  );
});

test("synthetic bounded cleanup attempts all resources and records timeout as unconfirmed", async () => {
  let attempted = false,
    cancelled = false;
  const result = await cleanupOwnedResources(
    [
      {
        resource: "failed",
        run: async () => {
          throw Error("synthetic cleanup failed");
        },
      },
      {
        resource: "deadline",
        run: (_, { signal }) =>
          new Promise((resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => {
                cancelled = true;
                reject(signal.reason);
              },
              { once: true },
            ),
          ),
      },
      {
        resource: "remaining",
        run: async () => {
          attempted = true;
          return "closed";
        },
      },
    ],
    { timeout_ms: 10 },
  );
  assert.equal(result.confirmed, false);
  assert.equal(attempted, true);
  assert.equal(cancelled, true);
  assert.deepEqual(
    result.outcomes.map((v) => v.confirmed),
    [false, false, true],
  );
});
