/** BiliScript ECMAScript display interpreter. Acorn supplies syntax only. There
 * is no eval/Function, prototype lookup, DOM, network or ambient global scope.
 * Timers are compiled against media time, with a shared instruction budget.
 * API reference: CommentCoreLibrary/docs/scripting (Display/Tween/Utils/Player). */
import {
  easing,
  finishScene,
  safeProps,
  sampleSceneNode,
  UnsupportedDanmaku,
  type DanmakuScene,
  type SceneAnimation,
  type SceneNode,
  type SceneProps,
  type DanmakuAction,
} from "./advanced-danmaku";
type Ast = any;
type Value = any;
type Env = { values: Record<string, Value>; parent?: Env };
type Closure = { closure: true; params: Ast[]; body: Ast; env: Env };
type Tween = {
  tween: true;
  duration: number;
  tracks: { node: SceneNode; animation: SceneAnimation }[];
};
type Timer = {
  id: number;
  at: number;
  delay: number;
  remaining: number;
  callback: Value;
  cancelled?: boolean;
};
const denied = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "caller",
  "callee",
  "arguments",
  "eval",
  "Function",
]);
const aliases: Record<string, string> = {
  size: "fontSize",
  fontsize: "fontSize",
  rotation: "rotateZ",
  rotationX: "rotateX",
  rotationY: "rotateY",
  text: "content",
};
export class ScriptParserUnavailable extends Error {
  constructor(cause: unknown) {
    super("Script parser is unavailable", { cause });
    this.name = "ScriptParserUnavailable";
  }
}
export async function compileScript(source: string): Promise<DanmakuScene> {
  if (new TextEncoder().encode(source).length > 32768)
    throw new UnsupportedDanmaku();
  const { parse } = await import("acorn").catch((cause) => {
    throw new ScriptParserUnavailable(cause);
  });
  const ast = parse(source, { ecmaVersion: 2020, sourceType: "script" }) as Ast;
  const nodes: SceneNode[] = [],
    timers: Timer[] = [];
  let fuel = 100_000,
    depth = 0,
    clock = 0,
    timerId = 0,
    collecting: DanmakuAction[] | undefined;
  let duration = 0;
  const root: Env = { values: Object.create(null) };
  const easeNames = new Map<Value, string>();
  const guard = () => {
    if (--fuel < 0) throw new UnsupportedDanmaku("Script 超出运行上限");
  };
  function key(k: Value): string {
    const s = String(k);
    if (denied.has(s) || s.length > 128)
      throw new UnsupportedDanmaku("Script 属性不可访问");
    return s;
  }
  function lookup(env: Env, id: string): Value {
    key(id);
    for (let e: Env | undefined = env; e; e = e.parent)
      if (Object.hasOwn(e.values, id)) return e.values[id];
    throw new UnsupportedDanmaku(`Script 接口暂不支持：${id.slice(0, 40)}`);
  }
  function setVariable(env: Env, id: string, v: Value, declare = false): Value {
    key(id);
    if (collecting && !declare) throw new UnsupportedDanmaku();
    if (!declare)
      for (let e: Env | undefined = env; e; e = e.parent)
        if (Object.hasOwn(e.values, id)) {
          e.values[id] = v;
          return v;
        }
    env.values[id] = v;
    return v;
  }
  const isNode = (v: Value): v is { display: SceneNode; graphics?: Value } =>
    v && typeof v === "object" && Object.hasOwn(v, "display");
  function canonical(raw: Value): SceneProps {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new UnsupportedDanmaku();
    const p: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(raw)) p[aliases[k] ?? k] = v;
    return safeProps(p);
  }
  function assignNode(node: SceneNode, property: string, v: Value) {
    if (collecting) throw new UnsupportedDanmaku();
    const next = canonical({ [property]: v });
    if (clock === node.start && !node.animations.length)
      Object.assign(node.props, next);
    else
      node.animations.push({
        start: clock,
        end: clock,
        from: {},
        to: next,
        easing: "linear",
      });
    if (node.animations.length > 1024) throw new UnsupportedDanmaku();
  }
  function getNode(node: SceneNode, property: string): Value {
    const k = aliases[property] ?? property;
    return sampleSceneNode(node, clock, 672, 438)[k];
  }

  function graphics(node: SceneNode): Value {
    let d = String(node.props.d ?? ""),
      fill = 0xffffff,
      fillAlpha = 1;
    function append(s: string) {
      d += s;
      assignNode(node, "d", d);
    }
    const n = (v: Value) => {
      const x = Number(v);
      if (!Number.isFinite(x) || Math.abs(x) > 8192)
        throw new UnsupportedDanmaku();
      return x;
    };
    return Object.assign(Object.create(null), {
      clear: () => {
        d = "";
        assignNode(node, "d", d);
      },
      beginFill: (color = 0xffffff, alpha = 1) => {
        fill = Number(color);
        fillAlpha = Number(alpha);
        assignNode(node, "fillColor", fill);
        assignNode(node, "fillAlpha", fillAlpha);
      },
      endFill: () => {},
      lineStyle: (width = 1, color = 0xffffff, alpha = 1) => {
        assignNode(node, "borderWidth", n(width));
        assignNode(node, "borderColor", Number(color));
        assignNode(node, "borderAlpha", n(alpha));
      },
      moveTo: (x: Value, y: Value) => append(`M${n(x)} ${n(y)} `),
      lineTo: (x: Value, y: Value) => append(`L${n(x)} ${n(y)} `),
      curveTo: (cx: Value, cy: Value, x: Value, y: Value) =>
        append(`Q${n(cx)} ${n(cy)} ${n(x)} ${n(y)} `),
      cubicCurveTo: (
        a: Value,
        b: Value,
        c: Value,
        e: Value,
        x: Value,
        y: Value,
      ) => append(`C${n(a)} ${n(b)} ${n(c)} ${n(e)} ${n(x)} ${n(y)} `),
      drawRect: (x: Value, y: Value, w: Value, h: Value) =>
        append(`M${n(x)} ${n(y)} h${n(w)} v${n(h)} h${-n(w)} Z `),
      drawRoundRect: (x: Value, y: Value, w: Value, h: Value) =>
        append(`M${n(x)} ${n(y)} h${n(w)} v${n(h)} h${-n(w)} Z `),
      drawCircle: (x: Value, y: Value, r: Value) =>
        append(
          `M${n(x) - n(r)} ${n(y)} a${n(r)} ${n(r)} 0 1 0 ${n(r) * 2} 0 a${n(r)} ${n(r)} 0 1 0 ${-n(r) * 2} 0 `,
        ),
      drawEllipse: (x: Value, y: Value, w: Value, h: Value) =>
        append(
          `M${n(x)} ${n(y) + n(h) / 2} a${n(w) / 2} ${n(h) / 2} 0 1 0 ${n(w)} 0 a${n(w) / 2} ${n(h) / 2} 0 1 0 ${-n(w)} 0 `,
        ),
    });
  }
  function create(
    kind: SceneNode["kind"],
    text: Value,
    params: Value = {},
  ): Value {
    if (collecting) throw new UnsupportedDanmaku();
    if (nodes.length >= 128)
      throw new UnsupportedDanmaku("Script 对象超出运行上限");
    const p: Record<string, unknown> = Object.create(null);
    let life = 4000;
    for (const [k, v] of Object.entries(params ?? {})) {
      if (k === "lifeTime") {
        life = Number(v) * 1000;
        continue;
      }
      if (k === "parent") {
        if (!isNode(v)) throw new UnsupportedDanmaku();
        p.parent = v.display.id;
        continue;
      }
      if (k === "motion" || k === "onclick") continue;
      p[aliases[k] ?? k] = v;
    }
    if (kind === "text" || kind === "button") p.content = String(text ?? "");
    if (kind === "path") {
      p.d = "";
      p.viewBox = "0 0 672 438";
      p.width = 672;
      p.height = 438;
    }
    p.duration = life;
    const node: SceneNode = {
      id: `s${nodes.length}`,
      kind,
      start: clock,
      end: clock + life,
      props: safeProps(p),
      animations: [],
    };
    duration = Math.max(duration, node.end);
    nodes.push(node);
    const display = {
      display: node,
      graphics: kind === "path" ? graphics(node) : undefined,
    };
    if (params?.motion) {
      for (const [k, raw] of Object.entries(params.motion)) {
        const motion = raw as Value;
        const from = canonical({ [k]: motion.from ?? getNode(node, k) ?? 0 }),
          to = canonical({ [k]: motion.to });
        const start = clock + Number(motion.delay ?? 0),
          end = start + Number(motion.duration ?? life);
        node.animations.push({ start, end, from, to, easing: "linear" });
      }
    }
    if (params?.onclick) attachClick(node, params.onclick);
    return display;
  }
  function attachClick(node: SceneNode, callback: Value) {
    const previous = collecting;
    collecting = [];
    try {
      call(callback, []);
      if (collecting.length !== 1)
        throw new UnsupportedDanmaku("Script 点击动作暂不支持");
      node.kind = "button";
      node.props.target = collecting[0];
    } finally {
      collecting = previous;
    }
  }
  function get(object: Value, property: string): Value {
    guard();
    const k = key(property);
    if (object?.tween && k === "play") return () => play(object);
    if (isNode(object)) {
      if (k === "graphics") return object.graphics;
      if (k === "addChild")
        return (child: Value) => {
          if (!isNode(child)) throw new UnsupportedDanmaku();
          child.display.props.parent = object.display.id;
          return child;
        };
      if (k === "removeChild")
        return (child: Value) => {
          if (isNode(child)) child.display.end = clock;
        };
      if (k === "remove" || k === "unload")
        return () => {
          object.display.props.duration = clock - object.display.start;
          object.display.end = clock;
        };
      if (k === "addEventListener")
        return (event: Value, callback: Value) => {
          if (event === "click") attachClick(object.display, callback);
          else if (event === "enterFrame")
            scheduleTimer(
              callback,
              1000 / 24,
              Math.floor((object.display.end - clock) / (1000 / 24)),
            );
          else throw new UnsupportedDanmaku("Script 事件暂不支持");
        };
      if (k === "setTextFormat")
        return (format: Value) => {
          for (const [name, v] of Object.entries(format))
            assignNode(object.display, name, v);
        };
      return getNode(object.display, k);
    }
    if (Array.isArray(object)) {
      if (k === "length") return object.length;
      if (/^\d+$/.test(k)) return object[Number(k)];
      if (k === "push")
        return (...args: Value[]) => {
          if (object.length + args.length > 2048)
            throw new UnsupportedDanmaku();
          return object.push(...args);
        };
      if (k === "pop") return () => object.pop();
      if (k === "join")
        return (separator = ",") => {
          const s = object
            .map((v) => (typeof v === "object" ? "[object]" : String(v)))
            .join(String(separator));
          if (s.length > 32768) throw new UnsupportedDanmaku();
          return s;
        };
      if (k === "slice")
        return (from: Value, to: Value) =>
          object.slice(Number(from), to === undefined ? undefined : Number(to));
      if (k === "forEach" || k === "map")
        return (callback: Value) =>
          object.map((v, i) => call(callback, [v, i, object]));
      throw new UnsupportedDanmaku();
    }
    if (typeof object === "string") {
      if (k === "length") return object.length;
      if (/^\d+$/.test(k)) return object[Number(k)];
      if (
        [
          "charAt",
          "charCodeAt",
          "slice",
          "substring",
          "substr",
          "toUpperCase",
          "toLowerCase",
          "split",
          "indexOf",
          "trim",
        ].includes(k)
      )
        return (...args: Value[]) => {
          if (
            args.some((v) => typeof v === "object" || typeof v === "function")
          )
            throw new UnsupportedDanmaku();
          const result = (String.prototype as Value)[k].apply(object, args);
          if (result.length > 32768) throw new UnsupportedDanmaku();
          return result;
        };
    }
    if (object && Object.hasOwn(object, k)) return object[k];
    throw new UnsupportedDanmaku(`Script 属性暂不支持：${k.slice(0, 40)}`);
  }
  function set(object: Value, property: string, v: Value): Value {
    if (collecting) throw new UnsupportedDanmaku();
    const k = key(property);
    if (isNode(object)) {
      if (k === "onclick") attachClick(object.display, v);
      else assignNode(object.display, k, v);
    } else {
      if (
        !object ||
        typeof object !== "object" ||
        (Array.isArray(object) && (!/^\d+$/.test(k) || Number(k) >= 2048))
      )
        throw new UnsupportedDanmaku();
      if (Object.keys(object).length >= 2048 && !Object.hasOwn(object, k))
        throw new UnsupportedDanmaku();
      object[k] = v;
    }
    return v;
  }
  function assign(ast: Ast, env: Env, v: Value): Value {
    if (ast.type === "Identifier") return setVariable(env, ast.name, v);
    if (ast.type === "MemberExpression")
      return set(
        expression(ast.object, env),
        ast.computed ? expression(ast.property, env) : ast.property.name,
        v,
      );
    throw new UnsupportedDanmaku();
  }
  function binary(op: string, a: Value, b: Value): Value {
    const n = Number(a),
      m = Number(b);
    switch (op) {
      case "+": {
        const v = a + b;
        if (typeof v === "string" && v.length > 32768)
          throw new UnsupportedDanmaku();
        return v;
      }
      case "-":
        return n - m;
      case "*":
        return n * m;
      case "/":
        return n / m;
      case "%":
        return n % m;
      case "**":
        return n ** m;
      case "==":
        return a == b;
      case "!=":
        return a != b;
      case "===":
        return a === b;
      case "!==":
        return a !== b;
      case "<":
        return a < b;
      case ">":
        return a > b;
      case "<=":
        return a <= b;
      case ">=":
        return a >= b;
      case "&":
        return n & m;
      case "|":
        return n | m;
      case "^":
        return n ^ m;
      case "<<":
        return n << m;
      case ">>":
        return n >> m;
      case ">>>":
        return n >>> m;
      default:
        throw new UnsupportedDanmaku();
    }
  }
  function call(fn: Value, args: Value[]): Value {
    guard();
    if (++depth > 32) throw new UnsupportedDanmaku("Script 调用超出运行上限");
    try {
      if (typeof fn === "function") return fn(...args);
      if (!fn?.closure) throw new UnsupportedDanmaku();
      const closure = fn as Closure,
        env: Env = { parent: closure.env, values: Object.create(null) };
      closure.params.forEach((p, i) => {
        if (p.type !== "Identifier") throw new UnsupportedDanmaku();
        setVariable(env, p.name, args[i], true);
      });
      try {
        return closure.body.type === "BlockStatement"
          ? statement(closure.body, env)
          : expression(closure.body, env);
      } catch (signal: Value) {
        if (signal?.control === "return") return signal.value;
        throw signal;
      }
    } finally {
      depth--;
    }
  }
  function expression(ast: Ast, env: Env): Value {
    guard();
    if (!ast) return undefined;
    switch (ast.type) {
      case "Literal":
        if (ast.regex || ast.bigint) throw new UnsupportedDanmaku();
        return ast.value;
      case "Identifier":
        return lookup(env, ast.name);
      case "ArrayExpression":
        return ast.elements.map((a: Ast) => expression(a, env));
      case "ObjectExpression": {
        const obj = Object.create(null);
        for (const p of ast.properties) {
          if (p.type !== "Property" || p.kind !== "init" || p.method)
            throw new UnsupportedDanmaku();
          obj[
            key(
              p.computed ? expression(p.key, env) : (p.key.name ?? p.key.value),
            )
          ] = expression(p.value, env);
        }
        return obj;
      }
      case "MemberExpression":
        return get(
          expression(ast.object, env),
          ast.computed ? expression(ast.property, env) : ast.property.name,
        );
      case "CallExpression":
        return call(
          expression(ast.callee, env),
          ast.arguments.map((a: Ast) => expression(a, env)),
        );
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return { closure: true, params: ast.params, body: ast.body, env };
      case "BinaryExpression":
        return binary(
          ast.operator,
          expression(ast.left, env),
          expression(ast.right, env),
        );
      case "LogicalExpression": {
        const a = expression(ast.left, env);
        return ast.operator === "&&"
          ? a && expression(ast.right, env)
          : ast.operator === "??"
            ? (a ?? expression(ast.right, env))
            : a || expression(ast.right, env);
      }
      case "ConditionalExpression":
        return expression(
          expression(ast.test, env) ? ast.consequent : ast.alternate,
          env,
        );
      case "SequenceExpression": {
        let v;
        for (const a of ast.expressions) v = expression(a, env);
        return v;
      }
      case "AssignmentExpression":
        return assign(
          ast.left,
          env,
          ast.operator === "="
            ? expression(ast.right, env)
            : binary(
                ast.operator.slice(0, -1),
                expression(ast.left, env),
                expression(ast.right, env),
              ),
        );
      case "UpdateExpression": {
        const old = Number(expression(ast.argument, env)),
          next = old + (ast.operator === "++" ? 1 : -1);
        assign(ast.argument, env, next);
        return ast.prefix ? next : old;
      }
      case "UnaryExpression": {
        const a = expression(ast.argument, env);
        switch (ast.operator) {
          case "!":
            return !a;
          case "+":
            return +a;
          case "-":
            return -a;
          case "~":
            return ~a;
          case "typeof":
            return typeof a;
          case "void":
            return undefined;
          default:
            throw new UnsupportedDanmaku();
        }
      }
      default:
        throw new UnsupportedDanmaku(`Script 语法暂不支持：${ast.type}`);
    }
  }
  function statement(ast: Ast, env: Env): Value {
    guard();
    if (!ast) return;
    switch (ast.type) {
      case "Program":
      case "BlockStatement":
        for (const s of ast.body)
          if (s.type === "FunctionDeclaration") {
            setVariable(
              env,
              s.id.name,
              { closure: true, params: s.params, body: s.body, env },
              true,
            );
          }
        for (const s of ast.body) statement(s, env);
        return;
      case "ForInStatement":
      case "ForOfStatement": {
        const object = expression(ast.right, env);
        if (
          !object ||
          (typeof object !== "object" && typeof object !== "string")
        )
          throw new UnsupportedDanmaku();
        if (
          ast.type === "ForOfStatement" &&
          !Array.isArray(object) &&
          typeof object !== "string"
        )
          throw new UnsupportedDanmaku();
        const values =
          ast.type === "ForInStatement"
            ? Object.keys(object)
            : Array.from(object);
        for (const value of values) {
          guard();
          if (ast.left.type === "VariableDeclaration") {
            if (
              ast.left.declarations.length !== 1 ||
              ast.left.declarations[0].id.type !== "Identifier"
            )
              throw new UnsupportedDanmaku();
            setVariable(env, ast.left.declarations[0].id.name, value, true);
          } else assign(ast.left, env, value);
          try {
            statement(ast.body, env);
          } catch (signal: Value) {
            if (signal?.control === "break") break;
            if (signal?.control !== "continue") throw signal;
          }
        }
        return;
      }
      case "SwitchStatement": {
        const value = expression(ast.discriminant, env);
        let start = ast.cases.findIndex(
          (c: Ast) => c.test && expression(c.test, env) === value,
        );
        if (start < 0) start = ast.cases.findIndex((c: Ast) => !c.test);
        if (start < 0) return;
        try {
          for (const c of ast.cases.slice(start))
            for (const s of c.consequent) statement(s, env);
        } catch (signal: Value) {
          if (signal?.control !== "break") throw signal;
        }
        return;
      }
      case "EmptyStatement":
        return;
      case "ExpressionStatement":
        return expression(ast.expression, env);
      case "VariableDeclaration":
        for (const d of ast.declarations) {
          if (d.id.type !== "Identifier") throw new UnsupportedDanmaku();
          setVariable(env, d.id.name, expression(d.init, env), true);
        }
        return;
      case "FunctionDeclaration":
        setVariable(
          env,
          ast.id.name,
          { closure: true, params: ast.params, body: ast.body, env },
          true,
        );
        return;
      case "IfStatement":
        return statement(
          expression(ast.test, env) ? ast.consequent : ast.alternate,
          env,
        );
      case "ReturnStatement":
        throw { control: "return", value: expression(ast.argument, env) };
      case "BreakStatement":
        throw { control: "break" };
      case "ContinueStatement":
        throw { control: "continue" };
      case "ForStatement":
      case "WhileStatement":
      case "DoWhileStatement": {
        if (ast.init) {
          if (ast.init.type === "VariableDeclaration") statement(ast.init, env);
          else expression(ast.init, env);
        }
        let first = true;
        while (
          (ast.type === "DoWhileStatement" && first) ||
          !ast.test ||
          expression(ast.test, env)
        ) {
          guard();
          first = false;
          try {
            statement(ast.body, env);
          } catch (s: Value) {
            if (s?.control === "break") break;
            if (s?.control !== "continue") throw s;
          }
          if (ast.update) expression(ast.update, env);
        }
        return;
      }
      default:
        throw new UnsupportedDanmaku(`Script 语法暂不支持：${ast.type}`);
    }
  }
  function scheduleTimer(callback: Value, delay: Value, count = 1): number {
    if (collecting) throw new UnsupportedDanmaku();
    if (
      !Number.isFinite(Number(delay)) ||
      Number(delay) < 1 ||
      timers.length >= 2048
    )
      throw new UnsupportedDanmaku();
    const id = ++timerId;
    timers.push({
      id,
      at: clock + Number(delay),
      delay: Number(delay),
      remaining: Math.min(Number(count), 2048),
      callback,
    });
    return id;
  }
  function tween(
    object: Value,
    dest: Value,
    src: Value = {},
    seconds = 1,
    ease: Value = "linear",
  ): Tween {
    if (!isNode(object)) throw new UnsupportedDanmaku();
    const duration = Number(seconds) * 1000;
    if (!Number.isFinite(duration) || duration < 0 || duration > 120000)
      throw new UnsupportedDanmaku();
    const to = canonical(dest),
      from = canonical(src);
    for (const k of Object.keys(to))
      if (from[k] === undefined)
        from[k] =
          getNode(object.display, k) ??
          (["alpha", "scale"].includes(k) ? 1 : 0);
    return {
      tween: true,
      duration,
      tracks: [
        {
          node: object.display,
          animation: {
            start: 0,
            end: duration,
            from,
            to,
            easing:
              typeof ease === "string"
                ? ease
                : ease == null
                  ? "linear"
                  : (easeNames.get(ease) ??
                    (() => {
                      throw new UnsupportedDanmaku(
                        "自定义 Script 插值函数暂不支持",
                      );
                    })()),
          },
        },
      ],
    };
  }
  function play(t: Tween): Tween {
    if (collecting || !t?.tween) throw new UnsupportedDanmaku();
    for (const track of t.tracks)
      track.node.animations.push({
        ...track.animation,
        start: track.animation.start + clock,
        end: track.animation.end + clock,
      });
    duration = Math.max(duration, clock + t.duration);
    return t;
  }
  function transformTween(t: Tween, shift: number, copies = 1): Tween {
    if (
      !t?.tween ||
      !Number.isSafeInteger(copies) ||
      copies < 1 ||
      copies > 128 ||
      t.tracks.length * copies > 1024
    )
      throw new UnsupportedDanmaku();
    return {
      tween: true,
      duration: shift + t.duration * copies,
      tracks: Array.from({ length: copies }, (_, i) =>
        t.tracks.map((v) => ({
          node: v.node,
          animation: {
            ...v.animation,
            start: v.animation.start + shift + t.duration * i,
            end: v.animation.end + shift + t.duration * i,
          },
        })),
      ).flat(),
    };
  }
  const display = {
    createComment: (text: Value, params?: Value) =>
      create("text", text, params),
    createTextField: (text: Value, params?: Value) =>
      create("text", text, params),
    createButton: (params: Value = {}) => {
      const { text, ...p } = params;
      return create("button", text, p);
    },
    createShape: (params?: Value) => create("path", undefined, params),
    createCanvas: (params?: Value) => create("group", undefined, params),
    createSprite: (params?: Value) => create("group", undefined, params),
    createTextFormat: (
      font = "sans-serif",
      size = 25,
      color = 0xffffff,
      bold = false,
    ) => ({ fontFamily: font, fontSize: size, color, bold: Number(bold) }),
    width: 672,
    height: 438,
    stageWidth: 672,
    stageHeight: 438,
    root: {
      addChild: (child: Value) => child,
      removeChild: (child: Value) => {
        if (isNode(child))
          child.display.props.duration = clock - child.display.start;
      },
    },
  };
  const math: Record<string, Value> = Object.create(null);
  for (const k of [
    "abs",
    "acos",
    "asin",
    "atan",
    "atan2",
    "ceil",
    "cos",
    "exp",
    "floor",
    "log",
    "max",
    "min",
    "pow",
    "round",
    "sin",
    "sqrt",
    "tan",
    "trunc",
  ])
    math[k] = (...args: Value[]) => (Math as Value)[k](...args.map(Number));
  math.PI = Math.PI;
  math.E = Math.E;
  // Reproducible random sequence, including after backwards seek.
  let seed = 2166136261;
  for (const c of source) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619);
  math.random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
  const linear = (t: number, b: number, c: number, d: number) =>
    b + (c * t) / d;
  easeNames.set(linear, "linear");
  const tweens: Record<string, Value> = {
    tween,
    to: (o: Value, d: Value, s = 1, e?: Value) => tween(o, d, {}, s, e),
    delay: (t: Tween, s: number) => transformTween(t, s * 1000),
    repeat: (t: Tween, n: number) => transformTween(t, 0, n),
    serial: (...ts: Tween[]) => {
      let shift = 0;
      const tracks: Tween["tracks"] = [];
      for (const t of ts) {
        tracks.push(...transformTween(t, shift).tracks);
        shift += t.duration;
      }
      return { tween: true, duration: shift, tracks };
    },
    parallel: (...ts: Tween[]) => ({
      tween: true,
      duration: Math.max(...ts.map((t) => t.duration)),
      tracks: ts.flatMap((t) => t.tracks),
    }),
    play,
    linear,
    Linear: { None: linear },
  };
  for (const name of [
    "quadratic",
    "cubic",
    "quartic",
    "quintic",
    "circular",
    "sine",
    "exponential",
  ]) {
    const fn = (t: number, b: number, c: number, d: number) =>
      b + c * easing(name, t / d);
    tweens[name] = fn;
    easeNames.set(fn, name);
  }
  Object.assign(root.values, {
    $: display,
    Display: display,
    Tween: tweens,
    Math: math,
    Utils: {
      timer: (cb: Value, ms = 1000) => scheduleTimer(cb, ms),
      interval: (cb: Value, ms = 1000, count = 1) =>
        scheduleTimer(cb, ms, count === 0 ? Math.floor(120000 / ms) : count),
      clearTimer: (id: number) => {
        timers.forEach((t) => {
          if (t.id === id) t.cancelled = true;
        });
      },
    },
    setTimeout: (cb: Value, ms: number) => scheduleTimer(cb, ms),
    setInterval: (cb: Value, ms: number) =>
      scheduleTimer(cb, ms, Math.floor(120000 / ms)),
    clearTimeout: (id: number) => {
      timers.forEach((t) => {
        if (t.id === id) t.cancelled = true;
      });
    },
    clearInterval: (id: number) => {
      timers.forEach((t) => {
        if (t.id === id) t.cancelled = true;
      });
    },
    Player: {
      seek: (at_ms: number) => {
        if (!collecting)
          throw new UnsupportedDanmaku("自动控制播放的 Script 暂不支持");
        collecting.push({ kind: "seek", at_ms });
      },
      jump: (video: number | string, page = 1, _newWindow = false) => {
        if (!collecting) throw new UnsupportedDanmaku();
        collecting.push({
          kind: "video",
          video: typeof video === "number" ? `av${video}` : video,
          page,
          at_ms: 0,
        });
      },
    },
    timer: (cb: Value, ms = 1000) => scheduleTimer(cb, ms),
    interval: (cb: Value, ms = 1000, count = 1) =>
      scheduleTimer(cb, ms, count === 0 ? Math.floor(120000 / ms) : count),
    trace: () => {},
    String: (v: Value) => String(v),
    Number: (v: Value) => Number(v),
    Boolean: (v: Value) => Boolean(v),
    parseInt: (v: Value, radix = 10) => parseInt(String(v), radix),
    parseFloat: (v: Value) => parseFloat(String(v)),
    isNaN: (v: Value) => isNaN(Number(v)),
    undefined,
    NaN,
    Infinity,
  });
  statement(ast, root);
  let callbacks = 0;
  while (true) {
    const timer = timers
      .filter((t) => !t.cancelled && t.remaining > 0 && t.at <= 120000)
      .sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!timer) break;
    if (++callbacks > 2048)
      throw new UnsupportedDanmaku("Script 定时器超出运行上限");
    clock = timer.at;
    timer.remaining--;
    timer.at += timer.delay;
    call(timer.callback, []);
    duration = Math.max(duration, clock);
  }
  return {
    ...finishScene(nodes, duration || 4000),
    stage: { width: 672, height: 438 },
  };
}
