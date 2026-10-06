import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";
import { sourceMedia } from "./fixtures/source-grant.mjs";

await isolatedServer("room-permissions", async (f) => {
  const admin = f.client();
  await admin.login();
  const users = [];
  for (const name of [
    "owner",
    "moderator",
    "viewer",
    "other",
    "outsider",
    "race_a",
    "race_b",
  ]) {
    await admin.request("/users", "POST", {
      username: name,
      password: f.password,
    });
    const client = f.client(),
      identity = await client.login(name, f.password);
    users.push({ client, identity });
  }
  const [owner, moderator, viewer, other, outsider, raceA, raceB] = users;
  const room = await owner.client.request("/rooms", "POST", {
    name: "permission fixture",
  });
  const otherRoom = await owner.client.request("/rooms", "POST", {
    name: "other room",
  });
  const sockets = new Set();
  const state = () =>
    JSON.parse(
      f.sql(`SELECT state FROM room_snapshots WHERE room_id='${room.id}'`),
    );
  const grant = (person, permissions, ttl = 3600) =>
    owner.client.request(
      `/rooms/${room.id}/permissions/${person.identity.id}`,
      "PUT",
      { role: "moderator", permissions, expires_in_seconds: ttl },
    );
  const invite = (policy = {}) =>
    owner.client.request(`/rooms/${room.id}/invites`, "POST", {
      expires_in_seconds: 3600,
      ...policy,
    });
  const join = (person, invitation, status = 200, target = room.id) =>
    person.client.request(
      `/rooms/${target}/join`,
      "POST",
      { token: invitation.token },
      status,
    );
  async function connect(person) {
    const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", {
      headers: { Origin: f.origin, Cookie: person.client.cookie },
    });
    sockets.add(ws);
    const frames = [];
    ws.on("message", (bytes) => frames.push(JSON.parse(bytes)));
    ws.on("error", () => {});
    await new Promise((done, reject) => {
      ws.once("open", done);
      ws.once("error", reject);
    });
    const next = async (type, id) => {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const i = frames.findIndex(
          (v) => v.type === type && (!id || v.command_id === id),
        );
        if (i >= 0) return frames.splice(i, 1)[0];
        await delay(10);
      }
      throw Error(`Missing ${type}: ${JSON.stringify(frames)}`);
    };
    ws.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
    return { ws, next, snapshot: await next("SNAPSHOT") };
  }
  async function command(socket, type, payload, status = "ACK") {
    const current = state(),
      id = randomUUID();
    socket.ws.send(
      JSON.stringify({
        protocol_version: 1,
        room_id: room.id,
        command_id: id,
        control_epoch: socket.snapshot.control_epoch.id,
        expected_revision: current.revision,
        media_generation: current.media_generation,
        type,
        payload,
      }),
    );
    return socket.next(status, id);
  }
  try {
    const reusable = await invite();
    const cookieOnly = await owner.client.request(
      `/rooms/${room.id}/invites`,
      "GET",
      undefined,
      200,
      { Origin: "", "x-csrf-token": "" },
    );
    assert.ok(
      cookieOnly.some((item) => item.id === reusable.id),
      "same-origin browser GET accepts the authorized cookie without Origin or CSRF",
    );
    await owner.client.request(
      `/rooms/${room.id}/invites`,
      "POST",
      undefined,
      403,
      { Origin: "" },
    );
    for (const person of [moderator, viewer, other])
      await join(person, reusable);
    await owner.client.request(
      `/rooms/${room.id}/permissions/${moderator.identity.id}`,
      "PUT",
      { role: "viewer", permissions: ["play"] },
      400,
    );
    await outsider.client.request(
      `/rooms/${room.id}/permissions`,
      "GET",
      undefined,
      403,
    );
    await viewer.client.request(
      `/rooms/${room.id}/permissions/${viewer.identity.id}`,
      "PUT",
      { role: "moderator", permissions: ["play"] },
      403,
    );
    await viewer.client.request(
      `/rooms/${room.id}/invites`,
      "GET",
      undefined,
      403,
      { Origin: "", "x-csrf-token": "" },
    );
    await outsider.client.request(
      `/rooms/${room.id}/invites`,
      "GET",
      undefined,
      403,
      { Origin: "", "x-csrf-token": "" },
    );
    await grant(moderator, ["invite", "pause"]);
    await moderator.client.request(
      `/rooms/${room.id}/invites`,
      "GET",
      undefined,
      200,
      { Origin: "", "x-csrf-token": "" },
    );
    const invited = await moderator.client.request(
      `/rooms/${room.id}/invites`,
      "POST",
      { expires_in_seconds: 60, max_uses: 1 },
    );
    await moderator.client.request(
      `/rooms/${room.id}/invites`,
      "POST",
      { role: "moderator", permissions: ["play"] },
      403,
    );
    await moderator.client.request(
      `/rooms/${room.id}/permissions/${moderator.identity.id}`,
      "PUT",
      { role: "moderator", permissions: ["play"] },
      403,
    );
    await moderator.client.request(
      `/rooms/${otherRoom.id}/invites`,
      "POST",
      undefined,
      403,
    );
    await moderator.client.request(
      `/rooms/${room.id}/playlist`,
      "POST",
      { media_id: randomUUID() },
      403,
    );
    await moderator.client.request(
      `/rooms/${room.id}/close`,
      "POST",
      { expected_revision: state().revision },
      403,
    );
    await moderator.client.request(
      `/rooms/${room.id}/owner`,
      "POST",
      { owner_id: moderator.identity.id, expected_revision: state().revision },
      403,
    );
    await join(outsider, invited, 403, otherRoom.id);

    const single = await invite({ max_uses: 1 });
    const raced = await Promise.all(
      [raceA, raceB].map((p) =>
        p.client.raw(`/rooms/${room.id}/join`, {
          method: "POST",
          body: { token: single.token },
        }),
      ),
    );
    assert.deepEqual(
      raced.map((r) => r.status).sort(),
      [200, 403],
      "one concurrent redemption wins",
    );
    const winner = raced[0].status === 200 ? raceA : raceB,
      loser = winner === raceA ? raceB : raceA;
    await join(winner, single);
    assert.equal(
      f.sql(`SELECT use_count FROM invites WHERE id='${single.id}'`),
      "1",
    );
    const targeted = await invite({
      max_uses: 1,
      invited_user_id: loser.identity.id,
      role: "moderator",
      permissions: ["seek"],
      grant_expires_in_seconds: 3600,
    });
    await join(outsider, targeted, 403);
    await join(loser, targeted);
    assert.equal(
      (await loser.client.request(`/rooms/${room.id}/permissions`))
        .self_permissions[0],
      "seek",
    );
    await owner.client.request(
      `/rooms/${room.id}/permissions/${loser.identity.id}`,
      "DELETE",
    );
    await join(loser, targeted);
    assert.deepEqual(
      (await loser.client.request(`/rooms/${room.id}/permissions`))
        .self_permissions,
      [],
      "join retry never resurrects a revoked grant",
    );
    const revoked = await invite({ max_uses: 2 });
    await owner.client.request(
      `/rooms/${room.id}/invites/${revoked.id}`,
      "DELETE",
    );
    const firstRevocation = (
      await owner.client.request(`/rooms/${room.id}/invites`)
    ).find((item) => item.id === revoked.id);
    assert.equal(firstRevocation.revoked, true);
    assert.ok(
      Number.isSafeInteger(firstRevocation.revoked_at) &&
        firstRevocation.revoked_at > 0,
      "explicit revocation exposes its persisted timestamp",
    );
    const exactRevocation = f.sql(
      `SELECT revoked_at::text FROM invites WHERE id='${revoked.id}'`,
    );
    await delay(20);
    await owner.client.request(
      `/rooms/${room.id}/invites/${revoked.id}`,
      "DELETE",
    );
    const repeatedRevocation = (
      await owner.client.request(`/rooms/${room.id}/invites`)
    ).find((item) => item.id === revoked.id);
    assert.equal(
      repeatedRevocation.revoked_at,
      firstRevocation.revoked_at,
      "repeated revocation preserves the original timestamp",
    );
    assert.equal(
      f.sql(`SELECT revoked_at::text FROM invites WHERE id='${revoked.id}'`),
      exactRevocation,
      "the original database timestamp is unchanged at full precision",
    );
    await join(outsider, revoked, 403);
    const expired = await invite();
    f.sql(
      `UPDATE invites SET expires_at=clock_timestamp()-interval '1 second' WHERE id='${expired.id}'`,
    );
    await join(outsider, expired, 403);
    const waitExpired = await invite();
    const expireTag = `invite-expiry-${randomUUID()}`;
    const roomLock = f.sqlProcess(
      `BEGIN; SELECT id FROM rooms WHERE id='${room.id}' FOR NO KEY UPDATE; SELECT pg_sleep(2) /* ${expireTag} */; COMMIT;`,
    );
    await f.waitForSql(
      `SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${expireTag}%'`,
      "1",
    );
    f.sql(
      `UPDATE invites SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id='${waitExpired.id}'`,
    );
    const expiredDuringWait = join(outsider, waitExpired, 403);
    await roomLock.done;
    await expiredDuringWait;
    assert.equal(
      f.sql(`SELECT use_count FROM invites WHERE id='${waitExpired.id}'`),
      "0",
      "expiration while waiting never consumes or admits",
    );
    const bounded = await invite({ max_uses: 2 });
    await join(viewer, bounded);
    await join(other, bounded);
    await join(outsider, bounded, 403);
    assert.equal(
      (await owner.client.request(`/rooms/${room.id}/invites`)).find(
        (i) => i.id === bounded.id,
      ).use_count,
      2,
    );

    const media = sourceMedia(f, {
      kind: "local",
      root: f.root,
      resource: "fixture",
    });
    f.sql(`UPDATE media_items SET duration_ms=30000 WHERE id='${media}'`);
    const ownerSocket = await connect(owner);
    await command(ownerSocket, "CHANGE_MEDIA", { media_id: media });
    let delegated = await connect(moderator);
    await command(delegated, "PAUSE");
    for (const [type, payload] of [
      ["PLAY"],
      ["SEEK", { position_ms: 500 }],
      ["SET_RATE", { rate: 1.5 }],
      ["CHANGE_MEDIA", { media_id: media }],
    ]) {
      assert.equal(
        (await command(delegated, type, payload, "ERROR")).error.code,
        "CONTROLLER_REQUIRED",
      );
    }
    const actionCases = [
      ["play", "PLAY", undefined],
      ["pause", "PAUSE", undefined],
      ["seek", "SEEK", { position_ms: 500 }],
      ["set_rate", "SET_RATE", { rate: 1.5 }],
      ["change_media", "CHANGE_MEDIA", { media_id: media }],
    ];
    for (const [permission, type, payload] of actionCases) {
      await grant(moderator, [permission]);
      delegated = await connect(moderator);
      await command(delegated, type, payload);
      const denied = permission === "play" ? "PAUSE" : "PLAY";
      assert.equal(
        (await command(delegated, denied, undefined, "ERROR")).error.code,
        "CONTROLLER_REQUIRED",
      );
    }
    assert.equal(
      f.sql(
        `SELECT count(*) FROM room_events WHERE room_id='${room.id}' AND diagnostic->>'actor_permission' IS NOT NULL AND diagnostic->>'actor_is_admin'='false'`,
      ),
      "6",
    );
    await grant(moderator, ["queue"]);
    await moderator.client.request(`/rooms/${room.id}/playlist`, "POST", {
      media_id: media,
    });
    const queued = (
      await moderator.client.request(`/rooms/${room.id}/playlist`)
    )[0];
    await moderator.client.request(
      `/rooms/${room.id}/playlist/${queued.id}`,
      "DELETE",
    );

    const privateLibrary = randomUUID(),
      privateMedia = sourceMedia(f, {
        kind: "local",
        root: f.root,
        resource: "private-fixture",
      });
    f.sql(
      `INSERT INTO private_libraries(id,name,owner_id,visibility) VALUES('${privateLibrary}','private permission fixture','${owner.identity.id}','private'); UPDATE sources SET library_id='${privateLibrary}' WHERE id=(SELECT source_id FROM media_items WHERE id='${privateMedia}'); INSERT INTO room_media_grants(id,library_id,media_id,source_generation,room_id,grantor_id,mode,permission_epoch,expires_at) SELECT '${randomUUID()}','${privateLibrary}',m.id,m.library_source_generation,'${room.id}','${owner.identity.id}','library_members',1,clock_timestamp()+interval '1 hour' FROM media_items m WHERE m.id='${privateMedia}';`,
    );
    await grant(moderator, ["change_media", "queue"]);
    delegated = await connect(moderator);
    assert.equal(
      (
        await command(
          delegated,
          "CHANGE_MEDIA",
          { media_id: privateMedia },
          "ERROR",
        )
      ).error.code,
      "MEDIA_NOT_FOUND",
      "room control grant does not confer private-library playback",
    );
    await moderator.client.request(
      `/rooms/${room.id}/playlist`,
      "POST",
      { media_id: privateMedia },
      404,
    );
    assert.equal(
      f.sql(
        `SELECT library_allowed('${moderator.identity.id}','${privateLibrary}','play')`,
      ),
      "f",
    );
    await grant(moderator, ["queue"]);
    const grantExpiryTag = `grant-expiry-${randomUUID()}`;
    const mediaLock = f.sqlProcess(
      `BEGIN; SELECT id FROM media_items WHERE id='${media}' FOR UPDATE; SELECT pg_sleep(2) /* ${grantExpiryTag} */; COMMIT;`,
    );
    await f.waitForSql(
      `SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${grantExpiryTag}%'`,
      "1",
    );
    f.sql(
      `UPDATE room_member_permissions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE room_id='${room.id}' AND user_id='${moderator.identity.id}'`,
    );
    const expiredWrite = moderator.client.request(
      `/rooms/${room.id}/playlist`,
      "POST",
      { media_id: media },
      403,
    );
    await mediaLock.done;
    await expiredWrite;
    assert.equal(
      f.sql(
        `SELECT count(*) FROM playlist_items WHERE room_id='${room.id}' AND media_id='${media}'`,
      ),
      "0",
      "natural expiry at final admission rolls back queue insertion",
    );

    await grant(moderator, ["invite", "play"]);
    delegated = await connect(moderator);
    f.sql(
      `UPDATE room_member_permissions SET expires_at=clock_timestamp()-interval '1 second' WHERE room_id='${room.id}' AND user_id='${moderator.identity.id}'`,
    );
    await moderator.client.request(
      `/rooms/${room.id}/invites`,
      "POST",
      undefined,
      403,
    );
    assert.equal(
      (await command(delegated, "PLAY", undefined, "ERROR")).error.code,
      "CONTROLLER_REQUIRED",
    );
    await grant(moderator, ["play"]);
    const oldDevice = await connect(moderator);
    await owner.client.request(
      `/rooms/${room.id}/permissions/${moderator.identity.id}`,
      "DELETE",
    );
    assert.equal(
      (await command(oldDevice, "PLAY", undefined, "ERROR")).error.code,
      "CONTROL_EPOCH_EXPIRED",
    );
    const reconnected = await connect(moderator);
    assert.equal(
      (await command(reconnected, "PLAY", undefined, "ERROR")).error.code,
      "CONTROLLER_REQUIRED",
    );

    await grant(moderator, ["kick"]);
    await moderator.client.request(
      `/rooms/${room.id}/members/${owner.identity.id}`,
      "DELETE",
      undefined,
      403,
    );
    const viewerSocket = await connect(viewer);
    await moderator.client.request(
      `/rooms/${room.id}/members/${viewer.identity.id}`,
      "DELETE",
    );
    assert.equal(
      (await viewerSocket.next("ERROR")).error.code,
      "NOT_A_MEMBER",
      "kick revokes the existing socket before it can admit another frame",
    );
    await viewer.client.request(
      `/rooms/${room.id}/playlist`,
      "GET",
      undefined,
      403,
    );
    assert.equal(
      f.sql(
        `SELECT count(*) FROM room_member_permissions WHERE room_id='${room.id}' AND user_id='${viewer.identity.id}'`,
      ),
      "0",
    );
    await grant(moderator, ["close"]);
    const closed = await moderator.client.request(
      `/rooms/${room.id}/close`,
      "POST",
      { expected_revision: state().revision },
    );
    await f.waitForSql(
      `SELECT lifecycle FROM rooms WHERE id='${room.id}'`,
      "closed",
    );
    await moderator.client.request(
      `/rooms/${room.id}/reopen`,
      "POST",
      { expected_revision: state().revision },
      403,
    );
    const transferred = await owner.client.request(
      `/rooms/${room.id}/owner`,
      "POST",
      { owner_id: other.identity.id, expected_revision: state().revision },
    );
    assert.equal(transferred.state.controller_user_id, other.identity.id);
    assert.equal(
      f.sql(`SELECT lifecycle FROM rooms WHERE id='${room.id}'`),
      "closed",
    );
    const archived = await other.client.request(
      `/rooms/${room.id}/archive`,
      "POST",
      { expected_revision: state().revision },
    );
    const archivedTransfer = await other.client.request(
      `/rooms/${room.id}/owner`,
      "POST",
      {
        owner_id: owner.identity.id,
        expected_revision: archived.state.revision,
      },
    );
    assert.equal(archivedTransfer.state.controller_user_id, owner.identity.id);
    assert.equal(
      f.sql(`SELECT lifecycle FROM rooms WHERE id='${room.id}'`),
      "archived",
    );
    assert.equal(
      f.sql(
        `SELECT count(*) FROM room_member_permissions WHERE room_id='${room.id}' AND NOT revoked`,
      ),
      "0",
    );
    console.log(
      "PASS: atomic bounded/targeted/revoked/expired invitations, nine exact room actions, owner-only delegation, room isolation, WS old devices/reconnect, grant expiry, kick, delegated close and closed/archived transfer",
    );
  } finally {
    for (const ws of sockets) ws.terminate();
  }
});
