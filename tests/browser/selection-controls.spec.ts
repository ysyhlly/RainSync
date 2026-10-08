import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";
test("custom source menu keeps the drawer open and Escape closes only the menu", async ({
  page,
}) => {
  await appFixture(page);
  await page.goto("/admin/sources");
  await page.getByRole("button", { name: "添加片源", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "添加片源" });
  const select = drawer.getByRole("combobox", { name: "类型", exact: true });
  await select.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page
    .getByRole("option", { name: "HTTP MP4 / HLS", exact: true })
    .click();
  await expect(drawer).toBeVisible();
  await expect(select).toContainText("HTTP MP4 / HLS");
  await select.click();
  await expect(
    page.getByRole("option", { selected: true }).locator("svg"),
  ).toBeVisible();
  await expect(page.getByRole("listbox")).toHaveCSS(
    "background-color",
    "rgb(252, 249, 242)",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(drawer).toBeVisible();
  await select.press("ArrowDown");
  await select.press("End");
  await select.press("Enter");
  await expect(select).toContainText("Emby");
  await select.press("Home");
  await select.press("Enter");
  await expect(select).toContainText("本地挂载目录");
  await select.press("Escape");
  await expect(drawer).toBeHidden();
});

const longMediaLabel =
  "RainSync_Desktop_Polish_Visual_Reference_Long_Media_Title_20261006_4K_UHD_HDR10_Remux.mkv";

async function pluginSelectFixture(page: import("@playwright/test").Page) {
  const fixture = await appFixture(page);
  fixture.media[0].title = longMediaLabel;
  await page.route("**/api/v1/admin/plugins", (route) =>
    route.fulfill({
      json: {
        catalog: [
          {
            id: "metadata.duration-badge",
            name: "时长标记",
            description: "测试时长插件",
            versions: [
              { version: "1.0.0", artifact_digest: "fixture-duration" },
            ],
          },
          {
            id: "metadata.viewer-note",
            name: "观看说明",
            description: "测试说明插件",
            versions: [{ version: "1.0.0", artifact_digest: "fixture-note" }],
          },
        ],
        installed: [],
      },
    }),
  );
  await page.goto("/admin/plugins");
  const select = page.getByRole("combobox", {
    name: "可访问的影片",
    exact: true,
  });
  await expect(select).toBeEnabled();
  return { select, fixture };
}

for (const width of [1280, 1440]) {
  test(`long media labels stay contained and accessible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { select, fixture } = await pluginSelectFixture(page);
    await select.click();
    const menu = page.getByRole("listbox", {
      name: "可访问的影片",
      exact: true,
    });
    const option = menu.getByRole("option", {
      name: longMediaLabel,
      exact: true,
    });
    await expect(option).toBeVisible();
    await expect(option).toHaveAttribute("title", longMediaLabel);
    await expect(menu).toHaveCSS("background-color", "rgb(252, 249, 242)");
    const optionGeometry = await option.evaluate((element) => {
      const label = element.querySelector(
        ".select-option-label",
      ) as HTMLElement;
      return {
        height: element.getBoundingClientRect().height,
        labelWidth: label.clientWidth,
        labelScrollWidth: label.scrollWidth,
        whiteSpace: getComputedStyle(label).whiteSpace,
        overflowWrap: getComputedStyle(label).overflowWrap,
      };
    });
    expect(optionGeometry.height).toBeGreaterThan(44);
    expect(optionGeometry.labelScrollWidth).toBeLessThanOrEqual(
      optionGeometry.labelWidth + 1,
    );
    expect(optionGeometry.whiteSpace).toBe("normal");
    expect(optionGeometry.overflowWrap).toBe("anywhere");
    expect(
      await menu.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await option.click();
    await expect(select).toHaveAttribute("title", longMediaLabel);
    await expect(select).toHaveAccessibleName("可访问的影片");
    await expect(select).toHaveAccessibleDescription(longMediaLabel);
    await expect(select).toBeFocused();
    const selectedGeometry = await select.evaluate((element) => {
      const label = element.querySelector(".select-value") as HTMLElement;
      const chevron = element.querySelector(".select-chevron")!;
      const triggerRect = element.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      const chevronRect = chevron.getBoundingClientRect();
      return {
        right: triggerRect.right,
        labelRight: labelRect.right,
        chevronLeft: chevronRect.left,
        chevronRight: chevronRect.right,
        labelWidth: label.clientWidth,
        labelScrollWidth: label.scrollWidth,
        textOverflow: getComputedStyle(label).textOverflow,
      };
    });
    expect(selectedGeometry.labelScrollWidth).toBeGreaterThan(
      selectedGeometry.labelWidth,
    );
    expect(selectedGeometry.textOverflow).toBe("ellipsis");
    expect(selectedGeometry.labelRight).toBeLessThanOrEqual(
      selectedGeometry.chevronLeft,
    );
    expect(selectedGeometry.chevronRight).toBeLessThanOrEqual(
      selectedGeometry.right,
    );
    await select.press("Enter");
    await expect(
      menu.getByRole("option", { name: longMediaLabel, selected: true }),
    ).toBeVisible();
    await select.press("Escape");
    await expect(menu).toBeHidden();
    await expect(select).toBeFocused();
    expect(fixture.errors).toEqual([]);
  });
}

test("same-task open and close never leaves a top-layer popup, and reopening still works", async ({
  page,
}) => {
  const { select, fixture } = await pluginSelectFixture(page);
  await select.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect(select).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("listbox")).toBeHidden();
  expect(await page.locator(":popover-open").count()).toBe(0);
  await select.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await select.press("Home");
  await select.press("ArrowDown");
  await select.press("Enter");
  await expect(select).toHaveAttribute("title", longMediaLabel);
  await expect(select).toBeFocused();
  await select.click();
  await page.getByRole("link", { name: "媒体库", exact: true }).click();
  await expect(page).toHaveURL(/\/library(?:\?|$)/);
  expect(await page.locator(":popover-open").count()).toBe(0);
  expect(fixture.errors).toEqual([]);
});
