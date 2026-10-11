// Explicit native qualification only: owned PostgreSQL/Server/WS and a current
// source/binary binding. Never imported by the pure suite, never a P08/P09 gate.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sha256 } from "../scripts/native-owner-binding.mjs";
import WebSocket from "ws";
import { nativeOwnerGate } from "./fixtures/native-owner-gate.mjs";
import { sourceMedia } from "./fixtures/source-grant.mjs";
import { testLoginHash } from "./fixtures/playback-admission.mjs";
import { verifyPidAbsent } from "./fixtures/postgres.mjs";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const cases = [
  { name: "list_exact_login_expiry_after_select_wait", operation: "list", expiry: "login" },
  { name: "list_membership_revoked_after_select_wait", operation: "list", expiry: "membership" },
  { name: "add_new_exact_login_expiry_after_media_wait", operation: "add", expiry: "login" },
  { name: "add_replay_exact_login_expiry_after_media_wait", operation: "replay", expiry: "login" },
  { name: "remove_exact_login_expiry_after_delete_wait", operation: "remove", expiry: "login" },
  { name: "add_queue_delegation_expiry_after_media_wait", operation: "add", expiry: "grant" },
  { name: "remove_queue_delegation_expiry_after_delete_wait", operation: "remove", expiry: "grant" },
];
// Frozen separately from the executable matrix: dropping a case cannot turn a
// partial qualification into a passing report.
const requiredChecks = [
  "mixed_media_private_projection_and_committed_invalidations",
  "list_exact_login_expiry_after_select_wait",
  "list_membership_revoked_after_select_wait",
  "add_new_exact_login_expiry_after_media_wait",
  "add_replay_exact_login_expiry_after_media_wait",
  "remove_exact_login_expiry_after_delete_wait",
  "add_queue_delegation_expiry_after_media_wait",
  "remove_queue_delegation_expiry_after_delete_wait"
];
await nativeOwnerGate("room-playlist-authority-native", async (f, { report, check, signal }) => {
  report.scope = "Playlist list/add/remove HTTP and runtime delivery; actual SELECT/media/DELETE waits, exact-login and Queue delegation natural expiry. Synthetic local/platform/private-library rows; no playback publication, media decode, distributed lease, P08/P09, soak or physical drain claim.";
  report.boundary_cases = [];
  // nativeOwnerGate rechecks this alongside its shared fixture/coordinator
  // inputs. Never allow an unbound synthetic-media seed to change mid-run.
  report.coordinator.push({
    path: "tests/fixtures/source-grant.mjs",
    sha256: sha256(await readFile(new URL("./fixtures/source-grant.mjs", import.meta.url))),
  });
  report.no_event_observation_ms = 250;
  const admin = f.client();
  await admin.login();
  let serial = 0;
  const bounded = async (work, ms = 12000) => {
    let timer;
    try {
      return await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("playlist_boundary_deadline")), ms);
      })]);
    } finally { clearTimeout(timer); }
  };
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (predicate()) return;
      await pause(25);
    }
    throw Error("playlist_boundary_witness_deadline");
  };
  async function account() {
    const username = `playlist-${++serial}`;
    await admin.request("/users", "POST", { username, password: f.password });
    const client = f.client();
    const user = await client.login(username, f.password);
    const live = f.client();
    await live.login(username, f.password);
    return { id: user.id, client, live };
  }
  async function subject(delegated = false) {
    const owner = await account();
    const room = await owner.live.request("/rooms", "POST", { name: "playlist operation fixture" });
    const actor = delegated ? await account() : owner;
    if (delegated) {
      const invitation = await owner.live.request(`/rooms/${room.id}/invites`, "POST");
      await actor.client.request(`/rooms/${room.id}/join`, "POST", { token: invitation.token });
      await owner.live.request(`/rooms/${room.id}/permissions/${actor.id}`, "PUT", { role: "moderator", permissions: ["queue"], expires_in_seconds: 60 });
    }
    const media = sourceMedia(f, { kind: "local", root: f.root, resource: `playlist-${randomUUID()}` });
    return { owner, actor, room, media, path: `/rooms/${room.id}/playlist` };
  }
  const rows = (room) => f.sql(`SELECT jsonb_build_object(
    'playlist',COALESCE((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.id) FROM playlist_items q WHERE q.room_id=${quote(room)}),'[]'::jsonb),
    'snapshot',(SELECT to_jsonb(s) FROM room_snapshots s WHERE s.room_id=${quote(room)}),
    'room',(SELECT to_jsonb(r) FROM rooms r WHERE r.id=${quote(room)}))::text`);
  async function connect(client, room) {
    const socket = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", { headers: { Origin: f.origin, Cookie: client.cookie } });
    const frames = [];
    let frameError;
    socket.on("error", (error) => { frameError ??= error; });
    socket.on("message", (bytes) => {
      try {
        assert.ok(frames.length < 256, "bounded owned socket buffer");
        frames.push(JSON.parse(bytes));
      } catch (error) { frameError ??= error; }
    });
    const closed = new Promise((done) => socket.once("close", done));
    const close = async () => {
      let cleanupError;
      try {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        await bounded(closed);
        assert.equal(socket.readyState, WebSocket.CLOSED);
      } catch (error) { cleanupError = error; }
      // Retain the terminal frame/transport failure, including one arriving
      // during termination, without skipping the actual owned close check.
      if (frameError && cleanupError) throw new AggregateError([frameError, cleanupError], "playlist_socket_frame_and_cleanup_failed");
      if (cleanupError) throw cleanupError;
      if (frameError) throw frameError;
    };
    try {
      await bounded(new Promise((done, reject) => { socket.once("open", done); socket.once("error", reject); }));
      if (frameError) throw frameError;
      socket.send(JSON.stringify({ type: "JOIN", room_id: room }));
      await waitFor(() => frameError || frames.some((frame) => frame.type === "SNAPSHOT"));
      if (frameError) throw frameError;
      const nextChange = async () => {
        if (frameError) throw frameError;
        await waitFor(() => frameError || frames.some((frame) => frame.type === "PLAYLIST_CHANGED"));
        if (frameError) throw frameError;
        const index = frames.findIndex((frame) => frame.type === "PLAYLIST_CHANGED");
        assert.deepEqual(frames.splice(index, 1)[0], { type: "PLAYLIST_CHANGED" });
      };
      const noChange = async () => {
        if (frameError) throw frameError;
        const nonce = randomUUID();
        socket.send(JSON.stringify({ type: "CLOCK_SYNC", t1: nonce }));
        await waitFor(() => frameError || frames.some((frame) => frame.type === "CLOCK_SYNC_REPLY" && frame.t1 === nonce));
        if (frameError) throw frameError;
        await pause(report.no_event_observation_ms);
        if (frameError) throw frameError;
        assert.equal(socket.readyState, WebSocket.OPEN, "absence is observed on a live recipient");
        assert.ok(!frames.some((frame) => frame.type === "PLAYLIST_CHANGED"), "no invalidation in the bounded post-response observation window");
      };
      return { nextChange, noChange, close };
    } catch (error) {
      try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup]); }
      throw error;
    }
  }
  async function holder(statement, queryPrefix) {
    const child = f.sqlProcess(undefined, { interactive: true });
    child.stdout.resume(); child.stderr.resume();
    const closed = new Promise((done) => child.once("close", (code) => done(code)));
    const marker = `playlist-holder-${randomUUID()}`;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      child.stdin.end("ROLLBACK;\n\\q\n");
      assert.equal(await bounded(closed), 0);
      assert.ok(verifyPidAbsent(child.pid), "owned lock holder exited");
      await waitFor(() => f.sql(`SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=${quote(marker)})`) === "t");
    };
    try {
      child.stdin.write(`SET application_name=${quote(marker)}; BEGIN; ${statement};\n`);
      await waitFor(() => f.sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=${quote(marker)} AND state='idle in transaction')`) === "t");
      const pid = Number(f.sql(`SELECT pid FROM pg_stat_activity WHERE application_name=${quote(marker)}`));
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      const witness = () => JSON.parse(f.sql(`SELECT COALESCE(jsonb_agg(a.pid ORDER BY a.pid),'[]'::jsonb)::text FROM pg_stat_activity a WHERE a.wait_event_type='Lock' AND a.query LIKE ${quote(queryPrefix + "%")} AND ${pid}=ANY(pg_blocking_pids(a.pid))`));
      return { release, witness, pid };
    } catch (error) {
      try { await release(); } catch (cleanup) { throw new AggregateError([error, cleanup]); }
      throw error;
    }
  }

  // One actual room combines the two list sources at a tied sort_order. Private
  // media is visible to its owner but filtered for another room member.
  const s = await subject();
  const viewer = await account();
  const invitation = await s.owner.live.request(`/rooms/${s.room.id}/invites`, "POST");
  await viewer.client.request(`/rooms/${s.room.id}/join`, "POST", { token: invitation.token });
  const peer = await connect(viewer.client, s.room.id);
  let projectionFailure;
  try {
    const initial = f.sql(`SELECT state FROM room_snapshots WHERE room_id=${quote(s.room.id)}`);
    const added = await s.owner.live.request(s.path, "POST", { media_id: s.media, compatible_extra_field: true });
    await peer.nextChange();
    assert.deepEqual(await s.owner.live.request(s.path, "POST", { media_id: s.media }), added);
    await peer.noChange();
    assert.deepEqual(await s.owner.live.request(`${s.path}/${randomUUID()}`, "DELETE"), { ok: true });
    await peer.noChange();
    const foreign = await s.owner.live.request("/rooms", "POST", { name: "foreign queue" });
    const foreignItem = await s.owner.live.request(`/rooms/${foreign.id}/playlist`, "POST", { media_id: s.media });
    await s.owner.live.request(`${s.path}/${foreignItem.id}`, "DELETE");
    assert.equal(f.sql(`SELECT count(*) FROM playlist_items WHERE id=${quote(foreignItem.id)}`), "1");
    await peer.noChange();
    await s.owner.live.request(`${s.path}/${added.id}`, "DELETE");
    await peer.nextChange();
    await s.owner.live.request(`${s.path}/${added.id}`, "DELETE");
    await peer.noChange();
    assert.equal(f.sql(`SELECT state FROM room_snapshots WHERE room_id=${quote(s.room.id)}`), initial);

    const library = randomUUID(), native = randomUUID();
    const hidden = sourceMedia(f, { kind: "local", root: f.root, resource: `private-${randomUUID()}` });
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    f.sql(`INSERT INTO private_libraries(id,name,owner_id,visibility) VALUES(${quote(library)},'playlist private',${quote(s.owner.id)},'private');
      UPDATE sources SET library_id=${quote(library)} WHERE id=(SELECT source_id FROM media_items WHERE id=${quote(hidden)});
      INSERT INTO media_items(id,title,resource) VALUES(${quote(native)},'opaque platform row','');
      INSERT INTO room_platform_media(media_id,room_id,provider,content_id,part,title,created_by) VALUES(${quote(native)},${quote(s.room.id)},'bilibili','BV1234567890',1,'platform queue title',${quote(s.owner.id)});
      INSERT INTO media_user_titles(media_id,user_id,title) VALUES(${quote(s.media)},${quote(viewer.id)},'viewer personal title');
      INSERT INTO playlist_items(id,room_id,media_id,sort_order) VALUES
        (${quote(ids[2])},${quote(s.room.id)},${quote(hidden)},1),
        (${quote(ids[1])},${quote(s.room.id)},${quote(s.media)},2),
        (${quote(ids[0])},${quote(s.room.id)},${quote(native)},2);`);
    const ownerList = await s.owner.live.request(s.path);
    assert.deepEqual(ownerList.map((item) => item.id), [ids[2], ids[0], ids[1]]);
    const response = await viewer.client.raw(s.path, { headers: { Origin: "", "x-csrf-token": "" } });
    const visible = await response.json();
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(visible.map((item) => item.id), [ids[0], ids[1]]);
    assert.deepEqual(visible[0], { id: ids[0], media_id: native, title: "platform queue title", kind: "native_platform", cover: { state: "missing", revision: null, url: null, retry_after_ms: null } });
    assert.equal(visible[1].title, "viewer personal title");
    assert.ok(!Object.hasOwn(visible[1], "kind"));
    const unavailable = await s.owner.live.request(s.path, "POST", { media_id: randomUUID() }, 404);
    assert.equal(unavailable.error.code, "MEDIA_NOT_FOUND");
    await peer.noChange();
    check(requiredChecks[0]);
  } catch (error) { projectionFailure = error; }
  finally {
    try { await peer.close(); }
    catch (cleanup) { throw new AggregateError([...(projectionFailure ? [projectionFailure] : []), cleanup], "playlist_projection_cleanup_failed"); }
  }
  if (projectionFailure) throw projectionFailure;

  for (const spec of cases) {
    signal.throwIfAborted();
    const s = await subject(spec.expiry === "grant" || spec.operation === "list");
    const existing = spec.operation === "remove" || spec.operation === "replay"
      ? await s.owner.live.request(s.path, "POST", { media_id: s.media }) : undefined;
    const peer = await connect(s.owner.live, s.room.id);
    const login = testLoginHash(f, s.actor.client);
    const selector = spec.expiry === "grant"
      ? `room_member_permissions WHERE room_id=${quote(s.room.id)} AND user_id=${quote(s.actor.id)}`
      : `sessions WHERE token_hash=${quote(login)} AND user_id=${quote(s.actor.id)}`;
    let block, pending, drained = false, failure;
    const evidence = { name: spec.name, result: "running" };
    report.boundary_cases.push(evidence);
    try {
      if (spec.expiry !== "membership") {
        f.sql(`UPDATE ${selector.replace(" WHERE ", " SET expires_at=clock_timestamp()+interval '3 seconds' WHERE ")}`);
        evidence.exact_expiry = f.sql(`SELECT expires_at::text FROM ${selector}`);
        assert.equal(f.sql(`SELECT expires_at>clock_timestamp() FROM ${selector}`), "t");
      }
      const before = rows(s.room.id);
      block = await holder(spec.operation === "list" ? "LOCK TABLE playlist_items IN ACCESS EXCLUSIVE MODE"
        : spec.operation === "remove" ? `SELECT id FROM playlist_items WHERE id=${quote(existing.id)} FOR UPDATE`
        : `SELECT id FROM media_items WHERE id=${quote(s.media)} FOR UPDATE`,
      spec.operation === "list" ? "SELECT q.id AS playlist_id" : spec.operation === "remove" ? "DELETE FROM playlist_items WHERE room_id=" : "SELECT id FROM media_items WHERE id=");
      let settled = false;
      pending = s.actor.client.raw(spec.operation === "remove" ? `${s.path}/${existing.id}` : s.path, {
        method: spec.operation === "list" ? "GET" : spec.operation === "remove" ? "DELETE" : "POST",
        body: spec.operation === "add" || spec.operation === "replay" ? { media_id: s.media } : undefined,
      });
      pending.then(() => { settled = true; }, () => { settled = true; });
      await waitFor(() => block.witness().length === 1);
      const [blockedPid] = block.witness();
      evidence.holder_backend_pid = block.pid; evidence.blocked_backend_pid = blockedPid;
      assert.equal(settled, false);
      if (spec.expiry === "membership") {
        f.sql(`DELETE FROM room_members WHERE room_id=${quote(s.room.id)} AND user_id=${quote(s.actor.id)}`);
      } else {
        await waitFor(() => f.sql(`SELECT expires_at<=clock_timestamp() FROM ${selector}`) === "t");
        assert.equal(f.sql(`SELECT expires_at::text FROM ${selector}`), evidence.exact_expiry, "natural deadline is unchanged");
      }
      assert.deepEqual(block.witness(), [blockedPid], "same real blocking edge still exists after invalidation");
      assert.equal(settled, false);
      await block.release();
      const response = await bounded(pending);
      const body = await bounded(response.json()); drained = true;
      assert.equal(response.status, spec.expiry === "login" ? 401 : 403);
      assert.equal(body.error.code, spec.expiry === "login" ? "SESSION_EXPIRED" : spec.expiry === "grant" ? "CONTROLLER_REQUIRED" : "NOT_A_MEMBER");
      assert.equal(rows(s.room.id), before, "failed operation leaves complete playlist, snapshot and room rows unchanged");
      await peer.noChange();
      // An independent live exact login still succeeds in the same room.
      const success = await s.owner.live.request(s.path, "POST", { media_id: s.media });
      assert.ok(success.id);
      if (!existing) await peer.nextChange();
      else await peer.noChange();
      evidence.result = "passed"; evidence.same_edge_after_invalidation = true;
      evidence.http_status = response.status; evidence.error_code = body.error.code;
      evidence.selected_rows_unchanged = true; check(spec.name);
    } catch (error) { failure = error; evidence.result = "failed"; }
    finally {
      const cleanup = [];
      if (block) try { await block.release(); } catch (error) { cleanup.push(error); }
      if (pending && !drained) try { const response = await bounded(pending); await bounded(response.arrayBuffer()); } catch (error) { cleanup.push(error); }
      try { await peer.close(); } catch (error) { cleanup.push(error); }
      if (cleanup.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanup], "playlist_boundary_cleanup_failed");
    }
    if (failure) throw failure;
  }
  assert.deepEqual(report.checks, requiredChecks.map((name) => ({ name, result: "passed" })),
    "Every frozen native check must complete exactly once");
});
