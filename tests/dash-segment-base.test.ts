import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as cmcd from "@svta/cml-cmcd";
import { platformSegmentBaseExtension } from "../packages/player-core/dash/segment-base";

// Execute the installed SDK's preserved sources, changing only module wiring.
// This exercises its real FactoryMaker override/parent contract and getter;
// the expected ranges are not computed by a second copy of our selector.
const map = JSON.parse(
  readFileSync(
    new URL(
      "../node_modules/dashjs/dist/modern/esm/dash.all.debug.js.map",
      import.meta.url,
    ),
    "utf8",
  ),
) as { sources: string[]; sourcesContent: string[] };
const source = (suffix: string) => {
  const index = map.sources.findIndex((path) => path.endsWith(suffix));
  if (index < 0) throw new Error(`Installed dash.js source missing: ${suffix}`);
  return map.sourcesContent[index];
};
const factoryMaker = new Function(
  source("/core/FactoryMaker.js").replace(
    "export default FactoryMaker;",
    "return FactoryMaker;",
  ),
)();
const constants = new Function(
  "cmcd",
  source("/streaming/constants/Constants.js")
    .replace(
      /import\s*\{([^}]+)\}\s*from\s*'@svta\/cml-cmcd';/,
      "const {$1} = cmcd;",
    )
    .replace("export default", "return"),
)(cmcd);
const getterFactory = new Function(
  "FactoryMaker",
  "Constants",
  source("/dash/utils/SegmentBaseGetter.js")
    .replace(/^import .*;\s*$/gm, "")
    .replace("export default factory;", "return factory;"),
)(factoryMaker, constants);
const config = {
  timelineConverter: { calcPeriodRelativeTimeFromMpdRelativeTime: () => 0 },
};
const segment = (index: number, start = index * 5, duration = 5) => ({
  index,
  presentationStartTime: start,
  duration,
  mediaRange: `${index * 100}-${index * 100 + 99}`,
});
const representation = (offset = 0) => ({
  segmentInfoType: "SegmentBase",
  segments: Array.from({ length: 9 }, (_, index) =>
    segment(index, index * 5 + offset),
  ),
});
function getter(enabled = () => true, dynamic = false) {
  const context = {};
  factoryMaker.extend(
    "SegmentBaseGetter",
    platformSegmentBaseExtension(enabled),
    true,
    context,
  );
  return getterFactory(context).create(config, dynamic);
}

it("fixes the installed SDK's extra previous segment without replacing index scheduling", () => {
  const vod = representation(),
    original = getterFactory({}).create(config, false),
    precise = getter();
  expect(original.getSegmentByTime(vod, 36).mediaRange).toBe("600-699");
  for (const [time, index] of [
    [35, 7],
    [36, 7],
    [38, 7],
    [40, 8],
  ] as const)
    expect(precise.getSegmentByTime(vod, time)).toBe(vod.segments[index]);
  expect(precise.getSegmentByIndex(vod, 6)).toBe(vod.segments[6]);
  expect(precise.getMediaFinishedInformation(vod).numberOfSegments).toBe(9);
});

it("keeps half-open boundaries, independently resolves A/V offsets, and allows only 1 ms leading rounding", () => {
  const precise = getter(),
    video = representation(),
    audio = representation(0.008);
  expect(precise.getSegmentByTime(video, 34.9995)).toBe(video.segments[6]);
  expect(precise.getSegmentByTime(video, 35)).toBe(video.segments[7]);
  expect(precise.getSegmentByTime(audio, 35)).toBe(audio.segments[6]);
  expect(precise.getSegmentByTime(audio, 35.008)).toBe(audio.segments[7]);
  const rounded = representation(0.001);
  expect(precise.getSegmentByTime(rounded, 0)).toBe(rounded.segments[0]);
  expect(precise.getSegmentByTime(representation(0.0011), 0)).toBeNull();
  const gap = {
    segmentInfoType: "SegmentBase",
    segments: [segment(0, 0), segment(1, 5.0005)],
  };
  expect(precise.getSegmentByTime(gap, 5)).toBe(gap.segments[1]);
  gap.segments[1] = segment(1, 5.002);
  expect(precise.getSegmentByTime(gap, 5)).toBeNull();
});

it("does not read a previous segment beyond the VOD end or for unusable indices", () => {
  const precise = getter(),
    vod = representation();
  expect(precise.getSegmentByTime(vod, 44.999)).toBe(vod.segments[8]);
  for (const time of [45, 45.001, NaN, Infinity, -Infinity, -0.002])
    expect(precise.getSegmentByTime(vod, time)).toBeNull();
  for (const segments of [
    [],
    [segment(0, NaN)],
    [segment(0, 0, NaN)],
    [segment(0, 0, 0)],
    [segment(-1)],
  ])
    expect(
      precise.getSegmentByTime({ segmentInfoType: "SegmentBase", segments }, 0),
    ).toBeNull();
  expect(
    precise.getSegmentByTime(
      { segmentInfoType: "SegmentBase", segments: null },
      0,
    ),
  ).toBeNull();
});

it("is stateless across successive seeks and isolated by player context, manifest approval and disposal", () => {
  let current = false;
  const scoped = getter(() => current),
    otherPlayer = getterFactory({}).create(config, false),
    vod = representation();
  expect(scoped.getSegmentByTime(vod, 36)).toBe(vod.segments[6]);
  current = true;
  for (const [time, index] of [
    [36, 7],
    [8, 1],
    [40, 8],
    [35, 7],
    [0, 0],
  ] as const)
    expect(scoped.getSegmentByTime(vod, time)).toBe(vod.segments[index]);
  expect(otherPlayer.getSegmentByTime(vod, 36)).toBe(vod.segments[6]);
  expect(getter(() => true, true).getSegmentByTime(vod, 36)).toBe(
    vod.segments[6],
  );
  expect(
    scoped.getSegmentByTime({ ...vod, segmentInfoType: "SegmentTemplate" }, 36),
  ).toBe(vod.segments[6]);
  current = false; // release invalidates the approval callback before SDK teardown
  expect(scoped.getSegmentByTime(vod, 36)).toBe(vod.segments[6]);
});
