/** The first platform adapter accepts RainSync's generated on-demand MPD only. */
export interface PlatformDashSource {
  playbackUrl: string;
  sessionId: string;
  origin: string;
}

export interface PlatformDashFence {
  readonly manifestUrl: string;
  readonly origin: string;
  readonly sessionPath: string;
  readonly query: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tokenQuery = /^\?token=[A-Za-z0-9_-]{16,512}$/;
const resourceKey = /^[A-Za-z0-9_-]{1,64}$/;
const unsafe = () => new Error("Unsafe RainSync DASH delivery source");

function deliveryUrl(raw: string, origin: string) {
  // URL() normalizes dot segments, encoded paths and backslashes. Reject these
  // spellings before parsing so a guard cannot accidentally bless another path.
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > 2048 ||
    /[\s\\%#]/.test(raw) ||
    (!raw.startsWith("/") && !/^https?:\/\//.test(raw)) ||
    raw.startsWith("//") ||
    /\/(?:\.|\.\.)(?:\/|\?)/.test(raw)
  ) throw unsafe();
  const url = new URL(raw, origin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.origin !== origin ||
    url.username || url.password || url.hash ||
    !tokenQuery.test(url.search)
  ) throw unsafe();
  return url;
}

export function createPlatformDashFence(source: PlatformDashSource): PlatformDashFence {
  const base = new URL(source.origin);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.origin !== source.origin || !uuid.test(source.sessionId)
  ) throw unsafe();
  const sessionPath = `/api/v1/platform-delivery/${source.sessionId}/`;
  const url = deliveryUrl(source.playbackUrl, source.origin);
  if (url.pathname !== sessionPath + "manifest.mpd") throw unsafe();
  return Object.freeze({
    manifestUrl: url.href,
    origin: url.origin,
    sessionPath,
    query: url.search,
  });
}

/** All URLs, including media/init/index byte-range requests, share one grant. */
export function validatePlatformDashRequest(
  raw: string,
  fence: PlatformDashFence,
  kind: "manifest" | "track" | "either" = "either",
) {
  const url = deliveryUrl(raw, fence.origin);
  if (url.search !== fence.query) throw unsafe();
  const manifest = url.pathname === fence.sessionPath + "manifest.mpd";
  const prefix = fence.sessionPath + "tracks/";
  const track = url.pathname.startsWith(prefix) &&
    resourceKey.test(url.pathname.slice(prefix.length));
  if (!(kind === "manifest" ? manifest : kind === "track" ? track : manifest || track))
    throw unsafe();
  return url.href;
}

type Node = { name: string; attrs: Record<string, string>; children: Node[]; text: string };
const attributes: Record<string, readonly string[]> = {
  MPD: ["xmlns", "type", "profiles", "mediaPresentationDuration", "minBufferTime"],
  Period: ["id", "start", "duration"],
  AdaptationSet: ["id", "contentType", "mimeType", "lang", "codecs", "segmentAlignment", "startWithSAP"],
  Representation: ["id", "mimeType", "codecs", "bandwidth", "width", "height", "frameRate", "sar", "audioSamplingRate", "startWithSAP"],
  BaseURL: [],
  SegmentBase: ["indexRange", "indexRangeExact"],
  Initialization: ["range"],
};

/** A deliberately narrow XML grammar, not a general-purpose XML parser.
 * Rejecting entities, namespaces other than the root DASH namespace, unknown
 * elements/attributes and processing instructions happens BEFORE dash.js parses
 * anything. Thus an MPD cannot start XLink, DRM, UTC, steering or event requests.
 * No DOM/network implementation is required for the validator's pure tests. */
function parseGeneratedMpd(value: unknown): Node {
  if (typeof value !== "string" || value.length > 128 * 1024 ||
    // eslint-disable-next-line no-control-regex -- Deliberately reject unsafe XML control characters.
    /[&\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw unsafe();
  const xml = value.trim().replace(
    /^<\?xml\s+version=(['"])1\.0\1(?:\s+encoding=(['"])utf-8\2)?\s*\?>\s*/i,
    "",
  );
  const stack: Node[] = [];
  let root: Node | undefined;
  let end = 0, count = 0;
  for (const match of xml.matchAll(/<[^<>]*>|[^<>]+/g)) {
    if (match.index !== end) throw unsafe();
    end += match[0].length;
    const part = match[0];
    if (!part.startsWith("<")) {
      if (!stack.length) { if (part.trim()) throw unsafe(); }
      else stack[stack.length - 1].text += part;
      continue;
    }
    const close = /^<\/([A-Za-z]+)\s*>$/.exec(part);
    if (close) {
      if (stack.pop()?.name !== close[1]) throw unsafe();
      continue;
    }
    const open = /^<([A-Za-z]+)([\s\S]*?)(\/?)>$/.exec(part);
    if (!open || !Object.hasOwn(attributes, open[1]) || ++count > 128 || stack.length > 5)
      throw unsafe();
    const node: Node = { name: open[1], attrs: {}, children: [], text: "" };
    let rest = open[2];
    while (rest.trim()) {
      const attr = /^\s+([A-Za-z]+)\s*=\s*(['"])([^'"<>&]*)\2/.exec(rest);
      if (!attr || !attributes[node.name].includes(attr[1]) || Object.hasOwn(node.attrs, attr[1]))
        throw unsafe();
      node.attrs[attr[1]] = attr[3];
      rest = rest.slice(attr[0].length);
    }
    if (stack.length) stack[stack.length - 1].children.push(node);
    else { if (root) throw unsafe(); root = node; }
    if (!open[3]) stack.push(node);
  }
  if (end !== xml.length || stack.length || !root || root.name !== "MPD") throw unsafe();
  return root;
}

function duration(value: string | undefined, allowZero = false) {
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value ?? "");
  if (!match || !match.slice(1).some(Boolean)) throw unsafe();
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  if (!Number.isFinite(seconds) || seconds < (allowZero ? 0 : Number.MIN_VALUE) || seconds > 7 * 86400)
    throw unsafe();
  return seconds;
}
function integer(value: string | undefined, maximum: number) {
  if (!/^\d+$/.test(value ?? "")) throw unsafe();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw unsafe();
  return result;
}
function sampleAspectRatio(value: string) {
  // The DASH XSD RatioType uses colon pairs; the renderer normalizes its
  // validated scalar form to N:1. This display metadata cannot name a resource.
  if (value.length > 32 || !/^\d+:\d+$/.test(value)) throw unsafe();
  for (const component of value.split(":")) integer(component, 0xffff_ffff);
}
function range(value: string | undefined) {
  const match = /^(\d+)-(\d+)$/.exec(value ?? "");
  if (!match) throw unsafe();
  const start = Number(match[1]), end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start + 1 > 2 * 1024 * 1024)
    throw unsafe();
  return { start, end };
}
function children(node: Node, names: readonly string[]) {
  if (node.text.trim() || node.children.some(child => !names.includes(child.name))) throw unsafe();
}
function commonAttrs(node: Node) {
  const a = node.attrs;
  if (a.id !== undefined && !resourceKey.test(a.id)) throw unsafe();
  if (a.lang !== undefined && !/^[A-Za-z0-9_-]{1,35}$/.test(a.lang)) throw unsafe();
  if (a.segmentAlignment !== undefined && !["true", "false"].includes(a.segmentAlignment)) throw unsafe();
  if (a.startWithSAP !== undefined && !/^[0-6]$/.test(a.startWithSAP)) throw unsafe();
}

/** Validates clear AVC/AAC variants already projected by the server, not an
 * encoder ladder, arbitrary DASH documents or live/multiperiod presentations. */
export function validatePlatformDashManifest(value: unknown, fence: PlatformDashFence) {
  const mpd = parseGeneratedMpd(value);
  if (mpd.attrs.xmlns !== "urn:mpeg:dash:schema:mpd:2011" || mpd.attrs.type !== "static" ||
    mpd.attrs.profiles !== "urn:mpeg:dash:profile:isoff-on-demand:2011") throw unsafe();
  if (duration(mpd.attrs.mediaPresentationDuration) < 0.001) throw unsafe();
  if (duration(mpd.attrs.minBufferTime, true) > 120) throw unsafe();
  children(mpd, ["Period"]);
  if (mpd.children.length !== 1) throw unsafe();
  const period = mpd.children[0];
  commonAttrs(period);
  if (period.attrs.start !== undefined && duration(period.attrs.start, true) !== 0) throw unsafe();
  if (period.attrs.duration !== undefined) duration(period.attrs.duration);
  children(period, ["AdaptationSet"]);
  if (period.children.length !== 2) throw unsafe();
  const kinds = new Set<string>(), ids = new Set<string>(), urls = new Set<string>();
  for (const adaptation of period.children) {
    commonAttrs(adaptation);
    const a = adaptation.attrs;
    const kind = a.contentType ?? (a.mimeType === "video/mp4" ? "video" : a.mimeType === "audio/mp4" ? "audio" : "");
    if (!["video", "audio"].includes(kind) || kinds.has(kind) || a.mimeType !== `${kind}/mp4`) throw unsafe();
    kinds.add(kind);
    children(adaptation, ["Representation"]);
    if (!adaptation.children.length || adaptation.children.length > (kind === "video" ? 8 : 4)) throw unsafe();
    for (const representation of adaptation.children) {
      commonAttrs(representation);
      const r = representation.attrs;
      if (!r.id || ids.has(r.id)) throw unsafe();
      ids.add(r.id);
      if (r.mimeType !== undefined && r.mimeType !== a.mimeType) throw unsafe();
      const codec = r.codecs ?? a.codecs ?? "";
      if (!(kind === "video" ? /^avc1\.[0-9a-fA-F]{6}$/.test(codec) : codec === "mp4a.40.2")) throw unsafe();
      integer(r.bandwidth, kind === "video" ? 80_000_000 : 512_000);
      if (r.width !== undefined) integer(r.width, 8192);
      if (r.height !== undefined) integer(r.height, 4320);
      if (r.audioSamplingRate !== undefined && integer(r.audioSamplingRate, 96000) < 8000) throw unsafe();
      if (r.sar !== undefined) {
        if (kind !== "video") throw unsafe();
        sampleAspectRatio(r.sar);
      }
      if (r.frameRate !== undefined) {
        if (kind !== "video" || r.frameRate.length > 32) throw unsafe();
        const rate = /^(\d+)(?:\/([1-9]\d*))?$/.exec(r.frameRate);
        if (!rate) throw unsafe();
        const numerator = integer(rate[1], 0xffff_ffff);
        const denominator = rate[2] === undefined ? 1 : integer(rate[2], 0xffff_ffff);
        const fps = numerator / denominator;
        if (!Number.isFinite(fps) || fps <= 0 || fps > 120) throw unsafe();
      }
      children(representation, ["BaseURL", "SegmentBase"]);
      if (representation.children.length !== 2) throw unsafe();
      const base = representation.children.find(n => n.name === "BaseURL");
      const segment = representation.children.find(n => n.name === "SegmentBase");
      if (!base || !segment || base.children.length) throw unsafe();
      const url = validatePlatformDashRequest(base.text.trim(), fence, "track");
      if (urls.has(url)) throw unsafe();
      urls.add(url);
      const index = range(segment.attrs.indexRange);
      if (segment.attrs.indexRangeExact !== undefined && !["true", "false"].includes(segment.attrs.indexRangeExact)) throw unsafe();
      children(segment, ["Initialization"]);
      if (segment.children.length !== 1) throw unsafe();
      const init = segment.children[0];
      children(init, []);
      const initialization = range(init.attrs.range);
      if (initialization.start !== 0 || initialization.end >= index.start) throw unsafe();
    }
  }
}
