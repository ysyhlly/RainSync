import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { delay } from "./server.mjs";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const digest = (value) => createHash("sha256").update(value).digest("hex");

function emptyOutcome() {
  return {
    transfers: 0,
    bytes: 0,
    duration_us: 0,
    duration_buckets: Array(9).fill(0),
  };
}
export function zeroTotals() {
  return {
    admitted: 0,
    dropped: 0,
    active: 0,
    body_seen: false,
    body_bytes: 0,
    complete: emptyOutcome(),
    failed: emptyOutcome(),
    cancelled: emptyOutcome(),
  };
}
export function completedTotals(bytes, transfers = 1) {
  return {
    ...zeroTotals(),
    admitted: transfers,
    body_seen: true,
    body_bytes: bytes,
    complete: {
      transfers,
      bytes,
      duration_us: transfers * 1000,
      duration_buckets: Array(9).fill(transfers),
    },
  };
}
export const packet = (connection, seq, totals) => ({
  type: "HEARTBEAT",
  uplink_metrics: { version: 1, connection_id: connection, seq, totals },
});

export async function waitUntil(probe, label, timeout = 10000, interval = 25) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(interval);
  }
  throw Error(`Deadline: ${label}`);
}

export async function fixtureLock(f, statement) {
  const marker = `nas_metrics_lock_${randomUUID().replaceAll("-", "")}`;
  const child = f.sqlProcess(undefined, { interactive: true });
  let output = "";
  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  const query = async (statement, timeout = 250) => {
    const complete = `nas_metrics_step_${randomUUID().replaceAll("-", "")}`;
    const start = output.length;
    child.stdin.write(
      `SELECT pg_stat_clear_snapshot(); ${statement}; SELECT ${quote(complete)};\n`,
    );
    await waitUntil(
      () => output.slice(start).includes(complete),
      "Owned lock session statement",
      timeout,
      5,
    );
    return output.slice(start).split(complete)[0].trim().split("\n").at(-1);
  };
  await query(
    `BEGIN; SET application_name=${quote(marker)}; ${statement}`,
    10000,
  );
  return {
    marker,
    query,
    async finish(commit = true) {
      if (child.exitCode !== null) return child.done;
      child.stdin.end(`${commit ? "COMMIT" : "ROLLBACK"};\n`);
      await child.done;
    },
  };
}

export async function queuedMetricIdentityRaces({
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
  connectReplacement,
}) {
  const variants = [];
  for (const mode of ["connection", "token"]) {
    const identity = await pair(`synthetic locked ${mode}`);
    const peer = await raw(identity);
    const before = await scrape();
    await delay(1050);
    const replacement = randomBytes(32).toString("hex");
    const held = await fixtureLock(f, "SELECT 1");
    const gateKey = randomBytes(4).readUInt32BE();
    const gateName = `nas_metrics_activity_${randomUUID().replaceAll("-", "")}`;
    const replacementKey = randomBytes(4).readUInt32BE();
    const replacementName = `nas_metrics_replace_${randomUUID().replaceAll("-", "")}`;
    let gate,
      replacementGate,
      handoff,
      heldReady,
      newer,
      invalidation,
      dispatch;
    try {
      const blockerPid = Number(await held.query("SELECT pg_backend_pid()"));
      assert.ok(Number.isSafeInteger(blockerPid) && blockerPid > 0);
      if (mode === "connection")
        handoff = await fixtureLock(
          f,
          "LOCK TABLE agent_transfer_runs IN SHARE MODE",
        );
      const tableBlockerPid = handoff
        ? Number(await handoff.query("SELECT pg_backend_pid()"))
        : null;
      gate = await fixtureLock(f, `SELECT pg_advisory_xact_lock(${gateKey})`);
      const gatePid = Number(await gate.query("SELECT pg_backend_pid()"));
      let replacementGatePid;
      if (mode === "connection") {
        replacementGate = await fixtureLock(
          f,
          `SELECT pg_advisory_xact_lock(${replacementKey})`,
        );
        replacementGatePid = Number(
          await replacementGate.query("SELECT pg_backend_pid()"),
        );
        f.sql(
          `CREATE FUNCTION ${replacementName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${replacementKey}); RETURN NEW; END $$; CREATE TRIGGER ${replacementName} AFTER UPDATE OF advanced_assets_connection ON agents FOR EACH ROW WHEN (NEW.id=${quote(identity.id)}::uuid AND OLD.advanced_assets_connection=${quote(peer.connection)}::uuid AND NEW.advanced_assets_connection IS DISTINCT FROM OLD.advanced_assets_connection) EXECUTE FUNCTION ${replacementName}()`,
        );
      }
      const seen = await gate.query(
        `SELECT last_seen::text FROM agents WHERE id=${quote(identity.id)}`,
      );
      f.sql(
        `CREATE FUNCTION ${gateName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${gateKey}); RETURN NEW; END $$; CREATE TRIGGER ${gateName} AFTER UPDATE OF last_seen ON agents FOR EACH ROW WHEN (NEW.id=${quote(identity.id)}::uuid AND NEW.advanced_assets_connection=${quote(peer.connection)}::uuid AND OLD.last_seen=${quote(seen)}::timestamptz) EXECUTE FUNCTION ${gateName}()`,
      );

      // Pause the next real incoming activity write, not the metrics receiver.
      // OLD.last_seen makes this an exact one-shot gate for the owned identity.
      peer.send(packet(peer.connection, 1, completedTotals(77)));
      const activityPid = Number(
        await waitUntil(
          async () => {
            const value = await gate.query(
              `SELECT COALESCE(json_agg(pid),'[]'::json) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ${gatePid}=ANY(pg_blocking_pids(pid))`,
            );
            const pids = JSON.parse(value);
            return pids.length === 1 ? pids[0] : null;
          },
          "Owned advisory gate pauses the incoming Agent activity",
          2000,
          5,
        ),
      );
      assert.ok(Number.isSafeInteger(activityPid) && activityPid > 0);

      if (mode === "connection") {
        // A synthetic dispatch supplies a real outgoing socket-owner await.
        // No playback/data grant or byte/receipt observation is fabricated.
        dispatch = randomUUID();
        f.sql(
          `INSERT INTO agent_transfers(id,agent_id,token_hash,request,expires_at) VALUES (${quote(dispatch)},${quote(identity.id)},${quote(digest(randomBytes(32)))},'{}',clock_timestamp()+interval '1 minute')`,
        );
      }
      heldReady = held.query(
        mode === "token"
          ? `UPDATE agents SET token_hash=${quote(digest(replacement))} WHERE id=${quote(identity.id)}`
          : `SELECT id FROM agents WHERE id=${quote(identity.id)} FOR UPDATE`,
        10000,
      );
      heldReady.catch(() => {});
      await waitUntil(
        async () =>
          Number(
            await gate.query(
              `SELECT count(*) FROM pg_stat_activity WHERE application_name=${quote(held.marker)} AND wait_event_type='Lock' AND ${activityPid}=ANY(pg_blocking_pids(pid))`,
            ),
          ) === 1,
        "Owned Agent row mutation queued immediately after incoming activity",
        250,
        5,
      );

      if (mode === "connection") {
        newer = await connectReplacement(identity);
        await waitUntil(
          async () =>
            Number(
              await gate.query(
                `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ${blockerPid}=ANY(pg_blocking_pids(pid))`,
              ),
            ) === 1,
          "Replacement initialization is the sole waiter behind the owned Agent lock before handoff",
          250,
          5,
        );
      }

      await gate.finish();
      await heldReady;
      await waitUntil(
        async () =>
          (await held.query(
            `SELECT last_seen::text FROM agents WHERE id=${quote(identity.id)}`,
          )) !== seen,
        "Authenticated incoming heartbeat refreshes Agent activity before receiver dispatch",
        2000,
        5,
      );
      await waitUntil(
        async () =>
          Number(
            await held.query(
              `WITH RECURSIVE wait_path(root,pid) AS (SELECT pid,pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT id FROM agents WHERE id=$1 AND token_hash=$2 AND NOT revoked FOR SHARE' UNION SELECT w.root,b.pid FROM wait_path w CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) b(pid)) SELECT count(DISTINCT root) FROM wait_path WHERE pid=${blockerPid}`,
            ),
          ) === 1,
        "Actual receiver Agent authorization lock wait",
        250,
        5,
      );
      if (mode === "connection")
        await waitUntil(
          async () =>
            Number(
              await held.query(
                `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ${tableBlockerPid}=ANY(pg_blocking_pids(pid)) AND query='UPDATE agent_transfer_runs SET dispatched_at=COALESCE(dispatched_at,clock_timestamp()) WHERE id=$1'`,
              ),
            ) === 1,
          "Old socket outgoing dispatch owns its queued receiver",
          250,
          5,
        );
      await held.finish();
      if (mode === "connection") {
        // Gate replacement after actual row ownership. Its production
        // commit installs the control identity while holding the controls mutex.
        const replacementPid = Number(
          await waitUntil(
            async () => {
              const pids = JSON.parse(
                await replacementGate.query(
                  `SELECT COALESCE(json_agg(pid),'[]'::json) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ${replacementGatePid}=ANY(pg_blocking_pids(pid))`,
                ),
              );
              return pids.length === 1 ? pids[0] : null;
            },
            "Replacement owns the Agent row before identity publication",
            250,
            5,
          ),
        );
        await waitUntil(
          async () =>
            Number(
              await replacementGate.query(
                `WITH RECURSIVE wait_path(root,pid) AS (SELECT pid,pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT id FROM agents WHERE id=$1 AND token_hash=$2 AND NOT revoked FOR SHARE' UNION SELECT w.root,b.pid FROM wait_path w CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) b(pid)) SELECT count(DISTINCT root) FROM wait_path WHERE pid=${replacementPid}`,
              ),
            ) === 1,
          "Actual receiver remains blocked by owned replacement",
          250,
          5,
        );
        await replacementGate.finish();
        await waitUntil(
          async () => {
            const row = (await admin.request("/agents")).find(
              (row) => row.id === identity.id,
            );
            return row?.connected === true && row.drain_receipts === null;
          },
          "Replacement registry positively installed",
          250,
          5,
        );
        assert.equal(
          peer.record.closed,
          false,
          "Old receiver remains owned through post-wait identity check",
        );
      }
      await waitUntil(async () => {
        const rows = await scrape();
        assert.equal(
          metric(rows, "dropped_total", { reason: "unavailable" }),
          metric(before, "dropped_total", { reason: "unavailable" }),
          "Authorization timeout cannot substitute for identity invalidation",
        );
        if (
          mode === "token" &&
          metric(rows, "dropped_total", { reason: "unauthorized" }) ===
            metric(before, "dropped_total", { reason: "unauthorized" }) + 1
        ) {
          invalidation = "post_wait_token_rejected";
          return true;
        }
        if (
          mode === "connection" &&
          metric(rows, "dropped_total", { reason: "stale" }) ===
            metric(before, "dropped_total", { reason: "stale" }) + 1
        ) {
          invalidation = "post_wait_connection_rejected";
          return true;
        }
        return false;
      }, "Explicit queued-report invalidation rather than timeout");
      if (mode === "connection")
        assert.equal(
          peer.record.closed,
          false,
          "Stale identity rejected before old socket cancellation",
        );
      await stable(before, 1200);
      assert.equal(
        metric(await scrape(), "dropped_total", { reason: "unavailable" }),
        metric(before, "dropped_total", { reason: "unavailable" }),
      );
    } catch (error) {
      error.fixtureSnapshot = {
        mode,
        peer_closed: peer.record.closed,
        waits: JSON.parse(
          f.sql(
            "SELECT COALESCE(json_agg(json_build_object('pid',pid,'application_name',application_name,'wait_type',wait_event_type,'wait',wait_event,'blocking',pg_blocking_pids(pid),'query',left(query,240))),'[]'::json) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
          ),
        ),
        metrics: await scrape(),
      };
      throw error;
    } finally {
      await gate?.finish(false);
      await replacementGate?.finish(false);
      await Promise.all([held.finish(false), handoff?.finish(false)]);
      await Promise.allSettled([heldReady].filter(Boolean));
      f.sql(
        `DROP TRIGGER IF EXISTS ${gateName} ON agents; DROP FUNCTION IF EXISTS ${gateName}()`,
      );
      if (mode === "connection")
        f.sql(
          `DROP TRIGGER IF EXISTS ${replacementName} ON agents; DROP FUNCTION IF EXISTS ${replacementName}()`,
        );
      if (dispatch)
        f.sql(`DELETE FROM agent_transfers WHERE id=${quote(dispatch)}`);
      if (newer) await newer.close();
      if (!peer.record.closed) await peer.close();
    }
    const recovered = await raw({
      ...identity,
      token: mode === "token" ? replacement : identity.token,
    });
    await accept(recovered, 1, completedTotals(3), 3);
    await recovered.close();
    variants.push({
      mode,
      contended_agent_row: true,
      incoming_activity_gate: true,
      invalidation,
      authorization_timeouts: 0,
      stale_report_credit: 0,
      fresh_authorized_delta: 3,
    });
  }
  return { synthetic: true, variants };
}
