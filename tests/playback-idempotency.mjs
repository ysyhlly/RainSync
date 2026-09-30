import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function playbackIdempotency({ admin, friend, room, state, sql }) {
  const request = {
    idempotency_key: randomUUID(),
    room_id: room.id,
    media_generation: state.media_generation,
    mode: "remux",
  };
  const responses = await Promise.all(
    Array.from({ length: 6 }, () =>
      friend.request("/playback-sessions", "POST", request, [200, 409]),
    ),
  );
  const plans = responses.filter((r) => r.session_id);
  assert.ok(plans.length > 0);
  for (const error of responses.filter((r) => r.error))
    assert.equal(error.error.code, "PLAYBACK_REQUEST_IN_PROGRESS");
  const plan = await friend.request("/playback-sessions", "POST", request);
  assert.ok(
    plans.every(
      (p) =>
        p.session_id === plan.session_id &&
        p.playback_url === plan.playback_url,
    ),
  );
  assert.equal(
    sql(
      `SELECT count(*) FROM media_jobs WHERE session_id='${plan.session_id}'`,
    ),
    "1",
  );
  assert.equal(
    sql(
      `SELECT count(*) FROM playback_requests WHERE idempotency_key='${request.idempotency_key}'`,
    ),
    "1",
  );
  const ciphertext = sql(
    `SELECT response_encrypted FROM playback_requests WHERE idempotency_key='${request.idempotency_key}'`,
  );
  assert.ok(!ciphertext.includes(plan.playback_url));
  assert.ok(
    !ciphertext.includes(
      new URL(plan.playback_url, "http://local").searchParams.get("token"),
    ),
  );
  const conflict = await friend.request(
    "/playback-sessions",
    "POST",
    { ...request, position_ms: 1000 },
    409,
  );
  assert.equal(conflict.error.code, "PLAYBACK_REQUEST_CONFLICT");
  const other = await admin.request("/playback-sessions", "POST", request);
  assert.notEqual(other.session_id, plan.session_id, "keys are scoped by user");
  await admin.request(`/playback-sessions/${other.session_id}`, "DELETE");
  sql(
    `UPDATE playback_requests SET expires_at=now()-interval '1 hour' WHERE session_id='${plan.session_id}'`,
  );
  const retained = await friend.request("/playback-sessions", "POST", request);
  assert.equal(
    retained.playback_url,
    plan.playback_url,
    "active completed session wins over record retention",
  );
  sql(
    `UPDATE playback_requests SET expires_at=now()+interval '1 minute' WHERE session_id='${plan.session_id}'`,
  );
  await friend.request(`/playback-sessions/${plan.session_id}`, "POST");
  assert.equal(
    sql(
      `SELECT expires_at>now()+interval '47 hours' FROM playback_requests WHERE session_id='${plan.session_id}'`,
    ),
    "t",
  );
  sql(
    `UPDATE playback_sessions SET expires_at=now()+interval '4 seconds' WHERE id='${plan.session_id}'`,
  );
  const replay = await friend.request("/playback-sessions", "POST", request);
  assert.ok(replay.expires_in_seconds > 0 && replay.expires_in_seconds <= 4);
  await friend.request(`/playback-sessions/${plan.session_id}`, "DELETE");
  const ended = await friend.request(
    "/playback-sessions",
    "POST",
    request,
    410,
  );
  assert.equal(ended.error.code, "PLAYBACK_REQUEST_EXPIRED");
  assert.equal(
    sql(
      `SELECT count(*) FROM media_jobs WHERE session_id='${plan.session_id}'`,
    ),
    "1",
  );

  const invalid = {
    ...request,
    idempotency_key: randomUUID(),
    mode: "invalid",
  };
  assert.equal(
    (await friend.request("/playback-sessions", "POST", invalid, 400)).error
      .code,
    "INVALID_MODE",
  );
  assert.equal(
    (await friend.request("/playback-sessions", "POST", invalid, 400)).error
      .code,
    "INVALID_MODE",
  );
  assert.equal(
    (
      await friend.request(
        "/playback-sessions",
        "POST",
        { ...invalid, mode: "direct" },
        409,
      )
    ).error.code,
    "PLAYBACK_REQUEST_CONFLICT",
  );

  // Insert failure must roll back both the new playback session and its task.
  const failing = { ...request, idempotency_key: randomUUID() };
  sql(
    "ALTER TABLE media_jobs ADD CONSTRAINT reject_new_test_job CHECK (false) NOT VALID",
  );
  try {
    assert.equal(
      (await friend.request("/playback-sessions", "POST", failing, 500)).error
        .code,
      "DATABASE_ERROR",
    );
    const id = sql(
      `SELECT session_id FROM playback_requests WHERE idempotency_key='${failing.idempotency_key}'`,
    );
    assert.equal(
      sql(`SELECT count(*) FROM playback_sessions WHERE id='${id}'`),
      "0",
    );
    assert.equal(
      sql(`SELECT count(*) FROM media_jobs WHERE session_id='${id}'`),
      "0",
    );
  } finally {
    sql("ALTER TABLE media_jobs DROP CONSTRAINT reject_new_test_job");
  }
  assert.equal(
    (await friend.request("/playback-sessions", "POST", failing, 500)).error
      .code,
    "DATABASE_ERROR",
    "failed requests do not silently become a new side effect when the source recovers",
  );

  for (const reason of ["source_probe_failed", "media_unavailable"]) {
    const transient = {
      ...request,
      mode: "direct",
      idempotency_key: randomUUID(),
    };
    const old = await friend.request("/playback-sessions", "POST", transient);
    sql(
      `UPDATE playback_requests SET status='failed',response_encrypted=NULL,error_status=502,error_code='${reason}' WHERE session_id='${old.session_id}'`,
    );
    const recovered = await friend.request(
      "/playback-sessions",
      "POST",
      transient,
    );
    assert.notEqual(recovered.session_id, old.session_id);
    assert.equal(
      sql(`SELECT stopped FROM playback_sessions WHERE id='${old.session_id}'`),
      "t",
    );
    assert.equal(
      sql(
        `SELECT attempt FROM playback_requests WHERE session_id='${recovered.session_id}'`,
      ),
      "2",
    );
    await friend.request(
      `/playback-sessions/${recovered.session_id}`,
      "DELETE",
    );
  }

  const cancelled = { ...request, idempotency_key: randomUUID() };
  await friend.request(
    `/playback-requests/${cancelled.idempotency_key}`,
    "DELETE",
  );
  assert.equal(
    (await friend.request("/playback-sessions", "POST", cancelled, 410)).error
      .code,
    "PLAYBACK_REQUEST_CANCELLED",
  );
  // Another user's tombstone cannot block or revoke this user's key.
  const isolated = await admin.request("/playback-sessions", "POST", cancelled);
  await friend.request(
    `/playback-requests/${cancelled.idempotency_key}`,
    "DELETE",
  );
  assert.equal(
    sql(
      `SELECT stopped FROM playback_sessions WHERE id='${isolated.session_id}'`,
    ),
    "f",
  );
  await admin.request(
    `/playback-requests/${cancelled.idempotency_key}`,
    "DELETE",
  );
  assert.equal(
    sql(
      `SELECT stopped FROM playback_sessions WHERE id='${isolated.session_id}'`,
    ),
    "t",
  );
  assert.equal(
    sql(
      `SELECT count(*) FROM media_jobs WHERE session_id='${isolated.session_id}' AND status IN('queued','running')`,
    ),
    "0",
  );
  // Repeated lost responses followed by key cancellation never exhaust quota.
  for (let i = 0; i < 10; i++) {
    const lost = { ...request, mode: "direct", idempotency_key: randomUUID() };
    const created = await friend.request("/playback-sessions", "POST", lost);
    await friend.request(
      `/playback-requests/${lost.idempotency_key}`,
      "DELETE",
    );
    assert.equal(
      sql(
        `SELECT stopped FROM playback_sessions WHERE id='${created.session_id}'`,
      ),
      "t",
    );
  }

  const concurrent = await Promise.all(
    Array.from({ length: 12 }, () =>
      admin.request(
        "/playback-sessions",
        "POST",
        { ...request, mode: "direct", idempotency_key: randomUUID() },
        [200, 429],
      ),
    ),
  );
  const active = concurrent.filter((p) => p.session_id);
  assert.equal(
    active.length,
    8,
    "user quota is atomic across distinct concurrent keys",
  );
  for (const error of concurrent.filter((p) => p.error))
    assert.equal(error.error.code, "TOO_MANY_PLAYBACK_SESSIONS");
  await Promise.all(
    active.map((p) =>
      admin.request(`/playback-sessions/${p.session_id}`, "DELETE"),
    ),
  );
  console.log(
    "PASS: playback request replay, concurrent quota, user/key binding, encrypted results, expiry, renewal, and transaction failure",
  );
}

export async function preparePlaybackRestart({ admin, room, state, sql }) {
  const request = {
    idempotency_key: randomUUID(),
    room_id: room.id,
    media_generation: state.media_generation,
    mode: "direct",
  };
  const completed = await admin.request("/playback-sessions", "POST", request);
  const pending = { ...request, idempotency_key: randomUUID() };
  const preparation = await admin.request(
    "/playback-sessions",
    "POST",
    pending,
  );
  // Simulate a durable reservation with an active probe grant at process loss.
  sql(
    `UPDATE playback_requests SET status='pending',response_encrypted=NULL WHERE session_id='${preparation.session_id}'`,
  );
  const accountBound = sql(`SELECT s.kind IN ('jellyfin','emby') FROM playback_sessions p JOIN media_items m ON m.id=p.media_id JOIN sources s ON s.id=m.source_id WHERE p.id='${completed.session_id}'`) === "t";
  return { request, completed, pending, preparation, accountBound };
}

export async function verifyPlaybackRestart({ admin, sql }, cases) {
  const replay = await admin.request(
    "/playback-sessions",
    "POST",
    cases.request,
    cases.accountBound ? 410 : 200,
  );
  if (cases.accountBound) {
    assert.equal(replay.error.code,"PLAYBACK_REQUEST_EXPIRED");
    assert.equal(sql(`SELECT stopped FROM playback_sessions WHERE id='${cases.completed.session_id}'`),"t","restart invalidates old upstream-account generation");
  } else {
    assert.equal(replay.session_id, cases.completed.session_id);
    assert.equal(replay.playback_url, cases.completed.playback_url);
  }
  const recovered = await admin.request(
    "/playback-sessions",
    "POST",
    cases.pending,
  );
  assert.notEqual(recovered.session_id, cases.preparation.session_id);
  if(cases.accountBound) {
    assert.equal(sql(`SELECT (fresh.resource->>'account_policy_generation')::bigint > (old.resource->>'account_policy_generation')::bigint FROM playback_sessions fresh,playback_sessions old WHERE fresh.id='${recovered.session_id}' AND old.id='${cases.completed.session_id}'`),"t","fresh authorization uses a new generation");
    assert.equal(sql(`SELECT fresh.play_session_id IS DISTINCT FROM old.play_session_id FROM upstream_reservations fresh,upstream_reservations old WHERE fresh.id='${recovered.session_id}' AND old.id='${cases.completed.session_id}'`),"t","new grant never replays the old upstream SID");
    await admin.request(`/playback-sessions/${cases.completed.session_id}`,"POST",undefined,410);
  }
  assert.equal(
    sql(
      `SELECT attempt FROM playback_requests WHERE session_id='${recovered.session_id}'`,
    ),
    "2",
  );
  assert.equal(
    sql(
      `SELECT stopped FROM playback_sessions WHERE id='${cases.preparation.session_id}'`,
    ),
    "t",
  );
  assert.equal(
    sql(
      `SELECT count(*) FROM playback_requests WHERE idempotency_key='${cases.pending.idempotency_key}'`,
    ),
    "1",
  );
  console.log(
    "PASS: restart preserves eligible replay and rejects old upstream-account grants; interrupted preparation recovers with a fenced new grant",
  );
}
