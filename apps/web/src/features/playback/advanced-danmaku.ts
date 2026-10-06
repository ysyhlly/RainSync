/** Finite display model shared by the worker and renderer. Upstream text never
 * becomes HTML, CSS, a URL, or a JavaScript function in the document realm. */
export type Percent = { percent: number };
export type DanmakuAction =
  | { kind: "seek"; at_ms: number }
  | { kind: "video"; video: string; page: number; at_ms: number }
  | { kind: "episode"; episode: number; at_ms: number };
export type SceneValue = number | string | Percent | DanmakuAction;
export type SceneProps = Record<string, SceneValue>;
export type SceneAnimation = {
  start: number;
  end: number;
  to: SceneProps;
  from: SceneProps;
  easing: string;
};
export type SceneNode = {
  id: string;
  kind: "text" | "button" | "path" | "group";
  start: number;
  end: number;
  props: SceneProps;
  animations: SceneAnimation[];
};
export type DanmakuScene = {
  duration_ms: number;
  nodes: SceneNode[];
  stage?: { width: number; height: number };
};
export const MAX_SCENE_MS = 120_000;
export const MAX_SCENE_NODES = 128;
export const MAX_PROGRAM_BYTES = 32_768;
export class UnsupportedDanmaku extends Error {
  constructor(message = "高级弹幕包含暂不支持的指令") {
    super(message);
  }
}
export const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const finite = (v: unknown, min = -8192, max = 8192): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
export function validVideo(v: unknown): v is string {
  return (
    typeof v === "string" && /^(BV[0-9A-Za-z]{10}|av[1-9][0-9]{0,18})$/.test(v)
  );
}
export function validDanmakuAction(v: unknown): v is DanmakuAction {
  if (
    !record(v) ||
    !Number.isSafeInteger(v.at_ms) ||
    !finite(v.at_ms, 0, 604_800_000)
  )
    return false;
  if (v.kind === "seek") return Object.keys(v).length === 2;
  if (v.kind === "video")
    return (
      Object.keys(v).length === 4 &&
      validVideo(v.video) &&
      Number.isSafeInteger(v.page) &&
      finite(v.page, 1, 1000)
    );
  return (
    v.kind === "episode" &&
    Object.keys(v).length === 3 &&
    Number.isSafeInteger(v.episode) &&
    finite(v.episode, 1, Number.MAX_SAFE_INTEGER)
  );
}
export function danmakuActionUrl(action: DanmakuAction): string | undefined {
  if (!validDanmakuAction(action) || action.kind === "seek") return;
  const url =
    action.kind === "video"
      ? new URL(`https://www.bilibili.com/video/${action.video}/`)
      : new URL(`https://www.bilibili.com/bangumi/play/ep${action.episode}`);
  if (action.kind === "video") url.searchParams.set("p", String(action.page));
  if (action.at_ms) url.searchParams.set("t", String(action.at_ms / 1000));
  return url.href;
}
const ranges: Record<string, [number, number]> = {
  x: [-8192, 8192],
  y: [-8192, 8192],
  alpha: [0, 1],
  scale: [-32, 32],
  scaleX: [-32, 32],
  scaleY: [-32, 32],
  rotateX: [-3600, 3600],
  rotateY: [-3600, 3600],
  rotateZ: [-3600, 3600],
  anchorX: [0, 1],
  anchorY: [0, 1],
  fontSize: [1, 512],
  color: [0, 0xffffff],
  textColor: [0, 0xffffff],
  fillColor: [0, 0xffffff],
  strokeColor: [0, 0xffffff],
  borderColor: [0, 0xffffff],
  textAlpha: [0, 1],
  fillAlpha: [0, 1],
  borderAlpha: [0, 1],
  strokeWidth: [0, 32],
  borderWidth: [0, 32],
  width: [0, 8192],
  height: [0, 8192],
  bold: [0, 1],
  textShadow: [0, 1],
  zIndex: [-1024, 1024],
  duration: [0, MAX_SCENE_MS],
};
const strings: Record<string, number> = {
  content: 2000,
  text: 2000,
  fontFamily: 64,
  parent: 64,
  d: 8192,
  viewBox: 128,
};
export function safeProps(raw: Record<string, unknown>): SceneProps {
  const result: SceneProps = Object.create(null);
  if (Object.keys(raw).length > 40) throw new UnsupportedDanmaku();
  for (const [key, value] of Object.entries(raw)) {
    if (key === "target") {
      if (!validDanmakuAction(value)) throw new UnsupportedDanmaku();
      result[key] = value;
      continue;
    }
    if (strings[key]) {
      if (
        typeof value !== "string" ||
        value.length > strings[key] ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)
      )
        throw new UnsupportedDanmaku();
      if (key === "fontFamily" && !/^[\p{L}\p{N} _,-]*$/u.test(value))
        throw new UnsupportedDanmaku();
      if (key === "parent" && !/^[\w$-]{1,64}$/.test(value))
        throw new UnsupportedDanmaku();
      if (key === "d" && !/^[MmZzLlHhVvCcSsQqTtAaEe0-9+.,\s-]*$/.test(value))
        throw new UnsupportedDanmaku();
      if (key === "viewBox") {
        const box = value.trim().split(/[ ,]+/).map(Number);
        if (
          box.length !== 4 ||
          !box.every((n) => finite(n)) ||
          box[2] <= 0 ||
          box[3] <= 0
        )
          throw new UnsupportedDanmaku();
      }
      result[key] = value;
      continue;
    }
    const range = ranges[key];
    if (!range) throw new UnsupportedDanmaku();
    if (
      record(value) &&
      Object.keys(value).length === 1 &&
      ["x", "y", "fontSize", "width", "height"].includes(key) &&
      finite(value.percent, -200, 300)
    )
      result[key] = { percent: value.percent };
    else if (finite(value, ...range)) result[key] = value;
    else throw new UnsupportedDanmaku();
  }
  return result;
}
export function finishScene(
  nodes: SceneNode[],
  duration: number,
): DanmakuScene {
  if (
    !finite(duration, 1, MAX_SCENE_MS) ||
    nodes.length > MAX_SCENE_NODES ||
    nodes.reduce((n, v) => n + v.animations.length, 0) > 1024
  )
    throw new UnsupportedDanmaku("高级弹幕超出运行上限");
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) throw new UnsupportedDanmaku();
  for (const node of nodes) {
    node.props = safeProps(node.props);
    for (const a of node.animations) {
      if (
        !finite(a.start, 0, MAX_SCENE_MS) ||
        !finite(a.end, a.start, MAX_SCENE_MS)
      )
        throw new UnsupportedDanmaku();
      a.from = safeProps(a.from);
      a.to = safeProps(a.to);
      easing(a.easing, 0.5);
    }
    node.end =
      node.props.duration === undefined
        ? Math.max(node.end, duration)
        : node.start + Number(node.props.duration);
    if (
      !finite(node.start, 0, MAX_SCENE_MS) ||
      !finite(node.end, node.start, MAX_SCENE_MS)
    )
      throw new UnsupportedDanmaku();
    const seen = new Set([node.id]);
    let parent = node.props.parent;
    while (typeof parent === "string") {
      if (seen.has(parent) || seen.size > 16 || !byId.has(parent))
        throw new UnsupportedDanmaku("高级弹幕层级无效");
      seen.add(parent);
      parent = byId.get(parent)!.props.parent;
    }
  }
  return { duration_ms: Math.max(duration, ...nodes.map((n) => n.end)), nodes };
}
export function easing(name: string, t: number): number {
  if (name === "linear") return t;
  if (["quadratic", "cubic", "quartic", "quintic"].includes(name)) {
    const n = { quadratic: 2, cubic: 3, quartic: 4, quintic: 5 }[
      name as "quadratic"
    ];
    return t < 0.5 ? (2 * t) ** n / 2 : 1 - (2 * (1 - t)) ** n / 2;
  }
  if (name === "sine") return (1 - Math.cos(Math.PI * t)) / 2;
  if (name === "circular")
    return t < 0.5
      ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2
      : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2;
  if (name === "exponential")
    return t === 0 || t === 1
      ? t
      : t < 0.5
        ? 2 ** (20 * t - 10) / 2
        : (2 - 2 ** (-20 * t + 10)) / 2;
  const css: Record<string, string> = {
    ease: "cubic-bezier(.25,.1,.25,1)",
    "ease-in": "cubic-bezier(.42,0,1,1)",
    "ease-out": "cubic-bezier(0,0,.58,1)",
    "ease-in-out": "cubic-bezier(.42,0,.58,1)",
  };
  name = css[name] ?? name;
  const bezier =
    /^cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)$/.exec(
      name,
    );
  if (bezier) {
    const [, x1, y1, x2, y2] = bezier.map(Number);
    if (![x1, y1, x2, y2].every((n) => finite(n, 0, 1)))
      throw new UnsupportedDanmaku();
    const curve = (s: number, a: number, b: number) =>
      3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3;
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (curve(mid, x1, x2) < t) lo = mid;
      else hi = mid;
    }
    return curve((lo + hi) / 2, y1, y2);
  }
  throw new UnsupportedDanmaku("高级弹幕插值类型暂不支持");
}
export function sampleSceneNode(
  node: SceneNode,
  elapsed: number,
  width: number,
  height: number,
  reduced = false,
): SceneProps {
  const p = { ...node.props };
  const coordinate = (v: SceneValue, key: string) =>
    record(v) && "percent" in v
      ? (Number(v.percent) *
          (key === "y" || key === "height" ? height : width)) /
        100
      : Number(v);
  for (const animation of node.animations) {
    if (elapsed < animation.start) continue;
    const t = reduced
      ? elapsed >= animation.end
        ? 1
        : 0
      : easing(
          animation.easing,
          animation.end === animation.start
            ? 1
            : Math.min(
                1,
                (elapsed - animation.start) / (animation.end - animation.start),
              ),
        );
    for (const [key, to] of Object.entries(animation.to)) {
      const from = animation.from[key];
      if (
        (typeof to === "number" || (record(to) && "percent" in to)) &&
        from !== undefined
      ) {
        const a = coordinate(from, key),
          b = coordinate(to, key);
        if (
          [
            "color",
            "textColor",
            "fillColor",
            "borderColor",
            "strokeColor",
          ].includes(key)
        ) {
          let rgb = 0;
          for (const shift of [16, 8, 0])
            rgb |=
              Math.round(
                ((a >> shift) & 255) +
                  (((b >> shift) & 255) - ((a >> shift) & 255)) * t,
              ) << shift;
          p[key] = rgb;
        } else p[key] = a + (b - a) * t;
      } else p[key] = to;
    }
  }
  return p;
}
