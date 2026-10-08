import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";
// Synthetic metadata only; this fixture does not access platforms or play media.
let fixture;
const report = {
  schema_version: 1,
  result: "running",
  scope:
    "Isolated synthetic PostgreSQL/REST/WS timeline and closed declarative metadata plugins; no media/platform/device/sustained SLA acceptance",
  checks: [],
};
await isolatedServer("timeline-plugin-runtime", async (f) => {
  fixture = f;
  report.server_binary_sha256 = createHash("sha256")
    .update(
      await readFile(
        process.platform === "linux"
          ? `/proc/${f.serverPid}/exe`
          : resolve(f.target, "rainsync-server"),
      ),
    )
    .digest("hex");
  const sockets = new Set();
  try {
    const owner = f.client(),
      ownerIdentity = await owner.login();
    await owner.request("/users", "POST", {
      username: "timeline-viewer",
      password: f.password,
    });
    const viewer = f.client(),
      viewerIdentity = await viewer.login("timeline-viewer", f.password),
      stranger = f.client();
    await owner.request("/users", "POST", {
      username: "timeline-stranger",
      password: f.password,
    });
    await stranger.login("timeline-stranger", f.password);
    const room = await owner.request("/rooms", "POST", {
        name: "synthetic timeline",
      }),
      invite = await owner.request(`/rooms/${room.id}/invites`, "POST");
    await viewer.request(`/rooms/${room.id}/join`, "POST", {
      token: invite.token,
    });
    const source = randomUUID(),
      media = randomUUID();
    f.sql(
      `INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${source}','synthetic catalog','local','not-a-playback-credential'); INSERT INTO media_items(id,source_id,title,resource,duration_ms,source_version) VALUES('${media}','${source}','Synthetic timeline title','fixture-only.mp4',60000,'fixture-v1'); UPDATE room_snapshots SET state=state||jsonb_build_object('media_id','${media}','media_generation',1,'duration_ms',60000) WHERE room_id='${room.id}';`,
    );
    async function connect(client) {
      const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", {
        headers: { Origin: f.origin, Cookie: client.cookie },
      });
      sockets.add(ws);
      const frames = [];
      ws.on("message", (b) => frames.push(JSON.parse(b)));
      ws.on("error", () => {});
      await new Promise((done, reject) => {
        ws.once("open", done);
        ws.once("error", reject);
      });
      const next = async (type, predicate = () => true) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const i = frames.findIndex((v) => v.type === type && predicate(v));
          if (i >= 0) return frames.splice(i, 1)[0];
          await delay(10);
        }
        throw Error(`Missing ${type}: ${JSON.stringify(frames)}`);
      };
      ws.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
      const initial = await next("SNAPSHOT");
      return { ws, next, initial, send: (v) => ws.send(JSON.stringify(v)) };
    }
    const normalSocket = await connect(viewer),
      controlSocket = await connect(owner);
    const normalInput = {
      type: "CHAT",
      body: "ordinary deleted retry",
      client_message_id: randomUUID(),
    };
    normalSocket.send(normalInput);
    const normal = await normalSocket.next(
      "CHAT",
      (v) => v.client_message_id === normalInput.client_message_id,
    );
    const prefix = `/rooms/${room.id}/timeline`,
      activity = (await owner.request(`${prefix}/current`)).activity;
    assert.equal(activity.media_id, media);
    assert.equal(activity.versioned, true);
    await stranger.request(`${prefix}/current`, "GET", undefined, 403);
    const input = {
      client_message_id: randomUUID(),
      activity_id: activity.id,
      body: "synthetic anchored comment",
      anchor_source: "client_reported",
      media_time_ms: 12000,
    };
    const first = await viewer.request(`${prefix}/messages`, "POST", input),
      repeat = await viewer.request(`${prefix}/messages`, "POST", input);
    assert.equal(first.message.id, repeat.message.id);
    assert.equal(repeat.replayed, true);
    await viewer.request(
      `${prefix}/messages`,
      "POST",
      { ...input, body: "changed payload" },
      409,
    );
    await viewer.request(
      `${prefix}/messages`,
      "POST",
      { ...input, client_message_id: randomUUID(), media_time_ms: 60001 },
      400,
    );
    const page = await viewer.request(
      `${prefix}/messages?activity_id=${activity.id}`,
    );
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].anchor_source, "client_reported");
    await viewer.request(
      `${prefix}/moderation`,
      "POST",
      {
        action: "delete",
        message_id: first.message.id,
        reason: "not moderator",
      },
      403,
    );
    await owner.request(`${prefix}/moderation`, "POST", {
      action: "delete",
      message_id: first.message.id,
      reason: "synthetic moderation",
    });
    const removed = await viewer.request(
      `${prefix}/messages?activity_id=${activity.id}`,
    );
    assert.equal(removed.items[0].deleted, true);
    assert.equal(removed.items[0].body, "");
    assert.equal(
      (await viewer.request(`${prefix}/messages`, "POST", input)).message
        .deleted,
      true,
      "replay cannot resurrect a tombstone",
    );
    await owner.request(`${prefix}/moderation`, "POST", {
      action: "delete",
      message_id: normal.id,
      reason: "ordinary tombstone fixture",
    });
    await normalSocket.next("CHAT_DELETED", (v) => v.id === normal.id);
    normalSocket.send(normalInput);
    const normalReplay = await normalSocket.next(
      "CHAT",
      (v) => v.client_message_id === normalInput.client_message_id,
    );
    assert.equal(normalReplay.id, normal.id);
    assert.equal(normalReplay.body, "");
    assert.equal(normalReplay.deleted, true);
    const checked = await viewer.request(
      `/rooms/${room.id}/messages?check_ids=${normal.id}`,
    );
    assert.equal(checked.length, 1);
    assert.equal(checked[0].deleted, true);
    await stranger.request(
      `/rooms/${room.id}/messages?check_ids=${normal.id}`,
      "GET",
      undefined,
      403,
    );
    const ordinary = await owner.request(`/rooms/${room.id}/messages`);
    assert.equal(ordinary.find((m) => m.id === first.message.id).body, "");
    await owner.request(`${prefix}/moderation`, "POST", {
      action: "mute",
      target_user_id: viewerIdentity.id,
      minutes: 10,
      reason: "rate fixture",
    });
    await viewer.request(
      `${prefix}/messages`,
      "POST",
      { ...input, client_message_id: randomUUID() },
      403,
    );
    await viewer.request(
      `${prefix}/reactions`,
      "POST",
      {
        client_reaction_id: randomUUID(),
        activity_id: activity.id,
        emoji: "👏",
      },
      403,
    );
    await owner.request(`${prefix}/moderation`, "POST", {
      action: "unmute",
      target_user_id: viewerIdentity.id,
      reason: "fixture resume",
    });
    const reaction = {
      client_reaction_id: randomUUID(),
      activity_id: activity.id,
      emoji: "👏",
    };
    await viewer.request(`${prefix}/reactions`, "POST", reaction);
    assert.equal(
      (await viewer.request(`${prefix}/reactions`, "POST", reaction)).replayed,
      true,
    );
    await viewer.request(
      `${prefix}/reactions`,
      "POST",
      { ...reaction, emoji: "🎉" },
      409,
    );
    await viewer.request(
      `${prefix}/reactions`,
      "POST",
      { ...reaction, client_reaction_id: randomUUID(), emoji: "<script>" },
      400,
    );
    const events = await owner.request(
      `${prefix}/reactions?activity_id=${activity.id}`,
    );
    assert.equal(events.items.length, 1);
    assert.ok(events.items[0].expires_at - events.server_now_ms <= 8000);
    const commandId = randomUUID(),
      ackStart = Date.now();
    const burstWork = Promise.all(
      Array.from({ length: 15 }, () =>
        viewer.raw(`${prefix}/reactions`, {
          method: "POST",
          body: {
            client_reaction_id: randomUUID(),
            activity_id: activity.id,
            emoji: "🎉",
          },
        }),
      ),
    );
    controlSocket.send({
      protocol_version: 1,
      room_id: room.id,
      command_id: commandId,
      control_epoch: controlSocket.initial.control_epoch.id,
      expected_revision: controlSocket.initial.state.revision,
      media_generation: 1,
      type: "PAUSE",
    });
    await controlSocket.next("ACK", (v) => v.command_id === commandId);
    const ackMs = Date.now() - ackStart;
    assert.ok(ackMs < 2000, `bounded reaction-burst ACK ${ackMs}ms`);
    const burst = await burstWork;
    assert.ok(burst.some((r) => r.status === 429));
    assert.ok(burst.every((r) => [200, 429].includes(r.status)));
    // No reaction replay after display expiry, even with the same client request ID.
    f.sql(
      `UPDATE room_reactions SET expires_at=clock_timestamp()-interval '1 second' WHERE room_id='${room.id}'`,
    );
    await viewer.request(`${prefix}/reactions`, "POST", reaction);
    assert.equal(
      (await owner.request(`${prefix}/reactions?activity_id=${activity.id}`))
        .items.length,
      0,
    );
    f.sql(
      `UPDATE room_snapshots SET state=state||jsonb_build_object('media_generation',2) WHERE room_id='${room.id}'`,
    );
    const next = (await viewer.request(`${prefix}/current`)).activity;
    assert.notEqual(next.id, activity.id);
    assert.equal(
      (await viewer.request(`${prefix}/messages?activity_id=${next.id}`)).items
        .length,
      0,
    );
    await viewer.request(
      `${prefix}/messages`,
      "POST",
      { ...input, client_message_id: randomUUID() },
      409,
    );
    // A lost response from the previous activity is still safely deduplicated.
    assert.equal(
      (await viewer.request(`${prefix}/messages`, "POST", input)).message.id,
      first.message.id,
    );
    f.sql(
      `UPDATE media_items SET source_version='fixture-v2' WHERE id='${media}'`,
    );
    const changed = (await owner.request(`${prefix}/current`)).activity;
    assert.notEqual(changed.id, next.id);
    assert.ok((await owner.request(`${prefix}/activities`)).items.length >= 3);
    f.sql(
      `UPDATE rooms SET lifecycle='closed',lifecycle_epoch=lifecycle_epoch+1 WHERE id='${room.id}'`,
    );
    assert.equal(
      (await owner.request(`${prefix}/current`)).activity.id,
      changed.id,
      "closed history retains last real viewing activity",
    );
    f.sql(
      `UPDATE rooms SET lifecycle='active',lifecycle_epoch=lifecycle_epoch+1 WHERE id='${room.id}'`,
    );
    assert.notEqual(
      (await owner.request(`${prefix}/current`)).activity.id,
      changed.id,
      "reopening creates a new viewing activity",
    );
    // Closed catalog: actual plugin config, grant, CAS, output, upgrade and rollback.
    await viewer.request("/admin/plugins", "GET", undefined, 403);
    const catalog = await owner.request("/admin/plugins");
    assert.equal(catalog.catalog.length, 2);
    const p = "metadata.duration-badge",
      body = {
        version: "1.0.0",
        enabled: true,
        config: { format: "clock" },
        granted_permissions: ["metadata:read"],
        expected_revision: "0",
      };
    await owner.request(
      `/admin/plugins/${p}`,
      "PUT",
      { ...body, granted_permissions: ["network:*"] },
      400,
    );
    const installed = await owner.request(`/admin/plugins/${p}`, "PUT", body);
    assert.equal(installed.revision, "1");
    await owner.request(`/admin/plugins/${p}`, "PUT", body, 409);
    let metadata = await viewer.request(`/media/${media}/plugin-metadata`);
    assert.equal(metadata.extensions[0].label, "0:01:00");
    const upgraded = await owner.request(`/admin/plugins/${p}`, "PUT", {
      ...body,
      version: "1.1.0",
      config: { format: "minutes" },
      expected_revision: "1",
    });
    assert.equal(upgraded.revision, "2");
    assert.notEqual(upgraded.artifact_digest, installed.artifact_digest);
    metadata = await viewer.request(`/media/${media}/plugin-metadata`);
    assert.equal(metadata.extensions[0].label, "1 分钟");
    const rollback = await owner.request(
      `/admin/plugins/${p}/rollback`,
      "POST",
      {
        expected_revision: "2",
      },
    );
    assert.equal(rollback.version, "1.0.0");
    assert.equal(rollback.revision, "3");
    assert.equal(rollback.can_rollback, false);
    await owner.request(`/admin/plugins/${p}`, "PUT", {
      ...body,
      enabled: false,
      expected_revision: "3",
    });
    assert.equal(
      (await viewer.request(`/media/${media}/plugin-metadata`)).extensions
        .length,
      0,
    );
    assert.equal((await owner.request("/admin/plugins/audit")).items.length, 4);
    const privateLibrary = randomUUID();
    f.sql(
      `INSERT INTO private_libraries(id,name,owner_id,visibility) VALUES('${privateLibrary}','private fixture','${ownerIdentity.id}','private');UPDATE sources SET library_id='${privateLibrary}' WHERE id='${source}'`,
    );
    await viewer.request(
      `/media/${media}/plugin-metadata`,
      "GET",
      undefined,
      404,
    );
    f.sql(
      `INSERT INTO library_grants(library_id,user_id,browse,expires_at,created_by) VALUES('${privateLibrary}','${viewerIdentity.id}',true,clock_timestamp()+interval '1 hour','${ownerIdentity.id}')`,
    );
    await viewer.request(`/media/${media}/plugin-metadata`);
    f.sql(
      `DELETE FROM library_grants WHERE library_id='${privateLibrary}' AND user_id='${viewerIdentity.id}'`,
    );
    await viewer.request(
      `/media/${media}/plugin-metadata`,
      "GET",
      undefined,
      404,
    );
    await owner.request(`${prefix}/moderation`, "POST", {
      action: "remove",
      target_user_id: viewerIdentity.id,
      reason: "fixture lost grant",
    });
    await viewer.request(`${prefix}/messages`, "POST", input, 403);
    assert.ok((await owner.request(`${prefix}/audit`)).items.length >= 4);
    report.checks = [
      "shared source/lifecycle activity identity",
      "REST and WS idempotency/tombstones",
      "bounded same-room deletion revalidation",
      "membership/mute/remove authorization",
      "ephemeral reaction replay/expiry/rate limiting",
      "plugin catalog/grant/CAS/config/output/upgrade/rollback/disable/audit",
      "private media browse grant/revocation",
    ];
    report.concurrent_reaction_burst_pause_ack_ms = ackMs;
    console.log(
      `PASS: isolated synthetic timeline/source/lifecycle identities, REST+WS dedup/tombstones, bounded deletion revalidation, membership/mutes, ephemeral reaction replay/rate limit (one PAUSE ACK ${ackMs}ms); closed plugin grants/CAS/output/upgrade/rollback/disable/audit and private-media ACL`,
    );
  } finally {
    for (const ws of sockets) ws.terminate();
  }
});

report.cleanup = await fixture.verifyStopped();
report.result = "passed";
await writeFile(
  resolve(fixture.root, "timeline-plugin-runtime-evidence.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  "PASS: owned Server and PostgreSQL process/PID/listener cleanup verified",
);
