import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";

await isolatedMediaStack(
  "playback-candidates",
  async (f) => {
    const client = f.client();
    await client.login();
    const file = resolve(f.root, "actual.mp4");
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=red:s=640x360:r=25:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-profile:a",
        "aac_low",
        "-ac",
        "2",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        file,
      ],
      { env: f.env, timeout: 15000 },
    );
    const source = await client.request("/sources", "POST", {
      name: "actual codec fixture",
      kind: "local",
      config: { root: f.root },
    });
    await client.request(`/sources/${source.id}/test`, "POST");
    const media = (await client.request("/media")).find((v) =>
      v.title.includes("actual"),
    );
    assert.ok(media);
    const room = await client.request("/rooms", "POST", {
      name: "actual capabilities",
    });
    f.sql(
      `UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${media.id}"'),'{media_generation}','1') WHERE room_id='${room.id}'`,
    );
    const request = {
      room_id: room.id,
      media_generation: 1,
      position_ms: 0,
      audio_index: null,
    };
    const candidates = await client.request(
      "/playback-candidates",
      "POST",
      request,
    );
    assert.equal(candidates.schema_version, 1);
    assert.ok(candidates.binding);
    assert.deepEqual(
      candidates.candidates.map((v) => v.id),
      ["direct", "remux", "audio_transcode", "transcode_720p"],
    );
    assert.equal(candidates.candidates[0].video.width, 640);
    assert.equal(candidates.candidates[0].video.height, 360);
    assert.equal(candidates.candidates[0].video.framerate, 25);
    assert.match(candidates.candidates[0].content_type, /avc1\.64001[0-9A-F]/);
    assert.equal(candidates.candidates[0].audio.channels, "2");
    const report = (allowed) => ({
      binding: candidates.binding,
      excluded_candidates: [],
      results: candidates.candidates.map((v) => ({
        candidate_id: v.id,
        progressive: allowed.includes(v.id) ? "probably" : "unsupported",
        mse_supported: allowed.includes(v.id),
        file_decoding: {
          supported: allowed.includes(v.id),
          smooth: true,
          power_efficient: false,
        },
        mse_decoding: {
          supported: allowed.includes(v.id),
          smooth: true,
          power_efficient: false,
        },
      })),
    });
    const prepare = (candidate_report, extra = {}) =>
      client.request("/playback-sessions", "POST", {
        ...request,
        mode: "auto",
        idempotency_key: randomUUID(),
        capabilities: {
          progressive_h264_aac: true,
          native_hls: false,
          mse_h264_aac: true,
        },
        candidate_report,
        observation_version: 1,
        ...extra,
      });
    assert.equal(f.sql("SELECT count(*) FROM playback_observations"), "0");
    const directKey = randomUUID();
    const allRoutes = report([
      "direct",
      "remux",
      "audio_transcode",
      "transcode_720p",
    ]);
    const direct = await prepare(allRoutes, { idempotency_key: directKey });
    assert.equal(direct.delivery_mode, "direct");
    assert.equal(direct.selected_candidate_id, "direct");
    assert.equal(direct.decision_reason, "actual_media_direct");
    assert.equal(direct.selected_audio_track, 1);
    assert.equal(direct.observation_version, 1);
    assert.equal(direct.observation_seq, 0);
    const sample = {
      media_generation: 1,
      seq: 3,
      event: "playing",
      media_time_ms: 500,
      paused: false,
      seeking: false,
      buffering: false,
      playback_rate: 1,
      has_played: true,
    };
    await client.request(
      `/playback-sessions/${direct.session_id}/observations`,
      "POST",
      sample,
    );
    const directReady = await client.request(
      `/playback-sessions/${direct.session_id}`,
    );
    assert.equal(directReady.observation_version, 1);
    assert.equal(directReady.observation_seq, 3);
    const replay = await prepare(allRoutes, { idempotency_key: directKey });
    assert.equal(replay.session_id, direct.session_id);
    assert.equal(replay.observation_seq, 3);
    await client.request(`/playback-sessions/${direct.session_id}`, "DELETE", {
      ...sample,
      seq: 4,
      event: "pause",
      paused: true,
      media_time_ms: 750,
    });
    assert.equal(
      f.sql(
        `SELECT seq FROM playback_observations WHERE session_id='${direct.session_id}'`,
      ),
      "4",
    );
    console.log(
      "PASS: actual candidates preserve observation-v1, readiness sequence and refreshed idempotent replay",
    );
    for (const [candidate, expected] of [
      ["remux", "remux"],
      ["audio_transcode", "audio_transcode"],
      ["transcode_720p", "transcode"],
    ]) {
      const plan = await prepare(report([candidate]));
      assert.equal(plan.delivery_mode, expected);
      const spec = JSON.parse(
        f.sql(
          `SELECT spec FROM media_jobs WHERE session_id='${plan.session_id}'`,
        ),
      );
      assert.equal(spec.negotiated_mode, expected);
      assert.match(spec.source_version, /^stat-v1:/);
      await client.request(`/playback-sessions/${plan.session_id}`, "DELETE");
    }
    const none = await client.request(
      "/playback-sessions",
      "POST",
      {
        ...request,
        mode: "auto",
        capabilities: {
          progressive_h264_aac: true,
          native_hls: false,
          mse_h264_aac: true,
        },
        candidate_report: report([]),
      },
      422,
    );
    assert.equal(
      none.error.code,
      "DEVICE_HAS_NO_COMPATIBLE_PLAYBACK_TRANSPORT",
    );
    const tampered = {
      ...report(["direct"]),
      binding: candidates.binding.slice(0, -3) + "abc",
    };
    const bad = await client.request(
      "/playback-sessions",
      "POST",
      {
        ...request,
        mode: "auto",
        capabilities: {
          progressive_h264_aac: true,
          native_hls: false,
          mse_h264_aac: true,
        },
        candidate_report: tampered,
      },
      409,
    );
    assert.equal(bad.error.code, "STALE_CAPABILITY_REPORT");
    console.log(
      "PASS: actual RFC6381/dimensions/audio, direct→remux→audio→constrained transcode, and tamper rejection",
    );
    await f.startWorker();
    for (const outputRoute of ["remux", "audio_transcode", "transcode_720p"]) {
      const output = await prepare(report([outputRoute]));
      const deadline = Date.now() + 45000;
      let ready;
      while (Date.now() < deadline) {
        ready = await client.request(`/playback-sessions/${output.session_id}`);
        if (ready.complete) break;
        await delay(150);
      }
      assert.equal(ready.complete, true);
      const path = resolve(
        f.env.CACHE_ROOT,
        f.sql(
          `SELECT o.relative_dir FROM media_outputs o JOIN media_jobs j ON j.id=o.job_id AND j.attempt=o.attempt WHERE j.session_id='${output.session_id}'`,
        ),
      );
      const probe = JSON.parse(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_streams",
            "-show_data",
            "-of",
            "json",
            resolve(path, "index.m3u8"),
          ],
          { env: f.env, timeout: 10000, encoding: "utf8" },
        ),
      );
      const video = probe.streams.find((v) => v.codec_type === "video"),
        audio = probe.streams.find((v) => v.codec_type === "audio");
      if (outputRoute === "transcode_720p") {
        assert.equal(video.width, 1280);
        assert.equal(video.height, 720);
        assert.equal(video.level, 31);
        assert.equal(video.profile, "High");
        assert.equal(video.r_frame_rate, "30/1");
        assert.match(video.extradata, /0164 001f/i);
      } else {
        assert.equal(video.width, 640);
        assert.equal(video.height, 360);
        assert.equal(video.r_frame_rate, "25/1");
      }
      assert.equal(audio.profile, "LC");
      assert.equal(audio.channels, 2);
      assert.equal(audio.sample_rate, "48000");
      await client.request(`/playback-sessions/${output.session_id}`, "DELETE");
    }
    console.log(
      "PASS: real FFmpeg remux/audio-only copy video and fixed transcode matches 720p30 High3.1/AAC-LC",
    );
    await appendFile(file, Buffer.from([0]));
    const changed = await client.request(
      "/playback-sessions",
      "POST",
      {
        ...request,
        mode: "auto",
        capabilities: {
          progressive_h264_aac: true,
          native_hls: false,
          mse_h264_aac: true,
        },
        candidate_report: report(["direct"]),
      },
      409,
    );
    assert.equal(changed.error.code, "SOURCE_CHANGED");
    f.sql(
      `UPDATE room_snapshots SET state=jsonb_set(state,'{media_generation}','2') WHERE room_id='${room.id}'`,
    );
    const stale = await client.request(
      "/playback-candidates",
      "POST",
      request,
      409,
    );
    assert.equal(stale.error.code, "STALE_MEDIA");
    console.log(
      "PASS: source replacement and stale generation cannot reuse capability binding",
    );
    // A fresh NAS index has no codec probe marker. Discovery must own and drain
    // an epoch-bound Worker grant rather than trusting generic indexed metadata.
    await f.startServer({ WORKER_URL: f.workerOrigin });
    const { agentId } = await f.startAgent();
    const until = Date.now() + 15000;
    let agentMedia;
    while (Date.now() < until) {
      agentMedia = f.sql(
        `SELECT id FROM media_items WHERE source_id='${agentId}' AND resource='actual.mp4' AND available LIMIT 1`,
      );
      if (agentMedia) break;
      await delay(100);
    }
    assert.ok(agentMedia);
    f.sql(
      `UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${agentMedia}"'),'{media_generation}','3') WHERE room_id='${room.id}'`,
    );
    const nas = await client.request("/playback-candidates", "POST", {
      ...request,
      media_generation: 3,
    });
    assert.ok(nas.binding);
    assert.equal(nas.candidates[0].id, "direct");
    assert.equal(
      f.sql(
        `SELECT metadata->>'capability_source_version'=source_version FROM media_items WHERE id='${agentMedia}'`,
      ),
      "t",
    );
    assert.equal(
      f.sql(
        "SELECT count(*) FROM playback_preparations WHERE drained_at IS NULL",
      ),
      "0",
    );
    assert.equal(
      f.sql(
        `SELECT count(*) FROM playback_sessions WHERE media_id='${agentMedia}' AND NOT stopped`,
      ),
      "0",
    );
    console.log(
      "PASS: first-use NAS candidates use verified versioned Worker probe and drain their temporary grant",
    );
    const nasReport = {
      binding: nas.binding,
      excluded_candidates: [],
      results: nas.candidates.map((v) => ({
        candidate_id: v.id,
        progressive: "probably",
        mse_supported: true,
        file_decoding: {
          supported: true,
          smooth: true,
          power_efficient: false,
        },
        mse_decoding: {
          supported: true,
          smooth: true,
          power_efficient: false,
        },
      })),
    };
    const epochGrant = await client.request("/playback-sessions", "POST", {
      ...request,
      media_generation: 3,
      mode: "auto",
      observation_version: 1,
      capabilities: {
        progressive_h264_aac: true,
        native_hls: false,
        mse_h264_aac: true,
      },
      candidate_report: nasReport,
    });
    const oldSample = { ...sample, media_generation: 3, seq: 1 };
    await client.request(
      `/playback-sessions/${epochGrant.session_id}/observations`,
      "POST",
      oldSample,
    );
    f.sql(
      `UPDATE rooms SET lifecycle_epoch=lifecycle_epoch+1 WHERE id='${room.id}'`,
    );
    const rejectedObservation = await client.request(
      `/playback-sessions/${epochGrant.session_id}/observations`,
      "POST",
      { ...oldSample, seq: 2 },
      409,
    );
    assert.equal(rejectedObservation.error.code, "ROOM_NOT_ACTIVE");
    const rejectedFinal = await client.request(
      `/playback-sessions/${epochGrant.session_id}`,
      "DELETE",
      { ...oldSample, seq: 2 },
      409,
    );
    assert.equal(rejectedFinal.error.code, "ROOM_NOT_ACTIVE");
    assert.equal(
      f.sql(
        `SELECT stopped FROM playback_sessions WHERE id='${epochGrant.session_id}'`,
      ),
      "t",
    );
    assert.equal(
      f.sql(
        `SELECT seq FROM playback_observations WHERE session_id='${epochGrant.session_id}'`,
      ),
      "1",
    );
    console.log(
      "PASS: old-epoch telemetry is rejected while owned final Stop still revokes its grant",
    );
    const oldEpoch = await client.request(
      "/playback-sessions",
      "POST",
      {
        ...request,
        media_generation: 3,
        mode: "auto",
        capabilities: {
          progressive_h264_aac: true,
          native_hls: false,
          mse_h264_aac: true,
        },
        candidate_report: nasReport,
      },
      409,
    );
    assert.equal(oldEpoch.error.code, "STALE_CAPABILITY_REPORT");
    console.log(
      "PASS: an old lifecycle epoch cannot reuse an otherwise current source binding",
    );
  },
  { env: { PLAYBACK_SESSION_LIMIT: "20" } },
);
