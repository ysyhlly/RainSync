// Pure, fail-closed prerequisite analyzer. It does not fetch media, confer a
// grant, or enable decoder fallback. The caller must bind successful decoder
// output to exactly these bytes and enforce cancellation/deadlines externally.
import { createHash } from "node:crypto";

export const STATIC_HLS_LIMITS = Object.freeze({
  manifestBytes: 256 * 1024,
  initBytes: 2 * 1024 * 1024,
  resourceBytes: 32 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  segments: 64,
  seconds: 300,
  records: 70000,
  decodeMilliseconds: 35000,
  decoderOutputBytes: 16 * 1024 * 1024,
  decoderAddressSpaceBytes: 1024 * 1024 * 1024,
});
const fail = (reason) => {
  throw new Error(`unsupported_static_hls_timeline:${reason}`);
};
const check = (condition, reason) => {
  if (!condition) fail(reason);
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const integer = (value, label, minimum = 0) => {
  check(Number.isSafeInteger(value) && value >= minimum, label);
  return value;
};

export function staticMediaPlaylist(text) {
  check(
    typeof text === "string" &&
      Buffer.byteLength(text) <= STATIC_HLS_LIMITS.manifestBytes,
    "manifest_bound",
  );
  const lines = text.trimEnd().split(/\r?\n/);
  check(lines.shift() === "#EXTM3U", "manifest_header");
  let map,
    duration,
    target,
    version,
    sequence,
    ended = false,
    vod = false;
  const segments = [];
  for (const line of lines) {
    check(line === line.trim() && line.length > 0 && !ended, "manifest_order");
    if (line === "#EXT-X-ENDLIST") {
      check(duration === undefined, "dangling_duration");
      ended = true;
    } else if (line === "#EXT-X-PLAYLIST-TYPE:VOD") {
      check(!vod, "duplicate_playlist_type");
      vod = true;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const match = /^#EXT-X-MAP:URI="([^"\r\n]+)"$/.exec(line);
      check(
        match && map === undefined && segments.length === 0,
        "single_init_required",
      );
      map = match[1];
    } else if (line.startsWith("#EXTINF:")) {
      check(duration === undefined, "duplicate_duration");
      const match = /^#EXTINF:([0-9]+(?:\.[0-9]{1,6})?),$/.exec(line);
      check(match, "duration_format");
      duration = Number(match[1]);
      check(duration > 0 && duration <= 32, "segment_duration_bound");
    } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      check(
        target === undefined &&
          /^#EXT-X-TARGETDURATION:[1-9][0-9]?$/.test(line),
        "target_duration",
      );
      target = Number(line.split(":")[1]);
      check(target <= 32, "target_duration_bound");
    } else if (line.startsWith("#EXT-X-VERSION:")) {
      check(
        version === undefined && /^#EXT-X-VERSION:[6-7]$/.test(line),
        "manifest_version",
      );
      version = Number(line.split(":")[1]);
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      check(
        sequence === undefined && /^#EXT-X-MEDIA-SEQUENCE:[0-9]+$/.test(line),
        "media_sequence",
      );
      sequence = integer(Number(line.split(":")[1]), "media_sequence");
    } else if (!line.startsWith("#")) {
      check(
        map &&
          duration !== undefined &&
          !line.includes("{$") &&
          !/[\x00-\x20\x7f]/.test(line),
        "segment_reference",
      );
      check(
        segments.length < STATIC_HLS_LIMITS.segments,
        "segment_count_bound",
      );
      segments.push({ uri: line, duration });
      duration = undefined;
    } else {
      // Closed subset. Unknown tags must never silently acquire clock meaning.
      fail("unsupported_manifest_tag");
    }
  }
  check(
    ended && vod && map && target && version && segments.length > 0,
    "static_fmp4_required",
  );
  const seconds = segments.reduce((sum, segment) => sum + segment.duration, 0);
  check(seconds <= STATIC_HLS_LIMITS.seconds, "duration_bound");
  check(
    segments.every((segment) => Math.ceil(segment.duration) <= target),
    "target_duration_mismatch",
  );
  check(
    new Set([map, ...segments.map((segment) => segment.uri)]).size ===
      segments.length + 1,
    "duplicate_resource",
  );
  return { map, segments, seconds, sequence: sequence ?? 0 };
}

// Parse only bounded ISO-BMFF boxes. Extended/zero sizes and unknown timing
// structures are outside this first prerequisite slice, not guessed defaults.
function boxes(bytes, start = 0, end = bytes.length) {
  const result = [];
  while (start < end) {
    check(start + 8 <= end, "truncated_box");
    const size = bytes.readUInt32BE(start);
    check(size >= 8 && start + size <= end && result.length < 128, "box_bound");
    result.push({
      type: bytes.toString("ascii", start + 4, start + 8),
      data: bytes.subarray(start + 8, start + size),
    });
    start += size;
  }
  return result;
}
function one(list, type) {
  const selected = list.filter((box) => box.type === type);
  check(selected.length === 1, `single_${type}_required`);
  return selected[0].data;
}
function full(data, version, size) {
  check(data.length >= size && data[0] === version, "box_version_or_length");
}
function u64(data, offset) {
  check(offset + 8 <= data.length, "truncated_integer");
  const value = data.readBigUInt64BE(offset);
  check(value <= BigInt(Number.MAX_SAFE_INTEGER), "timestamp_bound");
  return Number(value);
}
function initTracks(bytes) {
  check(
    Buffer.isBuffer(bytes) &&
      bytes.length > 0 &&
      bytes.length <= STATIC_HLS_LIMITS.initBytes,
    "init_bound",
  );
  const top = boxes(bytes);
  check(
    top.every((box) => ["ftyp", "moov"].includes(box.type)),
    "init_box_type",
  );
  one(top, "ftyp");
  const moov = boxes(one(top, "moov"));
  const tracks = moov
    .filter((box) => box.type === "trak")
    .map(({ data }) => {
      const track = boxes(data),
        tkhd = one(track, "tkhd");
      full(tkhd, 0, 24);
      const id = integer(tkhd.readUInt32BE(12), "track_id", 1);
      const mdia = boxes(one(track, "mdia")),
        mdhd = one(mdia, "mdhd"),
        hdlr = one(mdia, "hdlr");
      full(mdhd, 0, 24);
      full(hdlr, 0, 12);
      const scale = integer(mdhd.readUInt32BE(12), "timescale", 1);
      check(scale <= 1000000, "timescale_bound");
      const kind = hdlr.toString("ascii", 8, 12);
      check(["vide", "soun"].includes(kind), "unknown_track");
      const stsd = one(boxes(one(boxes(one(mdia, "minf")), "stbl")), "stsd");
      full(stsd, 0, 16);
      check(stsd.readUInt32BE(4) === 1, "alternate_sample_description");
      const sample = boxes(stsd, 8);
      check(
        sample.length === 1 &&
          sample[0].type === (kind === "vide" ? "avc1" : "mp4a"),
        "unsupported_codec_entry",
      );
      if (kind === "vide") {
        check(
          sample[0].data.length >= 28 &&
            sample[0].data.readUInt16BE(24) > 0 &&
            sample[0].data.readUInt16BE(24) <= 1920 &&
            sample[0].data.readUInt16BE(26) > 0 &&
            sample[0].data.readUInt16BE(26) <= 1080,
          "init_geometry_bound",
        );
      } else {
        check(
          sample[0].data.length >= 28 &&
            [1, 2].includes(sample[0].data.readUInt16BE(16)) &&
            sample[0].data.readUInt32BE(24) === 48000 * 65536,
          "init_audio_bound",
        );
      }
      const edit = one(boxes(one(track, "edts")), "elst");
      full(edit, 0, 20);
      check(
        edit.readUInt32BE(0) === 0 &&
          edit.length === 20 &&
          edit.readUInt32BE(4) === 1 &&
          edit.readUInt32BE(8) === 0 &&
          edit.readUInt32BE(16) === 65536,
        "unknown_edit_list",
      );
      const mediaTime = edit.readInt32BE(12);
      check(
        kind === "vide" ? mediaTime === 0 : [0, 1024].includes(mediaTime),
        "unknown_edit_offset",
      );
      return {
        id,
        kind: kind === "vide" ? "video" : "audio",
        scale,
        mediaTime,
      };
    });
  check(
    tracks.length >= 1 &&
      tracks.length <= 2 &&
      tracks.filter((track) => track.kind === "video").length === 1 &&
      tracks.filter((track) => track.kind === "audio").length <= 1,
    "track_set",
  );
  check(
    new Set(tracks.map((track) => track.id)).size === tracks.length,
    "duplicate_track",
  );
  return tracks;
}

function fragmentSamples(bytes, tracks, remainingSamples) {
  check(
    Buffer.isBuffer(bytes) &&
      bytes.length > 0 &&
      bytes.length <= STATIC_HLS_LIMITS.resourceBytes,
    "resource_bound",
  );
  const top = boxes(bytes);
  check(
    top.every((box) => ["styp", "sidx", "moof", "mdat"].includes(box.type)),
    "fragment_box_type",
  );
  const mdat = one(top, "mdat"),
    moof = boxes(one(top, "moof"));
  check(
    moof.every((box) => ["mfhd", "traf"].includes(box.type)),
    "fragment_clock_structure",
  );
  one(moof, "mfhd");
  let collectedSamples = 0;
  const fragments = moof
    .filter((box) => box.type === "traf")
    .map(({ data }) => {
      const children = boxes(data);
      check(
        children.every((box) => ["tfhd", "tfdt", "trun"].includes(box.type)),
        "unknown_fragment_timing",
      );
      const tfhd = one(children, "tfhd"),
        tfdt = one(children, "tfdt"),
        trun = one(children, "trun");
      full(tfhd, 0, 20);
      // Exact first-slice ffmpeg self-contained fragment shape, with explicit
      // default duration/size/flags and no alternate sample description.
      check(
        tfhd.readUInt32BE(0) === 0x20038 && tfhd.length === 20,
        "unsupported_tfhd",
      );
      const track = tracks.find((track) => track.id === tfhd.readUInt32BE(4));
      check(track, "fragment_unknown_track");
      const defaultDuration = tfhd.readUInt32BE(8),
        defaultSize = tfhd.readUInt32BE(12);
      check(defaultDuration > 0 && defaultSize > 0, "sample_defaults");
      check(
        tfdt.length === (tfdt[0] === 1 ? 12 : 8) &&
          [0, 0x1000000].includes(tfdt.readUInt32BE(0)),
        "tfdt_version",
      );
      let clock = tfdt[0] === 1 ? u64(tfdt, 4) : tfdt.readUInt32BE(4);
      full(trun, 0, 12);
      const flags = trun.readUInt32BE(0),
        count = trun.readUInt32BE(4);
      check(
        count > 0 &&
          count <= remainingSamples - collectedSamples &&
          (flags & ~0x305) === 0 &&
          (flags & 1) !== 0,
        "unsupported_trun",
      );
      collectedSamples += count;
      let offset = 12 + (flags & 4 ? 4 : 0);
      const samples = [];
      for (let index = 0; index < count; index++) {
        check(
          offset + (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) <=
            trun.length,
          "truncated_samples",
        );
        const duration =
          flags & 0x100 ? trun.readUInt32BE(offset) : defaultDuration;
        offset += flags & 0x100 ? 4 : 0;
        const size = flags & 0x200 ? trun.readUInt32BE(offset) : defaultSize;
        offset += flags & 0x200 ? 4 : 0;
        check(duration > 0 && size > 0, "empty_sample");
        samples.push({ pts: clock - track.mediaTime, duration, size });
        clock += duration;
        integer(clock, "sample_timestamp_bound");
      }
      check(offset === trun.length, "sample_table_length");
      return { track, samples };
    });
  check(
    fragments.length === tracks.length &&
      new Set(fragments.map(({ track }) => track.id)).size === tracks.length,
    "segment_track_set_changed",
  );
  check(
    fragments.reduce(
      (sum, part) =>
        sum + part.samples.reduce((sum, sample) => sum + sample.size, 0),
      0,
    ) === mdat.length,
    "media_payload_size",
  );
  return fragments;
}

/** Validate actual source bytes plus complete decoder observations. Probe data
 * is evidence, never client authority. Use inspectStaticHlsTimeline only after
 * the bounded owned runner has checked success, hashes, duration and teardown. */
export function inspectStaticHlsStructure({ manifest, init, segments }) {
  const playlist = staticMediaPlaylist(manifest);
  check(
    Array.isArray(segments) && segments.length === playlist.segments.length,
    "incomplete_closure",
  );
  const tracks = initTracks(init);
  check(
    Buffer.byteLength(manifest) +
      init.length +
      segments.reduce((sum, bytes) => sum + bytes.length, 0) <=
      STATIC_HLS_LIMITS.totalBytes,
    "total_bytes_bound",
  );
  const allSamples = new Map(tracks.map((track) => [track.id, []]));
  let remainingSamples = Math.floor(STATIC_HLS_LIMITS.records / 2);
  const resources = segments.map((bytes, index) => {
    const fragments = fragmentSamples(bytes, tracks, remainingSamples);
    remainingSamples -= fragments.reduce(
      (sum, fragment) => sum + fragment.samples.length,
      0,
    );
    for (const { track, samples } of fragments)
      allSamples.get(track.id).push(...samples);
    const video = fragments.find(({ track }) => track.kind === "video");
    check(
      Math.abs(
        video.samples.reduce((sum, sample) => sum + sample.duration, 0) /
          video.track.scale -
          playlist.segments[index].duration,
      ) <= 0.0000011,
      "manifest_media_duration_mismatch",
    );
    return {
      index,
      bytes: bytes.length,
      sha256: sha(bytes),
      track_ids: fragments.map(({ track }) => track.id),
    };
  });
  const sampleCount = [...allSamples.values()].reduce(
    (sum, samples) => sum + samples.length,
    0,
  );
  check(
    sampleCount * 2 <= STATIC_HLS_LIMITS.records,
    "source_sample_count_bound",
  );
  return { playlist, tracks, allSamples, resources };
}

export function inspectStaticHlsTimeline({ manifest, init, segments, probe }) {
  const { playlist, tracks, allSamples, resources } = inspectStaticHlsStructure(
    { manifest, init, segments },
  );
  check(
    Array.isArray(probe?.streams) && probe.streams.length === tracks.length,
    "decoder_track_set",
  );
  check(
    Array.isArray(probe?.packets_and_frames) &&
      probe.packets_and_frames.length > 0 &&
      probe.packets_and_frames.length <= STATIC_HLS_LIMITS.records,
    "decoder_record_bound",
  );
  const summaries = tracks.map((track) => {
    const sameKind = probe.streams.filter(
      (stream) => stream.codec_type === track.kind,
    );
    check(sameKind.length === 1, "decoder_track_identity");
    const stream = sameKind[0];
    check(
      stream.id === undefined || Number(stream.id) === track.id,
      "decoder_track_id",
    );
    check(
      stream &&
        stream.codec_type === track.kind &&
        stream.time_base === `1/${track.scale}`,
      "decoder_track_identity",
    );
    integer(stream.index, "stream_index");
    if (track.kind === "video") {
      check(
        stream.codec_name === "h264" &&
          stream.has_b_frames === 0 &&
          Number.isSafeInteger(stream.width) &&
          stream.width > 0 &&
          stream.width <= 1920 &&
          Number.isSafeInteger(stream.height) &&
          stream.height > 0 &&
          stream.height <= 1080,
        "video_recipe_scope",
      );
    } else {
      check(
        stream.codec_name === "aac" &&
          Number(stream.sample_rate) === 48000 &&
          track.scale === 48000 &&
          [1, 2].includes(stream.channels),
        "audio_recipe_scope",
      );
    }
    const records = probe.packets_and_frames.filter(
      (record) => record.stream_index === stream.index,
    );
    check(
      records.length > 0 &&
        records.every((record) => ["packet", "frame"].includes(record.type)),
      "unknown_decoder_record",
    );
    const packets = records.filter((record) => record.type === "packet"),
      frames = records.filter((record) => record.type === "frame"),
      samples = allSamples.get(track.id);
    if (track.kind === "video")
      check(
        [25, 30].includes(track.scale / samples[0].duration) &&
          samples.every((sample) => sample.duration === samples[0].duration),
        "video_frame_rate_scope",
      );
    else
      check(
        samples.every(
          (sample, index) =>
            sample.duration === 1024 ||
            (index === samples.length - 1 &&
              sample.duration > 0 &&
              sample.duration < 1024),
        ),
        "unknown_audio_sample_duration",
      );
    check(
      packets.length === samples.length && frames.length > 0,
      "incomplete_decoder_scan",
    );
    let priming = 0;
    samples.forEach((sample, index) => {
      const packet = packets[index];
      integer(packet.pts, "packet_pts", -1024);
      check(
        packet.pts === sample.pts && packet.dts === packet.pts,
        "packet_sample_clock_mismatch",
      );
      if (index > 0)
        check(
          sample.pts === samples[index - 1].pts + samples[index - 1].duration,
          "source_timestamp_gap_or_overlap",
        );
      const sides = packet.side_data_list ?? [];
      check(Array.isArray(sides), "packet_side_data");
      if (index === 0 && track.kind === "audio" && track.mediaTime === 1024) {
        check(
          sample.pts === -1024 &&
            sample.duration === 1024 &&
            sides.length === 1 &&
            sides[0].side_data_type === "Skip Samples" &&
            sides[0].skip_samples === 1024 &&
            sides[0].discard_padding === 0,
          "aac_priming_mismatch",
        );
        priming = 1024;
      } else {
        check(
          sides.length === 0 &&
            packet.duration ===
              (track.kind === "audio" ? 1024 : sample.duration),
          "unknown_packet_priming_or_duration",
        );
      }
    });
    const displayed = priming ? samples.slice(1) : samples;
    check(frames.length === displayed.length, "decoded_sample_count");
    frames.forEach((frame, index) => {
      const sample = displayed[index];
      check(
        frame.media_type === track.kind &&
          frame.pts === sample.pts &&
          frame.best_effort_timestamp === frame.pts,
        "decoded_presentation_clock",
      );
      const duration = frame.duration ?? frame.pkt_duration;
      check(
        duration === (track.kind === "audio" ? 1024 : sample.duration),
        "decoded_duration",
      );
      if (track.kind === "audio")
        check(
          frame.nb_samples === duration && duration === 1024,
          "audio_sample_clock",
        );
      else
        check(
          frame.width === stream.width && frame.height === stream.height,
          "video_geometry_changed",
        );
      if (index === 0) check(frame.pts === 0, "nonzero_presentation_origin");
    });
    const last = displayed.at(-1),
      end =
        (last.pts + (track.kind === "audio" ? 1024 : last.duration)) /
        track.scale;
    check(
      end > 0 && end <= STATIC_HLS_LIMITS.seconds + 1024 / 48000,
      "decoded_duration_bound",
    );
    return {
      track_id: track.id,
      stream_index: stream.index,
      kind: track.kind,
      time_base: stream.time_base,
      packet_count: packets.length,
      decoded_frames: frames.length,
      raw_first_pts: samples[0].pts,
      decoded_first_pts: frames[0].pts,
      priming_samples: priming,
      tail_padding_samples: track.kind === "audio" ? 1024 - last.duration : 0,
      raw_end_seconds: (last.pts + last.duration) / track.scale,
      end_seconds: end,
      last_frame_pts: frames.at(-1).pts,
    };
  });
  const indices = new Set(summaries.map((track) => track.stream_index));
  check(
    probe.packets_and_frames.every((record) =>
      indices.has(record.stream_index),
    ),
    "decoder_extra_track",
  );
  const video = summaries.find((track) => track.kind === "video"),
    audio = summaries.find((track) => track.kind === "audio");
  check(
    Math.abs(video.end_seconds - playlist.seconds) <= 0.0000011,
    "full_timeline_duration",
  );
  if (audio)
    check(
      Math.abs(audio.raw_end_seconds - video.end_seconds) <= 0.0000011 &&
        audio.end_seconds >= video.end_seconds &&
        audio.end_seconds - video.end_seconds <= 1024 / 48000 + 0.000001,
      "audio_video_end_alignment",
    );
  return {
    version: 1,
    scope: "bounded-zero-origin-avc-fmp4-prerequisite-only",
    source_origin_ms: 0,
    duration_ms: playlist.seconds * 1000,
    media_sequence: playlist.sequence,
    manifest_sha256: sha(manifest),
    manifest_bytes: Buffer.byteLength(manifest),
    init: { bytes: init.length, sha256: sha(init) },
    segments: resources,
    tracks: summaries,
  };
}

// Version/bytes, not the zero-origin result, freeze a representation. A new
// equally valid timeline is still a different source closure.
export function requireSameStaticHlsClosure(expected, current) {
  const hash = (value) =>
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  const size = (value, maximum) =>
    Number.isSafeInteger(value) && value > 0 && value <= maximum;
  for (const proof of [expected, current]) {
    check(
      proof?.version === 1 &&
        hash(proof.manifest_sha256) &&
        size(proof.manifest_bytes, STATIC_HLS_LIMITS.manifestBytes) &&
        hash(proof.init?.sha256) &&
        size(proof.init?.bytes, STATIC_HLS_LIMITS.initBytes) &&
        Array.isArray(proof.segments) &&
        proof.segments.length > 0 &&
        proof.segments.length <= STATIC_HLS_LIMITS.segments,
      "closure_proof_shape",
    );
    check(
      proof.segments.every(
        (segment, index) =>
          segment?.index === index &&
          hash(segment.sha256) &&
          size(segment.bytes, STATIC_HLS_LIMITS.resourceBytes),
      ),
      "closure_proof_shape",
    );
    check(
      proof.manifest_bytes +
        proof.init.bytes +
        proof.segments.reduce((sum, segment) => sum + segment.bytes, 0) <=
        STATIC_HLS_LIMITS.totalBytes,
      "closure_proof_shape",
    );
  }
  const identity = (proof) => ({
    manifest: proof.manifest_sha256,
    manifest_bytes: proof.manifest_bytes,
    init: { bytes: proof.init.bytes, sha256: proof.init.sha256 },
    segments: proof.segments.map(({ index, bytes, sha256 }) => ({
      index,
      bytes,
      sha256,
    })),
  });
  check(
    JSON.stringify(identity(expected)) === JSON.stringify(identity(current)),
    "source_changed",
  );
}

// Byte inventory is deliberately separate from timeline eligibility. A caller
// can reject a changed graph before attempting to reuse any decoder evidence.
export function staticHlsByteIdentity(input) {
  const { resources } = inspectStaticHlsStructure(input);
  return {
    version: 1,
    manifest_sha256: sha(input.manifest),
    manifest_bytes: Buffer.byteLength(input.manifest),
    init: { bytes: input.init.length, sha256: sha(input.init) },
    segments: resources,
  };
}
