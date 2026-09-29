import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";

// Called by input-retries against isolated real Server/Worker/PostgreSQL.
// Only the Agent data peer is controlled; ffprobe and playback preparation are real.
export async function sourceVersionPlayback({
  workerBase,
  sql,
  encrypt,
  userId,
  roomId,
  agentId,
  playback,
  fixture,
}) {
  const version = `stat-v1:${"0".repeat(64)}`;
  const mediaId = randomUUID();
  const originalState = sql(
    `SELECT state::text FROM room_snapshots WHERE room_id='${roomId}'`,
  );
  const original = JSON.parse(originalState);
  const generation = original.media_generation + 1;
  const config = encrypt({
    root: "",
    url: "",
    token: "",
    user_id: "",
    agent_id: agentId,
    headers: {},
  });
  const sockets = new Set();
  const seen = new Set();
  const sessions = [];
  const cases = [];
  let scenario;
  let peerFailure;
  const privateDiagnostic = "PRIVATE_NAS_PATH_AND_CREDENTIAL_DIAGNOSTIC";
  const send = (socket, data) =>
    new Promise((resolve, reject) =>
      socket.send(data, (error) => (error ? reject(error) : resolve())),
    );

  async function peer(request, selected) {
    const target = new URL(request.data_url);
    const socket = new WebSocket(
      workerBase.replace("http:", "ws:") + target.pathname + target.search,
    );
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    if (selected === "changed" || selected === "unknown") {
      await send(
        socket,
        JSON.stringify({
          status: 409,
          "content-length": "0",
          error: selected === "changed" ? "source_changed" : privateDiagnostic,
        }),
      );
      socket.close();
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.range ?? "");
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2]
      ? Math.min(Number(match[2]), fixture.length - 1)
      : fixture.length - 1;
    const meta = {
      status: match ? 206 : 200,
      "content-length": String(end - start + 1),
      "content-type": "video/mp4",
      "accept-ranges": "bytes",
      ...(match
        ? { "content-range": `bytes ${start}-${end}/${fixture.length}` }
        : {}),
      ...(selected === "missing"
        ? {}
        : {
            source_version:
              selected === "mismatch" ? `stat-v1:${"1".repeat(64)}` : version,
          }),
    };
    await send(socket, JSON.stringify(meta));
    if (selected === "healthy") {
      for (let offset = start; !request.head && offset <= end; offset += 32768)
        await send(
          socket,
          fixture.subarray(offset, Math.min(offset + 32768, end + 1)),
        );
    }
    socket.close();
  }

  const poll = setInterval(() => {
    if (!scenario) return;
    try {
      sql(
        `UPDATE agents SET revoked=false,last_seen=now() WHERE id='${agentId}'`,
      );
      const rows = JSON.parse(
        sql(
          `SELECT COALESCE(json_agg(json_build_object('id',id,'request',request)),'[]'::json) FROM agent_transfers WHERE agent_id='${agentId}'`,
        ),
      );
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        void peer(row.request, scenario).catch((error) => {
          peerFailure = error;
        });
      }
    } catch (error) {
      peerFailure = error;
    }
  }, 150);
  async function checked(response, status, code) {
    const text = await response.text();
    assert.ok(
      !text.includes(privateDiagnostic),
      "private Agent errors stay hidden",
    );
    assert.equal(response.status, status, text);
    const body = JSON.parse(text);
    if (code) {
      assert.equal(body.error.code, code);
      assert.equal(body.error.retryable, status !== 409);
    } else {
      assert.ok(
        body.format || body.session_id,
        "successful probe or playback plan",
      );
    }
    return body;
  }

  try {
    assert.ok(fixture.length > 0);
    sql(
      `INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${agentId}','probe version fixture','agent','${config}') ON CONFLICT(id) DO NOTHING; INSERT INTO media_items(id,source_id,title,resource,source_version) VALUES('${mediaId}','${agentId}','versioned probe','input.mp4','${version}'); UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${mediaId}"'),'{media_generation}','${generation}') WHERE room_id='${roomId}'`,
    );
    for (const [selected, status, code] of [
      ["healthy", 200, undefined],
      ["changed", 409, "SOURCE_CHANGED"],
      ["missing", 409, "SOURCE_VERSION_REQUIRED"],
      ["mismatch", 409, "SOURCE_CHANGED"],
      ["unknown", 502, "MEDIA_UNAVAILABLE"],
    ]) {
      scenario = selected;
      const id = randomUUID();
      const token = randomBytes(32).toString("hex");
      const resource = encrypt({
        kind: "agent",
        agent_id: agentId,
        resource: "input.mp4",
        source_version: version,
      });
      sql(
        `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES('${id}','${userId}','${roomId}','${mediaId}',${generation},'${createHash("sha256").update(token).digest("hex")}','{"encrypted":"${resource}"}',now()+interval '1 minute')`,
      );
      sessions.push(id);
      const response = await fetch(
        `${workerBase}/media-delivery/${id}/probe?token=${token}`,
        { signal: AbortSignal.timeout(40000) },
      );
      await checked(response, status, code);
      sql(`UPDATE playback_sessions SET stopped=true WHERE id='${id}'`);
      cases.push({ layer: "Worker probe", scenario: selected, status, code });
      console.log(`PASS: Worker probe ${selected}: ${status}`);

      const key = randomUUID();
      const request = {
        idempotency_key: key,
        room_id: roomId,
        media_generation: generation,
        mode: "auto",
        position_ms: 0,
        audio_index: null,
        capabilities: null,
      };
      const serverCode = selected === "unknown" ? "SOURCE_PROBE_FAILED" : code;
      const prepared = await checked(
        await playback(request),
        status,
        serverCode,
      );
      const row = JSON.parse(
        sql(
          `SELECT json_build_object('status',r.status,'attempt',r.attempt,'error',r.error_code,'session',r.session_id,'stopped',p.stopped) FROM playback_requests r LEFT JOIN playback_sessions p ON p.id=r.session_id WHERE r.user_id='${userId}' AND r.idempotency_key='${key}'`,
        ),
      );
      sessions.push(row.session);
      assert.equal(row.attempt, 1);
      if (status === 409) {
        assert.equal(row.status, "failed");
        assert.equal(row.error, serverCode.toLowerCase());
        assert.equal(row.stopped, true, "failed preparation grant is revoked");
        const beforeReplay = seen.size;
        await checked(await playback(request), status, serverCode);
        assert.equal(
          seen.size,
          beforeReplay,
          "nonretryable replay starts no new probe",
        );
        assert.equal(
          sql(
            `SELECT attempt FROM playback_requests WHERE user_id='${userId}' AND idempotency_key='${key}'`,
          ),
          "1",
        );
      } else if (status === 200) {
        assert.equal(prepared.media_id, mediaId);
        assert.equal(prepared.delivery_mode, "direct");
        assert.equal(row.status, "completed");
      } else {
        assert.equal(row.error, "source_probe_failed");
        assert.equal(row.stopped, true);
      }
      sql(
        `UPDATE playback_sessions SET stopped=true WHERE id='${row.session}'`,
      );
      cases.push({
        layer: "Server auto",
        scenario: selected,
        status,
        code: serverCode,
      });
      console.log(`PASS: Server auto ${selected}: ${status}`);
    }
    assert.equal(
      peerFailure,
      undefined,
      "controlled Agent peer stayed healthy",
    );
    return cases;
  } finally {
    scenario = undefined;
    clearInterval(poll);
    for (const socket of sockets) socket.terminate();
    if (sessions.length)
      sql(
        `UPDATE playback_sessions SET stopped=true WHERE id IN (${sessions.map((id) => `'${id}'`).join(",")})`,
      );
    sql(
      `UPDATE room_snapshots SET state='${originalState.replaceAll("'", "''")}'::jsonb WHERE room_id='${roomId}'; UPDATE media_items SET available=false WHERE id='${mediaId}'`,
    );
  }
}
