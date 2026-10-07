import { expect, test } from "@playwright/test";
import { appFixture } from "./fixtures/application";

test("edits an existing NAS and cancels/reopens settings without recreating pairing", async ({
  page,
}) => {
  const app = await appFixture(page);
  let name = "Owned NAS";
  const writes: any[] = [];
  await page.route("**/api/v1/agents", (route) =>
    route.fulfill({
      json: [
        { id: "nas", name, revoked: false, last_seen: null, connected: true },
      ],
    }),
  );
  await page.route("**/api/v1/agents/nas", async (route) => {
    writes.push({
      method: route.request().method(),
      body: route.request().postDataJSON(),
    });
    name = route.request().postDataJSON().name;
    await route.fulfill({ json: { id: "nas", name } });
  });
  await page.goto("/admin/agents");
  await page.getByRole("button", { name: "设备设置", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "NAS 设备设置",
    exact: true,
  });
  await dialog.getByLabel("设备名称").fill("cancelled draft");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "设备设置", exact: true }).click();
  await expect(dialog.getByLabel("设备名称")).toHaveValue("Owned NAS");
  await dialog.getByLabel("设备名称").fill("Renamed NAS");
  await dialog
    .getByRole("button", { name: "保存设备设置", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Renamed NAS", exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([
    {
      method: "PUT",
      body: { name: "Renamed NAS", expected_name: "Owned NAS" },
    },
  ]);
  expect(app.errors).toEqual([]);
});

test("quota editing, explicit FFmpeg consent and reset preserve their separate decisions", async ({
  page,
}, info) => {
  const app = await appFixture(page);
  let current = {
    id: "nas",
    name: "Owned NAS",
    enabled: false,
    revoked: false,
    revision: 0,
    healthy: true,
    slots: null as number | null,
    output_budget_bytes: null as number | null,
    running: 0,
    capabilities: ["h264_480p_hls_v1", "h264_2160p_hls_v1"],
  };
  const writes: any[] = [];
  await page.route("**/api/v1/agents/compute", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        nodes: [current],
        limits: {
          min_slots: 1,
          max_slots: 4,
          min_output_budget_bytes: 1048576,
          max_output_budget_bytes: 1073741824,
          total_output_budget_bytes: 536870912,
        },
      },
    }),
  );
  await page.route("**/api/v1/agents/nas/compute-policy", async (route) => {
    const body = route.request().postDataJSON();
    writes.push(body);
    current = { ...current, ...body, revision: current.revision + 1 };
    await route.fulfill({ json: current });
  });
  await page.goto("/admin/agents");
  await page.getByText("NAS 本地计算（需单独授权）", { exact: true }).click();
  await expect(page.getByText(/所有节点共享 512 MiB/)).toBeVisible();
  await page.getByRole("button", { name: "计算配额设置", exact: true }).click();
  let dialog = page.getByRole("dialog", {
    name: "NAS 计算配额设置",
    exact: true,
  });
  await dialog.getByLabel("并发任务槽").fill("2");
  await dialog.getByLabel("单任务产物上限（MiB）").fill("256");
  await expect(dialog).toContainText("当前 FFmpeg 计算授权保持关闭");
  await page.screenshot({
    path: info.outputPath("nas-quota-settings.png"),
    animations: "disabled",
    fullPage: false,
  });
  await dialog.getByRole("button", { name: "保存配额", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(writes).toEqual([
    {
      enabled: false,
      slots: 2,
      output_budget_bytes: 268435456,
      expected_revision: 0,
    },
  ]);
  await page
    .getByRole("button", { name: "允许固定配方计算", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "单独授权 FFmpeg 计算",
    exact: true,
  });
  await expect(dialog).toContainText("CPU、内存与磁盘");
  await expect(dialog).toContainText("256 MiB");
  expect(writes).toHaveLength(1);
  await dialog
    .getByRole("button", { name: "确认允许固定配方计算", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(writes[1]).toEqual({
    enabled: true,
    slots: 2,
    output_budget_bytes: 268435456,
    expected_revision: 1,
  });
  await page.getByRole("button", { name: "计算配额设置", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "NAS 计算配额设置", exact: true });
  await dialog
    .getByRole("button", { name: "重置计算配置…", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "重置计算配置", exact: true });
  await expect(dialog).toContainText("任务历史");
  expect(writes).toHaveLength(2);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "NAS 计算配额设置", exact: true });
  await expect(dialog.getByLabel("单任务产物上限（MiB）")).toHaveValue("256");
  await dialog
    .getByRole("button", { name: "重置计算配置…", exact: true })
    .click();
  await page
    .getByRole("button", { name: "确认重置计算配置", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(writes[2]).toEqual({
    enabled: false,
    slots: 1,
    output_budget_bytes: 67108864,
    expected_revision: 2,
  });
  expect(app.errors).toEqual([]);
});

test("browser Back closes quota editing without a mutation or a trapped overlay", async ({
  page,
  isMobile,
}) => {
  const app = await appFixture(page);
  let writes = 0;
  await page.route("**/api/v1/agents/compute", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        nodes: [
          {
            id: "nas",
            name: "Owned NAS",
            enabled: false,
            healthy: false,
            slots: 1,
            output_budget_bytes: 67108864,
            revision: 0,
            capabilities: [],
            running: 0,
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/agents/nas/compute-policy", (route) => {
    writes++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/rooms");
  if (isMobile)
    await page
      .getByRole("navigation", { name: "移动导航", exact: true })
      .getByRole("link", { name: "管理", exact: true })
      .click();
  await page.getByRole("link", { name: "NAS 设备", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/agents$/);
  await page.getByText("NAS 本地计算（需单独授权）", { exact: true }).click();
  await page.getByRole("button", { name: "计算配额设置", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "NAS 计算配额设置",
    exact: true,
  });
  await dialog.getByLabel("单任务产物上限（MiB）").fill("512");
  await page.goBack();
  await expect(page).toHaveURL(isMobile ? /\/admin\/sources$/ : /\/rooms$/);
  await expect(dialog).not.toBeVisible();
  expect(writes).toBe(0);
  await page.getByRole("link", { name: "NAS 设备", exact: true }).click();
  await page.getByText("NAS 本地计算（需单独授权）", { exact: true }).click();
  await page.getByRole("button", { name: "计算配额设置", exact: true }).click();
  await expect(dialog.getByLabel("单任务产物上限（MiB）")).toHaveValue("64");
  expect(writes).toBe(0);
  expect(app.errors).toEqual([]);
});
