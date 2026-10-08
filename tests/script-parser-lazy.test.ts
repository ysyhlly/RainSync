import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
  vi.doUnmock("acorn");
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function parserLoadProbe() {
  vi.resetModules();
  const loaded = vi.fn();
  vi.doMock("acorn", async (original) => {
    loaded();
    return original();
  });
  const compiler =
    await import("../apps/web/src/features/playback/script-danmaku");
  return { loaded, compiler };
}

it("does not import the parser when opening the compiler or rejecting oversized input", async () => {
  const { loaded, compiler } = await parserLoadProbe();
  expect(loaded).not.toHaveBeenCalled();
  await expect(compiler.compileScript("雨".repeat(11000))).rejects.toThrow();
  expect(loaded).not.toHaveBeenCalled();
  const scene = await compiler.compileScript(
    '$.createComment("first", {lifeTime:2});',
  );
  expect(scene.nodes[0].props.content).toBe("first");
  expect(loaded).toHaveBeenCalledOnce();
  await compiler.compileScript('$.createComment("second");');
  expect(loaded).toHaveBeenCalledOnce();
});

it("BAS-only worker requests skip Acorn and mixed requests preserve ordering and safety", async () => {
  const { loaded } = await parserLoadProbe();
  const worker = {
    onmessage: undefined as
      undefined | ((event: MessageEvent) => Promise<void>),
    postMessage: vi.fn(),
  };
  vi.stubGlobal("self", worker);
  await import("../apps/web/src/features/playback/advanced-danmaku-worker");
  await worker.onmessage?.({
    data: [
      { language: "bas", source: 'def text t {content="bas" duration=2s}' },
    ],
  } as MessageEvent);
  expect(loaded).not.toHaveBeenCalled();
  expect(
    worker.postMessage.mock.calls[0][0][0].scene.nodes[0].props.content,
  ).toBe("bas");
  await worker.onmessage?.({
    data: [
      { language: "script", source: '$.createComment("script");' },
      { language: "bas", source: 'def text t {content="another" duration=2s}' },
      {
        language: "script",
        source: '({}).constructor.constructor("return document.cookie")();',
      },
    ],
  } as MessageEvent);
  const result = worker.postMessage.mock.calls[1][0];
  expect(loaded).toHaveBeenCalledOnce();
  expect(result[0].scene.nodes[0].props.content).toBe("script");
  expect(result[1].scene.nodes[0].props.content).toBe("another");
  expect(result[2].scene).toBeUndefined();
  expect(result[2].error).toContain("暂不支持");
  expect(JSON.stringify(result)).not.toContain("document.cookie");
});

it("parser download failure leaves BAS usable and reports a safe recoverable loading message", async () => {
  vi.resetModules();
  vi.doMock("acorn", () => {
    throw new TypeError("private module URL?token=hidden");
  });
  const worker = {
    onmessage: undefined as
      undefined | ((event: MessageEvent) => Promise<void>),
    postMessage: vi.fn(),
  };
  vi.stubGlobal("self", worker);
  await import("../apps/web/src/features/playback/advanced-danmaku-worker");
  await worker.onmessage?.({
    data: [
      { language: "script", source: '$.createComment("needs parser");' },
      {
        language: "bas",
        source: 'def text t {content="bas survives" duration=2s}',
      },
    ],
  } as MessageEvent);
  const result = worker.postMessage.mock.calls[0][0];
  expect(result[0].error).toContain("解析器加载失败");
  expect(result[0].scene).toBeUndefined();
  expect(result[1].scene.nodes[0].props.content).toBe("bas survives");
  expect(JSON.stringify(result)).not.toContain("hidden");
});
