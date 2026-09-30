// Bounded source-account policy enforcement through real Server/Worker/PostgreSQL.
// "controlled" runs local protocol fault cases; "all", "jellyfin", or "emby"
// run the same checks using the existing pinned, disposable real-product fixture.
// Requires a frozen backend binding and an external artifact root. No builds,
// installations, existing databases or production accounts. The account-change
// race alone updates one owned source's encrypted configuration to exercise the
// existing revision trigger; policy/observation/session rows are never seeded.
import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WS from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { isolatedUpstreamReal } from "./fixtures/upstream-real.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const selection = process.argv[2] ?? "controlled";
assert.ok(["controlled", "all", "jellyfin", "emby"].includes(selection));
assert.ok(process.argv.length <= 3);
const bindingPath =
  process.env.W03_BACKEND_BINDING ??
  process.env.RAINSYNC_SOURCE_ACCESS_BINDING_FILE;
assert.ok(bindingPath, "a successful frozen backend binding is required");
assert.ok(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "an external artifact root is required",
);
const bindingBytes = await readFile(bindingPath);
const binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.equal(digest(JSON.stringify(binding.source)), binding.source_digest);
assert.equal(binding.binaries.length, 3);
assert.ok(
  binding.source.some(
    (entry) => entry.path === "migrations/0033_upstream_account_policy.sql",
  ),
);
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
for (const name of [
  "rainsync-server",
  "rainsync-media-worker",
  "rainsync-nas-agent",
])
  assert.equal(
    resolve(
      binding.binaries.find((entry) => entry.name === name)?.path ?? "missing",
    ),
    resolve(target, name + (process.platform === "win32" ? ".exe" : "")),
  );
const coordinator = await Promise.all(
  [
    "tests/upstream-policy-observation.mjs",
    "tests/fixtures/server.mjs",
    "tests/fixtures/media-stack.mjs",
    "tests/fixtures/postgres.mjs",
    "tests/fixtures/upstream-real.mjs",
    "tests/fixtures/browser-video.base64",
  ].map(async (path) => ({
    path,
    sha256: digest(await readFile(resolve(repo, path))),
  })),
);
async function verifyBinding() {
  assert.equal(digest(await readFile(bindingPath)), digest(bindingBytes));
  for (const input of [...binding.source, ...coordinator])
    assert.equal(
      digest(await readFile(resolve(repo, input.path))),
      input.sha256,
      `bound input unchanged: ${input.path}`,
    );
  for (const binary of binding.binaries)
    assert.equal(
      digest(await readFile(binary.path)),
      binary.sha256,
      `bound binary unchanged: ${binary.name}`,
    );
}
await verifyBinding();
const runId = randomUUID();
const root = resolve(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "upstream-policy-observation",
  runId,
);
await mkdir(root, { recursive: true });
const reportPath = resolve(root, "report.json");
const report = {
  schema_version: 1,
  run_id: runId,
  started_at: new Date().toISOString(),
  result: "running",
  scope:
    "RainSync source-bound upstream account policy admission, renewal and physical Worker delivery fencing. Controlled fault injection is explicitly labeled; real product cases use immutable disposable images. No browser, decode, production account or raw upstream-policy correctness claim.",
  selection,
  backend_binding: {
    path: resolve(bindingPath),
    sha256: digest(bindingBytes),
    source_digest: binding.source_digest,
    binaries: binding.binaries,
  },
  coordinator,
  products: [],
  failures: [],
};
const save = () =>
  writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(40);
  }
  throw Error(`Deadline: ${label}`);
}
function gate() {
  let release;
  const promise = new Promise((done) => {
    release = done;
  });
  return { promise, release };
}
async function listen(handler) {
  const server = createServer(handler);
  await new Promise((done, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", done),
  );
  const port = server.address().port;
  return {
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      const closed = new Promise((done) => server.close(done));
      server.closeAllConnections();
      await closed;
      assert.equal(await verifyClosedPort(port), true);
    },
  };
}

// The real fixture's credentials remain in closures. This adapter changes only
// the requested source destination to our owned loopback proxy, before creation.
async function policyProxy(upstream) {
  const modes = new Map(),
    tokens = new Map(),
    stalls = new Map(),
    configurations = new Map(),
    playbackHolds = new Map(),
    metadataHolds = new Map();
  const events = [],
    transfers = [],
    negotiations = [],
    metadataReads = [],
    sessionReports = [],
    held = new Set(),
    failures = [];
  const prefix = new URL(upstream.base).pathname.replace(/\/$/, "");
  const listener = await listen(async (incoming, outgoing) => {
    const path = new URL(incoming.url, upstream.origin);
    const relative = path.pathname.slice(prefix.length);
    const account = /^\/Users\/([^/]+)$/.exec(relative)?.[1];
    const authorization =
      incoming.headers.authorization ??
      incoming.headers["x-emby-authorization"] ??
      "";
    const token =
      incoming.headers["x-emby-token"] ??
      /Token="([^"]+)"/.exec(authorization)?.[1];
    const owner = tokens.get(token);
    const policy = incoming.method === "GET" && account !== undefined;
    const mode = policy ? (modes.get(account) ?? { name: "pass" }) : null;
    const event = policy
      ? {
          user_id: account,
          mode: mode.name,
          requested_at_ms: Date.now(),
          closed_at_ms: null,
        }
      : null;
    if (event) {
      events.push(event);
      outgoing.once("close", () => {
        event.closed_at_ms = Date.now();
      });
    }
    try {
      assert.equal(
        path.origin,
        upstream.origin,
        "proxy only contacts its owned product",
      );
      assert.ok(path.pathname.startsWith(prefix + "/"));
      if (policy && mode.name === "hang") {
        const pending = gate();
        held.add(pending);
        outgoing.once("close", () => pending.release());
        await pending.promise;
        held.delete(pending);
        if (!outgoing.destroyed) outgoing.destroy();
        return;
      }
      let bytes, status, headers;
      if (policy && mode.name === "status") {
        bytes = Buffer.from("{}");
        status = mode.status;
        headers = { "content-type": "application/json" };
      } else if (policy && mode.name === "malformed") {
        bytes = Buffer.from(mode.body);
        status = 200;
        headers = { "content-type": "application/json" };
      } else {
        const requestBody = [];
        for await (const chunk of incoming) requestBody.push(chunk);
        const forwardedHeaders = {
          ...incoming.headers,
          "accept-encoding": "identity",
        };
        delete forwardedHeaders.host;
        delete forwardedHeaders.connection;
        delete forwardedHeaders["content-length"];
        const body = Buffer.concat(requestBody);
        const response = await fetch(path, {
          method: incoming.method,
          headers: forwardedHeaders,
          body: body.length ? body : undefined,
          redirect: "manual",
          signal: AbortSignal.timeout(20000),
        });
        status = response.status;
        headers = Object.fromEntries(response.headers);
        delete headers["transfer-encoding"];
        delete headers.connection;
        delete headers["content-encoding"];
        const shouldStall =
          relative.startsWith("/Videos/") &&
          /\/stream\.mp4$/.test(relative) &&
          stalls.get(owner);
        if (shouldStall && status === 200) {
          stalls.delete(owner);
          const size = Number(response.headers.get("content-length"));
          assert.ok(
            size > 1024,
            "real media has enough bytes for sniffing then a stall",
          );
          const reader = response.body.getReader();
          const transfer = {
            user_id: owner,
            status,
            opened_at_ms: Date.now(),
            closed_at_ms: null,
            product_body_cancelled_at_ms: null,
            available_bytes: size,
            delivered_bytes: 0,
          };
          transfers.push(transfer);
          outgoing.once("close", () => {
            transfer.closed_at_ms = Date.now();
            reader
              .cancel()
              .then(() => {
                transfer.product_body_cancelled_at_ms = Date.now();
              })
              .catch(() => {});
          });
          outgoing.writeHead(status, headers);
          while (transfer.delivered_bytes < 1024) {
            const chunk = await reader.read();
            assert.equal(
              chunk.done,
              false,
              "owned media has its expected prefix",
            );
            const part = chunk.value.subarray(
              0,
              1024 - transfer.delivered_bytes,
            );
            transfer.delivered_bytes += part.length;
            outgoing.write(part);
          }
          // Keep the actual product body open and unread. There is deliberately
          // no timer/next chunk: Worker cancellation must progress independently
          // of both source data arrival and downstream consumer polling.
          return;
        }
        bytes = Buffer.from(await response.arrayBuffer());
        assert.ok(
          bytes.length <= 32 * 1024 * 1024,
          "owned fixture response is bounded",
        );
        if (
          incoming.method === "POST" &&
          /\/Items\/[^/]+\/PlaybackInfo$/.test(relative)
        ) {
          const value = JSON.parse(bytes);
          const negotiation = {
            user_id: owner,
            status,
            play_session_id: value.PlaySessionId ?? null,
            product_response_at_ms: Date.now(),
            forwarded_at_ms: null,
          };
          negotiations.push(negotiation);
          const hold = playbackHolds.get(owner);
          if (hold) {
            playbackHolds.delete(owner);
            hold.event = negotiation;
            held.add(hold.gate);
            await hold.gate.promise;
            held.delete(hold.gate);
          }
          negotiation.forwarded_at_ms = Date.now();
        }
        if (
          incoming.method === "GET" &&
          /^\/Users\/[^/]+\/Items\/[^/]+$/.test(relative)
        ) {
          const event = {
            user_id: owner,
            status,
            product_response_at_ms: Date.now(),
            forwarded_at_ms: null,
          };
          metadataReads.push(event);
          const hold = metadataHolds.get(owner);
          if (hold) {
            metadataHolds.delete(owner);
            hold.event = event;
            held.add(hold.gate);
            await hold.gate.promise;
            held.delete(hold.gate);
          }
          event.forwarded_at_ms = Date.now();
        }
        if (
          incoming.method === "POST" &&
          relative.startsWith("/Sessions/Playing")
        ) {
          const value = body.length ? JSON.parse(body) : {};
          sessionReports.push({
            user_id: owner,
            path: relative,
            play_session_id: value.PlaySessionId ?? null,
            status,
            at_ms: Date.now(),
          });
        }
        if (policy && mode.name === "hold") {
          mode.event = event;
          const pending = mode.gate;
          held.add(pending);
          await pending.promise;
          held.delete(pending);
        }
      }
      if (event) {
        event.status = status;
        event.responded_at_ms = Date.now();
        try {
          const value = JSON.parse(bytes);
          event.id_matches = value.Id === account;
          event.is_disabled = value.Policy?.IsDisabled;
          event.enable_media_playback = value.Policy?.EnableMediaPlayback;
        } catch {
          event.valid_json = false;
        }
      }
      if (outgoing.destroyed) return;
      if (status !== 204) headers["content-length"] = bytes.length;
      outgoing.writeHead(status, headers);
      outgoing.end(bytes);
    } catch (error) {
      failures.push(error.message);
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    }
  });
  return {
    ...listener,
    base: listener.origin + prefix,
    events,
    transfers,
    negotiations,
    metadataReads,
    sessionReports,
    failures,
    mode(userId, value) {
      modes.set(userId, value);
    },
    stall(userId) {
      stalls.set(userId, true);
    },
    holdPlayback(userId, hold) {
      playbackHolds.set(userId, hold);
    },
    holdMetadata(userId, hold) {
      metadataHolds.set(userId, hold);
    },
    async source(client, upstreamClient, label) {
      return upstream.addRainSyncSource(
        {
          request(path, method, body) {
            assert.equal(path, "/sources");
            assert.equal(method, "POST");
            tokens.set(body.config.token, body.config.user_id);
            const payload = {
              ...body,
              name: `policy-${label}-${randomUUID()}`,
              config: {
                ...body.config,
                url: listener.origin + prefix,
                access_policy: {
                  schema_version: 1,
                  origins: [
                    { origin: listener.origin, cidrs: ["127.0.0.1/32"] },
                  ],
                },
              },
            };
            return client.request(path, method, payload).then((created) => {
              configurations.set(created.id, payload.config);
              return created;
            });
          },
        },
        upstreamClient,
      );
    },
    async replaceAccount(fixture, sourceId, upstreamClient) {
      const config = await upstream.addRainSyncSource(
        {
          request(path, method, body) {
            assert.equal(path, "/sources");
            assert.equal(method, "POST");
            tokens.set(body.config.token, body.config.user_id);
            return {
              ...body.config,
              url: listener.origin + prefix,
              access_policy: configurations.get(sourceId).access_policy,
            };
          },
        },
        upstreamClient,
      );
      const nonce = randomBytes(12);
      const cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from(fixture.env.SOURCE_ENCRYPTION_KEY, "base64"),
        nonce,
      );
      const encrypted = Buffer.concat([
        nonce,
        cipher.update(JSON.stringify(config)),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64");
      fixture.sql(
        `UPDATE sources SET config_encrypted=${quote(encrypted)} WHERE id=${quote(sourceId)}`,
      );
      configurations.set(sourceId, config);
    },
    async close() {
      for (const pending of held) pending.release();
      await listener.close();
    },
  };
}

async function controlledUpstream(kind, run) {
  const users = new Map(),
    tokens = new Map();
  const sample = Buffer.from(
    await readFile(
      resolve(repo, "tests/fixtures/browser-video.base64"),
      "utf8",
    ),
    "base64",
  );
  const prefix = kind === "emby" ? "/emby" : "";
  const listener = await listen(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname.slice(
      prefix.length,
    );
    const auth =
      request.headers.authorization ??
      request.headers["x-emby-authorization"] ??
      "";
    const token =
      request.headers["x-emby-token"] ?? /Token="([^"]+)"/.exec(auth)?.[1];
    const userId = tokens.get(token);
    if (!userId) {
      response.writeHead(401).end();
      return;
    }
    const json = (body) =>
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(body));
    const user = /^\/Users\/([^/]+)$/.exec(path)?.[1];
    if (user) return json({ Id: user, Policy: users.get(user) });
    if (/^\/Users\/[^/]+\/Items$/.test(path))
      return json({
        TotalRecordCount: 1,
        Items: [
          {
            Id: "fixture-h264",
            Name: "rainsync-h264",
            RunTimeTicks: 200000000,
          },
        ],
      });
    if (/^\/Users\/[^/]+\/Items\/fixture-h264$/.test(path))
      return json({
        Id: "fixture-h264",
        MediaSources: [
          {
            Id: "fixture-media",
            MediaStreams: [{ Type: "Audio", Index: 1, Codec: "aac" }],
          },
        ],
      });
    if (path === "/Items/fixture-h264/PlaybackInfo")
      return json({
        PlaySessionId: randomUUID(),
        MediaSources: [
          {
            Id: "fixture-media",
            SupportsDirectPlay: true,
            RunTimeTicks: 200000000,
            MediaStreams: [],
          },
        ],
      });
    if (path === "/Videos/fixture-h264/stream.mp4")
      return response
        .writeHead(200, {
          "content-type": "video/mp4",
          "content-length": sample.length,
        })
        .end(sample);
    if (
      path.startsWith("/Sessions/Playing") ||
      path === "/Videos/ActiveEncodings"
    )
      return response.writeHead(204).end();
    response.writeHead(404).end();
  });
  const base = listener.origin + prefix;
  const upstream = {
    kind,
    origin: listener.origin,
    base,
    metadata: {
      kind,
      scope:
        "Controlled product protocol; not a real product compatibility claim",
    },
    async client() {
      const userId = randomUUID(),
        token = randomBytes(24).toString("hex");
      users.set(userId, { IsDisabled: false, EnableMediaPlayback: true });
      tokens.set(token, userId);
      return {
        userId,
        token,
        raw: (path) =>
          fetch(base + path, {
            headers: { "X-Emby-Token": token },
            signal: AbortSignal.timeout(5000),
          }),
      };
    },
    async setPolicy(client, changes) {
      Object.assign(users.get(client.userId), changes);
      return { ...users.get(client.userId) };
    },
    async addRainSyncSource(client, upstreamClient) {
      return client.request("/sources", "POST", {
        name: "controlled",
        kind,
        config: {
          url: base,
          token: upstreamClient.token,
          user_id: upstreamClient.userId,
        },
      });
    },
    item: {
      Id: "fixture-h264",
      MediaSources: [
        {
          Id: "fixture-media",
          MediaStreams: [{ Type: "Audio", Index: 1, Codec: "aac" }],
        },
      ],
    },
  };
  try {
    await run(upstream);
  } finally {
    await listener.close();
  }
}

class Controller {
  constructor(fixture, client) {
    this.fixture = fixture;
    this.client = client;
    this.inbox = [];
  }
  async message(check) {
    return until(() => {
      const index = this.inbox.findIndex(check);
      return index < 0 ? null : this.inbox.splice(index, 1)[0];
    }, "room WebSocket response");
  }
  async join(room, media) {
    this.room = room;
    this.socket = new WS(
      this.fixture.origin.replace("http", "ws") + "/api/v1/ws",
      { headers: { Origin: this.fixture.origin, Cookie: this.client.cookie } },
    );
    this.socket.on("message", (bytes) => this.inbox.push(JSON.parse(bytes)));
    await new Promise((done, reject) => {
      this.socket.once("open", done);
      this.socket.once("error", reject);
    });
    this.socket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
    const snapshot = await this.message((entry) => entry.type === "SNAPSHOT");
    const command = randomUUID();
    this.socket.send(
      JSON.stringify({
        protocol_version: 1,
        room_id: room.id,
        control_epoch: snapshot.control_epoch.id,
        command_id: command,
        expected_revision: snapshot.state.revision,
        media_generation: snapshot.state.media_generation,
        type: "CHANGE_MEDIA",
        payload: { media_id: media },
      }),
    );
    const answer = await this.message((entry) => entry.command_id === command);
    assert.equal(answer.type, "ACK");
    this.state = answer.state;
  }
  async close() {
    if (!this.socket || this.socket.readyState === WS.CLOSED) return;
    const closed = new Promise((done) => this.socket.once("close", done));
    this.socket.terminate();
    await closed;
  }
}

async function runMatrix(upstream, product) {
  const proxy = await policyProxy(upstream);
  const controllers = [],
    consumers = new Set();
  let fixture;
  const subjectClient = await upstream.client({
    restricted: true,
    deviceId: `policy-subject-${runId}`,
  });
  const controlClient = await upstream.client({
    restricted: true,
    deviceId: `policy-control-${runId}`,
  });
  const setPolicy = async (changes) => {
    if (upstream.setPolicy) return upstream.setPolicy(subjectClient, changes);
    const path = `/Users/${encodeURIComponent(subjectClient.userId)}`;
    const before = await upstream.admin.api(path);
    await upstream.admin.api(path + "/Policy", "POST", {
      ...before.Policy,
      ...changes,
    });
    const after = await upstream.admin.api(path);
    for (const [key, value] of Object.entries(changes))
      assert.equal(after.Policy[key], value, `real upstream ${key} readback`);
    return {
      IsDisabled: after.Policy.IsDisabled,
      EnableMediaPlayback: after.Policy.EnableMediaPlayback,
    };
  };
  async function scenario(name, run) {
    const record = {
      name,
      result: "running",
      started_at: new Date().toISOString(),
    };
    product.cases.push(record);
    await save();
    try {
      await run(record);
      record.result = "passed";
      console.log(`PASS ${product.kind} ${name}`);
    } catch (error) {
      record.result = "failed";
      record.error = error.message;
      throw error;
    } finally {
      record.finished_at = new Date().toISOString();
      await save();
    }
  }
  try {
    await isolatedMediaStack(
      "upstream-policy-observation",
      async (f) => {
        fixture = f;
        product.fixture = {
          id: f.id,
          root: f.root,
          database: f.postgresDiagnostics(),
        };
        const databaseUrl = new URL(f.env.DATABASE_URL);
        const workerApplication = `policy-observation-${f.id}`;
        databaseUrl.searchParams.set("application_name", workerApplication);
        await f.startWorker({ DATABASE_URL: databaseUrl.toString() });
        const admin = f.client();
        await admin.login();
        async function setup(client, label) {
          const source = await proxy.source(admin, client, label);
          await admin.request(`/sources/${source.id}/test`, "POST");
          const media = f.sql(
            `SELECT id FROM media_items WHERE source_id=${quote(source.id)} AND title='rainsync-h264'`,
          );
          assert.match(media, /^[0-9a-f-]{36}$/);
          const room = await admin.request("/rooms", "POST", { name: label });
          const controller = new Controller(f, admin);
          controllers.push(controller);
          await controller.join(room, media);
          return { source, room, controller, client };
        }
        const subject = await setup(subjectClient, "subject");
        const control = await setup(controlClient, "independent-account");
        const prepare = async (current, extra = {}) => {
          const response = await admin.raw("/playback-sessions", {
            method: "POST",
            body: {
              room_id: current.room.id,
              media_generation: current.controller.state.media_generation,
              viewer_id: randomUUID(),
              plan_generation: 1,
              idempotency_key: randomUUID(),
              mode: "direct",
              position_ms: 0,
              ...extra,
            },
          });
          return { status: response.status, body: await response.json() };
        };
        const stop = (plan) =>
          admin.request(`/playback-sessions/${plan.session_id}`, "DELETE");
        const ready = async (plan) => {
          const response = await admin.raw(
            `/playback-sessions/${plan.session_id}`,
          );
          return { status: response.status, body: await response.json() };
        };
        const renew = async (plan) => {
          const response = await admin.raw(
            `/playback-sessions/${plan.session_id}`,
            { method: "POST" },
          );
          return { status: response.status, body: await response.json() };
        };
        const delivery = (plan) =>
          new URL(plan.playback_url, f.workerOrigin).href;
        const policyRow = (source = subject.source) =>
          JSON.parse(
            f.sql(
              `SELECT jsonb_build_object('source_revision',source_revision,'generation',generation,'state',state,'reason',reason,'observation_seq',observation_seq,'claim',claim,'observed_at_ms',extract(epoch FROM observed_at)*1000,'valid_until_ms',extract(epoch FROM valid_until)*1000,'remaining_ms',extract(epoch FROM valid_until-clock_timestamp())*1000) FROM source_account_policies WHERE source_id=${quote(source.id)}`,
            ),
          );
        const expectDenied = (answer) => {
          assert.ok(
            [401, 403, 409, 410, 502, 503].includes(answer.status),
            `bounded policy denial; status=${answer.status}`,
          );
          assert.equal(answer.body.playback_url, undefined);
          assert.equal(answer.body.session_id, undefined);
          assert.ok(
            answer.body.error?.code,
            "denied API response has an error code",
          );
        };
        const nextPlan = async (current = subject) => {
          const response = await until(async () => {
            const result = await prepare(current);
            if (result.status === 200) return result;
            expectDenied(result);
            return null;
          }, "fresh permitted plan after policy recovery");
          assert.equal(response.body.delivery_mode, "direct");
          const observed = policyRow(current.source);
          assert.equal(observed.state, "allowed");
          assert.ok(
            observed.remaining_ms > 0 && observed.remaining_ms <= 5000,
            "positive cache remaining lifetime is bounded to 5 seconds",
          );
          assert.ok(
            observed.valid_until_ms - observed.observed_at_ms <= 5000,
            "positive cache lifetime includes upstream response time",
          );
          return response.body;
        };
        const bytes = async (plan, expected = 200) => {
          const response = await fetch(delivery(plan), {
            signal: AbortSignal.timeout(6000),
          });
          assert.equal(response.status, expected, "Worker delivery status");
          const data = await response.arrayBuffer();
          if (expected === 200) assert.ok(data.byteLength > 1024);
          return { status: response.status, bytes: data.byteLength };
        };
        let controlPlan = await nextPlan(control);
        async function pausedTransfer(plan, userId = subjectClient.userId) {
          proxy.stall(userId);
          const state = {
            response: null,
            aborted: false,
            ended: false,
            bytes: 0,
          };
          const req = httpRequest(delivery(plan), (res) => {
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
          req.on("error", () => {});
          consumers.add(req);
          req.on("close", () => consumers.delete(req));
          req.end();
          await until(() => state.response, "stalled delivery headers");
          assert.equal(state.response.statusCode, 200);
          const transfer = proxy.transfers.at(-1);
          assert.ok(transfer && !transfer.closed_at_ms);
          return { state, req, transfer };
        }
        async function assertControl(record) {
          assert.equal((await ready(controlPlan)).status, 200);
          assert.equal((await renew(controlPlan)).status, 200);
          record.unrelated_source = await bytes(controlPlan);
          assert.equal(
            f.sql(
              `SELECT stopped FROM playback_sessions WHERE id=${quote(controlPlan.session_id)}`,
            ),
            "f",
          );
        }

        await scenario(
          "concurrent first prepares share one source-account policy observation",
          async (record) => {
            const client = await upstream.client({
              restricted: true,
              deviceId: `policy-concurrent-${runId}`,
            });
            const current = await setup(client, "concurrent-first-admission");
            const hold = { name: "hold", gate: gate() };
            proxy.mode(client.userId, hold);
            const requests = Array.from({ length: 8 }, () => prepare(current));
            const results = Promise.all(requests);
            // Attach a rejection handler before awaiting the policy event so every
            // concurrent HTTP request is owned even if an assertion fails early.
            results.catch(() => {});
            try {
              await until(
                () => hold.event,
                "one policy observation receives concurrent demand",
              );
              await delay(250);
              const pending = proxy.events.filter(
                (event) => event.user_id === client.userId,
              );
              assert.equal(
                pending.length,
                1,
                "eight initial prepares must not cause eight policy GETs",
              );
              record.concurrent_prepares = 8;
              record.policy_gets_before_release = pending.length;
              proxy.mode(client.userId, { name: "pass" });
              hold.gate.release();
              const responses = await results;
              for (const response of responses) {
                assert.equal(response.status, 200);
                await stop(response.body);
              }
              record.successful_admissions = responses.length;
              await assertControl(record);
            } finally {
              hold.gate.release();
              await Promise.allSettled(requests);
            }
          },
        );

        await scenario(
          "unknown account policy fails closed before first successful observation",
          async (record) => {
            // New source identity prevents a previous successful source observation
            // from lending authority while this source's account GET is unavailable.
            proxy.mode(subjectClient.userId, { name: "status", status: 401 });
            const unknown = await setup(subjectClient, "initial-unknown");
            const response = await prepare(unknown);
            expectDenied(response);
            assert.equal(response.status, 503);
            assert.equal(
              response.body.error.code.toLowerCase(),
              "upstream_policy_unavailable",
            );
            record.response = response;
            await assertControl(record);
            proxy.mode(subjectClient.userId, { name: "pass" });
          },
        );

        await scenario(
          "real policy denial stops a paused consumer and stalled source independently of upstream media status",
          async (record) => {
            const plan = await nextPlan();
            await bytes(plan);
            const { state, req, transfer } = await pausedTransfer(plan);
            const began = Date.now();
            record.policy = await setPolicy({ EnableMediaPlayback: false });
            record.policy_changed_at_ms = began;
            const item =
              upstream.item ??
              upstream.items.find((entry) => entry.Name === "rainsync-h264");
            const raw = await subjectClient.raw(
              `/Videos/${encodeURIComponent(item.Id)}/stream.mp4?Static=true&MediaSourceId=${encodeURIComponent(item.MediaSources[0].Id)}`,
            );
            record.raw_upstream_media_status_after_policy_false = raw.status;
            await raw.body?.cancel();
            // The raw product result is evidence, not reclassified as a pass. The
            // untouched upstream-real-contracts test still owns its strict assertion.
            record.denied_observation = await until(
              () => {
                const row = policyRow();
                return row.state === "denied" ? row : null;
              },
              "explicit policy denial committed",
              6000,
            );
            const observedDenied = Date.now();
            await until(
              () => transfer.closed_at_ms,
              "Worker releases stalled source while client remains paused",
              3000,
            );
            record.source_release_ms = transfer.closed_at_ms - began;
            record.observed_deny_to_source_release_ms = Math.max(
              0,
              transfer.closed_at_ms - observedDenied,
            );
            await until(
              () => transfer.product_body_cancelled_at_ms,
              "stalled product body cancellation completes",
              1000,
            );
            assert.ok(
              record.source_release_ms <= 7000,
              "physical release within 5s cache plus 2s Worker check bound",
            );
            assert.ok(
              record.observed_deny_to_source_release_ms <= 3000,
              "observed denial promptly releases the physical source",
            );
            state.response.resume();
            await until(
              () => state.aborted,
              "downstream aborted after resuming",
            );
            assert.equal(state.ended, false);
            record.downstream = {
              aborted: state.aborted,
              ended: state.ended,
              bytes: state.bytes,
            };
            req.destroy();
            expectDenied(await ready(plan));
            expectDenied(await renew(plan));
            const admission = await prepare(subject);
            expectDenied(admission);
            assert.equal(admission.status, 403);
            assert.equal(
              admission.body.error.code.toLowerCase(),
              "upstream_policy_denied",
            );
            const denied = await fetch(delivery(plan), {
              signal: AbortSignal.timeout(6000),
            });
            assert.equal(denied.status, 401);
            await denied.arrayBuffer();
            await assertControl(record);
            await setPolicy({ EnableMediaPlayback: true });
            const recovered = await nextPlan();
            await bytes(recovered);
            expectDenied(await ready(plan));
            expectDenied(await renew(plan));
            record.old_grant_remains_dead_after_allow = true;
            await stop(recovered);
          },
        );

        await scenario(
          "observed denial fences a late real PlaybackInfo response and retains its cleanup identity",
          async (record) => {
            const warm = await nextPlan();
            await stop(warm);
            const hold = { gate: gate() };
            proxy.holdPlayback(subjectClient.userId, hold);
            const requestKey = randomUUID();
            const pending = prepare(subject, { idempotency_key: requestKey });
            pending.catch(() => {});
            try {
              await until(
                () => hold.event,
                "actual PlaybackInfo response held before RainSync reads its SID",
              );
              assert.equal(hold.event.status, 200);
              assert.ok(hold.event.play_session_id);
              const sessionId = f.sql(
                `SELECT session_id FROM playback_requests WHERE idempotency_key=${quote(requestKey)}`,
              );
              assert.match(sessionId, /^[0-9a-f-]{36}$/);
              await setPolicy({ EnableMediaPlayback: false });
              record.denied_observation = await until(
                () => {
                  const row = policyRow();
                  return row.state === "denied" ? row : null;
                },
                "account denial committed while PlaybackInfo is held",
                6000,
              );
              hold.gate.release();
              const response = await pending;
              expectDenied(response);
              record.admission = response;
              const reservation = () =>
                JSON.parse(
                  f.sql(
                    `SELECT jsonb_build_object('id',id,'state',state,'play_session_id',play_session_id,'stop_confirmed',stop_confirmed,'start_reported',start_reported,'close_reason',close_reason,'closed_at',closed_at) FROM upstream_reservations WHERE id=${quote(sessionId)}`,
                  ),
                );
              record.reservation = await until(
                () => {
                  const row = reservation();
                  return row?.state === "closed" && row.stop_confirmed
                    ? row
                    : null;
                },
                "late SID receives confirmed cleanup after account denial",
                15000,
              );
              assert.equal(
                record.reservation.play_session_id,
                hold.event.play_session_id,
              );
              assert.equal(record.reservation.start_reported, false);
              assert.equal(
                f.sql(
                  `SELECT count(*) FROM playback_sessions WHERE id=${quote(sessionId)}`,
                ),
                "0",
                "denied late negotiation never publishes a playback session",
              );
              assert.ok(
                proxy.sessionReports.some(
                  (event) =>
                    event.play_session_id === hold.event.play_session_id &&
                    event.path.endsWith("Stopped") &&
                    event.status >= 200 &&
                    event.status < 300,
                ),
                "cleanup reaches actual product with the exact late SID",
              );
              await assertControl(record);
            } finally {
              hold.gate.release();
              await Promise.allSettled([pending]);
              await setPolicy({ EnableMediaPlayback: true });
            }
          },
        );

        await scenario(
          "observed denial during audio metadata discovery prevents any PlaybackInfo POST",
          async (record) => {
            const warm = await nextPlan();
            await stop(warm);
            const item =
              upstream.item ??
              upstream.items.find((entry) => entry.Name === "rainsync-h264");
            const audio = item.MediaSources[0].MediaStreams.find(
              (entry) => entry.Type === "Audio",
            );
            assert.ok(Number.isInteger(audio?.Index));
            const hold = { gate: gate() };
            proxy.holdMetadata(subjectClient.userId, hold);
            const before = proxy.negotiations.filter(
              (entry) => entry.user_id === subjectClient.userId,
            ).length;
            const requestKey = randomUUID();
            const pending = prepare(subject, {
              idempotency_key: requestKey,
              audio_index: audio.Index,
            });
            pending.catch(() => {});
            try {
              await until(
                () => hold.event,
                "actual audio metadata response held before negotiation",
              );
              assert.equal(hold.event.status, 200);
              await setPolicy({ EnableMediaPlayback: false });
              record.denied_observation = await until(
                () => {
                  const row = policyRow();
                  return row.state === "denied" ? row : null;
                },
                "denial observed during metadata GET",
                6000,
              );
              hold.gate.release();
              const response = await pending;
              expectDenied(response);
              record.admission = response;
              record.playback_info_posts =
                proxy.negotiations.filter(
                  (entry) => entry.user_id === subjectClient.userId,
                ).length - before;
              assert.equal(
                record.playback_info_posts,
                0,
                "denied metadata completion cannot allocate an upstream SID",
              );
              const sessionId = f.sql(
                `SELECT session_id FROM playback_requests WHERE idempotency_key=${quote(requestKey)}`,
              );
              record.reservation = await until(() => {
                const row = JSON.parse(
                  f.sql(
                    `SELECT jsonb_build_object('state',state,'negotiation',negotiation,'play_session_id',play_session_id,'start_reported',start_reported,'closed_at',closed_at) FROM upstream_reservations WHERE id=${quote(sessionId)}`,
                  ),
                );
                return row?.state === "closed" ? row : null;
              }, "metadata-only reservation closes without remote allocation");
              assert.equal(record.reservation.play_session_id, null);
              assert.equal(record.reservation.start_reported, false);
              await assertControl(record);
            } finally {
              hold.gate.release();
              await Promise.allSettled([pending]);
              await setPolicy({ EnableMediaPlayback: true });
            }
          },
        );

        for (const fault of [
          {
            label: "authentication failure",
            mode: { name: "status", status: 401 },
          },
          {
            label: "forbidden policy read",
            mode: { name: "status", status: 403 },
          },
          {
            label: "missing policy boolean",
            mode: {
              name: "malformed",
              body: JSON.stringify({
                Id: subjectClient.userId,
                Policy: { IsDisabled: false },
              }),
            },
          },
          {
            label: "wrong account identity",
            mode: {
              name: "malformed",
              body: JSON.stringify({
                Id: randomUUID(),
                Policy: { IsDisabled: false, EnableMediaPlayback: true },
              }),
            },
          },
          { label: "hung policy endpoint", mode: { name: "hang" } },
        ]) {
          await scenario(
            `expired positive cache fails closed on ${fault.label} and recovers`,
            async (record) => {
              const plan = await nextPlan();
              await bytes(plan);
              const before = proxy.events
                .filter(
                  (event) =>
                    event.user_id === subjectClient.userId &&
                    event.status === 200 &&
                    event.enable_media_playback === true,
                )
                .at(-1);
              assert.ok(before);
              proxy.mode(subjectClient.userId, fault.mode);
              record.last_positive_response_at_ms = before.responded_at_ms;
              const response = await until(
                async () => {
                  const current = await renew(plan);
                  return current.status !== 200 ? current : null;
                },
                "expired authority refuses renewal",
                7000,
              );
              expectDenied(response);
              record.denied_at_ms = Date.now();
              record.denial = response;
              assert.ok(
                record.denied_at_ms - before.responded_at_ms <= 7000,
                "expired authority is refused within the bounded request window",
              );
              const admission = await prepare(subject);
              expectDenied(admission);
              assert.equal(admission.status, 503);
              assert.equal(
                admission.body.error.code.toLowerCase(),
                "upstream_policy_unavailable",
              );
              const rejected = await fetch(delivery(plan), {
                signal: AbortSignal.timeout(6000),
              });
              assert.equal(rejected.status, 401);
              await rejected.arrayBuffer();
              await assertControl(record);
              proxy.mode(subjectClient.userId, { name: "pass" });
              const recovered = await nextPlan();
              record.recovered = await bytes(recovered);
              await stop(recovered);
            },
          );
        }

        await scenario(
          "Worker expires stalled delivery while policy observer process is paused",
          async (record) => {
            assert.notEqual(
              process.platform,
              "win32",
              "SIGSTOP runtime case requires the Linux CI/native harness",
            );
            const plan = await nextPlan();
            await bytes(plan);
            const { state, req, transfer } = await pausedTransfer(plan);
            record.last_policy = policyRow();
            assert.ok(
              Number.isInteger(f.serverPid) && f.serverPid > 1,
              "fixture exposes its owned Server PID",
            );
            const pausedAt = Date.now();
            process.kill(f.serverPid, "SIGSTOP");
            try {
              await until(
                () => transfer.closed_at_ms,
                "Worker expires delivery without Server observation progress",
                7000,
              );
              record.source_release_after_pause_ms =
                transfer.closed_at_ms - pausedAt;
              assert.ok(record.source_release_after_pause_ms <= 7000);
              await until(
                () => transfer.product_body_cancelled_at_ms,
                "expired product body cancellation completes",
                1000,
              );
              state.response.resume();
              await until(
                () => state.aborted,
                "paused observer downstream abort",
              );
              assert.equal(state.ended, false);
              const rejected = await fetch(delivery(plan), {
                signal: AbortSignal.timeout(3000),
              });
              assert.equal(rejected.status, 401);
              await rejected.arrayBuffer();
              record.expired_policy = policyRow();
              assert.ok(record.expired_policy.remaining_ms <= 0);
            } finally {
              process.kill(f.serverPid, "SIGCONT");
              req.destroy();
            }
            const recovered = await nextPlan();
            record.recovered = await bytes(recovered);
            await stop(recovered);
            expectDenied(await renew(plan));
            await stop(controlPlan);
            controlPlan = await nextPlan(control);
          },
        );

        await scenario(
          "expired policy cancels stalled delivery while shared Worker pool waits for a database lock",
          async (record) => {
            const plan = await nextPlan();
            await bytes(plan);
            const streams = [];
            for (let index = 0; index < 12; index++)
              streams.push(await pausedTransfer(plan));
            const lock = f.sqlProcess(undefined, { interactive: true });
            lock.done.catch(() => {});
            let output = "";
            lock.stdout.on("data", (chunk) => {
              output += chunk;
            });
            lock.stdin.write(
              "BEGIN; LOCK TABLE source_account_policies IN ACCESS EXCLUSIVE MODE; SELECT 'policy-lock-held';\n",
            );
            try {
              await until(
                () => output.includes("policy-lock-held"),
                "owned policy table lock acquired",
              );
              const began = Date.now();
              record.blocked_worker_queries = await until(
                () => {
                  const count = Number(
                    f.sql(
                      `SELECT count(*) FROM pg_stat_activity WHERE application_name=${quote(workerApplication)} AND wait_event_type='Lock'`,
                    ),
                  );
                  return count >= 8 ? count : null;
                },
                "multiple authorization checks occupy the shared Worker pool",
                4000,
              );
              await until(
                () => streams.every(({ transfer }) => transfer.closed_at_ms),
                "stalled deliveries expire despite blocked database reads",
                7000,
              );
              record.connections = streams.map(({ transfer }) => ({
                closed_after_lock_ms: transfer.closed_at_ms - began,
                delivered_bytes: transfer.delivered_bytes,
              }));
              assert.ok(
                record.connections.every(
                  (entry) => entry.closed_after_lock_ms <= 7000,
                ),
              );
              for (const { state } of streams) state.response.resume();
              await until(
                () => streams.every(({ state }) => state.aborted),
                "all paused consumers observe truncated delivery",
              );
              assert.ok(streams.every(({ state }) => !state.ended));
            } finally {
              lock.stdin.end("ROLLBACK;\n");
              await lock.done;
              for (const { req } of streams) req.destroy();
            }
            const recovered = await nextPlan();
            record.recovered = await bytes(recovered);
            await stop(recovered);
            expectDenied(await renew(plan));
            await stop(controlPlan);
            controlPlan = await nextPlan(control);
            await assertControl(record);
          },
        );

        await scenario(
          "source revision race discards an in-flight positive observation",
          async (record) => {
            const plan = await nextPlan();
            await bytes(plan);
            const hold = { name: "hold", gate: gate() };
            proxy.mode(subjectClient.userId, hold);
            await until(
              () => hold.event && policyRow().claim,
              "policy read captured before revision change",
            );
            const revision = Number(
              f.sql(
                `SELECT access_policy_revision FROM sources WHERE id=${quote(subject.source.id)}`,
              ),
            );
            const changed = await admin.request(
              `/sources/${subject.source.id}/access-policy`,
              "POST",
              {
                expected_revision: revision,
                policy: {
                  schema_version: 1,
                  origins: [{ origin: proxy.origin, cidrs: ["127.0.0.1/32"] }],
                },
              },
            );
            assert.equal(changed.access_policy_revision, revision + 1);
            record.changed_revision = changed.access_policy_revision;
            proxy.mode(subjectClient.userId, { name: "hang" });
            hold.gate.release();
            expectDenied(await ready(plan));
            expectDenied(await prepare(subject));
            await assertControl(record);
            proxy.mode(subjectClient.userId, { name: "pass" });
            const recovered = await nextPlan();
            await bytes(recovered);
            await stop(recovered);
          },
        );

        await scenario(
          "account configuration replacement cannot consume the previous account's in-flight allow",
          async (record) => {
            const plan = await nextPlan();
            await bytes(plan);
            const replacement = await upstream.client({
              restricted: true,
              deviceId: `policy-replacement-${runId}`,
            });
            const hold = { name: "hold", gate: gate() };
            proxy.mode(subjectClient.userId, hold);
            await until(
              () => hold.event && policyRow().claim,
              "old account policy read held",
            );
            const before = policyRow();
            proxy.mode(replacement.userId, { name: "hang" });
            await proxy.replaceAccount(f, subject.source.id, replacement);
            const changed = policyRow();
            assert.equal(changed.source_revision, before.source_revision + 1);
            assert.ok(changed.generation > before.generation);
            assert.equal(changed.state, "unknown");
            hold.gate.release();
            expectDenied(await ready(plan));
            const admission = await prepare(subject);
            expectDenied(admission);
            assert.equal(admission.status, 503);
            assert.equal(
              admission.body.error.code.toLowerCase(),
              "upstream_policy_unavailable",
            );
            record.old_account = subjectClient.userId;
            record.new_account = replacement.userId;
            record.before = before;
            record.after = policyRow();
            record.mutation_scope =
              "only the owned source's encrypted config; existing revision/reset triggers execute";
            await assertControl(record);
            proxy.mode(subjectClient.userId, { name: "pass" });
            await proxy.replaceAccount(f, subject.source.id, subjectClient);
            const recovered = await nextPlan();
            record.recovered = await bytes(recovered);
            await stop(recovered);
          },
        );

        await scenario(
          "server restart invalidates previous positive policy authority",
          async (record) => {
            const plan = await nextPlan();
            await bytes(plan);
            record.before_restart = policyRow();
            assert.equal(record.before_restart.state, "allowed");
            proxy.mode(subjectClient.userId, { name: "hang" });
            await f.stopServer();
            await f.startServer();
            record.after_restart = policyRow();
            assert.notEqual(
              record.after_restart.state,
              "allowed",
              "restart must discard cached positive authority before accepting new requests",
            );
            assert.equal(record.after_restart.valid_until_ms, null);
            expectDenied(await renew(plan));
            expectDenied(await prepare(subject));
            const response = await fetch(delivery(plan), {
              signal: AbortSignal.timeout(6000),
            });
            assert.equal(response.status, 401);
            await response.arrayBuffer();
            record.old_delivery_status = response.status;
            proxy.mode(subjectClient.userId, { name: "pass" });
            const recovered = await nextPlan();
            record.recovered = await bytes(recovered);
            await stop(recovered);
          },
        );
        await stop(controlPlan);
        for (const controller of controllers) await controller.close();
      },
      { env: { PLAYBACK_SESSION_LIMIT: "128" } },
    );
    product.result = "passed";
  } finally {
    for (const consumer of consumers) consumer.destroy();
    for (const controller of controllers) await controller.close();
    await proxy.close();
    product.proxy = {
      origin: proxy.origin,
      policy_events: proxy.events,
      stalled_transfers: proxy.transfers,
      negotiations: proxy.negotiations,
      metadata_reads: proxy.metadataReads,
      session_reports: proxy.sessionReports,
      failures: proxy.failures,
      port_closed: true,
    };
    if (fixture) {
      product.cleanup = await fixture.verifyStopped();
      product.cleanup.worker = {
        pid: fixture.workerPid,
        pid_absent: verifyPidAbsent(fixture.workerPid),
        port_closed: await verifyClosedPort(
          Number(new URL(fixture.workerOrigin).port),
        ),
      };
      assert.equal(product.cleanup.worker.pid_absent, true);
      assert.equal(product.cleanup.worker.port_closed, true);
    }
    assert.deepEqual(
      proxy.failures,
      [],
      "controlled proxy has no unexpected failures",
    );
  }
}

const kinds =
  selection === "controlled" || selection === "all"
    ? ["jellyfin", "emby"]
    : [selection];
for (const kind of kinds) {
  const product = {
    kind,
    product_type: selection === "controlled" ? "controlled" : "real-pinned",
    result: "running",
    cases: [],
  };
  report.products.push(product);
  await save();
  try {
    if (selection === "controlled")
      await controlledUpstream(kind, (upstream) =>
        runMatrix(upstream, product),
      );
    else {
      const result = await isolatedUpstreamReal(
        kind,
        async (upstream) => {
          product.image = upstream.metadata.image;
          product.image_id = upstream.metadata.image_id;
          product.version = upstream.metadata.actual_version;
          await runMatrix(upstream, product);
        },
        {
          durationSeconds: 30,
          artifactRoot: resolve(root, kind),
          ffmpegBin: process.env.RAINSYNC_FFMPEG_BIN,
        },
      );
      product.upstream_fixture_report = result.reportPath;
      product.upstream_cleanup = result.metadata.cleanup;
    }
  } catch (error) {
    product.result = "failed";
    product.error = error.message;
    report.failures.push({ kind, error: error.message });
  } finally {
    await save();
  }
}
try {
  await verifyBinding();
  report.bound_source_and_binaries_unchanged = true;
} catch (error) {
  report.failures.push({ name: "final binding", error: error.message });
}
report.finished_at = new Date().toISOString();
report.result = report.failures.length ? "failed" : "passed";
await save();
console.log(`Report: ${reportPath}`);
if (report.result !== "passed") process.exitCode = 1;
