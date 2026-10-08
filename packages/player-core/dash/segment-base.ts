/** dash.js 5.2's SegmentBaseGetter permits half a segment of overlap when
 * choosing by time. For our generated finite VODs that can fetch the previous
 * five-second video segment before the segment containing a seek target.
 *
 * Install through MediaPlayer.extend, per player, before initialize. The
 * manifest interceptor must approve our generated static MPD before enabled
 * becomes true. Keep index-based scheduling and every request guard in dash.js.
 */
interface IndexedSegment {
  presentationStartTime: number;
  duration: number;
  index: number;
}
interface IndexedRepresentation {
  segmentInfoType?: string;
  segments?: IndexedSegment[] | null;
}
interface SegmentBaseParent {
  getSegmentByTime(
    representation: IndexedRepresentation | null,
    time: number,
  ): unknown;
  getSegmentByIndex(
    representation: IndexedRepresentation,
    index: number,
  ): unknown;
}
interface ExtensionScope {
  parent: SegmentBaseParent;
}

const START_TOLERANCE_SECONDS = 0.001;

export function platformSegmentBaseExtension(enabled: () => boolean) {
  return function (this: ExtensionScope, _config?: unknown, isDynamic = false) {
    const parent = this.parent;
    // FactoryMaker merges the override into this same parent object, so capture
    // the original function before the merge to keep fallback non-recursive.
    const originalByTime = parent.getSegmentByTime.bind(parent);
    return {
      getSegmentByTime(
        representation: IndexedRepresentation | null,
        time: number,
      ) {
        if (
          isDynamic ||
          !enabled() ||
          representation?.segmentInfoType !== "SegmentBase"
        )
          return originalByTime(representation, time);
        if (!Number.isFinite(time) || !representation.segments?.length)
          return null;

        let nearStart: IndexedSegment | undefined;
        for (const segment of representation.segments) {
          if (!segment) continue;
          const start = segment.presentationStartTime,
            duration = segment.duration;
          const end = start + duration;
          if (
            !Number.isFinite(start) ||
            !Number.isFinite(duration) ||
            duration <= 0 ||
            !Number.isFinite(end) ||
            !Number.isSafeInteger(segment.index) ||
            segment.index < 0
          )
            continue;
          // Containment takes precedence over rounding tolerance, including
          // different audio/video starts and a target just before a boundary.
          if (time >= start && time < end)
            return parent.getSegmentByIndex(representation, segment.index);
          const lead = start - time;
          if (
            lead > 0 &&
            lead <=
              START_TOLERANCE_SECONDS +
                Number.EPSILON * Math.max(1, Math.abs(start)) &&
            (!nearStart || start < nearStart.presentationStartTime)
          )
            nearStart = segment;
        }
        // Only bridge sub-millisecond index rounding/a leading offset. Do not
        // select a previous segment for a gap, exact VOD end, or invalid time.
        return nearStart
          ? parent.getSegmentByIndex(representation, nearStart.index)
          : null;
      },
    };
  };
}
