import { readFileSync } from "node:fs";

// Locally generated FFmpeg 5.1.9 AVC baseline/AAC clear samples, 45 seconds,
// 160x90 at 10 fps, keyframes every 5 s; AAC intentionally has distinct times.
// Original single-file DASH output stores one SIDX per fragment. Combine its
// actual index entries into an on-demand global SIDX; moof/mdat bytes stay exact.
// No platform URLs, downloads, credentials, FFmpeg or Docker are needed at test time.
interface Fragment {
  data: Buffer;
  duration: number;
}
export interface DashTrackFixture {
  data: Buffer;
  initialization: string;
  indexRange: string;
  segments: { start: number; end: number; range: string }[];
}
export function dashTrackFixture(kind: "video" | "audio"): DashTrackFixture {
  const input = Buffer.from(
    readFileSync(
      new URL(
        `../../fixtures/dash-segment-base-${kind}.base64`,
        import.meta.url,
      ),
      "utf8",
    ),
    "base64",
  );
  const fragments: Fragment[] = [];
  let initEnd = 0,
    timescale = 0,
    earliest = 0,
    referenceId = 0;
  for (let offset = 0; offset + 8 <= input.length;) {
    const size = input.readUInt32BE(offset),
      type = input.toString("ascii", offset + 4, offset + 8);
    if (size < 8 || offset + size > input.length)
      throw new Error("Invalid MP4 fixture box");
    if (type !== "sidx") {
      offset += size;
      continue;
    }
    if (input[offset + 8] !== 1 || input.readUInt16BE(offset + 38) !== 1)
      throw new Error("Expected FFmpeg version-1 one-reference SIDX");
    if (!fragments.length) {
      initEnd = offset;
      referenceId = input.readUInt32BE(offset + 12);
      timescale = input.readUInt32BE(offset + 16);
      earliest = Number(input.readBigUInt64BE(offset + 20));
    }
    const firstOffset = Number(input.readBigUInt64BE(offset + 28));
    const length = input.readUInt32BE(offset + 40) & 0x7fff_ffff;
    const start = offset + size + firstOffset;
    fragments.push({
      data: input.subarray(start, start + length),
      duration: input.readUInt32BE(offset + 44),
    });
    offset = start + length;
  }
  if (fragments.length !== 9 || !timescale)
    throw new Error("Expected nine indexed VOD fragments");
  const index = Buffer.alloc(32 + fragments.length * 12);
  index.writeUInt32BE(index.length, 0);
  index.write("sidx", 4, "ascii");
  index.writeUInt32BE(referenceId, 12);
  index.writeUInt32BE(timescale, 16);
  index.writeUInt32BE(earliest, 20);
  index.writeUInt16BE(fragments.length, 30);
  let byteOffset = initEnd + index.length,
    time = earliest / timescale;
  const segments = fragments.map((fragment, number) => {
    index.writeUInt32BE(fragment.data.length, 32 + number * 12);
    index.writeUInt32BE(fragment.duration, 36 + number * 12);
    index.writeUInt32BE(0x9000_0000, 40 + number * 12); // SAP starts at this fragment
    const range = `${byteOffset}-${byteOffset + fragment.data.length - 1}`;
    const start = time;
    byteOffset += fragment.data.length;
    time += fragment.duration / timescale;
    return { start, end: time, range };
  });
  return {
    data: Buffer.concat([
      input.subarray(0, initEnd),
      index,
      ...fragments.map((fragment) => fragment.data),
    ]),
    initialization: `0-${initEnd - 1}`,
    indexRange: `${initEnd}-${initEnd + index.length - 1}`,
    segments,
  };
}

export function dashFixtureManifest(
  path: string,
  query: string,
  video: DashTrackFixture,
  audio: DashTrackFixture,
) {
  const representation = (kind: "video" | "audio", track: DashTrackFixture) =>
    `<AdaptationSet id="${kind}" contentType="${kind}" mimeType="${kind}/mp4">
      <Representation id="${kind}_1" codecs="${kind === "video" ? "avc1.42d00b" : "mp4a.40.2"}" bandwidth="${kind === "video" ? 35000 : 16000}" ${kind === "video" ? 'width="160" height="90" frameRate="10"' : 'audioSamplingRate="48000"'}>
        <BaseURL>${path}tracks/${kind}_1${query}</BaseURL>
        <SegmentBase indexRange="${track.indexRange}" indexRangeExact="true"><Initialization range="${track.initialization}"/></SegmentBase>
      </Representation>
    </AdaptationSet>`;
  return `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" mediaPresentationDuration="PT45S" minBufferTime="PT1.5S"><Period id="vod" start="PT0S" duration="PT45S">${representation("video", video)}${representation("audio", audio)}</Period></MPD>`;
}
