/** Independent parser for Bilibili Animation Script. Grammar/semantics:
 * https://bilibili.github.io/bas/ (definitions, templates, paths, set/then).
 * No evaluation of JavaScript or CSS occurs. */
import {
  easing,
  finishScene,
  validVideo,
  safeProps,
  UnsupportedDanmaku,
  type DanmakuScene,
  type SceneNode,
  type SceneProps,
  type SceneValue,
} from "./advanced-danmaku";
type Token = { text: string; value?: unknown };
type Template = {
  kind: SceneNode["kind"];
  props: Record<string, unknown>;
  params: [string, unknown][];
};
type SetExpr = {
  node?: SceneNode;
  values?: Record<string, unknown>;
  ms?: number;
  ease?: string;
  parallel?: SetExpr[];
  next?: SetExpr;
};
const refValue = (name: string) => ({ ref: name });
export function compileBas(source: string): DanmakuScene {
  if (new TextEncoder().encode(source).length > 32768)
    throw new UnsupportedDanmaku();
  const tokens: Token[] = [];
  let rest = source;
  while (rest) {
    const ignored = /^(?:\s+|;|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/.exec(rest);
    if (ignored) {
      rest = rest.slice(ignored[0].length);
      continue;
    }
    const string = /^(?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')/.exec(
      rest,
    );
    if (string) {
      const raw = string[0];
      const value =
        raw[0] === '"'
          ? JSON.parse(raw)
          : raw
              .slice(1, -1)
              .replace(
                /\\(['\\nrt])/g,
                (_, c: string) => ({ n: "\n", r: "\r", t: "\t" })[c] ?? c,
              );
      tokens.push({ text: "string", value });
      rest = rest.slice(raw.length);
      continue;
    }
    const number =
      /^[+-]?(?:0x[0-9a-f]+|(?:\d+(?:\.\d*)?|\.\d+))(?:%|(?:ms|h|m|s)(?:\d+(?:\.\d*)?(?:ms|h|m|s))*)?/i.exec(
        rest,
      );
    if (number) {
      const raw = number[0];
      let value: unknown;
      if (raw.endsWith("%")) value = { percent: Number(raw.slice(0, -1)) };
      else if (/\d(?:ms|h|m|s)/.test(raw)) {
        let ms = 0;
        for (const part of raw.matchAll(
          /([+-]?(?:\d+(?:\.\d*)?|\.\d+))(ms|h|m|s)/g,
        ))
          ms +=
            Number(part[1]) *
            ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[part[2]] ?? 0);
        value = ms;
      } else value = Number(raw);
      tokens.push({ text: "number", value });
      rest = rest.slice(raw.length);
      continue;
    }
    const word = /^[A-Za-z_$][\w$-]*/.exec(rest);
    if (word) {
      tokens.push({ text: word[0] });
      rest = rest.slice(word[0].length);
      continue;
    }
    if ("{}()[]=,".includes(rest[0])) {
      tokens.push({ text: rest[0] });
      rest = rest.slice(1);
      continue;
    }
    throw new UnsupportedDanmaku("BAS 语法暂不支持");
  }
  if (tokens.length > 12000) throw new UnsupportedDanmaku("BAS 超出运行上限");
  tokens.push({ text: "EOF" });
  let index = 0,
    anonymous = 0,
    depth = 0;
  const defs = new Map<string, Template>(),
    nodes: SceneNode[] = [],
    byId = new Map<string, SceneNode>();
  const peek = () => tokens[index].text;
  function take(expected?: string): Token {
    const t = tokens[index++];
    if (!t || (expected && t.text !== expected))
      throw new UnsupportedDanmaku("BAS 语法无效");
    return t;
  }
  function name(): string {
    const s = take().text;
    if (
      !/^[A-Za-z_$][\w$-]{0,63}$/.test(s) ||
      ["constructor", "__proto__", "prototype"].includes(s)
    )
      throw new UnsupportedDanmaku();
    return s;
  }
  function value(): unknown {
    if (++depth > 24) throw new UnsupportedDanmaku("BAS 嵌套超出运行上限");
    try {
      if (peek() === "string" || peek() === "number") return take().value;
      if (peek() === "[") {
        take("[");
        const v = value();
        let ease = "linear";
        if (peek() === ",") {
          take();
          ease = String(take("string").value);
        }
        take("]");
        easing(ease, 0.5);
        return { animated: v, easing: ease };
      }
      const id = name();
      if (peek() === "{") return { type: id, props: props() };
      return validVideo(id) ? id : refValue(id);
    } finally {
      depth--;
    }
  }
  function props(): Record<string, unknown> {
    take("{");
    const result: Record<string, unknown> = Object.create(null);
    while (peek() !== "}") {
      const id = name();
      take("=");
      result[id] = value();
      if (peek() === ",") take();
    }
    take("}");
    return result;
  }
  function resolve(v: unknown, args: Record<string, unknown>): unknown {
    if (v && typeof v === "object" && "ref" in v) {
      const key = String(v.ref);
      if (!(key in args)) throw new UnsupportedDanmaku("BAS 模板参数无效");
      return args[key];
    }
    if (v && typeof v === "object" && "type" in v && "props" in v) {
      const p = Object.fromEntries(
        Object.entries(v.props as Record<string, unknown>).map(([k, x]) => [
          k,
          resolve(x, args),
        ]),
      );
      const at_ms = Number(p.time ?? 0);
      if (v.type === "seek") return { kind: "seek", at_ms };
      if (v.type === "av")
        return {
          kind: "video",
          video: p.bvid ?? `av${p.av}`,
          page: p.page ?? 1,
          at_ms,
        };
      if (v.type === "bangumi")
        return { kind: "episode", episode: p.episodeId, at_ms };
      throw new UnsupportedDanmaku();
    }
    return v;
  }
  function instantiate(
    base: string,
    id: string,
    overrides: Record<string, unknown>,
    call: Record<string, unknown> = {},
  ): SceneNode {
    const def = defs.get(base);
    if (!def || byId.has(id) || nodes.length >= 128)
      throw new UnsupportedDanmaku();
    const args = Object.fromEntries(
      def.params.map(([k, v]) => [k, resolve(v, {})]),
    );
    Object.assign(args, call);
    const p = safeProps(
      Object.fromEntries(
        Object.entries({ ...def.props, ...overrides }).map(([k, v]) => [
          k,
          resolve(v, args),
        ]),
      ),
    );
    const node: SceneNode = {
      id,
      kind: def.kind,
      start: 0,
      end: 0,
      props: p,
      animations: [],
    };
    nodes.push(node);
    byId.set(id, node);
    return node;
  }
  function argsFor(base: string): Record<string, unknown> {
    const def = defs.get(base);
    if (!def) throw new UnsupportedDanmaku();
    const args: Record<string, unknown> = Object.create(null);
    let positional = 0;
    take("(");
    while (peek() !== ")") {
      let key: string;
      if (tokens[index + 1]?.text === "=") {
        key = name();
        take("=");
      } else key = def.params[positional++]?.[0] ?? "";
      if (!def.params.some(([k]) => k === key)) throw new UnsupportedDanmaku();
      args[key] = value();
      if (peek() === ",") take();
      else if (peek() !== ")") throw new UnsupportedDanmaku();
    }
    take(")");
    return args;
  }
  function clone(id: string): SceneNode {
    const base = name();
    const call = peek() === "(" ? argsFor(base) : {};
    const overrides =
      peek() === "{" &&
      (tokens[index + 2]?.text === "=" || tokens[index + 1]?.text === "}")
        ? props()
        : {};
    return instantiate(base, id, overrides, call);
  }
  function setUnit(): SetExpr {
    if (++depth > 24) throw new UnsupportedDanmaku();
    try {
      let expression: SetExpr;
      if (peek() === "{") {
        take();
        const parallel: SetExpr[] = [];
        while (peek() !== "}") parallel.push(setUnit());
        take("}");
        expression = { parallel };
      } else {
        take("set");
        let node: SceneNode;
        if (peek() === "(") {
          take();
          node = clone(`anon${++anonymous}`);
          take(")");
        } else {
          const id = name();
          node = byId.get(id) ?? instantiate(id, id, {});
        }
        const values = props();
        const ms = Number(take("number").value);
        if (!Number.isFinite(ms) || ms < 0 || ms > 120000)
          throw new UnsupportedDanmaku();
        let ease = "linear";
        if (peek() === ",") {
          take();
          ease = String(take("string").value);
        }
        easing(ease, 0.5);
        expression = { node, values, ms, ease };
      }
      if (peek() === "then") {
        take();
        expression.next = setUnit();
      }
      return expression;
    } finally {
      depth--;
    }
  }
  while (["def", "let"].includes(peek())) {
    const keyword = take().text;
    if (keyword === "let") {
      const id = name();
      take("=");
      if (
        ["text", "button", "path"].includes(peek()) &&
        tokens[index + 1]?.text === "{"
      ) {
        const kind = name() as SceneNode["kind"];
        defs.set(id, { kind, props: props(), params: [] });
        instantiate(id, id, {});
      } else {
        const node = clone(id);
        defs.set(id, { kind: node.kind, props: node.props, params: [] });
      }
      continue;
    }
    const kind = name();
    if (!["text", "button", "path"].includes(kind))
      throw new UnsupportedDanmaku();
    const id = name(),
      params: [string, unknown][] = [];
    if (defs.has(id)) throw new UnsupportedDanmaku();
    if (peek() === "(") {
      take();
      while (peek() !== ")") {
        const k = name();
        take("=");
        params.push([k, value()]);
        if (peek() === ",") take();
        else if (peek() !== ")") throw new UnsupportedDanmaku();
      }
      take(")");
    }
    defs.set(id, { kind: kind as SceneNode["kind"], props: props(), params });
    if (!params.length) instantiate(id, id, {});
  }
  const expressions: SetExpr[] = [];
  while (peek() !== "EOF") expressions.push(setUnit());
  function schedule(expr: SetExpr, start: number): number {
    let end = start;
    if (expr.parallel)
      for (const child of expr.parallel)
        end = Math.max(end, schedule(child, start));
    else {
      end = start + expr.ms!;
      if (end > 120000) throw new UnsupportedDanmaku();
      const node = expr.node!,
        from: SceneProps = { ...node.props },
        to: SceneProps = {};
      for (const animation of node.animations)
        if (animation.end <= start) Object.assign(from, animation.to);
      for (const [key, raw] of Object.entries(expr.values!)) {
        if (
          ![
            "x",
            "y",
            "alpha",
            "color",
            "scale",
            "rotateX",
            "rotateY",
            "rotateZ",
            "content",
            "text",
            "fontSize",
          ].includes(key)
        )
          continue;
        // Per-property easing is represented as an independent track.
        const animated = raw && typeof raw === "object" && "animated" in raw;
        const next = safeProps({
          [key]: animated ? raw.animated : resolve(raw, {}),
        });
        if (["content", "text", "fontSize"].includes(key)) {
          node.animations.push({
            start,
            end: start,
            from: {},
            to: next,
            easing: "linear",
          });
          continue;
        }
        const defaults: Record<string, SceneValue> = {
          x: 0,
          y: 0,
          alpha: 1,
          scale: 1,
          rotateX: 0,
          rotateY: 0,
          rotateZ: 0,
          color: 0xffffff,
        };
        if (from[key] === undefined && defaults[key] !== undefined)
          from[key] = defaults[key];
        if (animated)
          node.animations.push({
            start,
            end,
            to: next,
            from: { ...from },
            easing: String((raw as unknown as { easing: string }).easing),
          });
        else Object.assign(to, next);
      }
      node.animations.push({ start, end, to, from, easing: expr.ease! });
      if (node.id.startsWith("anon"))
        node.start = Math.min(node.animations[0].start, start);
    }
    return expr.next ? schedule(expr.next, end) : end;
  }
  let duration = 0;
  for (const expr of expressions)
    duration = Math.max(duration, schedule(expr, 0));
  return finishScene(nodes, duration || 4000);
}
