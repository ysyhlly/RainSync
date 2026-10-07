import { expect, test, type Page, type Route } from "@playwright/test";
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
            user_id: "service-user",
          },
    credentials: {
      token_configured: ["jellyfin", "emby"].includes(kind),
      headers_configured: kind === "http",
      header_names: kind === "http" ? ["Authorization"] : [],
      url_configured: true,
      url_redacted: false,
    },
  };
  if (kind === "http")
    detail.config.advanced_assets = {
      schema_version: 1,
      subtitles: ["ass"],
      fonts: ["body.ttf"],
    };
  const writes: any[] = [];
  let mode = "success",
    pending: Route | undefined,
    removed = false;
  await page.route("**/api/v1/sources**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === "/api/v1/sources")
      return route.fulfill({ json: removed ? [] : [detail] });
    if (path === "/api/v1/sources/source-one") {
      if (req.method() === "GET") return route.fulfill({ json: detail });
      writes.push({
        method: req.method(),
        body: req.postData() ? req.postDataJSON() : null,
      });
      if (req.method() === "DELETE") {
        removed = true;
        return route.fulfill({ json: { ok: true } });
      }
      if (mode === "busy") {
        pending = route;
        return;
      }
      if (mode === "conflict")
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "SOURCE_CHANGED",
              message: "fixture revision conflict",
            },
          },
        });
      if (mode === "forbidden")
        return route.fulfill({
          status: 403,
          json: {
            error: {
              code: "ADMIN_REQUIRED",
              message: "fixture permission revoked",
            },
          },
        });
      const body = req.postDataJSON();
      detail = {
        ...detail,
        name: body.name,
        config: { ...detail.config, ...body.config },
        revision: String(Number(detail.revision) + 1),
        config_changed: !!body.config,
        rescan_required: !!body.config,
      };
      return route.fulfill({ json: detail });
    }
    return route.fallback();
  });
  return {
    ...app,
    writes,
    setMode: (m: string) => (mode = m),
    update: (patch: any) => (detail = { ...detail, ...patch }),
    finish: async () => {
      expect(pending).toBeTruthy();
      const body = pending!.request().postDataJSON();
      detail = {
        ...detail,
        name: body.name,
        revision: "8",
        config_changed: false,
        rescan_required: false,
      };
      await pending!.fulfill({ json: detail });
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
for (const width of [1280, 1440, 1920])
  test(`source settings prefill change cancel reopen save at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({
      width,
      height: width === 1280 ? 800 : width === 1440 ? 900 : 1080,
    });
    const f = await fixture(page);
    await open(page);
    const d = dialog(page),
      name = d.getByLabel("名称", { exact: true }),
      save = d.getByRole("button", { name: "保存设置", exact: true });
    await expect(d.getByLabel("容器内路径")).toHaveValue("/media/films");
    await expect(save).toBeDisabled();
    await expect(d).toContainText("仅修改名称不会中断播放");
    await page.screenshot({
      path: info.outputPath(`source-settings-${width}.png`),
      animations: "disabled",
    });
    expect(await d.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(
      true,
    );
    await name.fill("不会保存的草稿");
    await page.keyboard.press("Escape");
    await expect(
      d.getByRole("group", { name: "放弃未保存的片源设置" }),
    ).toBeVisible();
    await d.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(name).toHaveValue("不会保存的草稿");
    await d.getByRole("button", { name: "取消", exact: true }).click();
    await d
      .getByRole("button", { name: "放弃未保存内容", exact: true })
      .click();
    await expect(d).toBeHidden();
    expect(f.writes).toEqual([]);
    await page
      .getByRole("button", { name: "片源设置 家庭电影目录", exact: true })
      .click();
    await expect(name).toHaveValue("家庭电影目录");
    await name.fill("保留影片的新名称");
    await save.click();
    await expect(d).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "保留影片的新名称", exact: true }),
    ).toBeVisible();
    expect(f.writes).toEqual([
      {
        method: "PATCH",
        body: { expected_revision: "7", name: "保留影片的新名称" },
      },
    ]);
    expect(f.errors).toEqual([]);
  });
test("shared settings mutation stays locked through pending response and sends only one write", async ({
  page,
}) => {
  const f = await fixture(page, "jellyfin");
  f.setMode("busy");
  await open(page);
  const d = dialog(page);
  await expect(d.getByLabel("服务 URL")).toHaveValue(
    "https://media.example.test/video.mp4",
  );
  await expect(d.getByLabel("专用账户 User ID")).toHaveValue("service-user");
  await expect(
    d.getByRole("combobox", { name: "访问令牌处理方式", exact: true }),
  ).toContainText("保持已保存的令牌");
  await expect(d.locator('input[type="password"]')).toHaveCount(0);
  await d.getByLabel("名称", { exact: true }).fill("繁忙测试");
  await d.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(
    d.getByRole("button", { name: "正在保存…", exact: true }),
  ).toBeDisabled();
  await expect(
    d.getByRole("button", { name: "取消", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(d).toBeVisible();
  expect(f.writes).toHaveLength(1);
  await f.finish();
  await expect(d).toBeHidden();
  expect(f.errors).toEqual([]);
});
test("conflict retains source draft and requires deliberate reload before a new revision is used", async ({
  page,
}, info) => {
  const f = await fixture(page);
  f.setMode("conflict");
  await open(page);
  const d = dialog(page),
    name = d.getByLabel("名称", { exact: true });
  await name.fill("保留的冲突草稿");
  await d.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(d.getByRole("alert")).toContainText("你的输入已保留");
  await expect(name).toHaveValue("保留的冲突草稿");
  await expect(
    d.getByRole("button", { name: "保存设置", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("source-conflict.png"),
    animations: "disabled",
  });
  await d
    .getByRole("button", { name: "重新载入已保存设置", exact: true })
    .click();
  await expect(
    d.getByRole("group", { name: "放弃未保存的片源设置" }),
  ).toBeVisible();
  await d.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(name).toHaveValue("保留的冲突草稿");
  expect(f.writes).toHaveLength(1);
  f.update({ revision: "9", name: "其他管理员的新名称" });
  f.setMode("success");
  await d
    .getByRole("button", { name: "重新载入已保存设置", exact: true })
    .click();
  await d
    .getByRole("button", { name: "放弃修改并重新载入", exact: true })
    .click();
  await expect(name).toHaveValue("其他管理员的新名称");
  await name.fill("重载后保存");
  await d.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(d).toBeHidden();
  expect(f.writes[1].body.expected_revision).toBe("9");
  expect(f.errors).toEqual([]);
});
for (const width of [1280, 1440, 1920])
  test(`HTTP settings credentials advanced section and keyboard layout at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({
      width,
      height: width === 1280 ? 800 : width === 1440 ? 900 : 1080,
    });
    const f = await fixture(page, "http");
    await open(page);
    const d = dialog(page);
    const summary = d.locator("summary");
    if (
      !(await d
        .locator("details")
        .evaluate((el: HTMLDetailsElement) => el.open))
    )
      await summary.click();
    await expect(
      d.getByRole("combobox", { name: "请求头处理方式", exact: true }),
    ).toContainText("保持已保存的请求头");
    await expect(d.getByLabel("新的请求头 JSON")).toHaveCount(0);
    await expect(d.getByLabel("外部字幕/字体关联 JSON（可选）")).toHaveValue(
      /body\.ttf/,
    );
    await d
      .getByRole("combobox", { name: "请求头处理方式", exact: true })
      .click();
    await page
      .getByRole("option", { name: "清除全部请求头", exact: true })
      .click();
    await expect(
      d.getByText("保存后将清除全部请求头，需要鉴权的媒体可能无法播放。"),
    ).toBeVisible();
    const assets = d.getByLabel("外部字幕/字体关联 JSON（可选）");
    await d.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(assets).toBeInViewport({ ratio: 1 });
    const assetBox = await assets.boundingBox(),
      actionsBox = await d.locator(".source-settings-actions").boundingBox();
    expect(assetBox!.y + assetBox!.height).toBeLessThanOrEqual(actionsBox!.y);
    await assets.focus();
    await page.keyboard.press("Tab");
    await expect(
      d.getByRole("button", { name: "取消", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      d.getByRole("button", { name: "保存设置", exact: true }),
    ).toBeFocused();
    for (const label of ["取消", "保存设置"]) {
      const button = d.getByRole("button", { name: label, exact: true });
      await expect(button).toBeInViewport({ ratio: 1 });
      const box = await button.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(
        page.viewportSize()!.height,
      );
    }
    expect(await d.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath(`http-settings-${width}.png`),
      animations: "disabled",
    });
    await d.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(d).toBeHidden();
    expect(f.writes[0].body).toEqual({
      expected_revision: "7",
      name: "家庭电影目录",
      config: { headers: {} },
    });
    expect(f.errors).toEqual([]);
  });
test("source delete impact is explicit and cancelling cannot issue deletion", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.goto("/admin/sources");
  const trigger = page.getByRole("button", {
    name: "删除片源 家庭电影目录",
    exact: true,
  });
  await trigger.click();
  const d = page.getByRole("dialog", { name: "删除片源", exact: true });
  await expect(d).toContainText("关联影片将从媒体库移除");
  await expect(d).toContainText("不会删除原始媒体文件");
  await expect(d).toContainText("房间历史记录会保留");
  await page.screenshot({
    path: info.outputPath("source-delete-impact.png"),
    animations: "disabled",
  });
  await d.getByRole("button", { name: "取消", exact: true }).click();
  await expect(d).toBeHidden();
  expect(f.writes).toEqual([]);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await d.getByRole("button", { name: "确认删除片源", exact: true }).click();
  await expect(d).toBeHidden();
  await expect(trigger).toHaveCount(0);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].method).toBe("DELETE");
  expect(f.errors).toEqual([]);
});

// This audit deliberately sets desktop widths; shared mobile flows are covered elsewhere.
test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, "Desktop settings and hierarchy geometry");
});
