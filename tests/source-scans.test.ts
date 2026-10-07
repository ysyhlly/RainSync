import { afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { useSourceScans } from "../apps/web/src/features/admin/source-scans.store";
afterEach(() => vi.unstubAllGlobals());
it("reports a completed legacy NAS index as needing upgrade rather than successful playback readiness", async () => {
  setActivePinia(createPinia());
  const scans = useSourceScans();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        status: "upgrade_required",
        count: 4,
        unversioned_count: 4,
      }),
    ),
  );
  await scans.scan({ id: "nas", name: "NAS", kind: "agent" });
  expect(scans.results.nas.failed).toBe(true);
  expect(scans.results.nas.busy).toBe(false);
  expect(scans.results.nas.message).toBe(
    "请升级 NAS Agent 并重新扫描，现有索引缺少文件版本",
  );
  scans.$dispose();
});
it("a delayed previous identity scan cannot remove a new identity result", async () => {
  setActivePinia(createPinia());
  const session = useSession(),
    scans = useSourceScans();
  session.accept({ id: "a", username: "a", admin: true, csrf: "a" });
  await nextTick();
  let release!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((r) => (release = r)))
      .mockResolvedValue(Response.json({ count: 7 })),
  );
  const source = { id: "source", name: "source", kind: "local" };
  const old = scans.scan(source);
  session.clear();
  session.accept({ id: "b", username: "b", admin: true, csrf: "b" });
  await nextTick();
  await scans.scan(source);
  release(Response.json({ count: 1 }));
  await old;
  expect(scans.results.source.message).toBe("本次扫描发现 7 部影片");
  scans.$dispose();
});
it("scan-all bounds upstream concurrency to two and continues after one failure", async () => {
  setActivePinia(createPinia());
  const scans = useSourceScans();
  const pending: (() => void)[] = [];
  let active = 0,
    maximum = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/sources"))
        return Response.json(
          Array.from({ length: 5 }, (_, i) => ({
            id: String(i),
            name: String(i),
            kind: "local",
          })),
        );
      if (url.endsWith("/agents")) return Response.json([]);
      maximum = Math.max(maximum, ++active);
      await new Promise<void>((r) => pending.push(r));
      active--;
      return url.includes("/1/")
        ? Response.json(
            { error: { code: "SOURCE_SCAN_FAILED" } },
            { status: 502 },
          )
        : Response.json({ count: 2 });
    }),
  );
  const work = scans.scanAll();
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending.splice(0).forEach((r) => r());
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending.splice(0).forEach((r) => r());
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  pending.splice(0).forEach((r) => r());
  await work;
  expect(maximum).toBe(2);
  expect(Object.values(scans.results).filter((r) => r.failed)).toHaveLength(1);
  expect(Object.values(scans.results).every((r) => !r.busy)).toBe(true);
  scans.$dispose();
});

it("scans three S3 sources without oversubscribing and makes partial-page results explicit", async () => {
  setActivePinia(createPinia());
  const scans = useSourceScans();
  const pending: (() => void)[] = [];
  let active = 0,
    maximum = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/sources"))
        return Response.json(
          Array.from({ length: 3 }, (_, i) => ({
            id: String(i),
            name: String(i),
            kind: "s3",
          })),
        );
      if (url.endsWith("/agents")) return Response.json([]);
      maximum = Math.max(maximum, ++active);
      await new Promise<void>((r) => pending.push(r));
      active--;
      return Response.json({ status: "running", count: 100, has_more: true });
    }),
  );
  const work = scans.scanAll();
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending.splice(0).forEach((r) => r());
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  pending.splice(0).forEach((r) => r());
  await work;
  expect(maximum).toBe(2);
  expect(
    Object.values(scans.results).every(
      (r) => !r.failed && !r.busy && r.message.includes("继续下一页"),
    ),
  ).toBe(true);
  scans.$dispose();
});
