import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function queueCapacity({ admin, room, state, sql }) {
  const ids = Array.from({ length: 20 }, () => randomUUID());
  const request = {
    room_id: room.id,
    media_generation: state.media_generation,
    mode: "remux",
    idempotency_key: randomUUID(),
  };
  const list = ids.map((id) => `'${id}'`).join(",");
  try {
    for (const id of ids) {
      sql(
        `INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES('${id}',0,'${id}','{}',now()+interval '1 hour'); INSERT INTO media_jobs(id,session_id,status,spec,lease_until) VALUES('${id}','${id}','running','{}',now()+interval '1 hour')`,
      );
    }
    const failure = await admin.request(
      "/playback-sessions",
      "POST",
      request,
      503,
    );
    assert.equal(failure.error.code, "MEDIA_QUEUE_FULL");
    assert.equal(failure.error.retryable, true);
    assert.equal(
      sql(
        `SELECT count(*) FROM playback_sessions p JOIN playback_requests r ON r.session_id=p.id WHERE r.idempotency_key='${request.idempotency_key}' AND NOT p.stopped`,
      ),
      "0",
    );
    assert.equal(
      sql(
        `SELECT count(*) FROM media_jobs j JOIN playback_requests r ON r.session_id=j.session_id WHERE r.idempotency_key='${request.idempotency_key}'`,
      ),
      "0",
    );
    const direct = await admin.request("/playback-sessions", "POST", {
      ...request,
      mode: "direct",
      idempotency_key: randomUUID(),
    });
    await admin.request(`/playback-sessions/${direct.session_id}`, "DELETE");
  } finally {
    sql(
      `DELETE FROM media_jobs WHERE id IN (${list}); DELETE FROM playback_sessions WHERE id IN (${list})`,
    );
  }
  const recovered = await admin.request("/playback-sessions", "POST", request);
  assert.equal(
    sql(
      `SELECT attempt FROM playback_requests WHERE idempotency_key='${request.idempotency_key}'`,
    ),
    "2",
  );
  await admin.request(`/playback-sessions/${recovered.session_id}`, "DELETE");
  console.log(
    "PASS: full media queue rejects atomically, preserves direct playback and permits same-key recovery",
  );
}
