// Only synthetic agents/media in a newly owned PostgreSQL + Server fixture.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";
const report = {
  result: "running",
  checks: [],
  scope:
    "owned isolated PostgreSQL and real HTTP/WebSocket settings; no actual NAS files or encoder",
};
let fixture;
try {
  await isolatedServer(
    "nas-configuration-settings",
    async (f) => {
      fixture = f;
      const admin = f.client();
      await admin.login();
      const created = await admin.request("/agents", "POST", {
        name: "  owned NAS  ",
      });
      const id = created.id;
      const pair = await admin.request("/agents/pair", "POST", {
        code: created.pair_code,
      });
      const rename = (name, expected_name, status = 200, client = admin) =>
        client.request(`/agents/${id}`, "PUT", { name, expected_name }, status);
      const current = () => f.sql(`SELECT name FROM agents WHERE id='${id}'`);
      assert.equal(current(), "owned NAS");
      for (const name of ["", "  ", "x".repeat(121), "bad\nname"]) {
        assert.equal(
          (await rename(name, "owned NAS", 400)).error.code,
          "INVALID_AGENT_NAME",
        );
        await admin.request("/agents", "POST", { name }, 400);
      }
      const outsider = f.client();
      await admin.request("/users", "POST", {
        username: "nas-outsider",
        password: f.password,
      });
      await outsider.login("nas-outsider", f.password);
      await rename("forbidden", "owned NAS", 403, outsider);
      await rename("forbidden", "owned NAS", 401, f.client());
      await admin.request(
        `/agents/${id}`,
        "PUT",
        { name: "forbidden", expected_name: "owned NAS" },
        403,
        { "x-csrf-token": "wrong" },
      );
      await admin.request(
        `/agents/${randomUUID()}`,
        "PUT",
        { name: "missing", expected_name: "missing" },
        404,
      );
      await rename("named before connect", "owned NAS");
      const ws = new WebSocket(
        f.origin.replace("http", "ws") + "/api/v1/agents/ws",
        { headers: { Authorization: `Bearer ${pair.token}` } },
      );
      ws.on("error", () => {});
      try {
        await new Promise((done, reject) => {
          ws.once("open", done);
          ws.once("error", reject);
        });
        const deadline = Date.now() + 15000;
        while (f.sql(`SELECT count(*) FROM sources WHERE id='${id}'`) !== "1") {
          assert.ok(Date.now() < deadline, "source created on connect");
          await delay(30);
        }
        assert.equal(
          f.sql(`SELECT name FROM sources WHERE id='${id}'`),
          "named before connect",
        );
        const sourceConfig = f.sql(
          `SELECT config_encrypted FROM sources WHERE id='${id}'`,
        );
        await rename("  renamed in place  ", "named before connect");
        assert.equal(current(), "renamed in place");
        assert.equal(
          f.sql(`SELECT name FROM sources WHERE id='${id}'`),
          "renamed in place",
        );
        assert.equal(
          f.sql(`SELECT config_encrypted FROM sources WHERE id='${id}'`),
          sourceConfig,
        );
        assert.equal(
          (await rename("stale overwrite", "named before connect", 409)).error
            .code,
          "AGENT_SETTINGS_CONFLICT",
        );
        assert.equal(current(), "renamed in place");
        const races = await Promise.all(
          ["race A", "race B"].map((name) =>
            admin.raw(`/agents/${id}`, {
              method: "PUT",
              body: { name, expected_name: "renamed in place" },
            }),
          ),
        );
        assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
        assert.equal(
          f.sql(`SELECT name FROM sources WHERE id='${id}'`),
          current(),
        );
        assert.equal(
          f.sql(
            `SELECT token_hash IS NOT NULL AND NOT revoked FROM agents WHERE id='${id}'`,
          ),
          "t",
        );
        report.checks.push(
          "admin/CSRF/name validation; rename before first connection; atomic agent/source name updates; encrypted source configuration and paired identity preserved; stale and concurrent renames rejected",
        );
      } finally {
        ws.close();
      }
      const first = await admin.request("/agents/compute");
      const initial = first.nodes.find((n) => n.id === id);
      assert.equal(initial.revision, 0);
      assert.equal(initial.enabled, false);
      assert.equal(initial.revoked, false);
      assert.deepEqual(first.limits, {
        min_slots: 1,
        max_slots: 4,
        min_output_budget_bytes: 1048576,
        max_output_budget_bytes: 1073741824,
        total_output_budget_bytes: 536870912,
      });
      const policy = (body, status = 200, client = admin) =>
        client.request(`/agents/${id}/compute-policy`, "POST", body, status);
      const defaults = {
        enabled: false,
        slots: 1,
        output_budget_bytes: 67108864,
      };
      await policy({ ...defaults, expected_revision: 0 }, 403, outsider);
      for (const patch of [
        { slots: 0 },
        { slots: 5 },
        { output_budget_bytes: 1048575 },
        { output_budget_bytes: 1073741825 },
        { expected_revision: -1 },
      ])
        await policy({ ...defaults, expected_revision: 0, ...patch }, 400);
      let receipt = await policy({
        ...defaults,
        slots: 2,
        output_budget_bytes: 268435456,
        expected_revision: 0,
      });
      assert.equal(receipt.revision, 1);
      assert.equal(receipt.enabled, false);
      assert.equal(
        (
          await policy(
            { ...defaults, enabled: true, expected_revision: 0 },
            409,
          )
        ).error.code,
        "COMPUTE_POLICY_CONFLICT",
      );
      const policyRaces = await Promise.all(
        [2, 3].map((slots) =>
          admin.raw(`/agents/${id}/compute-policy`, {
            method: "POST",
            body: { ...defaults, slots, expected_revision: 1 },
          }),
        ),
      );
      assert.deepEqual(policyRaces.map((r) => r.status).sort(), [200, 409]);
      receipt = await policy({
        ...defaults,
        enabled: true,
        expected_revision: 2,
      });
      const connection = randomUUID();
      const agentRequest = async (path, body, status = 200) => {
        const response = await fetch(f.origin + "/api/v1" + path, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${pair.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const value = await response.json();
        assert.equal(
          response.status,
          status,
          `${path}: ${JSON.stringify(value)}`,
        );
        return value;
      };
      await agentRequest("/agent-compute/heartbeat", {
        connection_id: connection,
        capabilities: ["h264_480p_hls_v1"],
        self_test: {},
      });
      const media = randomUUID(),
        version = `stat-v1:${"a".repeat(64)}`;
      f.sql(
        `INSERT INTO media_items(id,source_id,title,resource,source_version) VALUES('${media}','${id}','owned synthetic clip','owned.mp4','${version}')`,
      );
      await agentRequest("/agent-compute/catalog", {
        media_id: media,
        source_version: version,
        content_sha256: "b".repeat(64),
        size_bytes: 1024,
      });
      const room = await admin.request("/rooms", "POST", {
        name: "owned settings room",
      });
      f.sql(
        `UPDATE room_snapshots SET state=state||jsonb_build_object('media_id','${media}','media_generation',1) WHERE room_id='${room.id}'`,
      );
      const job = await admin.request(`/rooms/${room.id}/compute`, "POST", {
        media_generation: 1,
        recipe: "h264_480p_hls_v1",
      });
      const claim = (
        await agentRequest("/agent-compute/claim", {
          connection_id: connection,
        })
      ).job;
      assert.equal(claim.id, job.id);
      // Freeze the room after renewal has pinned its policy. A settings write
      // must wait on the same device-first order, never hold device -> policy
      // while renewal owns policy -> device. No media process is involved.
      const roomLocker = f.sqlProcess(undefined, { interactive: true });
      let roomLockOutput = "";
      roomLocker.stdout.on("data", bytes => { roomLockOutput += bytes; });
      roomLocker.stdin.write(`BEGIN; SELECT id FROM rooms WHERE id='${room.id}' FOR NO KEY UPDATE; SELECT 'compute-room-locked';\n`);
      let renewal, quotaChange;
      try {
        const deadline = Date.now() + 5000;
        while (!roomLockOutput.includes("compute-room-locked")) {
          assert.ok(Date.now() < deadline, "owned room lock acquired");
          await delay(20);
        }
        renewal = agentRequest(`/agent-compute/jobs/${job.id}/renew`, {
          connection_id: connection,
          attempt: claim.attempt,
          output_generation: claim.output_generation,
        });
        renewal.catch(() => {});
        await f.waitForSql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT lifecycle,lifecycle_epoch FROM rooms WHERE id=$1 FOR NO KEY UPDATE'", "1", 5000);
        quotaChange = policy({ ...defaults, enabled: true, output_budget_bytes: 134217728, expected_revision: receipt.revision });
        quotaChange.catch(() => {});
        await f.waitForSql("SELECT (count(*)>=2)::text FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'", "true", 5000);
        roomLocker.stdin.end("ROLLBACK;\n");
        await roomLocker.done;
        const results = await Promise.all([renewal, quotaChange]);
        assert.equal(results[0].lease_ms, 20000);
        receipt = results[1];
        assert.equal(f.sql(`SELECT status||':'||output_budget_bytes FROM distributed_compute_jobs WHERE id='${job.id}'`), "running:67108864", "quota edit leaves the current attempt and frozen budget intact");
        report.checks.push("concurrent renewal and quota edit use device-before-policy locks without deadlock or cancelling the live attempt");
      } finally {
        if (!roomLocker.stdin.writableEnded) roomLocker.stdin.end("ROLLBACK;\n");
        await roomLocker.done.catch(() => {});
        await Promise.allSettled([renewal, quotaChange].filter(Boolean));
      }
      receipt = await policy({
        ...defaults,
        expected_revision: receipt.revision,
      });
      assert.equal(
        f.sql(
          `SELECT status FROM distributed_compute_jobs WHERE id='${job.id}'`,
        ),
        "cancelled",
      );
      assert.equal(
        f.sql(
          `SELECT count(*) FROM distributed_compute_attempts WHERE job_id='${job.id}'`,
        ),
        "1",
      );
      assert.equal(
        f.sql(`SELECT count(*) FROM media_items WHERE id='${media}'`),
        "1",
      );
      assert.equal(receipt.enabled, false);
      assert.equal(receipt.slots, 1);
      assert.equal(receipt.output_budget_bytes, 67108864);
      report.checks.push(
        "server quota bounds and global budget exposed; defaults stay disabled/1-slot/64-MiB; revision CAS rejects stale and concurrent writes; reset cancels owned job but retains media and attempt/history records",
      );
      // A valid session may expire while a settings request waits for its device lock.
      for (const action of ["rename", "policy"]) {
        await admin.login();
        f.sql(
          "UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE user_id=(SELECT id FROM users WHERE username='admin')",
        );
        const locker = f.sqlProcess(undefined, { interactive: true });
        let output = "";
        locker.stdout.on("data", (bytes) => {
          output += bytes;
        });
        locker.stdin.write(
          `BEGIN; SELECT id FROM agents WHERE id='${id}' FOR NO KEY UPDATE; SELECT 'nas-settings-locked';\n`,
        );
        const deadline = Date.now() + 15000;
        while (!output.includes("nas-settings-locked")) {
          assert.ok(Date.now() < deadline);
          await delay(25);
        }
        const pending =
          action === "rename"
            ? rename("expired request", current(), 401)
            : policy({ ...defaults, expected_revision: receipt.revision }, 401);
        while (
          f.sql(
            "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM agents WHERE id=$1 AND NOT revoked FOR NO KEY UPDATE%'",
          ) === "0"
        ) {
          assert.ok(
            Date.now() < deadline,
            "settings request waits on device lock",
          );
          await delay(25);
        }
        await delay(2200);
        locker.stdin.end("COMMIT;\n");
        assert.equal((await pending).error.code, "SESSION_EXPIRED");
        assert.notEqual(current(), "expired request");
        assert.equal(
          f.sql(
            `SELECT revision FROM distributed_compute_policy WHERE agent_id='${id}'`,
          ),
          String(receipt.revision),
        );
      }
      await admin.login();
      report.checks.push(
        "rename and compute policy recheck session expiry after waiting for row locks; expired writes roll back without changing name or policy revision",
      );
      receipt = await policy({
        ...defaults,
        enabled: true,
        expected_revision: receipt.revision,
      });
      await f.startServer({ RAINSYNC_COMPUTE_OUTPUT_ROOT: "" });
      await admin.login();
      assert.equal((await admin.request("/agents/compute")).enabled, false);
      await policy(
        { ...defaults, enabled: true, expected_revision: receipt.revision },
        503,
      );
      receipt = await policy({
        ...defaults,
        expected_revision: receipt.revision,
      });
      assert.equal(receipt.enabled, false);
      await admin.request(`/agents/${id}`, "DELETE");
      await rename("after revoke", current(), 404);
      await policy({ ...defaults, expected_revision: receipt.revision }, 404);
      const revoked = (await admin.request("/agents/compute")).nodes.find(
        (n) => n.id === id,
      );
      assert.equal(revoked.revoked, true);
      assert.equal(revoked.enabled, false);
      assert.equal(revoked.healthy, false);
      assert.equal(
        f.sql(
          `SELECT revoked AND token_hash IS NULL FROM agents WHERE id='${id}'`,
        ),
        "t",
      );
      assert.equal(f.sql(`SELECT count(*) FROM sources WHERE id='${id}'`), "1");
      assert.equal(
        f.sql(
          `SELECT count(*) FROM distributed_compute_jobs WHERE id='${job.id}'`,
        ),
        "1",
      );
      report.checks.push(
        "global compute shutdown still permits permission revocation/reset; revoked nodes reject settings and report disabled/unhealthy while source, media and job history remain",
      );
      report.result = "passed";
    },
    {
      beforeStart: (f) => {
        f.env.RAINSYNC_COMPUTE_OUTPUT_ROOT = resolve(f.root, "published");
        f.env.RAINSYNC_COMPUTE_TOTAL_BYTES = "536870912";
      },
    },
  );
  report.cleanup = await fixture.verifyStopped();
} catch (error) {
  report.result = "failed";
  report.error = String(error);
  if (fixture) report.cleanup = await fixture.verifyStopped();
  throw error;
} finally {
  if (fixture) {
    await writeFile(
      resolve(fixture.root, "evidence.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  }
}
