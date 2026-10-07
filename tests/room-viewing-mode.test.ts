import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoomViewingMode } from "../apps/web/src/features/rooms/room-viewing-mode";

const controllers: ReturnType<typeof createRoomViewingMode>[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((c) => c.dispose()));
});
function fixture() {
  const events = new EventTarget();
  let element: Element | null = null;
  const root = { requestFullscreen: vi.fn() } as unknown as HTMLElement;
  const doc = {
    documentElement: root,
    fullscreenEnabled: true,
    get fullscreenElement() {
      return element;
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: vi.fn(events.removeEventListener.bind(events)),
    exitFullscreen: vi.fn(async () => {
      change(null);
    }),
  };
  function change(value: Element | null) {
    element = value;
    events.dispatchEvent(new Event("fullscreenchange"));
  }
  vi.mocked(root.requestFullscreen).mockImplementation(async () => {
    change(root);
  });
  const c = createRoomViewingMode(doc);
  controllers.push(c);
  return { c, doc, root, change, request: vi.mocked(root.requestFullscreen) };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("room viewing presentation", () => {
  it("does not request browser fullscreen until an explicit action", async () => {
    const { c, request } = fixture();
    expect(c.mode.value).toBe("normal");
    await c.toggleWebpage();
    expect(c.mode.value).toBe("webpage");
    c.toggleChat();
    expect(c.chatVisible.value).toBe(false);
    await c.toggleWebpage();
    expect(c.expanded.value).toBe(false);
    await c.toggleWebpage();
    expect(c.chatVisible.value).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  it("only claims native fullscreen after the actual root became fullscreen", async () => {
    const { c, request, root, change } = fixture();
    const d = deferred();
    request.mockReturnValueOnce(d.promise);
    const action = c.toggleBrowser();
    expect(request).toHaveBeenCalledTimes(1); // Before the first await.
    expect(c.pending.value).toBe(true);
    expect(c.mode.value).toBe("normal");
    await c.toggleBrowser();
    expect(request).toHaveBeenCalledTimes(1);
    change(root);
    expect(c.mode.value).toBe("browser");
    d.resolve();
    await action;
    expect(c.pending.value).toBe(false);
  });
  it("rejects unsupported browsers and native rejections without changing webpage/chat", async () => {
    const { c, doc, request } = fixture();
    doc.fullscreenEnabled = false;
    await c.toggleBrowser();
    expect(c.error.value).toContain("不支持");
    expect(request).not.toHaveBeenCalled();
    await c.toggleWebpage();
    c.toggleChat();
    doc.fullscreenEnabled = true;
    request.mockRejectedValueOnce(new Error("permission denied"));
    await c.toggleBrowser();
    expect(c.mode.value).toBe("webpage");
    expect(c.chatVisible.value).toBe(false);
    expect(c.pending.value).toBe(false);
    expect(c.error.value).toContain("无法进入");
  });
  it("does not mistake a resolved request without fullscreen for success", async () => {
    const { c, request } = fixture();
    request.mockResolvedValueOnce(undefined);
    await c.toggleBrowser();
    expect(c.mode.value).toBe("normal");
    expect(c.error.value).toContain("未进入");
  });
  it.each([false, true])(
    "external Escape restores the prior webpage mode (%s) and chat choice",
    async (webpage) => {
      const { c, change } = fixture();
      if (webpage) await c.toggleWebpage();
      await c.toggleBrowser();
      c.toggleChat();
      expect(c.mode.value).toBe("browser");
      change(null);
      expect(c.mode.value).toBe(webpage ? "webpage" : "normal");
      expect(c.chatVisible.value).toBe(false);
    },
  );
  it("switches browser fullscreen into webpage fullscreen through a real exit", async () => {
    const { c, doc } = fixture();
    await c.toggleBrowser();
    await c.toggleWebpage();
    expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(doc.fullscreenElement).toBeNull();
    expect(c.mode.value).toBe("webpage");
  });
  it("keeps native state truthful after an exit rejection", async () => {
    const { c, doc } = fixture();
    await c.toggleBrowser();
    doc.exitFullscreen.mockRejectedValueOnce(new Error("exit denied"));
    await c.toggleBrowser();
    expect(c.mode.value).toBe("browser");
    expect(c.error.value).toContain("未能退出");
    expect(c.pending.value).toBe(false);
    await c.toggleBrowser();
    expect(c.mode.value).toBe("normal");
  });
  it("does not exit or adopt an unrelated video-only fullscreen", async () => {
    const { c, doc, change, request } = fixture();
    const player = {} as Element;
    change(player);
    await c.toggleBrowser();
    expect(request).not.toHaveBeenCalled();
    expect(c.error.value).toContain("仅视频");
    await c.reset();
    expect(doc.exitFullscreen).not.toHaveBeenCalled();
    expect(doc.fullscreenElement).toBe(player);
  });
  it("preserves chat through nested video fullscreen and cleans both levels on route exit", async () => {
    const { c, root, doc, change } = fixture();
    await c.toggleBrowser();
    c.toggleChat();
    change({} as Element);
    expect(c.browser.value).toBe(false);
    change(root);
    expect(c.mode.value).toBe("browser");
    expect(c.chatVisible.value).toBe(false);
    change({} as Element);
    doc.exitFullscreen.mockImplementationOnce(async () => {
      change(root);
    });
    await c.reset();
    expect(doc.exitFullscreen).toHaveBeenCalledTimes(2);
    expect(doc.fullscreenElement).toBeNull();
    expect(c.mode.value).toBe("normal");
  });
  it.each(["reset", "dispose"] as const)(
    "releases a late native entry after %s and ignores its stale UI",
    async (method) => {
      const { c, root, doc, change, request } = fixture();
      const d = deferred();
      request.mockReturnValueOnce(d.promise);
      const action = c.toggleBrowser();
      await c[method]();
      await c.toggleBrowser();
      expect(request).toHaveBeenCalledTimes(1);
      change(root);
      expect(c.mode.value).toBe("normal");
      d.resolve();
      await action;
      expect(doc.fullscreenElement).toBeNull();
      expect(c.mode.value).toBe("normal");
      expect(c.error.value).toBe("");
      expect(c.pending.value).toBe(false);
      if (method === "dispose")
        expect(doc.removeEventListener).toHaveBeenCalledWith(
          "fullscreenchange",
          expect.any(Function),
        );
    },
  );
  it("ignores late rejection after route exit and allows a fresh explicit request", async () => {
    const { c, request } = fixture();
    const d = deferred();
    request.mockReturnValueOnce(d.promise);
    const action = c.toggleBrowser();
    await c.reset();
    d.reject(new Error("old request"));
    await action;
    expect(c.error.value).toBe("");
    await c.toggleBrowser();
    expect(request).toHaveBeenCalledTimes(2);
    expect(c.mode.value).toBe("browser");
  });
});
