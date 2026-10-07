import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { sourceMedia } from "./fixtures/source-grant.mjs";
import { withPlaybackAdmission } from "./fixtures/playback-admission.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

let owned;
let result = "failed";
try {
  await isolatedMediaStack("scoped-guests", async (f) => {
    owned = f;
    const admin = f.client(),
      owner = await admin.login();
    const room = await admin.request("/rooms", "POST", {
      name: "Guest fixture",
    });
    const other = await admin.request("/rooms", "POST", {
      name: "Other fixture",
    });
    const invitation = await admin.request(
      `/rooms/${room.id}/invites`,
      "POST",
      {
        max_uses: 100,
      },
    );
    const enter = (client, token = invitation.token, status = 201) =>
      client.request(
        `/rooms/${room.id}/guest-session`,
        "POST",
        { token, display_name: "Guest fixture" },
        status,
      );
    async function global(enabled) {
      const before = await admin.request("/admin/settings");
      await admin.request("/admin/settings", "PATCH", {
        expected_revision: before.revision,
        changes: { guests_enabled: enabled },
      });
    }
    const access = (enabled) =>
      admin.request(`/rooms/${room.id}/guest-access`, "PUT", { enabled });
    const resetRate = () =>
      f.sql("DELETE FROM account_rate_limits WHERE scope='guest-entry'");
    const sockets = new Set();
    async function connect(client, selected = room.id) {
      const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", {
        headers: { Origin: f.origin, Cookie: client.cookie },
      });
      sockets.add(ws);
      const frames = [];
      ws.on("message", (bytes) => frames.push(JSON.parse(bytes)));
      ws.on("error", () => {});
      await new Promise((done, reject) => {
        ws.once("open", done);
        ws.once("error", reject);
      });
      const send = (value) => ws.send(JSON.stringify(value));
      async function next(type) {
        const until = Date.now() + 10000;
        while (Date.now() < until) {
          const i = frames.findIndex((v) => v.type === type);
          if (i >= 0) return frames.splice(i, 1)[0];
          await delay(20);
        }
        throw Error(`Missing ${type}`);
      }
      send({ type: "JOIN", room_id: selected });
      return { ws, send, next };
    }
    try {
      assert.equal(
        (await admin.request(`/rooms/${room.id}/guest-access`)).enabled,
        false,
      );
      await enter(f.client(), invitation.token, 403);
      await global(true);
      await enter(f.client(), invitation.token, 403);
      await access(true);
      await enter(admin, invitation.token, 409);
      assert.equal((await admin.request("/auth/me")).id, owner.id);
      await enter(f.client(), "0".repeat(64), 403);
      const moderator = await admin.request(
        `/rooms/${room.id}/invites`,
        "POST",
        {
          role: "moderator",
          permissions: ["play"],
        },
      );
      await enter(f.client(), moderator.token, 403);
      const targeted = await admin.request(
        `/rooms/${room.id}/invites`,
        "POST",
        {
          invited_user_id: owner.id,
        },
      );
      await enter(f.client(), targeted.token, 403);
      const guest = f.client(),
        identity = await enter(guest);
      guest.csrf = identity.csrf;
      assert.equal(identity.guest, true);
      assert.equal(identity.guest_room_id, room.id);
      assert.equal(identity.admin, false);
      assert.ok(
        identity.guest_expires_at > Date.now() &&
          identity.guest_expires_at <= Date.now() + 7200000,
      );
      const restored = await guest.request("/auth/me");
      assert.equal(restored.id, identity.id);
      assert.equal(restored.guest, true);
      assert.deepEqual(
        (await guest.request("/rooms")).map((r) => r.id),
        [room.id],
      );
      await enter(guest, invitation.token, 409);
      for (const [path, method, body] of [
        ["/media", "GET"],
        ["/media/browse", "GET"],
        ["/sources", "GET"],
        ["/admin/settings", "GET"],
        ["/users/me/profile", "GET"],
        ["/users/me/profile", "PATCH", { display_name: "Elevate" }],
        ["/rooms", "POST", { name: "Guest room" }],
        [`/rooms/${other.id}/members`, "GET"],
        [`/rooms/${other.id}/messages`, "GET"],
        [`/rooms/${room.id}/guest-access`, "PUT", { enabled: false }],
        [`/rooms/${room.id}/invites`, "POST", {}],
        [`/rooms/${other.id}/join`, "POST", { token: invitation.token }],
        [
          "/auth/register",
          "POST",
          { username: "guest-register", password: f.password },
        ],
      ]) {
        const response = await guest.raw(path, { method, body });
        assert.equal(response.status, 403, `${method} ${path}`);
      }
      await guest.request(
        "/auth/login",
        "POST",
        { username: "admin", password: f.password },
        409,
      );
      await f
        .client()
        .request(
          "/auth/login",
          "POST",
          { username: identity.username, password: "!" },
          401,
        );
      await guest.request("/auth/logout", "POST", undefined, 403, {
        "x-csrf-token": "wrong",
      });
      assert.equal((await guest.request("/auth/me")).id, identity.id);
      await admin.request(
        `/rooms/${room.id}/permissions/${identity.id}`,
        "PUT",
        { role: "moderator", permissions: ["play"] },
        403,
      );
      const snapshot = JSON.parse(
        f.sql(`SELECT state FROM room_snapshots WHERE room_id='${room.id}'`),
      );
      await admin.request(
        `/rooms/${room.id}/owner`,
        "POST",
        { owner_id: identity.id, expected_revision: snapshot.revision },
        403,
      );
      const bytes = Buffer.alloc(8192, 7);
      await writeFile(resolve(f.root, "guest-view.bin"), bytes);
      const resource = {
        kind: "local",
        root: f.root,
        resource: "guest-view.bin",
      };
      const media = sourceMedia(f, resource),
        hidden = sourceMedia(f, {
          ...resource,
          resource: "private-not-selected.bin",
        });
      f.sql(
        `UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${media}"'),'{media_generation}','1') WHERE room_id='${room.id}'`,
      );
      assert.equal(
        (await guest.request(`/rooms/${room.id}/media/${media}`)).id,
        media,
      );
      await guest.request(
        `/rooms/${room.id}/media/${hidden}`,
        "GET",
        undefined,
        404,
      );
      const socket = await connect(guest),
        initial = await socket.next("SNAPSHOT");
      assert.equal(initial.control_epoch, null);
      const revision = initial.state.revision;
      socket.send({
        protocol_version: 1,
        type: "PAUSE",
        room_id: room.id,
        command_id: randomUUID(),
        expected_revision: revision,
        media_generation: 1,
      });
      await socket.next("ERROR");
      assert.equal(
        JSON.parse(
          f.sql(`SELECT state FROM room_snapshots WHERE room_id='${room.id}'`),
        ).revision,
        revision,
      );
      socket.send({
        type: "CHAT",
        body: "A temporary hello",
        client_message_id: randomUUID(),
      });
      const guestMessage = await socket.next("CHAT");
      assert.equal(guestMessage.body, "A temporary hello");
      const accountSocket = await connect(admin);
      await accountSocket.next("SNAPSHOT");
      accountSocket.send({
        type: "CHAT",
        body: "A registered reply",
        client_message_id: randomUUID(),
      });
      const accountMessage = await accountSocket.next("CHAT");
      assert.equal(accountMessage.body, "A registered reply");
      assert.equal((await socket.next("CHAT")).id, accountMessage.id);
      const historyFields = ({ id, user_id, body, display_name }) => ({
        id,
        user_id,
        body,
        display_name,
      });
      const expectedHistory = [
        {
          id: guestMessage.id,
          user_id: identity.id,
          body: "A temporary hello",
          display_name: identity.display_name,
        },
        {
          id: accountMessage.id,
          user_id: owner.id,
          body: "A registered reply",
          display_name: accountMessage.display_name,
        },
      ];
      // Exercise every history query for both admitted account and guest
      // callers. Default history must retain guest display names without
      // making joined room/identity/timestamp columns ambiguous.
      for (const reader of [admin, guest]) {
        const path = `/rooms/${room.id}/messages`;
        assert.deepEqual(
          (await reader.request(path)).map(historyFields),
          expectedHistory,
        );
        assert.deepEqual(
          (await reader.request(`${path}?after=${guestMessage.id}`)).map(
            historyFields,
          ),
          expectedHistory.slice(1),
        );
        assert.deepEqual(
          (
            await reader.request(
              `${path}?check_ids=${accountMessage.id},${guestMessage.id}`,
            )
          ).map(historyFields),
          expectedHistory,
        );
      }
      const wrong = await connect(guest, other.id);
      await wrong.next("ERROR");
      const nonce = randomBytes(12),
        cipher = createCipheriv(
          "aes-256-gcm",
          Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"),
          nonce,
        );
      const encrypted = Buffer.concat([
        nonce,
        cipher.update(JSON.stringify(resource)),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64");
      const playback = randomUUID(),
        delivery = randomBytes(32).toString("hex"),
        deliveryHash = createHash("sha256").update(delivery).digest("hex");
      withPlaybackAdmission(
        f,
        { client: guest, user: identity.id, room: room.id, session: playback },
        `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES('${playback}','${identity.id}','${room.id}','${media}',1,'${deliveryHash}','${JSON.stringify({ encrypted })}',clock_timestamp()+interval '30 minutes')`,
      );
      await f.startWorker();
      // Separate witness: real guest negotiation/preparation through public HTTP,
      // using a generated clip scanned through the administrator source workflow.
      await f.makeClip("guest-api.mp4");
      const apiSource = await admin.request("/sources", "POST", {
        name: "Guest API playback",
        kind: "local",
        config: { root: f.root },
      });
      await admin.request(`/sources/${apiSource.id}/test`, "POST");
      const apiMedia = (await admin.request("/media")).find((item) =>
        item.title.includes("guest-api"),
      );
      assert.ok(apiMedia);
      f.sql(
        `UPDATE room_snapshots SET state=jsonb_set(state,'{media_id}','"${apiMedia.id}"') WHERE room_id='${room.id}'`,
      );
      const request = {
        room_id: room.id,
        media_generation: 1,
        position_ms: 0,
        audio_index: null,
      };
      const candidates = await guest.request(
        "/playback-candidates",
        "POST",
        request,
      );
      assert.ok(candidates.binding);
      const candidate_report = {
        binding: candidates.binding,
        excluded_candidates: [],
        results: candidates.candidates.map((candidate) => ({
          candidate_id: candidate.id,
          progressive: candidate.id === "direct" ? "probably" : "unsupported",
          mse_supported: candidate.id === "direct",
          file_decoding: {
            supported: candidate.id === "direct",
            smooth: true,
            power_efficient: false,
          },
          mse_decoding: {
            supported: candidate.id === "direct",
            smooth: true,
            power_efficient: false,
          },
        })),
      };
      const plan = await guest.request("/playback-sessions", "POST", {
        ...request,
        mode: "auto",
        idempotency_key: randomUUID(),
        capabilities: {
          progressive_h264_aac: true,
          native_hls: false,
          mse_h264_aac: true,
        },
        candidate_report,
      });
      assert.equal(plan.media_id, apiMedia.id);
      assert.match(plan.playback_url, /^\/media-delivery\//);
      const apiDelivery = await fetch(f.workerOrigin + plan.playback_url);
      assert.equal(apiDelivery.status, 200);
      assert.ok((await apiDelivery.arrayBuffer()).byteLength > 0);
      await guest.request(`/playback-sessions/${plan.session_id}`);
      await guest.request(`/playback-sessions/${plan.session_id}`, "DELETE");
      await guest.request(
        "/playback-candidates",
        "POST",
        { ...request, room_id: other.id },
        403,
      );
      f.sql(
        `UPDATE room_snapshots SET state=jsonb_set(state,'{media_id}','"${media}"') WHERE room_id='${room.id}'`,
      );
      const url = `${f.workerOrigin}/media-delivery/${playback}/source?token=${delivery}`;
      const delivered = await fetch(url);
      assert.equal(delivered.status, 200);
      assert.deepEqual(Buffer.from(await delivered.arrayBuffer()), bytes);
      // Current-media changes deny even a previously minted cookie-less token.
      f.sql(
        `UPDATE room_snapshots SET state=jsonb_set(state,'{media_id}','"${hidden}"') WHERE room_id='${room.id}'`,
      );
      const changed = await fetch(url);
      assert.equal(changed.status, 401);
      assert.equal(
        (await changed.json()).error.code,
        "INVALID_PLAYBACK_SESSION",
      );
      f.sql(
        `UPDATE room_snapshots SET state=jsonb_set(state,'{media_id}','"${media}"') WHERE room_id='${room.id}'`,
      );
      await global(false);
      await guest.request("/auth/me", "GET", undefined, 401);
      socket.send({ type: "CLOCK_SYNC", t1: 0 });
      await socket.next("ERROR");
      for (const enabled of [false, true]) {
        if (enabled) await global(true);
        const response = await fetch(url);
        assert.equal(response.status, 401);
        assert.equal(
          (await response.json()).error.code,
          "INVALID_PLAYBACK_SESSION",
        );
      }
      await enter(guest, invitation.token, 409);
      await guest.request("/auth/logout", "POST", undefined, 403, {
        Origin: "https://wrong.invalid",
      });
      await guest.request("/auth/logout", "POST");
      assert.equal(guest.cookie, "rainsync_session=");
      assert.equal((await guest.login()).id, owner.id);
      await guest.request("/auth/logout", "POST");
      resetRate();
      const fresh = await enter(guest);
      guest.csrf = fresh.csrf;
      assert.notEqual(fresh.id, identity.id);
      await access(false);
      await access(true);
      await guest.request("/auth/me", "GET", undefined, 401);
      await guest.request("/auth/logout", "POST");
      const expiring = await enter(guest);
      guest.csrf = expiring.csrf;
      f.sql(
        `UPDATE guest_principals SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id='${expiring.id}'`,
      );
      await guest.request("/auth/me", "GET", undefined, 401);
      await guest.request("/auth/logout", "POST");
      const kicked = await enter(guest);
      guest.csrf = kicked.csrf;
      await admin.request(`/rooms/${room.id}/members/${kicked.id}`, "DELETE");
      await guest.request("/auth/me", "GET", undefined, 401);
      await guest.request("/auth/logout", "POST");
      const once = await admin.request(`/rooms/${room.id}/invites`, "POST", {
        max_uses: 1,
      });
      const one = f.client();
      await enter(one, once.token);
      await enter(f.client(), once.token, 403);
      resetRate();
      for (let i = 0; i < 10; i++) await enter(f.client(), "0".repeat(64), 403);
      await enter(f.client(), "0".repeat(64), 429);
      result = "passed";
      console.log(
        "PASS: guest defaults/invite consumption/live-account preservation, HTTP denylist, account/guest default/cursor/ID history, exact current media, WS read/chat/no control, public playback negotiation/preparation/readiness/stop, Worker bytes/global off-on revocation, stale-cookie logout/login, room disable/expiry/kick and entry rate limit",
      );
    } finally {
      for (const ws of sockets) ws.terminate();
    }
  });
} finally {
  if (owned) {
    const cleanup = await owned.verifyStopped();
    const worker = owned.workerPid
      ? {
          pid: owned.workerPid,
          pid_absent: verifyPidAbsent(owned.workerPid),
          port_closed: await verifyClosedPort(
            Number(new URL(owned.workerOrigin).port),
          ),
        }
      : null;
    if (worker) {
      assert.equal(worker.pid_absent, true);
      assert.equal(worker.port_closed, true);
    }
    await writeFile(
      resolve(owned.root, "guest-report.json"),
      JSON.stringify({ schema_version: 1, result, cleanup, worker }, null, 2),
    );
    console.log(`Owned guest fixture cleanup verified: ${owned.root}`);
  }
}
