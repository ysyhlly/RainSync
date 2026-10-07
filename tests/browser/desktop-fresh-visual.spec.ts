import { expect, test, type Page } from "@playwright/test";
import { appFixture } from "./fixtures/application";
async function fixture(page: Page, kind = "local") {
  const app = await appFixture(page);
  let detail: any = {
    id: "source-one",
    kind,
    name: "家庭电影目录",
    library_id: "00000000-0000-0000-0000-000000000001",
    revision: "7",
    access_policy_revision: 2,
    config:
      kind === "local"
        ? { root: "/media/films" }
        : {
            url: "https://media.example.test/video.mp4",
            advanced_assets: {
              schema_version: 1,
              subtitles: ["ass"],
              fonts: ["body.ttf"],
            },
          },
    credentials: {
      token_configured: false,
      headers_configured: kind === "http",
      header_names: kind === "http" ? ["Authorization"] : [],
      url_configured: kind !== "local",
      url_redacted: false,
    },
  };
  const writes: string[] = [];
  await page.route("**/api/v1/sources**", (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (req.method() !== "GET") writes.push(req.method());
    if (path === "/api/v1/sources") return route.fulfill({ json: [detail] });
    if (path === "/api/v1/sources/source-one")
      return route.fulfill({ json: detail });
    return route.fallback();
  });
  return {
    ...app,
    writes,
    update: (patch: any) => {
      detail = { ...detail, ...patch };
    },
  };
}
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "片源设置", exact: true });
async function open(page: Page, name = "家庭电影目录") {
  await page.goto("/admin/sources");
  await page
    .getByRole("button", { name: "片源设置 " + name, exact: true })
    .click();
  await expect(dialog(page).getByLabel("名称", { exact: true })).toHaveValue(
    name,
  );
}

for (const width of [1280, 1440, 1920]) {
  test(`source discard decisions stay clear of the footer at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 600 });
    const f = await fixture(page, "http");
    await open(page);
    const d = dialog(page);
    await d.getByLabel("名称", { exact: true }).fill("键盘操作草稿");
    await page.screenshot({
      path: info.outputPath(`01-http-top-${width}.png`),
      animations: "disabled",
    });
    const summary = d.locator("summary");
    if (
      !(await d
        .locator("details")
        .evaluate((el: HTMLDetailsElement) => el.open))
    )
      await summary.click();
    await d
      .getByRole("combobox", { name: "请求头处理方式", exact: true })
      .click();
    await page.screenshot({
      path: info.outputPath(`02-http-select-${width}.png`),
      animations: "disabled",
    });
    await expect(
      page.getByRole("option", { name: "清除全部请求头", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page
      .getByRole("option", { name: "清除全部请求头", exact: true })
      .click();
    await d.getByLabel("外部字幕/字体关联 JSON（可选）").focus();
    await page.keyboard.press("Tab");
    await expect(
      d.getByRole("button", { name: "取消", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      d.getByRole("button", { name: "保存设置", exact: true }),
    ).toBeFocused();
    await page.screenshot({
      path: info.outputPath(`03-http-footer-${width}.png`),
      animations: "disabled",
    });
    await expect(
      d.getByRole("button", { name: "保存设置", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Escape");
    const guard = d.getByRole("group", { name: "放弃未保存的片源设置" });
    await expect(guard).toBeVisible();
    await expect(
      d.getByRole("button", { name: "继续编辑", exact: true }),
    ).toBeFocused();
    await page.screenshot({
      path: info.outputPath(`04-dirty-guard-${width}.png`),
      animations: "disabled",
    });
    const decision = d.getByRole("button", { name: "继续编辑", exact: true });
    const decisionBox = await decision.boundingBox(),
      footerBox = await d.locator(".source-settings-actions").boundingBox();
    expect(decisionBox!.y + decisionBox!.height).toBeLessThanOrEqual(
      footerBox!.y,
    );
    expect(
      await decision.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return (
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) ===
          el
        );
      }),
    ).toBe(true);
    await d
      .getByRole("button", { name: "放弃未保存内容", exact: true })
      .click();
    await expect(d).toBeHidden();
    expect(f.writes).toEqual([]);
    expect(f.errors).toEqual([]);
  });
  test(`long source deletion remains contained at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 600 });
    const f = await fixture(page),
      longName = "FamilyMediaArchive2026".repeat(4);
    f.update({ name: longName });
    await page.goto("/admin/sources");
    const trigger = page.getByRole("button", {
      name: "删除片源 " + longName,
      exact: true,
    });
    await trigger.click();
    const d = page.getByRole("dialog", { name: "删除片源", exact: true });
    await expect(d).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`05-long-delete-${width}.png`),
      animations: "disabled",
    });
    await info.attach("geometry", {
      body: JSON.stringify(
        await d.evaluate((el) => ({
          client: el.clientWidth,
          scroll: el.scrollWidth,
          rect: el.getBoundingClientRect().toJSON(),
        })),
      ),
      contentType: "application/json",
    });
    expect(await d.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(
      true,
    );
    await d.getByRole("button", { name: "取消", exact: true }).click();
    await expect(d).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(f.writes).toEqual([]);
  });
  test(`deep long hierarchy remains contained at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 600 });
    const app = await appFixture(page);
    const name =
      "Family_Media_NAS_Archive_2026_UHD_Remux_Complete_Collection".repeat(2);
    await page.route("**/api/v1/media/browse?**", (route) => {
      const node = new URL(route.request().url()).searchParams.get("node");
      return route.fulfill({
        json: {
          node,
          breadcrumbs: node
            ? [
                { id: null, name: "全部片源" },
                ...Array.from({ length: 5 }, (_, i) => ({
                  id: "level-" + i,
                  name: name + "_" + i,
                })),
              ]
            : [{ id: null, name: "全部片源" }],
          entries: node
            ? app.media.slice(0, 12).map((media) => ({ type: "media", media }))
            : [
                {
                  type: "source",
                  id: "source",
                  name,
                  kind: "local",
                  media_count: 12,
                },
              ],
          next_cursor: null,
          total_media: 12,
        },
      });
    });
    await page.goto("/library");
    await page
      .getByRole("button", { name: "打开片源 " + name, exact: true })
      .click();
    const nav = page.getByRole("navigation", { name: "媒体库目录" });
    await expect(nav).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`06-deep-hierarchy-${width}.png`),
      animations: "disabled",
    });
    await info.attach("geometry", {
      body: JSON.stringify(
        await nav.evaluate((el) => ({
          client: el.clientWidth,
          scroll: el.scrollWidth,
          rect: el.getBoundingClientRect().toJSON(),
          doc: document.documentElement.scrollWidth,
          viewport: innerWidth,
        })),
      ),
      contentType: "application/json",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await nav.getByRole("button", { name: "全部片源", exact: true }).focus();
    await expect(
      nav.getByRole("button", { name: "全部片源", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "打开片源 " + name, exact: true }),
    ).toBeVisible();
    expect(app.errors).toEqual([]);
  });
}

// Deliberately exercise desktop widths; the hierarchy suite also covers mobile.
test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, "Desktop short-height geometry");
});
