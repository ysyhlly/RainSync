import { test, expect, type Page } from "@playwright/test";
import { appFixture } from "./fixtures/application";

async function contentFixture(page: Page) {
  const app = await appFixture(page);
  const libraries = ["家庭影片", "旅行纪录"].map((name, i) => ({
    id: i ? "travel" : "private",
    name,
    owner_id: "owner",
    visibility: "private",
    revision: "7",
    permission_epoch: "3",
    permissions: {
      browse: true,
      play: true,
      share_to_room: true,
      manage: true,
    },
    sources: [],
    grants: [],
    room_shares: [],
    audit: [],
  }));
  const mutations: { path: string; body: any }[] = [];
  const inviteQueries: string[] = [];
  await page.route("**/api/v1/libraries**", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname === "/api/v1/libraries")
      return route.fulfill({ json: { enabled: true, items: libraries } });
    const library = libraries.find((item) =>
      url.pathname.includes(`/${item.id}`),
    )!;
    if (url.pathname.endsWith("/media")) {
      const query = url.searchParams.get("search") ?? "";
      return route.fulfill({
        json: app.media
          .slice(0, 5)
          .filter((item) => item.title.includes(query)),
      });
    }
    if (request.method() === "PUT") {
      const body = request.postDataJSON();
      mutations.push({ path: url.pathname, body });
      library.name = body.name;
      library.revision = String(Number(library.revision) + 1);
    }
    return route.fulfill({ json: library });
  });
  await page.route("**/api/v1/admin/registration-invites**", (route) => {
    const url = new URL(route.request().url());
    inviteQueries.push(url.search);
    const status =
      url.searchParams.get("status") === "used" ? "used" : "unused";
    return route.fulfill({
      json: {
        items: [
          {
            id: "invite",
            batch_id: "fixture",
            code_suffix: "ABCD",
            status,
            created_at: 1_800_000_000_000,
            expires_at: 1_800_086_400_000,
            note: "周末电影会新成员",
            used_by: status === "used" ? "viewer" : null,
            used_by_username: "friend",
            used_by_display_name: "朋友",
            used_at: status === "used" ? 1_800_000_000_000 : null,
            revoked_at: null,
          },
        ],
        next_cursor: null,
        server_time: 1_800_000_000_000,
      },
    });
  });
  return { ...app, mutations, inviteQueries };
}

async function fits(page: Page, width: number) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        content: document.documentElement.scrollWidth,
        viewport: innerWidth,
      })),
    )
    .toEqual({ content: width, viewport: width });
}

for (const viewport of [
  { width: 1280, height: 800, columns: 3 },
  { width: 1440, height: 900, columns: 4 },
  { width: 1920, height: 1080, columns: 5 },
]) {
  test(`library exposes content early with readable cards at ${viewport.width}px`, async ({
    page,
  }, info) => {
    test.skip(info.project.name !== "desktop");
    const app = await contentFixture(page);
    await page.setViewportSize(viewport);
    await page.goto("/library");
    await expect(page.locator(".media-card")).toHaveCount(24);
    const cards = await page.locator(".media-card").evaluateAll((items) =>
      items.map((item) => {
        const { x, y, width, height } = item.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
    expect(cards[0].y).toBeLessThan(350);
    expect(cards[0].width).toBeGreaterThanOrEqual(256);
    expect(
      cards.filter((card) => Math.abs(card.y - cards[0].y) < 1),
    ).toHaveLength(viewport.columns);
    expect(cards[viewport.columns].y).toBeLessThan(viewport.height - 100);
    const title = (await page
      .locator(".library-results-heading h2")
      .boundingBox())!;
    const count = (await page
      .locator(".library-results-heading .helper")
      .boundingBox())!;
    // Desktop counts belong on the title row, keeping the next film row discoverable.
    expect(count.x).toBeGreaterThan(title.x + title.width);
    expect(
      Math.abs(count.y + count.height - title.y - title.height),
    ).toBeLessThan(8);
    await expect(
      page.getByRole("link", { name: "选择放映室", exact: true }),
    ).toBeInViewport();
    const play = await page
      .locator(".media-card")
      .first()
      .locator(".media-actions > button")
      .first()
      .boundingBox();
    expect(play!.height).toBeGreaterThanOrEqual(44);
    await fits(page, viewport.width);
    expect(app.errors).toEqual([]);
  });

  test(`private library shows films beside bounded management at ${viewport.width}px`, async ({
    page,
  }, info) => {
    test.skip(info.project.name !== "desktop");
    const app = await contentFixture(page);
    await page.setViewportSize(viewport);
    await page.goto("/libraries");
    const rows = page.locator(".private-media-list > .data-row");
    await expect(rows).toHaveCount(5);
    const management = (await page
      .locator(".library-management")
      .boundingBox())!;
    const content = (await page.locator(".library-content").boundingBox())!;
    const first = (await rows.first().boundingBox())!;
    const third = (await rows.nth(2).boundingBox())!;
    expect(management.width).toBeLessThanOrEqual(320);
    expect(content.x).toBeGreaterThan(management.x + management.width);
    expect(Math.abs(content.y - management.y)).toBeLessThan(2);
    expect(first.y).toBeLessThan(430);
    expect(third.y + third.height).toBeLessThan(viewport.height - 24);
    expect(
      (await page.getByLabel("媒体库名称", { exact: true }).boundingBox())!
        .width,
    ).toBeLessThanOrEqual(288);
    for (const form of await page
      .locator(
        ".library-content .library-form-grid, .library-content .library-inline-form",
      )
      .all())
      expect((await form.boundingBox())!.width).toBeLessThanOrEqual(832);
    await fits(page, viewport.width);
    expect(app.errors).toEqual([]);
  });

  test(`invite filter and refresh share a baseline at ${viewport.width}px`, async ({
    page,
  }, info) => {
    test.skip(info.project.name !== "desktop");
    const app = await contentFixture(page);
    await page.setViewportSize(viewport);
    await page.goto("/admin/registration-invites");
    await expect(page.locator(".invite-card")).toHaveCount(1);
    const status = (await page
      .getByRole("combobox", { name: "状态", exact: true })
      .boundingBox())!;
    const refresh = (await page
      .getByRole("button", { name: "刷新列表" })
      .boundingBox())!;
    expect(
      Math.abs(status.y + status.height - refresh.y - refresh.height),
    ).toBeLessThan(2);
    expect(status.height).toBeGreaterThanOrEqual(44);
    expect(refresh.height).toBeGreaterThanOrEqual(44);
    expect((await page.locator(".invite-card").boundingBox())!.y).toBeLessThan(
      380,
    );
    await fits(page, viewport.width);
    expect(app.errors).toEqual([]);
  });
}

test("desktop management layout preserves selection, revisioned rename and film search", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  const app = await contentFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/libraries");
  const navigation = page.getByRole("navigation", { name: "媒体库选择" });
  await navigation.getByRole("button", { name: "旅行纪录 · 私人" }).click();
  await expect(page.getByLabel("媒体库名称", { exact: true })).toHaveValue(
    "旅行纪录",
  );
  await page.getByLabel("媒体库名称", { exact: true }).fill("旅行精选");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(page.getByText("名称已保存", { exact: true })).toBeVisible();
  expect(app.mutations).toEqual([
    {
      path: "/api/v1/libraries/travel",
      body: { name: "旅行精选", expected_revision: "7" },
    },
  ]);
  await page.getByLabel("搜索当前库", { exact: true }).fill("没有这部影片");
  await page.getByLabel("搜索当前库", { exact: true }).press("Enter");
  await expect(
    page.getByRole("heading", { name: "没有找到匹配影片" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await expect(page.locator(".private-media-list > .data-row")).toHaveCount(5);
  await page
    .locator(".private-media-list")
    .getByRole("button", { name: "选择分享", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "已选择分享", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(app.errors).toEqual([]);
});

test("aligned invite controls retain filtering and refreshing", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  const app = await contentFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/registration-invites");
  await page.getByRole("combobox", { name: "状态", exact: true }).click();
  await page.getByRole("option", { name: "已使用", exact: true }).click();
  await expect(page.locator(".status-tag")).toHaveText("已使用");
  const before = app.inviteQueries.length;
  await page.getByRole("button", { name: "刷新列表" }).click();
  await expect.poll(() => app.inviteQueries.length).toBe(before + 1);
  expect(app.inviteQueries.at(-1)).toContain("status=used");
  expect(app.errors).toEqual([]);
});

test("content pages remain stacked and overflow-free on mobile", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile");
  const app = await contentFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/libraries");
  await expect(page.locator(".private-media-list > .data-row")).toHaveCount(5);
  const management = (await page.locator(".library-management").boundingBox())!;
  const content = (await page.locator(".library-content").boundingBox())!;
  expect(content.y).toBeGreaterThanOrEqual(management.y + management.height);
  await fits(page, 390);
  for (const path of ["/library", "/admin/registration-invites"]) {
    await page.goto(path);
    await expect(
      page.locator(".media-card, .invite-card").first(),
    ).toBeVisible();
    await fits(page, 390);
  }
  expect(app.errors).toEqual([]);
});
