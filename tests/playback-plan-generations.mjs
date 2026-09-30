import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";

const report = { schema_version: 1, checks: [], status: "running" };
let fixture;
try {
  await isolatedMediaStack(
    "playback-plan-generations",
    async (f) => {
      fixture = f;
      const admin = f.client();
      const identity = await admin.login();
      await f.makeClip("generation.mp4", { pictureSeconds: 2 });
      const source = await admin.request("/sources", "POST", {
        name: "owned generation media",
        kind: "local",
        config: { root: f.root },
      });
      await admin.request(`/sources/${source.id}/test`, "POST");
      const media = (await admin.request("/media")).find((v) =>
        v.title.includes("generation"),
      );
      assert.ok(media);
      await f.startWorker();
      const room = await admin.request("/rooms", "POST", {
        name: "generation scope",
      });
      const setMedia = (id, generation = 1, selected = media.id) =>
        f.sql(
          `UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${selected}"'),'{media_generation}','${generation}') WHERE room_id='${id}'`,
        );
      setMedia(room.id);
      const revision = () =>
        f.sql(
          `SELECT state->>'revision' FROM room_snapshots WHERE room_id='${room.id}'`,
        );
      const initialRevision = revision();
      const viewer = randomUUID();
      const input = {
        room_id: room.id,
        media_generation: 1,
        mode: "direct",
        position_ms: 0,
        viewer_id: viewer,
      };
      const prepare = (
        generation,
        extra = {},
        client = admin,
        expected = 200,
      ) =>
        client.request(
          "/playback-sessions",
          "POST",
          {
            ...input,
            plan_generation: generation,
            idempotency_key: randomUUID(),
            ...extra,
          },
          expected,
        );
      const check = (name) => {
        report.checks.push(name);
        console.log(`PASS: ${name}`);
      };
      const highWater = (who = identity.id, where = room.id, which = viewer) =>
        f.sql(
          `SELECT plan_generation FROM playback_viewer_plans WHERE user_id='${who}' AND room_id='${where}' AND viewer_id='${which}'`,
        );
      const ready = (p, generation = p.plan_generation) =>
        admin.request(
          `/playback-sessions/${p.session_id}${generation === undefined ? "" : `?plan_generation=${generation}`}`,
        );

      for (const body of [
        { ...input, plan_generation: 0 },
        { ...input },
        {
          room_id: room.id,
          media_generation: 1,
          mode: "direct",
          plan_generation: 1,
        },
      ]) {
        const invalid = await admin.request(
          "/playback-sessions",
          "POST",
          body,
          400,
        );
        assert.equal(invalid.error.code, "INVALID_PLAN_GENERATION");
      }
      assert.equal(highWater(), "");
      check("partial/zero generation rejected without creating high-water");

      const legacyKey = randomUUID();
      const legacyInput = {
        room_id: room.id,
        media_generation: 1,
        mode: "direct",
        idempotency_key: legacyKey,
      };
      const legacy = await admin.request(
        "/playback-sessions",
        "POST",
        legacyInput,
      );
      assert.equal(legacy.plan_generation, undefined);
      assert.equal(
        (await admin.request("/playback-sessions", "POST", legacyInput))
          .session_id,
        legacy.session_id,
      );
      assert.equal((await ready(legacy)).plan_generation, undefined);
      check(
        "legacy no-field plans, readiness and same-key replay stay compatible",
      );

      const key = randomUUID();
      const first = await prepare(1, {
        idempotency_key: key,
        observation_version: 1,
      });
      assert.equal(first.plan_generation, 1);
      assert.equal(highWater(), "1");
      assert.equal((await ready(first)).plan_generation, 1);
      assert.equal(
        (await prepare(1, { idempotency_key: key, observation_version: 1 }))
          .session_id,
        first.session_id,
      );
      assert.equal(
        (await prepare(1, {}, admin, 409)).error.code,
        "STALE_PLAYBACK_PLAN",
      );
      assert.equal(
        (
          await admin.request(
            `/playback-sessions/${first.session_id}?plan_generation=2`,
            "GET",
            undefined,
            409,
          )
        ).error.code,
        "STALE_PLAYBACK_PLAN",
      );
      check(
        "current generation echoes, replays one session, and rejects equal new keys/readiness mismatches",
      );

      const second = await prepare(3);
      assert.equal(second.plan_generation, 3);
      assert.equal(highWater(), "3");
      assert.equal(
        f.sql(
          `SELECT stopped FROM playback_sessions WHERE id='${first.session_id}'`,
        ),
        "t",
      );
      assert.equal(
        (await prepare(2, {}, admin, 409)).error.code,
        "STALE_PLAYBACK_PLAN",
      );
      assert.equal(
        (
          await prepare(
            1,
            { idempotency_key: key, observation_version: 1 },
            admin,
            409,
          )
        ).error.code,
        "STALE_PLAYBACK_PLAN",
      );
      await admin.request(
        `/playback-sessions/${first.session_id}`,
        "GET",
        undefined,
        410,
      );
      await admin.request(
        `/playback-sessions/${first.session_id}`,
        "POST",
        undefined,
        410,
      );
      const retiredDelivery = await fetch(f.workerOrigin + first.playback_url);
      assert.equal(retiredDelivery.status, 401);
      await retiredDelivery.arrayBuffer();
      await admin.request(
        `/playback-sessions/${first.session_id}/observations`,
        "POST",
        {
          media_generation: 1,
          seq: 1,
          event: "playing",
          media_time_ms: 0,
          paused: false,
          seeking: false,
          buffering: false,
          playback_rate: 1,
          has_played: true,
        },
        410,
      );
      assert.equal((await ready(legacy)).status, "ready");
      check(
        "newer generation retires old replay/readiness/renewal/delivery/observations without retiring legacy grants",
      );

      await admin.request(`/playback-sessions/${second.session_id}`, "DELETE");
      assert.equal(highWater(), "3");
      assert.equal(
        (await prepare(3, {}, admin, 409)).error.code,
        "STALE_PLAYBACK_PLAN",
      );
      const failedKey = randomUUID();
      assert.equal(
        (
          await prepare(
            5,
            { idempotency_key: failedKey, audio_index: 999 },
            admin,
            400,
          )
        ).error.code,
        "INVALID_AUDIO_TRACK",
      );
      assert.equal(highWater(), "5");
      assert.equal(
        (await prepare(4, {}, admin, 409)).error.code,
        "STALE_PLAYBACK_PLAN",
      );
      const pendingKey = randomUUID();
      await admin.request(`/playback-requests/${pendingKey}`, "DELETE");
      assert.equal(
        (await prepare(6, { idempotency_key: pendingKey }, admin, 410)).error
          .code,
        "PLAYBACK_REQUEST_CANCELLED",
      );
      const sixth = await prepare(6);
      await admin.request(
        `/playback-requests/${f.sql(`SELECT idempotency_key FROM playback_requests WHERE session_id='${sixth.session_id}'`)}`,
        "DELETE",
      );
      assert.equal(highWater(), "6");
      check(
        "failure, stop and cancellation preserve durable high-water; cancel-before-POST remains fenced",
      );

      const seventh = await prepare(7);
      const otherViewer = randomUUID();
      const independent = await prepare(1, { viewer_id: otherViewer });
      assert.equal((await ready(seventh)).status, "ready");
      assert.equal(highWater(identity.id, room.id, otherViewer), "1");
      const otherRoom = await admin.request("/rooms", "POST", {
        name: "other generation room",
      });
      setMedia(otherRoom.id);
      await prepare(1, { room_id: otherRoom.id });
      await admin.request("/users", "POST", {
        username: "generation-viewer",
        password: f.password,
      });
      const member = f.client();
      const memberIdentity = await member.login("generation-viewer");
      assert.equal(
        (await prepare(99, {}, member, 403)).error.code,
        "NOT_A_MEMBER",
      );
      assert.equal(highWater(memberIdentity.id), "");
      const invite = await admin.request(`/rooms/${room.id}/invites`, "POST");
      await member.request(`/rooms/${room.id}/join`, "POST", {
        token: invite.token,
      });
      const memberPlan = await prepare(1, {}, member);
      assert.equal(memberPlan.plan_generation, 1);
      assert.equal((await ready(seventh)).status, "ready");
      check(
        "viewer/user/room scopes are independent and identity never bypasses membership",
      );

      await admin.request("/playback-candidates", "POST", {
        room_id: room.id,
        media_generation: 1,
        position_ms: 0,
      });
      assert.equal(highWater(), "7");
      assert.equal((await ready(seventh)).status, "ready");
      assert.equal(
        f.sql(
          "SELECT count(*) FROM playback_requests WHERE viewer_id IS NULL AND plan_generation IS NOT NULL",
        ),
        "0",
      );
      check(
        "real FFmpeg candidate discovery does not advance or retire playback generation",
      );

      // Concurrent same generation admissions are serialized through real PG locks.
      const contenders = await Promise.all(
        [8, 8].map((generation) =>
          admin.raw("/playback-sessions", {
            method: "POST",
            body: {
              ...input,
              plan_generation: generation,
              idempotency_key: randomUUID(),
            },
          }),
        ),
      );
      assert.deepEqual(contenders.map((r) => r.status).sort(), [200, 409]);
      for (const response of contenders) await response.arrayBuffer();
      assert.equal(highWater(), "8");
      assert.equal(
        f.sql(
          `SELECT count(*) FROM playback_sessions WHERE user_id='${identity.id}' AND room_id='${room.id}' AND viewer_id='${viewer}' AND NOT stopped`,
        ),
        "1",
      );
      check(
        "simultaneous equal-generation new keys admit exactly one durable plan",
      );

      setMedia(room.id, 2);
      assert.equal(
        (await prepare(9, {}, admin, 409)).error.code,
        "STALE_MEDIA",
      );
      assert.equal(highWater(), "8");
      const ninth = await prepare(9, { media_generation: 2 });
      assert.equal(ninth.plan_generation, 9);
      assert.equal(revision(), initialRevision);
      await f.startServer();
      assert.equal(highWater(), "9");
      assert.equal(
        (await prepare(8, { media_generation: 2 }, admin, 409)).error.code,
        "STALE_PLAYBACK_PLAN",
      );
      assert.equal((await ready(ninth)).status, "ready");
      check(
        "media fencing is independent, no room revision changes, and restart retains high-water",
      );

      await f.startServer({ PLAYBACK_SESSION_LIMIT: "1" });
      const quotaKey = randomUUID();
      const rejected = await prepare(
        10,
        { media_generation: 2, idempotency_key: quotaKey },
        admin,
        429,
      );
      assert.equal(rejected.error.code, "TOO_MANY_PLAYBACK_SESSIONS");
      assert.equal(highWater(), "9");
      assert.equal(
        f.sql(
          `SELECT count(*) FROM playback_requests WHERE idempotency_key='${quotaKey}'`,
        ),
        "0",
      );
      assert.equal(
        f.sql(
          `SELECT stopped FROM playback_sessions WHERE id='${ninth.session_id}'`,
        ),
        "f",
      );
      await f.startServer();
      await prepare(10, { media_generation: 2, idempotency_key: quotaKey });
      check(
        "quota rejection rolls back high-water and retirement; same logical intent succeeds after capacity recovery",
      );

      const capRoom = await admin.request("/rooms", "POST", {
        name: "bounded viewer scope",
      });
      setMedia(capRoom.id);
      const capViewer = "00000000-0000-4000-8000-000000000001";
      f.sql(
        `INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation) SELECT '${identity.id}','${capRoom.id}',('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,1 FROM generate_series(1,1024) i`,
      );
      const cappedKey = randomUUID(),
        cappedViewer = randomUUID();
      const capped = await prepare(
        1,
        {
          room_id: capRoom.id,
          viewer_id: cappedViewer,
          idempotency_key: cappedKey,
        },
        admin,
        429,
      );
      assert.equal(capped.error.code, "PLAYBACK_VIEWER_LIMIT_EXCEEDED");
      assert.equal(
        f.sql(
          `SELECT count(*) FROM playback_requests WHERE idempotency_key='${cappedKey}'`,
        ),
        "0",
      );
      assert.equal(highWater(identity.id, capRoom.id, cappedViewer), "");
      assert.equal(
        (await prepare(2, { room_id: capRoom.id, viewer_id: capViewer }))
          .plan_generation,
        2,
      );
      const capInvite = await admin.request(
        `/rooms/${capRoom.id}/invites`,
        "POST",
      );
      await member.request(`/rooms/${capRoom.id}/join`, "POST", {
        token: capInvite.token,
      });
      assert.equal(
        (
          await prepare(
            1,
            { room_id: capRoom.id, viewer_id: cappedViewer },
            member,
          )
        ).plan_generation,
        1,
      );
      assert.equal(
        f.sql(
          `SELECT count(*) FROM playback_viewer_plans WHERE user_id='${identity.id}' AND room_id='${capRoom.id}'`,
        ),
        "1024",
      );
      check(
        "1024-viewer cap has no failed-admission side effects, preserves existing viewers, and isolates users",
      );

      // This controlled HTTP probe endpoint tests preparation ordering, not real
      // product or Worker decoding compatibility. The metadata came from ffprobe.
      const metadata = JSON.parse(
        f.sql(`SELECT metadata FROM media_items WHERE id='${media.id}'`),
      );
      const offers = [];
      const peer = createServer((_request, response) => offers.push(response));
      await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${peer.address().port}`;
      const respond = (response, status = 200) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(metadata));
      };
      try {
        await f.startServer({ WORKER_URL: origin });
        const delayedSource = await admin.request("/sources", "POST", {
          name: "controlled probe",
          kind: "http",
          config: { url: origin + "/media.mp4" },
        });
        const delayedMedia = randomUUID();
        f.sql(
          `INSERT INTO media_items(id,source_id,title,resource,metadata) VALUES('${delayedMedia}','${delayedSource.id}','controlled probe','media.mp4','{}')`,
        );
        const delayedRoom = await admin.request("/rooms", "POST", {
          name: "late publication",
        });
        setMedia(delayedRoom.id, 1, delayedMedia);
        const delayedViewer = randomUUID();
        const delayedInput = {
          room_id: delayedRoom.id,
          viewer_id: delayedViewer,
          media_generation: 1,
          mode: "auto",
          position_ms: 0,
          plan_generation: 1,
          idempotency_key: randomUUID(),
        };
        const late = admin.raw("/playback-sessions", {
          method: "POST",
          body: delayedInput,
          signal: AbortSignal.timeout(60000),
        });
        for (let i = 0; i < 100 && offers.length < 1; i++) await delay(30);
        assert.equal(offers.length, 1);
        const pendingReplay = await admin.request(
          "/playback-sessions",
          "POST",
          delayedInput,
          409,
        );
        assert.equal(pendingReplay.error.code, "PLAYBACK_REQUEST_IN_PROGRESS");
        const oldSession = f.sql(
          `SELECT session_id FROM playback_requests WHERE idempotency_key='${delayedInput.idempotency_key}'`,
        );
        const newer = await admin.request("/playback-sessions", "POST", {
          ...delayedInput,
          mode: "direct",
          plan_generation: 2,
          idempotency_key: randomUUID(),
        });
        respond(offers[0]);
        const lateResponse = await late;
        assert.equal(lateResponse.status, 409);
        assert.equal(
          (await lateResponse.json()).error.code,
          "STALE_PLAYBACK_PLAN",
        );
        assert.equal(
          f.sql(
            `SELECT stopped FROM playback_sessions WHERE id='${oldSession}'`,
          ),
          "t",
        );
        await f.waitForSql(
          `SELECT drained_at IS NOT NULL FROM playback_preparations WHERE session_id='${oldSession}'`,
          "t",
        );
        assert.equal((await ready(newer)).status, "ready");
        check(
          "late old preparation cannot publish after successor; real owner drain acknowledgement remains separate",
        );

        const retryInput = {
          ...delayedInput,
          plan_generation: 3,
          idempotency_key: randomUUID(),
        };
        const failed = admin.raw("/playback-sessions", {
          method: "POST",
          body: retryInput,
        });
        for (let i = 0; i < 100 && offers.length < 2; i++) await delay(30);
        assert.equal(offers.length, 2);
        respond(offers[1], 502);
        const failure = await failed;
        assert.equal(failure.status, 502);
        await failure.arrayBuffer();
        const retried = admin.raw("/playback-sessions", {
          method: "POST",
          body: retryInput,
        });
        for (let i = 0; i < 100 && offers.length < 3; i++) await delay(30);
        assert.equal(offers.length, 3);
        respond(offers[2]);
        const retriedResponse = await retried;
        assert.equal(retriedResponse.status, 200);
        assert.equal((await retriedResponse.json()).plan_generation, 3);
        assert.equal(
          f.sql(
            `SELECT attempt || ':' || plan_generation FROM playback_requests WHERE idempotency_key='${retryInput.idempotency_key}'`,
          ),
          "2:3",
        );
        check(
          "same-key transient preparation retry keeps its generation and creates one current session",
        );
      } finally {
        peer.closeAllConnections();
        await new Promise((resolve) => peer.close(resolve));
      }
      const beforeClose = await admin.request(`/rooms/${room.id}/lifecycle`);
      await admin.request(`/rooms/${room.id}/close`, "POST", {
        expected_revision: beforeClose.state.revision,
      });
      await f.waitForSql(
        `SELECT lifecycle FROM rooms WHERE id='${room.id}'`,
        "closed",
        15000,
      );
      const closed = await admin.request(`/rooms/${room.id}/lifecycle`);
      await admin.request(`/rooms/${room.id}/reopen`, "POST", {
        expected_revision: closed.state.revision,
      });
      assert.equal(highWater(), "10");
      assert.equal(
        (await prepare(10, { media_generation: 2 }, admin, 409)).error.code,
        "STALE_PLAYBACK_PLAN",
      );
      assert.equal(
        (await prepare(11, { media_generation: 2 })).plan_generation,
        11,
      );
      check(
        "close/reopen keeps independent media/epoch checks and never resets viewer high-water",
      );
      await f.stopWorker();
      report.status = "passed";
    },
    { env: { PLAYBACK_SESSION_LIMIT: "64" } },
  );
  report.cleanup = await fixture.verifyStopped();
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (fixture) {
    report.postgres = fixture.postgresDiagnostics();
    report.completed_at = new Date().toISOString();
    const path = resolve(fixture.root, "report.json");
    await writeFile(path, JSON.stringify(report, null, 2));
    console.log(`Evidence: ${path}`);
  }
}
