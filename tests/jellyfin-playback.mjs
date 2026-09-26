import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import WS from "ws";
const exec = promisify(execFile),
  base = "http://localhost:8088";
const config = Object.fromEntries(
  (await readFile(".env", "utf8"))
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const upstream = JSON.parse(
  await readFile(".runtime/jellyfin-fixture.json", "utf8"),
);
let cookie = "",
  csrf = "",
  socket;
const plans = [];
async function api(path, method = "GET", body) {
  const r = await fetch(base + "/api/v1" + path, {
    method,
    signal: AbortSignal.timeout(45000),
    headers: {
      Origin: base,
      Cookie: cookie,
      "Content-Type": "application/json",
      "x-csrf-token": csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  const value = await r.json();
  assert.equal(r.status, 200, `${path}: ${JSON.stringify(value)}`);
  return value;
}
try {
  csrf = (
    await api("/auth/login", "POST", {
      username: "admin",
      password: config.ADMIN_PASSWORD,
    })
  ).csrf;
  let source = (await api("/sources")).find(
    (s) => s.name === "Jellyfin 10.11.0 verification",
  );
  source ??= await api("/sources", "POST", {
    name: "Jellyfin 10.11.0 verification",
    kind: "jellyfin",
    config: {
      url: upstream.url,
      token: upstream.token,
      user_id: upstream.user_id,
    },
  });
  await api(`/sources/${source.id}/test`, "POST");
  const media = (await api("/media")).filter((m) => m.kind === "jellyfin");
  assert.ok(media.length >= 2);
  let room = (await api("/rooms")).find(
    (r) => r.name === "Jellyfin verification",
  );
  room ??= await api("/rooms", "POST", { name: "Jellyfin verification" });
  const inbox = [];
  socket = new WS(base.replace("http", "ws") + "/api/v1/ws", {
    headers: { Origin: base, Cookie: cookie },
  });
  socket.on("message", (b) => inbox.push(JSON.parse(b)));
  await new Promise((r, j) => {
    socket.once("open", r);
    socket.once("error", j);
  });
  async function wait(type) {
    for (let i = 0; i < 100; i++) {
      const n = inbox.findIndex((v) => v.type === type);
      if (n >= 0) return inbox.splice(n, 1)[0];
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("missing " + type);
  }
  socket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
  let state = (await wait("SNAPSHOT")).state;
  for (const item of media) {
    socket.send(
      JSON.stringify({
        protocol_version: 1,
        room_id: room.id,
        command_id: randomUUID(),
        expected_revision: state.revision,
        media_generation: state.media_generation,
        type: "CHANGE_MEDIA",
        payload: { media_id: item.id },
      }),
    );
    state = (await wait("ACK")).state;
    let selectedAudio;
    for (const mode of ["auto", "transcode"]) {
      const plan = await api("/playback-sessions", "POST", {
        room_id: room.id,
        media_generation: state.media_generation,
        position_ms: mode === "transcode" ? 4000 : 0,
        audio_index: mode === "transcode" ? selectedAudio : undefined,
        mode,
        capabilities: {
          progressive_h264_aac: true,
          native_hls: false,
          mse_h264_aac: true,
        },
      });
      plans.push(plan.session_id);
      assert.equal(
        plan.delivery_mode,
        mode === "auto" && item.title === "rainsync-demo"
          ? "direct"
          : "transcode",
        "honor direct-play priority and incompatible-codec fallback",
      );
      assert.ok(plan.audio_tracks.length > 0, "upstream audio tracks mapped");
      assert.ok(plan.duration_ms > 19000);
      if (item.title === "rainsync-demo") {
        assert.ok(
          plan.subtitle_tracks.length > 0,
          "upstream text subtitle mapped",
        );
        const response = await fetch(base + plan.subtitle_tracks[0].url);
        assert.equal(response.status, 200, "authorized upstream VTT delivery");
        const subtitle = await response.text();
        assert.ok(subtitle.startsWith("WEBVTT"));
        assert.ok(subtitle.includes("RainSync subtitle check"));
      }
      selectedAudio = plan.audio_tracks[0].index;
      assert.equal(
        plan.timeline_origin_ms,
        0,
        "Jellyfin VOD manifest retains original timeline",
      );
      const r = await fetch(base + plan.playback_url, {
        signal: AbortSignal.timeout(45000),
      });
      assert.equal(r.status, 200, `${item.title} ${mode}`);
      await r.arrayBuffer();
      await exec(
        "docker",
        [
          "run",
          "--rm",
          "rainsync-server:dev",
          "ffmpeg",
          "-v",
          "error",
          "-ss",
          mode === "transcode" ? "4" : "0",
          "-i",
          "http://host.docker.internal:8088" + plan.playback_url,
          "-t",
          "1",
          "-f",
          "null",
          "-",
        ],
        { timeout: 60000 },
      ).catch(() => {
        throw new Error(
          `Decode failed: ${item.title} ${mode}; inspect local container logs (signed URLs omitted)`,
        );
      });
      await api(`/playback-sessions/${plan.session_id}`, "DELETE");
      console.log(
        `PASS Jellyfin 10.11.0: ${item.title} ${mode} -> ${plan.delivery_mode}/${plan.transport}`,
      );
    }
  }
} finally {
  for (const id of plans)
    await api(`/playback-sessions/${id}`, "DELETE").catch(() => {});
  socket?.close();
}
