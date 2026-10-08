import { describe, expect, it, vi, afterEach } from "vitest";
import { compileBas } from "../apps/web/src/features/playback/bas-danmaku";
import { compileScript } from "../apps/web/src/features/playback/script-danmaku";
import {
  sampleSceneNode,
  danmakuActionUrl,
  validDanmakuAction,
} from "../apps/web/src/features/playback/advanced-danmaku";
import { compileDanmakuCues } from "../apps/web/src/features/playback/advanced-danmaku-loader";
import {
  parsePlatformDanmaku,
  visiblePlatformDanmaku,
  type PlatformDanmakuCue,
} from "../apps/web/src/features/playback/platform-text";
afterEach(() => vi.unstubAllGlobals());
describe("BAS media-time semantics", () => {
  it("renders the official sequential example across pause/backwards seek and viewport resize", () => {
    const scene =
      compileBas(`def text c { content="bilibili" fontSize=10% x=50% y=50% anchorX=0.5 anchorY=0.5 }
      set c {} 2s then set c { content="干杯" x=75% alpha=0 } 3s`);
    expect(scene.duration_ms).toBe(5000);
    const c = scene.nodes[0];
    expect(sampleSceneNode(c, 1000, 800, 450).content).toBe("bilibili");
    const middle = sampleSceneNode(c, 3500, 800, 450);
    expect(middle.content).toBe("干杯");
    expect(middle.x).toBe(500);
    expect(middle.alpha).toBe(0.5);
    expect(sampleSceneNode(c, 3500, 800, 450)).toEqual(middle);
    expect(sampleSceneNode(c, 1000, 800, 450).content).toBe("bilibili");
    expect(sampleSceneNode(c, 3500, 1600, 900).x).toBe(1000);
  });
  it("composes concurrent groups and then, templates, named arguments, clones and per-property easing", () => {
    const scene =
      compileBas(`def text t(color=0xffffff, content="default") { content=content color=color x=0 }
      let a=t(0xff0000,"A") let b=t(content="B",color=0x00ff00)
      { set a {x=[100,"quadratic"]} 2s set b {y=200} 1s }
      then set (t(content="C")) {alpha=0} 500ms`);
    expect(scene.nodes.map((n) => n.props.content)).toEqual(["A", "B", "C"]);
    expect(scene.duration_ms).toBe(2500);
    expect(sampleSceneNode(scene.nodes[0], 1000, 672, 438).x).toBe(50);
    expect(sampleSceneNode(scene.nodes[1], 1000, 672, 438).y).toBe(200);
    expect(scene.nodes[2].start).toBe(2000);
    expect(sampleSceneNode(scene.nodes[2], 2250, 672, 438).alpha).toBe(0.5);
  });
  it("retains SVG path data, parent hierarchy, 3D transforms and typed user actions", () => {
    const scene = compileBas(`def text p {content="父层" rotateY=45 duration=8s}
      def path s {parent="p" d="M0 0 L32 32 Z" viewBox="0 0 32 32" width=20% fillColor=0x00a1d6}
      def button b {text="下一段" target=seek {time=1m30s} x=35% y=45%}
      def button link {text="视频" target=av {bvid=BV1dGhd68Epd page=2 time=20.5s500ms}}`);
    expect(scene.duration_ms).toBe(8000);
    expect(scene.nodes[1].props.parent).toBe("p");
    expect(scene.nodes[1].props.d).toBe("M0 0 L32 32 Z");
    expect(scene.nodes[2].props.target).toEqual({ kind: "seek", at_ms: 90000 });
    expect(danmakuActionUrl(scene.nodes[3].props.target as any)).toBe(
      "https://www.bilibili.com/video/BV1dGhd68Epd/?p=2&t=21",
    );
  });
  it.each([
    'def text t {content="x" fontFamily="url(evil)"}',
    'def path p {d="<svg onload=evil>"}',
    'def text a {content="x" parent="b"} def text b {content="y" parent="a"}',
    'def button b {text="x" target=av {bvid="javascript:evil"}}',
    'def text t {content="x"} set t {x=NaN} 1s',
    'def text t {content="x"} set t {} 2m then set t {} 1s',
    'def text t {content="x"} set t {x=1} 1s,"unknown"',
  ])(
    "refuses invalid BAS without producing a partial executable scene: %s",
    (source) => expect(() => compileBas(source)).toThrow(),
  );
});
describe("bounded BiliScript display interpreter", () => {
  it("reads tweened properties at the timer callback's media time", async () => {
    const scene =
      await compileScript(`var c=$.createComment("moving",{x:0,lifeTime:4});Tween.to(c,{x:100},2).play();
      Utils.timer(function(){$.createComment("observed",{x:c.x,lifeTime:2});},1000);`);
    expect(scene.nodes[1].props.x).toBe(50);
  });

  it("hoists functions and handles collection loops, continue and switch fallthrough", async () => {
    const scene =
      await compileScript(`var titles=["one","two","three"]; for(var i in titles){if(i==1)continue; draw(titles[i]);}
      function draw(s){$.createComment(s,{lifeTime:4});}
      for(var s of ["four"]) {switch(s){case "four":draw(s);break;default:draw("wrong");}}`);
    expect(scene.nodes.map((n) => n.props.content)).toEqual([
      "one",
      "three",
      "four",
    ]);
  });

  it("supports functions, arithmetic, loops, text, graphics and Tween serial/parallel timing", async () => {
    const scene =
      await compileScript(`function label(i) { return $.createComment("第"+(i+1)+"行", {x:i*50,y:20,size:24,lifeTime:8}); }
      var labels=[]; for(var i=0;i<3;i++){labels.push(label(i));}
      var s=$.createShape({lifeTime:8});s.graphics.beginFill(0x00a1d6,.8);s.graphics.drawRect(10,40,80,20);
      Tween.serial(Tween.to(labels[0],{x:100},2),Tween.to(labels[0],{alpha:0},1)).play();`);
    expect(scene.nodes.map((n) => n.props.content).slice(0, 3)).toEqual([
      "第1行",
      "第2行",
      "第3行",
    ]);
    expect(sampleSceneNode(scene.nodes[0], 1000, 672, 438).x).toBe(50);
    expect(sampleSceneNode(scene.nodes[0], 2500, 672, 438).alpha).toBe(0.5);
    expect(scene.nodes[3].props.d).toContain("h80 v20");
  });
  it("compiles delayed mutations and timed creations against media time", async () => {
    const scene =
      await compileScript(`var c=$.createComment("first",{lifeTime:5});
      Utils.timer(function(){c.text="second";$.createComment("late",{x:50,lifeTime:2});},1000);`);
    expect(scene.nodes[1].start).toBe(1000);
    expect(sampleSceneNode(scene.nodes[0], 500, 672, 438).content).toBe(
      "first",
    );
    expect(sampleSceneNode(scene.nodes[0], 1500, 672, 438).content).toBe(
      "second",
    );
    expect(sampleSceneNode(scene.nodes[0], 500, 672, 438).content).toBe(
      "first",
    );
  });
  it("turns an explicit click callback into a typed seek without an automatic playback action", async () => {
    const scene = await compileScript(
      `var c=$.createComment("点击跳转",{lifeTime:5});c.addEventListener("click",function(){Player.seek(30000);});`,
    );
    expect(scene.nodes[0].kind).toBe("button");
    expect(scene.nodes[0].props.target).toEqual({ kind: "seek", at_ms: 30000 });
    await expect(compileScript("Player.seek(30000);")).rejects.toThrow();
  });
  it("uses deterministic random values across replay", async () => {
    const code = '$.createComment("x",{x:Math.random()*600,lifeTime:4});';
    expect(await compileScript(code)).toEqual(await compileScript(code));
  });
  it.each([
    "while(true){}",
    "function f(){f();} f();",
    'fetch("https://evil.test");',
    "document.cookie;",
    'self.postMessage("evil");',
    'var x={}; x.constructor.constructor("return this")();',
    'var x=[]; x["__proto__"]={};',
    "var x=Object.create(null);",
    'var c=$.createComment("x"); c.addEventListener("click",function(){c.text="changed";Player.seek(1);});',
    'setInterval(function(){$.createComment("many");},1);',
  ])("stops prohibited or runaway code: %s", (source) =>
    expect(compileScript(source)).rejects.toThrow(),
  );
});
describe("advanced snapshot isolation and display bounds", () => {
  const program: PlatformDanmakuCue = {
    at_ms: 0,
    text: "BAS 弹幕",
    mode: "top",
    program: {
      language: "bas",
      source: 'def text t {content="test" duration=1m}',
    },
  };
  it("keeps long scenes visible past the plain-cue lifetime and reconstructs them on seek", () => {
    const cue = { ...program, scene: compileBas(program.program!.source) };
    expect(visiblePlatformDanmaku([cue], 50000)).toHaveLength(1);
    expect(visiblePlatformDanmaku([cue], 60000)).toHaveLength(0);
    expect(visiblePlatformDanmaku([cue], 1000)).toHaveLength(1);
  });
  it("validates input programs/interactions independently of the ordinary density bound", () => {
    const cues = [
      program,
      ...Array.from({ length: 6 }, () => ({
        at_ms: 0,
        text: "plain",
        mode: "scroll",
      })),
    ];
    expect(
      parsePlatformDanmaku({ snapshot: true, cues, warnings: [] }),
    ).toHaveLength(7);
    expect(() =>
      parsePlatformDanmaku({
        snapshot: true,
        cues: [{ ...program, program: { language: "js", source: "x" } }],
      }),
    ).toThrow();
    expect(() =>
      parsePlatformDanmaku({
        snapshot: true,
        cues: [
          {
            ...program,
            program: { language: "bas", source: "雨".repeat(11000) },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parsePlatformDanmaku({
        snapshot: true,
        cues: [
          {
            ...program,
            interaction: {
              kind: "vote",
              duration_ms: 5000,
              video: "BV1dGhd68Epd",
              options: [],
            },
          },
        ],
      }),
    ).toThrow();
  });
  it("never constructs arbitrary action URLs", () => {
    expect(
      validDanmakuAction({
        kind: "video",
        video: "https://evil.test",
        page: 1,
        at_ms: 0,
      }),
    ).toBe(false);
    expect(danmakuActionUrl({ kind: "seek", at_ms: 1 })).toBeUndefined();
    expect(
      danmakuActionUrl({ kind: "episode", episode: 123, at_ms: 2000 }),
    ).toBe("https://www.bilibili.com/bangumi/play/ep123?t=2");
  });
  it("terminates an owned worker when the caller cancels and rejects its late result", async () => {
    const instances: any[] = [];
    class FakeWorker {
      onmessage?: (event: any) => void;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("Worker", FakeWorker);
    const controller = new AbortController(),
      task = compileDanmakuCues([program], controller.signal);
    controller.abort(new Error("disabled"));
    await expect(task).rejects.toThrow("disabled");
    expect(instances[0].terminate).toHaveBeenCalledTimes(1);
    instances[0].onmessage({
      data: [{ scene: compileBas(program.program!.source) }],
    });
  });
  it("preserves ordinary cues when an individual advanced program fails", async () => {
    class FakeWorker {
      onmessage?: (event: any) => void;
      terminate = vi.fn();
      postMessage() {
        queueMicrotask(() =>
          this.onmessage?.({ data: [{ error: "unsupported" }] }),
        );
      }
    }
    vi.stubGlobal("Worker", FakeWorker);
    const cues = await compileDanmakuCues(
      [program, { at_ms: 1, text: "plain", mode: "scroll" }],
      new AbortController().signal,
    );
    expect(cues[0].program_error).toBe("unsupported");
    expect(cues[1].text).toBe("plain");
  });
});
