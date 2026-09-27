import assert from "node:assert/strict";

// API/persistence assertions only; real decoded track contents are checked by
// audio-fixtures.mjs with the same production FFmpeg argument builder.
export async function audioRouting({ admin, room, state, sql }) {
  const original = sql(
    `SELECT metadata FROM media_items WHERE id='${state.media_id}'`,
  );
  const metadata = {
    format: { format_name: "mov,mp4" },
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" },
      {
        index: 1,
        codec_type: "audio",
        codec_name: "aac",
        tags: { language: "eng" },
      },
      {
        index: 2,
        codec_type: "audio",
        codec_name: "aac",
        tags: { language: "jpn" },
      },
    ],
  };
  sql(
    `UPDATE media_items SET metadata='${JSON.stringify(metadata)}'::jsonb WHERE id='${state.media_id}'`,
  );
  const request = {
    room_id: room.id,
    media_generation: state.media_generation,
    position_ms: 1250,
    audio_index: 2,
  };
  try {
    for (const mode of ["auto", "direct", "remux", "transcode"]) {
      const plan = await admin.request("/playback-sessions", "POST", {
        ...request,
        mode,
      });
      // Nonzero origin requires precise decode/discard, including a remux request.
      assert.equal(plan.delivery_mode, "transcode");
      assert.equal(plan.transport, "hls");
      assert.equal(plan.timeline_origin_ms, 1250);
      const spec = JSON.parse(
        sql(
          `SELECT spec FROM media_jobs WHERE session_id='${plan.session_id}'`,
        ),
      );
      assert.equal(spec.audio_index, 2);
      assert.equal(spec.start_seconds, 1.25);
      await admin.request(`/playback-sessions/${plan.session_id}`, "DELETE");
    }
    for (const audio_index of [0, 99]) {
      const error = await admin.request(
        "/playback-sessions",
        "POST",
        { ...request, mode: "direct", audio_index },
        400,
      );
      assert.equal(error.error.code, "INVALID_AUDIO_TRACK");
    }
    const unsupported = await admin.request(
      "/playback-sessions",
      "POST",
      {
        ...request,
        mode: "direct",
        capabilities: {
          progressive_h264_aac: true,
          native_hls: false,
          mse_h264_aac: false,
        },
      },
      422,
    );
    assert.equal(
      unsupported.error.code,
      "DEVICE_HAS_NO_COMPATIBLE_PLAYBACK_TRANSPORT",
    );
  } finally {
    sql(
      `UPDATE media_items SET metadata='${original.replaceAll("'", "''")}'::jsonb WHERE id='${state.media_id}'`,
    );
  }
  console.log(
    "PASS: explicit audio selection reaches local HLS jobs; invalid indices and missing HLS transport rejected",
  );
}
