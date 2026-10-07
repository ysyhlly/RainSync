import { afterEach, expect, it, vi } from "vitest";
import { effectScope, nextTick, reactive, ref } from "vue";
import { useVisiblePreviews } from "../apps/web/src/features/library/use-visible-previews";

const hooks = vi.hoisted(() => ({ mounted: [] as (() => void)[], unmount: [] as (() => void)[], catalog: undefined as any }));
vi.mock("vue", async original => ({
  ...await original<any>(),
  onMounted: (fn: () => void) => hooks.mounted.push(fn),
  onBeforeUnmount: (fn: () => void) => hooks.unmount.push(fn),
}));
vi.mock("../apps/web/src/features/library/media-catalog.store", () => ({ useMediaCatalog: () => hooks.catalog }));

afterEach(() => {
  hooks.unmount.splice(0).forEach(fn => fn());
  hooks.mounted.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup() {
  vi.useFakeTimers();
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: (entries: any[]) => void) {}
    observe(node: unknown) { this.callback([{ target: node, isIntersecting: true }]); }
    disconnect() {}
  });
  const catalog = hooks.catalog = {
    records: reactive({ movie: { cover: { status: "missing", retry_after_ms: null as number | null } } }),
    requestPreviews: vi.fn(async () => {}),
    refreshPreviewStatuses: vi.fn(async () => {}),
  };
  const root = ref({ querySelectorAll: () => [{ dataset: { mediaId: "movie" } }] });
  const scope = effectScope();
  const previews = scope.run(() => useVisiblePreviews(root as any, () => ["movie"]))!;
  hooks.mounted.splice(0).forEach(fn => fn());
  await nextTick();
  return { catalog, previews, stop: () => scope.stop() };
}

it("keeps polling a requested missing preview and requeues it with bounded waiting", async () => {
  const s = await setup();
  try {
    await vi.advanceTimersByTimeAsync(50);
    expect(s.catalog.requestPreviews).toHaveBeenCalledOnce();
    expect(s.catalog.refreshPreviewStatuses).toHaveBeenCalledOnce();
    expect(s.previews.stalled.value.has("movie")).toBe(false);
    await vi.advanceTimersByTimeAsync(62000);
    expect(s.catalog.requestPreviews.mock.calls.length).toBeGreaterThan(1);
    expect(s.previews.stalled.value.has("movie")).toBe(true);
    const count = s.catalog.requestPreviews.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(s.catalog.requestPreviews).toHaveBeenCalledTimes(count);
    s.catalog.requestPreviews.mockImplementation(async () => { s.catalog.records.movie.cover.status = "queued"; });
    s.catalog.refreshPreviewStatuses.mockImplementation(async () => { s.catalog.records.movie.cover.status = "ready"; });
    s.previews.retry("movie");
    await vi.advanceTimersByTimeAsync(2100);
    expect(s.catalog.records.movie.cover.status).toBe("ready");
    expect(s.previews.stalled.value.has("movie")).toBe(false);
  } finally { s.stop(); }
});

it("a queued preview returning to missing can be requested again and eventually becomes ready", async () => {
  const s = await setup();
  try {
    s.catalog.requestPreviews.mockImplementation(async () => { s.catalog.records.movie.cover.status = "queued"; });
    s.catalog.refreshPreviewStatuses.mockImplementationOnce(async () => { s.catalog.records.movie.cover.status = "missing"; })
      .mockImplementation(async () => { s.catalog.records.movie.cover.status = "ready"; });
    await vi.advanceTimersByTimeAsync(50);
    expect(s.catalog.records.movie.cover.status).toBe("missing");
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.catalog.requestPreviews).toHaveBeenCalledTimes(2);
    expect(s.catalog.records.movie.cover.status).toBe("ready");
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.catalog.requestPreviews).toHaveBeenCalledTimes(2);
  } finally { s.stop(); }
});
