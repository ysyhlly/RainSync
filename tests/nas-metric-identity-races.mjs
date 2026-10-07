// Real Server/PostgreSQL synthetic identity races; no NAS body/descriptor claim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";
import {
  queuedMetricIdentityRaces,
  waitUntil,
  zeroTotals,
  completedTotals,
  packet,
} from "./fixtures/nas-metric-identity-races.mjs";

const bindingFile = process.env.W03_BACKEND_BINDING;
assert.ok(
  bindingFile,
  "Use a successful native backend binding; this runner never builds",
);
const binding = JSON.parse(await readFile(bindingFile, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.equal(digest(JSON.stringify(binding.source)), binding.source_digest);
for (const file of binding.source)
  assert.equal(
    digest(await readFile(resolve(file.path))),
    file.sha256,
    `Fresh bound source: ${file.path}`,
  );
const binary = binding.binaries.find((item) => item.name === "rainsync-server");
assert.ok(binary);
assert.equal(digest(await readFile(binary.path)), binary.sha256);
const coordinatorInputs = await Promise.all(
  [
    "tests/nas-metric-identity-races.mjs",
    "tests/fixtures/nas-metric-identity-races.mjs",
  ].map(async (path) => ({
    path,
    sha256: digest(await readFile(resolve(path))),
  })),
);
const prefix = "rainsync_agent_reported_nas_";
const metric = (rows, name, labels = {}) =>
  rows
    .filter(
      (row) =>
        row.name === prefix + name &&
        Object.entries(labels).every(
          ([key, value]) => row.labels[key] === value,
        ),
    )
    .reduce((total, row) => total + row.value, 0);
const credited = (rows) =>
  rows.filter(
    (row) =>
      row.name.startsWith(prefix) && row.name !== prefix + "dropped_total",
  );
let owned,
  result = "failed",
  evidence,
  failure;
try {
  await isolatedServer(
    "nas-metric-identity-races",
    async (f) => {
      owned = f;
      const admin = f.client();
      await admin.login();
      const peers = new Set();
      const connect = async (identity) => {
        const ws = new WebSocket(
          f.origin.replace("http:", "ws:") + "/api/v1/agents/ws",
          { headers: { Authorization: `Bearer ${identity.token}` } },
        );
        const frames = [],
          record = { closed: false };
        ws.on("message", (data) => frames.push(JSON.parse(data)));
        ws.on("close", () => {
          record.closed = true;
          peers.delete(peer);
        });
        ws.on("error", () => {});
        const peer = {
          ws,
          record,
          send: (value) => ws.send(JSON.stringify(value)),
          next: (type) =>
            waitUntil(() => {
              const index = frames.findIndex((frame) => frame.type === type);
              return index < 0 ? null : frames.splice(index, 1)[0];
            }, `WebSocket ${type}`),
          async close() {
            if (ws.readyState < WebSocket.CLOSING) ws.close();
            await waitUntil(() => record.closed, "Owned WebSocket closed");
          },
        };
        peers.add(peer);
        await new Promise((done, reject) => {
          ws.once("open", done);
          ws.once("error", reject);
        });
        return peer;
      };
      const raw = async (identity) => {
        const peer = await connect(identity);
        peer.send({
          type: "HELLO",
          uplink_metrics_version: 1,
          uplink_metrics_baseline: zeroTotals(),
        });
        peer.connection = (await peer.next("NAS_METRICS_READY")).connection_id;
        assert.match(peer.connection, /^[a-f\d-]{36}$/);
        return peer;
      };
      const pair = async (name) => {
        const identity = await admin.request("/agents", "POST", { name });
        return {
          id: identity.id,
          ...(await admin.request("/agents/pair", "POST", {
            code: identity.pair_code,
          })),
        };
      };
      const scrape = async () => {
        const response = await fetch(f.origin + "/api/v1/metrics", {
          headers: { Cookie: admin.cookie },
        });
        assert.equal(response.status, 200);
        const rows = [];
        for (const line of (await response.text()).split("\n")) {
          if (!line.startsWith(prefix)) continue;
          const found = /^(\w+)(?:\{([^}]*)\})? ([^ ]+)$/.exec(line);
          assert.ok(found, "Valid metric exposition");
          const labels = {};
          for (const field of found[2]?.split(",") ?? []) {
            const label = /^(\w+)="([^"]*)"$/.exec(field);
            assert.ok(label);
            labels[label[1]] = label[2];
          }
          rows.push({ name: found[1], labels, value: Number(found[3]) });
        }
        return rows;
      };
      const stable = async (before, duration = 200) => {
        const deadline = Date.now() + duration;
        do {
          assert.deepEqual(
            credited(await scrape()),
            credited(before),
            "No accepted aggregate mutation",
          );
          await delay(25);
        } while (Date.now() < deadline);
      };
      const accept = async (peer, seq, totals, bytes) => {
        await delay(1050);
        const before = await scrape();
        peer.send(packet(peer.connection, seq, totals));
        const after = await waitUntil(async () => {
          const rows = await scrape();
          return metric(rows, "samples_total") ===
            metric(before, "samples_total") + 1
            ? rows
            : null;
        }, "Fresh authorized sample accepted");
        assert.equal(
          metric(after, "body_bytes_total") -
            metric(before, "body_bytes_total"),
          bytes,
        );
      };
      try {
        const primer = await raw(
          await pair("synthetic metric namespace primer"),
        );
        await accept(primer, 1, zeroTotals(), 0);
        await primer.close();
        evidence = await queuedMetricIdentityRaces({
          f,
          admin,
          pair,
          raw,
          scrape,
          stable,
          accept,
          metric,
          packet,
          completedTotals,
          connectReplacement: connect,
        });
        assert.equal(
          f.sql(
            "SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'nas_metrics_activity_%' OR tgname LIKE 'nas_metrics_replace_%'",
          ),
          "0",
        );
        assert.equal(
          f.sql(
            "SELECT count(*) FROM pg_proc WHERE proname LIKE 'nas_metrics_activity_%' OR proname LIKE 'nas_metrics_replace_%'",
          ),
          "0",
        );
        assert.equal(
          f.sql(
            "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'",
          ),
          "0",
        );
        result = "passed";
      } finally {
        await Promise.all([...peers].map((peer) => peer.close()));
      }
    },
    {
      binary: binary.path,
      beforeStart: async (f) => {
        const actualPath = resolve(
          f.target,
          `rainsync-server${process.platform === "win32" ? ".exe" : ""}`,
        );
        const normalize = (path) =>
          process.platform === "win32" ? path.toLowerCase() : path;
        assert.equal(
          normalize(await realpath(actualPath)),
          normalize(await realpath(binary.path)),
          "Actual Server target matches the frozen binding",
        );
        assert.equal(
          digest(await readFile(actualPath)),
          binary.sha256,
          "Actual spawned Server bytes match the frozen binding",
        );
      },
    },
  );
} catch (error) {
  failure = error;
} finally {
  if (owned) {
    const cleanup = await owned.verifyStopped();
    const path = resolve(owned.root, "report.json");
    await writeFile(
      path,
      JSON.stringify(
        {
          result,
          scope:
            "Real Server/PostgreSQL synthetic incoming-activity and metric identity races; no NAS body/descriptor/Linux coverage",
          binding: bindingFile,
          binary_sha256: binary.sha256,
          coordinator_inputs: coordinatorInputs,
          evidence,
          cleanup,
          failure_snapshot: failure?.fixtureSnapshot,
          error: failure?.stack,
        },
        null,
        2,
      ),
    );
    console.log(`Evidence: ${path}`);
  }
}
if (failure) throw failure;
console.log(
  "PASS: shared queued metric connection/token races and owned cleanup",
);
