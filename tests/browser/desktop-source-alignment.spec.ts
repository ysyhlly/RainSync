import { expect, test } from "@playwright/test";
import { appFixture } from "./fixtures/application";

test("desktop source actions keep stable columns across source kinds", async ({
  page,
  isMobile,
}) => {
  test.skip(
    isMobile,
    "Desktop column alignment; narrow layouts retain their flow",
  );
  await appFixture(page);
  await page.route("**/api/v1/sources", (route) =>
    route.fulfill({
      json: [
        { id: "local", kind: "local", name: "家庭电影目录" },
        {
          id: "agent",
          kind: "agent",
          name: "Family_Media_NAS_Archive_2026_UHD_Remux_Complete_Collection",
        },
        { id: "http", kind: "http", name: "HTTP 纪录片" },
        { id: "managed", kind: "s3", name: "共享对象存储" },
      ],
    }),
  );
  await page.goto("/admin/sources");
  const scans = page.getByRole("button", {
    name: "检测并扫描",
    exact: true,
  });
  await expect(scans).toHaveCount(4);
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        scans.evaluateAll((buttons) => {
          const bounds = buttons.map((button) =>
            button.getBoundingClientRect(),
          );
          const left = bounds.map((rect) => rect.left);
          return Math.max(...left) - Math.min(...left);
        }),
      )
      .toBeLessThan(1);
    expect(
      await scans.evaluateAll((buttons) =>
        buttons.every((button) => button.getBoundingClientRect().height >= 44),
      ),
    ).toBe(true);
    await expect
      .poll(() =>
        page.locator(".admin-row").evaluateAll((rows) =>
          rows.every((row) => {
            const rect = row.getBoundingClientRect();
            return (
              row.scrollWidth <= row.clientWidth + 1 && rect.right <= innerWidth
            );
          }),
        ),
      )
      .toBe(true);
  }
  await expect(
    page.getByRole("link", { name: "管理 NAS 设备" }),
  ).toHaveAttribute("href", "/admin/agents");
  await expect(page.getByText("请在所属媒体库中管理")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "删除片源 家庭电影目录" }),
  ).toBeEnabled();
  await scans.first().focus();
  await expect(scans.first()).toBeFocused();
});
