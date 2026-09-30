import { test, expect, type Page } from "@playwright/test";
import { appFixture, appBase } from "./fixtures/application";

const batchId = "d5949e4c-082b-4bca-abd9-b95ff29e201d";
const code = "RS-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH";
function invite(id = "invite-1", status = "unused") {
  return {
    id,
    batch_id: batchId,
    code_suffix: id === "invite-1" ? "HHHH" : "2222",
    status,
    created_at: Date.UTC(2026, 8, 28),
    expires_at: Date.UTC(2026, 9, 5),
    note: "测试邀请",
    used_by: status === "used" ? "user-2" : null,
    used_by_username: status === "used" ? "viewer" : null,
    used_by_display_name: status === "used" ? "昵称" : null,
    used_at: status === "used" ? Date.UTC(2026, 8, 29) : null,
    revoked_at: null,
  };
}
async function inviteFixture(
  page: Page,
  mode: "success" | "lost" | "retry" = "success",
) {
  const app = await appFixture(page),
    posts: any[] = [],
    queries: string[] = [],
    deletes: string[] = [];
  const items = [invite()];
  let committed = mode === "success";
  await page.route("**/api/v1/admin/registration-invites**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      posts.push(body);
      if (mode === "lost" || (mode === "retry" && posts.length === 1)) {
        committed = mode === "lost";
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: '{"batch_id":',
        });
      }
      committed = true;
      return route.fulfill({
        status: 201,
        json: {
          batch_id: body.batch_id,
          items: [
            {
              id: "invite-1",
              code,
              code_suffix: "HHHH",
              expires_at: items[0].expires_at,
            },
          ],
        },
      });
    }
    if (request.method() === "DELETE") {
      deletes.push(url.pathname);
      items[0].status = "revoked";
      return route.fulfill({ json: items[0] });
    }
    queries.push(url.search);
    const filtered = url.searchParams.has("batch_id")
      ? committed
        ? items
        : []
      : url.searchParams.get("status") === "used"
        ? [invite("invite-2", "used")]
        : url.searchParams.has("cursor")
          ? [invite("invite-2", "used")]
          : items;
    return route.fulfill({
      json: {
        items: filtered,
        next_cursor:
          url.searchParams.has("cursor") ||
          url.searchParams.get("status") === "used"
            ? null
            : "next-id",
        server_time: Date.UTC(2026, 8, 28),
      },
    });
  });
  return { ...app, posts, queries, deletes };
}

test("invitation raw codes appear once with honest copy fallback, close warning and revoke", async ({
  page,
}) => {
  const app = await inviteFixture(page);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw Error("denied");
        },
      },
      configurable: true,
    }),
  );
  await page.goto(appBase + "/admin/registration-invites");
  await expect(page.getByText("尾号 HHHH", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "生成邀请码", exact: true }).click();
  await expect(page.getByLabel("数量", { exact: true })).toHaveValue("1");
  await expect(
    page.getByRole("combobox", { name: "有效期", exact: true }),
  ).toContainText("7 天");
  await page
    .getByRole("button", { name: "生成 1 个邀请码", exact: true })
    .click();
  await expect(page.getByLabel("全部邀请码", { exact: true })).toHaveValue(
    code,
  );
  await page
    .getByRole("button", { name: "复制全部邀请码", exact: true })
    .click();
  await expect(
    page.getByText("复制失败，请选中文本手动复制。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("全部邀请码", { exact: true })).toBeFocused();
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await expect(
    page.getByText(
      "仍有邀请码尚未复制。关闭后无法再次查看，但代码不会自动撤销。",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "仍然关闭", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.values(sessionStorage).some((v) => String(v).includes("RS-AAAA")),
    ),
  ).toBe(false);
  expect(app.deletes).toHaveLength(0);
  await expect(page.getByText(code, { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "撤销尾号 HHHH", exact: true })
    .click();
  await page
    .getByRole("button", { name: "确认撤销邀请码", exact: true })
    .click();
  await expect(page.locator(".status-tag")).toHaveText("已撤销");
  expect(app.deletes).toHaveLength(1);
  expect(app.posts).toHaveLength(1);
  expect(app.errors).toEqual([]);
});

test("lost batch response queries same id and exposes metadata without generating another batch", async ({
  page,
}) => {
  const app = await inviteFixture(page, "lost");
  await page.goto(appBase + "/admin/registration-invites");
  await page.getByRole("button", { name: "生成邀请码", exact: true }).click();
  await page
    .getByRole("button", { name: "生成 1 个邀请码", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("已确认本批生成成功");
  expect(app.posts).toHaveLength(1);
  expect(
    app.queries.some((q) => q.includes("batch_id=" + app.posts[0].batch_id)),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "使用同一批次重试" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("已确认本批生成成功");
  expect(app.posts).toHaveLength(1);
  await page.getByRole("button", { name: "关闭并查看列表" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(app.errors).toEqual([]);
});

test("uncommitted unknown batch explicitly retries the same persisted parameters after reload", async ({
  page,
}) => {
  const app = await inviteFixture(page, "retry");
  await page.goto(appBase + "/admin/registration-invites");
  await page.getByRole("button", { name: "生成邀请码", exact: true }).click();
  await page.getByLabel("备注（可选）").fill("批次参数");
  await page.getByRole("combobox", { name: "有效期", exact: true }).click();
  await page.getByRole("option", { name: "30 天", exact: true }).click();
  await page
    .getByRole("button", { name: "生成 1 个邀请码", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("尚未查到此批次");
  await page.reload();
  await page.getByRole("button", { name: "使用同一批次重试" }).click();
  await expect(page.getByLabel("全部邀请码", { exact: true })).toHaveValue(
    code,
  );
  expect(app.posts).toHaveLength(2);
  expect(app.posts[1]).toEqual(app.posts[0]);
  expect(app.errors).toEqual([]);
});

test("invitation filters reset server cursor and list both account and nickname", async ({
  page,
}) => {
  const app = await inviteFixture(page);
  await page.goto(appBase + "/admin/registration-invites");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText("第 2 页 · 本页 1 条")).toBeVisible();
  expect(app.queries.at(-1)).toContain("cursor=next-id");
  await page.getByRole("combobox", { name: "状态", exact: true }).click();
  await page.getByRole("option", { name: "已使用", exact: true }).click();
  await expect(page.getByText("第 1 页 · 本页 1 条")).toBeVisible();
  await expect(page.getByText("昵称（viewer）", { exact: true })).toBeVisible();
  expect(app.queries.at(-1)).not.toContain("cursor=");
  await expect(page.getByRole("button", { name: /撤销尾号/ })).toHaveCount(0);
});

test("sources validate dynamic fields and keep scans scoped to each row", async ({
  page,
}) => {
  const app = await appFixture(page);
  const added: any[] = [];
  let finishFirst: () => void = () => {};
  await page.route("**/api/v1/sources**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path.endsWith("/a/test"))
      await new Promise<void>((resolve) => (finishFirst = resolve));
    if (path.endsWith("/test")) return route.fulfill({ json: { count: 7 } });
    if (req.method() === "POST") {
      added.push(req.postDataJSON());
      return route.fulfill({ json: { id: "new" } });
    }
    return route.fulfill({
      json: [
        { id: "a", name: "目录一", kind: "local" },
        { id: "b", name: "目录二", kind: "http" },
        { id: "c", name: "NAS片源", kind: "agent" },
      ],
    });
  });
  await page.goto(appBase + "/admin/sources");
  const first = page.locator(".admin-row").filter({ hasText: "目录一" }),
    second = page.locator(".admin-row").filter({ hasText: "目录二" });
  await first.getByRole("button", { name: "检测并扫描" }).click();
  await second.getByRole("button", { name: "检测并扫描" }).click();
  await expect(second.getByText("本次扫描发现 7 部影片")).toBeVisible();
  await expect(first.getByRole("button")).toBeDisabled();
  finishFirst();
  await expect(first.getByText("本次扫描发现 7 部影片")).toBeVisible();
  await expect(
    page
      .locator(".admin-row")
      .filter({ hasText: "NAS片源" })
      .getByRole("button"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "添加片源", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("HTTP来源");
  await page.getByRole("combobox", { name: "类型", exact: true }).click();
  await page
    .getByRole("option", { name: "HTTP MP4 / HLS", exact: true })
    .click();
  await page
    .getByLabel("媒体或服务 URL")
    .fill("https://example.test/video.mp4");
  await page.getByLabel("请求头 JSON（可选）").fill('{"Authorization":3}');
  await page.getByRole("button", { name: "保存片源" }).click();
  await expect(page.getByRole("alert")).toContainText("请求头须为JSON对象");
  expect(added).toHaveLength(0);
  await page
    .getByLabel("请求头 JSON（可选）")
    .fill('{"X-Fixture":"synthetic"}');
  await page.getByRole("button", { name: "保存片源" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(added[0]).toEqual({
    name: "HTTP来源",
    kind: "http",
    config: {
      url: "https://example.test/video.mp4",
      headers: { "X-Fixture": "synthetic" },
    },
  });
  expect(app.errors).toEqual([]);
});

test("NAS history is not claimed online; pairing and revoke preserve actual contract", async ({
  page,
}) => {
  const app = await appFixture(page);
  const rows = [
    {
      id: "nas",
      name: "家中设备",
      revoked: false,
      last_seen: "2026-09-20T10:00:00Z",
    },
  ];
  let deletes = 0;
  await page.route("**/api/v1/agents**", async (route) => {
    if (route.request().method() === "POST")
      return route.fulfill({
        json: { id: "new", pair_code: "PAIR-SYNTHETIC" },
      });
    if (route.request().method() === "DELETE") {
      deletes++;
      rows[0].revoked = true;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: rows });
  });
  await page.goto(appBase + "/admin/agents");
  await expect(page.locator(".admin-row")).toContainText("已配对记录");
  await expect(page.locator(".admin-row")).toContainText("文件版本索引状态未知");
  await page.getByRole("button", { name: "添加设备", exact: true }).click();
  await page.getByLabel("设备名称").fill("第二设备");
  await page.getByRole("button", { name: "生成配对码" }).click();
  await expect(page.getByLabel("配对码", { exact: true })).toHaveValue(
    "PAIR-SYNTHETIC",
  );
  await expect(page.getByText(/预计剩余/)).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭弹窗" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "添加NAS设备" })).toBeHidden();
  await page.getByRole("button", { name: "撤销设备", exact: true }).click();
  expect(deletes).toBe(0);
  await page.getByRole("button", { name: "确认撤销设备" }).click();
  await expect(
    page.getByRole("button", { name: "撤销设备", exact: true }),
  ).toBeDisabled();
  expect(deletes).toBe(1);
  expect(app.errors).toEqual([]);
});

test("manual account uses new rules and preserves password spaces", async ({
  page,
}) => {
  const app = await appFixture(page),
    posts: any[] = [];
  await page.route("**/api/v1/users", async (route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: "new" } });
  });
  await page.goto(appBase + "/admin/users");
  await page.getByLabel("登录账号", { exact: true }).fill("fixed.account");
  await page.getByLabel("昵称（可选）").fill("重复昵称🙂");
  await page.getByLabel("密码", { exact: true }).fill("中文abcdef");
  await page.getByRole("button", { name: "创建普通账号" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(posts).toHaveLength(0);
  await page.getByLabel("密码", { exact: true }).fill(" abcdef ");
  await page.getByRole("button", { name: "创建普通账号" }).click();
  await expect(page.getByText("普通账号 fixed.account 已创建")).toBeVisible();
  expect(posts[0]).toEqual({
    username: "fixed.account",
    display_name: "重复昵称🙂",
    password: " abcdef ",
  });
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue("");
  expect(app.errors).toEqual([]);
});

test("admin navigation preserves the persistent video and room connection", async ({
  page,
}) => {
  const app = await inviteFixture(page);
  await page.goto(appBase + "/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await page.evaluate(() => {
    (window as any).__adminVideo = document.querySelector("video");
  });
  const nav = page
    .getByRole("link", { name: /^(管理|片源管理)$/ })
    .filter({ visible: true })
    .first();
  await nav.click();
  await expect(page.getByRole("heading", { name: "片源管理" })).toBeVisible();
  for (const label of ["NAS 设备", "账号与注册"]) {
    await page
      .getByRole("link", { name: label, exact: true })
      .filter({ visible: true })
      .click();
    await expect(
      page.getByRole("heading", { name: label, exact: true }),
    ).toBeVisible();
  }
  await expect(page.locator(".mini-player")).toBeVisible();
  await page.getByRole("link", { name: "返回房间" }).click();
  expect(
    await page.evaluate(
      () => (window as any).__adminVideo === document.querySelector("video"),
    ),
  ).toBe(true);
  expect(app.connections()).toBe(1);
  expect(app.preparations()).toBe(1);
  expect(app.errors).toEqual([]);
});
