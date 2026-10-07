import { expect, test, type Page } from "@playwright/test";
import { appFixture } from "./fixtures/application";
async function fixture(
  page: Page,
  opts: {
    manage?: boolean;
    owner?: boolean;
    admin?: boolean;
    authorization?: boolean;
  } = {},
) {
  const app = await appFixture(page, { admin: opts.admin ?? false });
  const writes: any[] = [],
    browse: string[] = [],
    publicWrites: any[] = [];
  let sources = [
    {
      id: "private-http",
      name: "私人 HTTP",
      kind: "http",
      revision: "5",
      access_policy_revision: 2,
    },
    {
      id: "private-s3",
      name: "私人 S3",
      kind: "s3",
      revision: "9",
      access_policy_revision: 1,
    },
  ];
  let removed = false;
  const detail = () => ({
    id: "private",
    name: "私人合成片库",
    owner_id: opts.owner === false ? "another-owner" : "owner",
    visibility: "private",
    revision: "3",
    permission_epoch: "1",
    permissions: {
      browse: true,
      play: true,
      share_to_room: opts.authorization ?? false,
      manage: opts.manage ?? true,
    },
    sources,
    grants: opts.authorization
      ? [
          {
            user_id: "guest",
            username: "fixed-guest",
            expires_at: Date.now() + 3600000,
            browse: true,
            play: true,
            share_to_room: false,
            manage: false,
          },
        ]
      : [],
    room_shares: opts.authorization
      ? [
          {
            id: "share-one",
            media_id: "movie",
            room_id: "room",
            title: "仅这部私人影片",
            mode: "library_members",
            expires_at: Date.now() + 1800000,
            max_expires_at: Date.now() + 3600000,
            active: true,
          },
        ]
      : [],
    audit: [],
  });
  await page.route("**/api/v1/media/browse?**", (route) => {
    browse.push(route.request().url());
    return route.fulfill({
      json: {
        node: null,
        breadcrumbs: [{ id: null, name: "全部片源" }],
        entries: [],
        total_media: 0,
        next_cursor: null,
      },
    });
  });
  await page.route("**/api/v1/sources**", (route) => {
    if (route.request().method() !== "GET")
      publicWrites.push(route.request().url());
    return route.fulfill({ json: [] });
  });
  await page.route("**/api/v1/libraries**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      method = req.method();
    if (method !== "GET")
      writes.push({
        path,
        method,
        body: req.postData() ? req.postDataJSON() : null,
      });
    if (path === "/api/v1/libraries")
      return route.fulfill({
        json: { enabled: true, items: removed ? [] : [detail()] },
      });
    if (path === "/api/v1/libraries/private" && method === "DELETE") {
      removed = true;
      return route.fulfill({ json: { deleted: true } });
    }
    if (path === "/api/v1/libraries/private")
      return route.fulfill({ json: detail() });
    if (path === "/api/v1/libraries/private/grants")
      return route.fulfill({ json: detail() });
    if (path === "/api/v1/libraries/private/room-shares/share-one")
      return route.fulfill({ json: { id: "share-one", revision: "4" } });
    const source = sources.find((s) => path.endsWith("/" + s.id));
    if (source) {
      if (method === "DELETE") {
        sources = sources.filter((s) => s.id !== source.id);
        return route.fulfill({ json: { deleted: true } });
      }
      if (method === "PATCH") {
        Object.assign(source, {
          name: req.postDataJSON().name,
          revision: String(Number(source.revision) + 1),
        });
      }
      return route.fulfill({
        json: {
          ...source,
          library_id: "private",
          config:
            source.kind === "http"
              ? {
                  url: "https://private.example.test/video.mp4",
                  advanced_assets: null,
                }
              : {
                  url: "https://s3.example.test",
                  s3: {
                    region: "local",
                    bucket: "private",
                    prefix: "films/",
                    credential_ref: {
                      access_key_id_env: "RAINSYNC_S3_ACCESS",
                      secret_access_key_env: "RAINSYNC_S3_SECRET",
                    },
                  },
                },
          credentials: {
            token_configured: false,
            headers_configured: true,
            header_names: ["Authorization"],
            url_configured: true,
            url_redacted: false,
          },
          config_changed: false,
          rescan_required: false,
        },
      });
    }
    return route.fulfill({ json: [] });
  });
  return { ...app, writes, browse, publicWrites };
}
function sourceRow(page: Page, name: string) {
  return page
    .locator(".data-row")
    .filter({ has: page.getByText(name, { exact: true }) });
}
for (const width of [1280, 1440, 1920])
  test(`private manager HTTP settings stay scoped and preserve credentials at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({
      width,
      height: width === 1280 ? 800 : width === 1440 ? 900 : 1080,
    });
    const f = await fixture(page);
    await page.goto("/libraries");
    await sourceRow(page, "私人 HTTP")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    const d = page.getByRole("dialog", { name: "片源设置", exact: true });
    await expect(d.getByLabel("名称", { exact: true })).toHaveValue(
      "私人 HTTP",
    );
    await expect(d.getByLabel("媒体 URL")).toHaveValue(
      "https://private.example.test/video.mp4",
    );
    await d.getByLabel("名称", { exact: true }).fill("个人影片目录");
    await page.screenshot({
      path: info.outputPath(`private-http-settings-${width}.png`),
      animations: "disabled",
    });
    await d.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(d).toBeHidden();
    await expect(sourceRow(page, "个人影片目录")).toBeVisible();
    expect(f.writes).toEqual([
      {
        path: "/api/v1/libraries/private/sources/private-http",
        method: "PATCH",
        body: { expected_revision: "5", name: "个人影片目录" },
      },
    ]);
    expect(f.publicWrites).toEqual([]);
    expect(f.browse.length).toBeGreaterThan(0);
    expect(
      f.browse.every(
        (url) => new URL(url).searchParams.get("library_id") === "private",
      ),
    ).toBe(true);
    expect(f.errors).toEqual([]);
  });
test("private S3 manager can rename without exposing administrator connection config", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.goto("/libraries");
  await sourceRow(page, "私人 S3")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  const d = page.getByRole("dialog", { name: "S3 片源设置", exact: true });
  await expect(d.getByLabel("片源名称")).toHaveValue("私人 S3");
  await expect(d.getByLabel("服务地址")).toHaveCount(0);
  await expect(d.getByLabel("S3 配置 JSON")).toHaveCount(0);
  await expect(d).toContainText("你可以修改名称");
  await d.getByLabel("片源名称").fill("未保存名字");
  await d.getByRole("button", { name: "取消", exact: true }).click();
  await expect(d).toBeHidden();
  expect(f.writes).toEqual([]);
  await sourceRow(page, "私人 S3")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await expect(d.getByLabel("片源名称")).toHaveValue("私人 S3");
  await d.getByLabel("片源名称").fill("云端私人影片");
  await page.screenshot({
    path: info.outputPath("private-s3-manager-settings.png"),
    animations: "disabled",
  });
  await d.getByRole("button", { name: "保存片源设置", exact: true }).click();
  await expect(d).toBeHidden();
  expect(f.writes).toEqual([
    {
      path: "/api/v1/libraries/private/sources/private-s3",
      method: "PATCH",
      body: { name: "云端私人影片", expected_revision: "9" },
    },
  ]);
  expect(f.publicWrites).toEqual([]);
  expect(f.errors).toEqual([]);
});
test("private source and library deletion identify scope and cancelling preserves all configuration", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.goto("/libraries");
  await sourceRow(page, "私人 HTTP")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  let d = page.getByRole("dialog", { name: "删除片源配置", exact: true });
  await expect(d).toContainText("私人合成片库");
  await expect(d).toContainText("不会把私人影片迁入共享库");
  await expect(d).toContainText("保存的连接凭据会清除");
  await d.getByRole("button", { name: "取消", exact: true }).click();
  await expect(d).toBeHidden();
  expect(f.writes).toEqual([]);
  await page.getByRole("button", { name: "删除媒体库", exact: true }).click();
  d = page.getByRole("dialog", { name: "删除私人媒体库", exact: true });
  await expect(d).toContainText("所有账户授权和房间分享将撤销");
  await expect(d).toContainText("原始媒体文件不受影响");
  await expect(d).toContainText("此页面无法恢复已删除配置");
  await page.screenshot({
    path: info.outputPath("private-library-delete-impact.png"),
    animations: "disabled",
  });
  await d.getByRole("button", { name: "取消", exact: true }).click();
  expect(f.writes).toEqual([]);
  await sourceRow(page, "私人 HTTP")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  d = page.getByRole("dialog", { name: "删除片源配置", exact: true });
  await d.getByRole("button", { name: "确认删除片源", exact: true }).click();
  await expect(d).toBeHidden();
  expect(f.writes).toEqual([
    {
      path: "/api/v1/libraries/private/sources/private-http",
      method: "DELETE",
      body: { expected_revision: "5", expected_library_revision: "3" },
    },
  ]);
  await expect(sourceRow(page, "私人 S3")).toBeVisible();
  await expect(sourceRow(page, "私人 HTTP")).toHaveCount(0);
  expect(f.publicWrites).toEqual([]);
  expect(f.errors).toEqual([]);
});
test("browse-only private member cannot edit sources or delete another owners library", async ({
  page,
}) => {
  const f = await fixture(page, { manage: false, owner: false });
  await page.goto("/libraries");
  await expect(
    page.getByRole("heading", { name: "私人合成片库", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "片源与索引", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "删除媒体库", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "保存名称", exact: true }),
  ).toHaveCount(0);
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("private grant settings prefill the fixed identity and preserve revision on explicit update", async ({
  page,
}, info) => {
  const f = await fixture(page, { authorization: true });
  await page.goto("/libraries");
  const row = sourceRow(page, "fixed-guest");
  await row.getByRole("button", { name: "设置", exact: true }).click();
  const username = page.getByLabel("固定登录账号", { exact: true });
  await expect(username).toHaveValue("fixed-guest");
  await expect(username).toHaveAttribute("readonly", "");
  await expect(
    page.getByRole("checkbox", { name: "浏览", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "管理片源", exact: true }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "取消编辑", exact: true }).click();
  await expect(username).toHaveValue("");
  expect(f.writes).toEqual([]);
  await row.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("从保存起有效小时", { exact: true }).fill("2");
  await page
    .getByRole("checkbox", { name: "再分享到房间", exact: true })
    .check();
  await page
    .getByRole("button", { name: "保存授权设置", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("private-grant-settings.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "保存授权设置", exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.writes[0]).toMatchObject({
    path: "/api/v1/libraries/private/grants",
    method: "POST",
    body: {
      username: "fixed-guest",
      expires_in_hours: 2,
      browse: true,
      play: true,
      share_to_room: true,
      manage: false,
      expected_revision: "3",
    },
  });
  expect(f.errors).toEqual([]);
});
test("private room-share settings prefill scope and expiry and cancel before an explicit revision-fenced update", async ({
  page,
}, info) => {
  const f = await fixture(page, { authorization: true });
  await page.goto("/libraries");
  const row = sourceRow(page, "仅这部私人影片");
  await row.getByRole("button", { name: "设置", exact: true }).click();
  const d = page.getByRole("dialog", { name: "房间分享设置", exact: true });
  await expect(
    d.getByRole("combobox", { name: "观看范围", exact: true }),
  ).toHaveValue("library_members");
  await expect(d.getByLabel("到期时间", { exact: true })).not.toHaveValue("");
  await expect(d).toContainText("其他有效分享保持可用");
  await d
    .getByRole("combobox", { name: "观看范围", exact: true })
    .selectOption("room_members");
  await d.getByRole("button", { name: "取消", exact: true }).click();
  await expect(d).toBeHidden();
  expect(f.writes).toEqual([]);
  await row.getByRole("button", { name: "设置", exact: true }).click();
  await expect(
    d.getByRole("combobox", { name: "观看范围", exact: true }),
  ).toHaveValue("library_members");
  await d
    .getByRole("combobox", { name: "观看范围", exact: true })
    .selectOption("room_members");
  await page.screenshot({
    path: info.outputPath("private-room-share-settings.png"),
    animations: "disabled",
  });
  await d.getByRole("button", { name: "保存分享设置", exact: true }).click();
  await expect(d).toBeHidden();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toMatchObject({
    path: "/api/v1/libraries/private/room-shares/share-one",
    method: "PATCH",
    body: { mode: "room_members", expected_revision: "3" },
  });
  expect(f.writes[0].body.expires_at).toBeGreaterThan(Date.now());
  expect(f.publicWrites).toEqual([]);
  expect(f.errors).toEqual([]);
});

// This audit deliberately sets desktop widths; shared mobile flows are covered elsewhere.
test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, "Desktop settings and hierarchy geometry");
});

test("private hierarchy preserves library scope when sharing a movie beyond the first fifty entries", async ({
  page,
}, info) => {
  const f = await fixture(page, { authorization: true });
  const calls: URL[] = [];
  const shares: any[] = [];
  const media = Array.from({ length: 60 }, (_, i) => ({
    ...f.media[0],
    id: "private-" + i,
    title: "私人目录影片 " + i,
    original_title: "私人目录影片 " + i,
  }));
  await page.route("**/api/v1/media/browse?**", (route) => {
    const u = new URL(route.request().url());
    calls.push(u);
    if (!u.searchParams.has("library_id")) return route.fallback();
    const node = u.searchParams.get("node"),
      offset = Number(u.searchParams.get("after") ?? 0);
    return route.fulfill({
      json: {
        node,
        breadcrumbs: [
          { id: null, name: "全部片源" },
          ...(node
            ? [{ id: "private-source", name: "只属于私人库的目录" }]
            : []),
        ],
        entries: node
          ? media
              .slice(offset, offset + 24)
              .map((media) => ({ type: "media", media }))
          : [
              {
                type: "source",
                id: "private-source",
                name: "只属于私人库的目录",
                kind: "http",
                media_count: 60,
              },
            ],
        total_media: 60,
        next_cursor: node && offset + 24 < 60 ? String(offset + 24) : null,
      },
    });
  });
  await page.route("**/api/v1/libraries/private/room-shares", (route) => {
    shares.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: "new-share", revision: "4" } });
  });
  await page.goto("/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await page.getByRole("link", { name: "媒体库", exact: true }).first().click();
  await page
    .getByRole("link", { name: "我的媒体库与共享授权", exact: true })
    .click();
  await page
    .getByRole("button", { name: "打开片源 只属于私人库的目录", exact: true })
    .click();
  await expect(page.locator(".media-card")).toHaveCount(24);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".media-card")).toHaveCount(24);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".media-card")).toHaveCount(12);
  const card = page
    .locator(".media-card")
    .filter({
      has: page.getByRole("heading", { name: "私人目录影片 54", exact: true }),
    });
  await card.getByRole("button", { name: "选择分享", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "已选择分享", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("combobox", { name: "影片", exact: true }),
  ).toHaveValue("private-54");
  await page
    .getByRole("button", { name: "确认分享指定影片", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("private-third-page-selected-share.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "确认分享指定影片", exact: true })
    .click();
  await expect.poll(() => shares.length).toBe(1);
  expect(shares[0]).toMatchObject({
    room_id: "room",
    media_id: "private-54",
    mode: "library_members",
    expected_revision: "3",
  });
  const scoped = calls.filter((u) => u.searchParams.has("library_id"));
  expect(scoped.length).toBeGreaterThanOrEqual(4);
  expect(
    scoped.every((u) => u.searchParams.get("library_id") === "private"),
  ).toBe(true);
  expect(scoped.at(-1)?.searchParams.get("after")).toBe("48");
  expect(f.publicWrites).toEqual([]);
  expect(f.errors).toEqual([]);
});
