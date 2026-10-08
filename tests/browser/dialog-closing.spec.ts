import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";

test("Escape followed immediately by Enter cannot submit a closing room dialog", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop keyboard dismissal regression");
  await appFixture(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const posts: unknown[] = [];
  await page.route("**/api/v1/rooms", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts.push(route.request().postDataJSON());
    await route.fulfill({
      status: 400,
      json: {
        error: { code: "FIXTURE_REJECTED", message: "Fixture create rejected" },
      },
    });
  });
  await page.goto("/rooms");
  const trigger = page.getByRole("button", { name: "创建房间", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "创建房间", exact: true });
  const name = dialog.getByLabel("房间名称", { exact: true });
  await name.fill("Should not create after Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(posts).toEqual([]);

  await trigger.click();
  await expect(dialog).not.toHaveAttribute("inert");
  await name.fill("Create after reopening");
  await name.press("Enter");
  await expect.poll(() => posts).toEqual([{ name: "Create after reopening" }]);
  await expect(dialog.getByRole("alert")).toContainText(
    "Fixture create rejected",
  );
});

test("a vetoed source dismissal stays interactive and allows a later valid submission", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop keyboard dismissal regression");
  await appFixture(page);
  const posts: unknown[] = [];
  await page.route("**/api/v1/sources", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts.push(route.request().postDataJSON());
    await route.fulfill({
      status: 400,
      json: {
        error: { code: "FIXTURE_REJECTED", message: "Fixture source rejected" },
      },
    });
  });
  await page.goto("/admin/sources");
  await page.getByRole("button", { name: "添加片源", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加片源", exact: true });
  const name = dialog.getByRole("textbox", { name: "名称", exact: true });
  await name.fill("Continue after veto");
  await page.keyboard.press("Escape");
  await expect(
    dialog.getByRole("group", { name: "放弃未保存内容" }),
  ).toBeVisible();
  await expect(dialog).not.toHaveAttribute("inert");
  await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
  await name.press("Enter");
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({
    name: "Continue after veto",
    kind: "local",
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "Fixture source rejected",
  );
});
