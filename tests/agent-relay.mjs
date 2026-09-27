import assert from "node:assert/strict";
import { request } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";

export async function agentRelay({
  docker,
  tag,
  network,
  server,
  worker,
  workerBase,
  sql,
  encrypt,
  userId,
  roomId,
  agentId,
  revoke,
}) {
  const agent = `${worker}-agent`,
    volume = `${agent}-media`;
  const token = randomBytes(32).toString("hex");
  const requests = new Set(),
    cases = [];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(check, label, timeout = 5000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await check()) return;
      await delay(50);
    }
    throw Error(`deadline: ${label}`);
  }
  function handles() {
    return Number(
      docker(
        "exec",
        agent,
        "sh",
        "-c",
        'n=0; for f in /proc/[0-9]*/fd/*; do p=$(readlink "$f" 2>/dev/null || true); if [ "$p" = /media/large.mp4 ]; then n=$((n+1)); fi; done; echo "$n"',
      ),
    );
  }
  function start({ pause = true, method = "GET", range } = {}) {
    const id = randomUUID(),
      ticket = randomBytes(32).toString("hex");
    const resource = encrypt({
      kind: "agent",
      agent_id: agentId,
      resource: "large.mp4",
    });
    sql(
      `INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${id}','${userId}','${roomId}',0,'${createHash("sha256").update(ticket).digest("hex")}','{"encrypted":"${resource}"}',now()+interval '1 hour')`,
    );
    const state = { id, bytes: 0, ended: false, aborted: false };
    const req = request(
      `${workerBase}/media-delivery/${id}/source?token=${ticket}`,
      { method, headers: range ? { Range: range } : {} },
      (res) => {
        state.response = res;
        res.on("data", (chunk) => {
          state.bytes += chunk.length;
        });
        res.on("end", () => {
          state.ended = true;
        });
        res.on("aborted", () => {
          state.aborted = true;
        });
        res.on("error", () => {});
        if (pause) res.pause();
      },
    );
    requests.add(req);
    req.on("close", () => requests.delete(req));
    req.on("error", () => {});
    req.end();
    state.request = req;
    return state;
  }
  async function streaming(count) {
    const states = [];
    for (let i = 0; i < count; i++) {
      const state = start();
      await until(() => state.response, "HTTP headers");
      assert.equal(state.response.statusCode, 200);
      states.push(state);
    }
    return states;
  }
  async function aborted(states, label) {
    for (const state of states) state.response.resume();
    await until(() => states.every((s) => s.aborted), label);
    assert.ok(states.every((s) => !s.ended && s.bytes < 1073741824));
    for (const state of states) state.request.destroy();
  }
  try {
    sql(
      `UPDATE agents SET token_hash='${createHash("sha256").update(token).digest("hex")}',last_seen=NULL WHERE id='${agentId}'`,
    );
    docker("volume", "create", volume);
    docker(
      "run",
      "--rm",
      "--user",
      "0",
      "-v",
      `${volume}:/media`,
      tag,
      "sh",
      "-c",
      "truncate -s 1073741824 /media/large.mp4; chmod 644 /media/large.mp4",
    );
    docker(
      "run",
      "-d",
      "--name",
      agent,
      "--network",
      network,
      "-v",
      `${volume}:/media`,
      "-e",
      `SERVER_URL=http://${server}:8080`,
      "-e",
      `AGENT_DATA_ORIGIN=http://${worker}:8081`,
      "-e",
      `AGENT_TOKEN=${token}`,
      "-e",
      "MEDIA_ROOT=/media",
      tag,
      "rainsync-nas-agent",
    );
    await until(
      () =>
        sql(
          `SELECT (last_seen IS NOT NULL)::text FROM agents WHERE id='${agentId}'`,
        ) === "true",
      "real Agent control",
      10000,
    );
    const active = await streaming(8);
    await until(() => handles() === 8, "eight real files");
    let began = Date.now();
    for (let i = 0; i < 8; i += 2) active[i].request.destroy();
    await until(
      () => handles() === 4,
      "HTTP cancellation closes four Agent files",
    );
    cases.push({
      scenario: "HTTP-cancel-through-Worker",
      released_ms: Date.now() - began,
      handles: 4,
    });
    const remaining = active.filter((_, i) => i % 2 === 1);
    remaining.push(...(await streaming(4)));
    await until(() => handles() === 8, "HTTP reuse after cancel");
    began = Date.now();
    docker("restart", agent);
    await aborted(remaining, "Agent restart truncates old HTTP responses");
    await until(() => handles() === 0, "restarted Agent has no old files");
    const range = start({ pause: false, range: "bytes=10-99" });
    await until(() => range.ended, "reconnected Range", 10000);
    assert.equal(range.response.statusCode, 206);
    assert.equal(range.bytes, 90);
    cases.push({
      scenario: "Agent-restart-through-Worker",
      recovered_ms: Date.now() - began,
      range_bytes: range.bytes,
    });

    const revoked = await streaming(8);
    await until(() => handles() === 8, "files before revoke");
    began = Date.now();
    await revoke();
    await until(() => handles() === 0, "admin revoke closes real Agent files");
    const released = Date.now() - began;
    await aborted(revoked, "admin revoke truncates old HTTP responses");
    assert.equal(
      sql(`SELECT revoked::text FROM agents WHERE id='${agentId}'`),
      "true",
    );
    const denied = start({ pause: false });
    await until(() => denied.ended, "new revoked request refused");
    assert.equal(denied.response.statusCode, 503);
    assert.equal(handles(), 0);
    cases.push({
      scenario: "admin-revoke-through-Server-Worker-Agent",
      released_ms: released,
      old_http_aborted: 8,
      new_http_status: denied.response.statusCode,
    });
    assert.equal(
      sql(`SELECT count(*) FROM agent_transfers WHERE agent_id='${agentId}'`),
      "0",
    );
    return cases;
  } finally {
    for (const req of requests) req.destroy();
    try {
      docker("rm", "-f", agent);
    } catch {}
    try {
      docker("volume", "rm", volume);
    } catch {}
  }
}
