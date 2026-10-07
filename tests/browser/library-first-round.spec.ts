import { test, expect } from "@playwright/test";
import { appFixture, openFixtureSource } from "./fixtures/application";
import { mediaRecord } from "./fixtures/media";

test("failed new query preserves the old page, announces it, and retries from page one", async ({
  page,
}, info) => {
  const app = await appFixture(page);
  const rows = (query: string) =>
    Array.from({ length: 60 }, (_, i) =>
      mediaRecord({ id: `${query}-${i}`, title: `${query} 影片 ${i}` }),
    );
  let failB = true;
  const requests: URL[] = [];
  await page.route("**/api/v1/media?**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const query = url.searchParams.get("search") || "A";
    if (query === "B" && failB)
      return route.fulfill({
        status: 503,
        json: { error: { code: "UNAVAILABLE", message: "搜索 B 暂时失败" } },
      });
    const after = url.searchParams.get("after"),
      all = rows(query);
    const start = after ? all.findIndex((item) => item.id === after) + 1 : 0;
    return route.fulfill({ json: all.slice(start, start + 25) });
  });
  await page.goto("/library");
  await openFixtureSource(page);
  await page.getByLabel("搜索影片").fill("A");
  await page.getByLabel("搜索影片").press("Enter");
  await expect(page.locator(".media-card").first()).toContainText("A 影片 0");
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.locator(".media-card").first()).toContainText("A 影片 24");
  await page.getByLabel("搜索影片").fill("B");
  await page.getByLabel("搜索影片").press("Enter");
  await expect(page.getByRole("alert")).toContainText("搜索 B 暂时失败");
  await expect(page.getByText(/仍显示上次成功加载的“A”搜索结果/)).toContainText(
    "第 2 页",
  );
  await expect(page.getByRole("button", { name: "下一页" })).toBeDisabled();
  await expect(page.locator(".media-card").first()).toContainText("A 影片 24");
  failB = false;
  await page.getByRole("button", { name: "重试本次加载" }).click();
  await expect(page.locator(".media-card").first()).toContainText("B 影片 0");
  await expect(page.getByText("第 1 页 · 本页 24 部")).toBeVisible();
  expect(requests.at(-1)?.searchParams.get("after")).toBeNull();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.locator(".media-card").first()).toContainText("B 影片 24");
  expect(requests.at(-1)?.searchParams.get("after")).toBe("B-23");
  expect(app.errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath("library-query-snapshot.png"),
    fullPage: true,
  });
});

test("selection survives choosing a room and requires one explicit confirmation", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.goto("/library");
  await openFixtureSource(page);
  await page
    .getByRole("button", { name: "播放 真实合成测试视频", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "已选择：真实合成测试视频" }),
  ).toBeVisible();
  expect(app.commands.filter((c) => c.type === "CHANGE_MEDIA")).toHaveLength(0);
  await page.getByRole("button", { name: "进入房间", exact: true }).click();
  const confirm = page.getByRole("button", { name: "确认播放所选影片" });
  await expect(confirm).toBeEnabled();
  expect(app.commands.filter((c) => c.type === "CHANGE_MEDIA")).toHaveLength(0);
  await confirm.click();
  await expect(confirm).toHaveCount(0);
  expect(app.commands.filter((c) => c.type === "CHANGE_MEDIA")).toHaveLength(1);
  expect(
    app.commands.find((c) => c.type === "CHANGE_MEDIA").payload.media_id,
  ).toBe("movie");
  expect(app.errors).toEqual([]);
});

test("cancelling a selection before entering a room never sends it", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.goto("/library");
  await openFixtureSource(page);
  await page
    .getByRole("button", { name: "播放 真实合成测试视频", exact: true })
    .click();
  await page.getByRole("button", { name: "取消选片", exact: true }).click();
  await page.getByRole("button", { name: "进入房间", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认播放所选影片" }),
  ).toHaveCount(0);
  expect(app.commands.filter((c) => c.type === "CHANGE_MEDIA")).toHaveLength(0);
});

test("zoom without editable focus preserves navigation and the original video", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await page.evaluate(() => {
    (window as any).__zoomVideo = document.querySelector("video");
  });
  await page
    .getByRole("link", { name: "媒体库", exact: true })
    .filter({ visible: true })
    .click();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    Object.defineProperty(visualViewport!, "height", {
      configurable: true,
      get: () => innerHeight / 2,
    });
    Object.defineProperty(visualViewport!, "scale", {
      configurable: true,
      get: () => 2,
    });
    visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator(".mini-player")).toBeVisible();
  await expect(page.locator(".bottom-nav")).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).__zoomVideo === document.querySelector("video"),
    ),
  ).toBe(true);
  expect(app.connections()).toBe(1);
  expect(app.preparations()).toBe(1);
});

test("private library pagination uses the applied query until a new search succeeds", async ({
  page,
}) => {
  const app = await appFixture(page, { admin: false });
  const detail = {
    id: "private",
    name: "合成私人库",
    owner_id: "owner",
    visibility: "private",
    revision: "1",
    permission_epoch: "1",
    permissions: {
      browse: true,
      play: true,
      share_to_room: false,
      manage: false,
    },
    sources: [],
    grants: [],
    room_shares: [],
    audit: [],
  };
  const requests: URL[] = [];
  await page.route("**/api/v1/libraries**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/libraries")
      return route.fulfill({ json: { enabled: true, items: [detail] } });
    if (url.pathname === "/api/v1/libraries/private")
      return route.fulfill({ json: detail });
    requests.push(url);
    const search = url.searchParams.get("search") || "A";
    const all = Array.from({ length: search === "A" ? 53 : 3 }, (_, i) =>
      mediaRecord({ id: `${search}-${i}`, title: `${search} 私人影片 ${i}` }),
    );
    const after = url.searchParams.get("after"),
      start = after ? all.findIndex((m) => m.id === after) + 1 : 0;
    return route.fulfill({ json: all.slice(start, start + 50) });
  });
  await page.goto("/libraries");
  // The default is now directory browsing. Enter an applied server search
  // before checking that later edits cannot change pagination's query.
  await page.getByLabel("搜索当前库").fill("A");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.locator(".private-media-list li")).toHaveCount(50);
  await page.getByLabel("搜索当前库").fill("B");
  await page.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(page.locator(".private-media-list li")).toHaveCount(53);
  expect(requests.at(-1)?.searchParams.get("search")).toBe("A");
  expect(requests.at(-1)?.searchParams.get("after")).toBe("A-49");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.locator(".private-media-list li")).toHaveCount(3);
  await expect(page.locator(".private-media-list")).not.toContainText(
    "A 私人影片",
  );
  expect(requests.at(-1)?.searchParams.get("search")).toBe("B");
  expect(requests.at(-1)?.searchParams.get("after")).toBeNull();
  expect(app.errors).toEqual([]);
});

test("revoked media clears a saved selection without changing the room", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.goto("/library");
  await openFixtureSource(page);
  await page
    .getByRole("button", { name: "播放 真实合成测试视频", exact: true })
    .click();
  await page.getByRole("button", { name: "进入房间", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认播放所选影片" }),
  ).toBeEnabled();
  await page.route("**/api/v1/media/movie", (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: "MEDIA_NOT_FOUND", message: "影片已不可访问" } },
    }),
  );
  await page.getByRole("button", { name: "确认播放所选影片" }).click();
  await expect(page.getByText("影片已不可访问", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认播放所选影片" }),
  ).toHaveCount(0);
  expect(app.commands.filter((c) => c.type === "CHANGE_MEDIA")).toHaveLength(0);
});
