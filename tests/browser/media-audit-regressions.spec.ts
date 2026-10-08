import { test, expect } from "@playwright/test";
import { appFixture, openFixtureSource } from "./fixtures/application";

test("queue thumbnail image retry is reachable inside its compact bounds", async ({
  page,
  isMobile,
}) => {
  const app = await appFixture(page);
  const cover = {
    status: "ready",
    revision: "queue-v1",
    url: "/api/v1/media/movie/cover?revision=queue-v1",
    retry_after_ms: null,
  };
  app.media[0].cover = cover as any;
  await page.route("**/rooms/room/playlist", (route) =>
    route.fulfill({
      json: [{ id: "q", media_id: "movie", title: app.media[0].title, cover }],
    }),
  );
  let images = 0;
  await page.route("**/media/movie/cover?revision=queue-v1", (route) => {
    images++;
    return route.abort("failed");
  });
  await page.goto("/rooms/room");
  await expect(page.locator("#room-queue")).toBeVisible();
  const thumbnail = page.locator(".queue-row .media-thumbnail");
  const retry = thumbnail.getByRole("button", {
    name: "重新加载封面",
    exact: true,
  });
  await expect(retry).toBeVisible();
  // Compare the two rectangles in one browser task. Room/video startup can
  // move the entire queue between separate awaited locator measurements.
  const { outer, inner } = await thumbnail.evaluate((element) => {
    const button = element.querySelector('button[aria-label="重新加载封面"]');
    if (!(button instanceof HTMLButtonElement))
      return { outer: null, inner: null };
    const bounds = (node: Element) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    return { outer: bounds(element), inner: bounds(button) };
  });
  expect(outer).not.toBeNull();
  expect(inner).not.toBeNull();
  expect(inner!.height).toBeGreaterThanOrEqual(44);
  expect(inner!.y).toBeGreaterThanOrEqual(outer!.y);
  expect(inner!.y + inner!.height).toBeLessThanOrEqual(
    outer!.y + outer!.height,
  );
  expect(inner!.x).toBeGreaterThanOrEqual(outer!.x);
  expect(inner!.x + inner!.width).toBeLessThanOrEqual(outer!.x + outer!.width);
  const before = images;
  await retry.click();
  await expect.poll(() => images).toBe(before + 1);
});

for (const scope of ["personal", "shared"] as const) {
  test(`${scope} save superseded before response preserves draft and shows the concurrent value`, async ({
    page,
  }) => {
    const app = await appFixture(page);
    await page.goto("/library");
    await openFixtureSource(page);
    await page
      .getByRole("button", { name: "重命名 真实合成测试视频", exact: true })
      .click();
    const field = page.getByLabel(
      scope === "personal" ? "仅我看到的名称" : "所有人的默认名称",
    );
    await expect(field).toBeEnabled();
    await field.fill("my draft");
    await page.route(
      `**/movie/${scope}-title`,
      async (route) => {
        Object.assign(app.media[0], {
          [`${scope}_title`]: "newer than my save",
          [`${scope}_title_revision`]: "2",
          title: "newer than my save",
        });
        await route.fulfill({ json: app.media[0] });
      },
      { times: 1 },
    );
    const save = page.getByRole("button", {
      name: scope === "personal" ? "保存个人名称" : "保存全站名称",
      exact: true,
    });
    await save.click();
    await expect(page.getByText(/你的草稿已保留/)).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("newer than my save");
    await expect(field).toHaveValue("my draft");
    await expect(page.getByText("名称已保存", { exact: true })).toHaveCount(0);
    await save.click();
    await expect(page.getByText("名称已保存", { exact: true })).toBeVisible();
  });
  test(`${scope} draft keeps its version across focus refresh and explicit conflict retry`, async ({
    page,
  }) => {
    const app = await appFixture(page);
    Object.assign(app.media[0], {
      [`${scope}_title`]: "opened title",
      [`${scope}_title_revision`]: "1",
      title: "opened title",
    });
    await page.goto("/library");
    await openFixtureSource(page);
    await page
      .getByRole("button", { name: "重命名 opened title", exact: true })
      .click();
    const field = page.getByLabel(
      scope === "personal" ? "仅我看到的名称" : "所有人的默认名称",
    );
    const save = page.getByRole("button", {
      name: scope === "personal" ? "保存个人名称" : "保存全站名称",
      exact: true,
    });
    await expect(field).toHaveValue("opened title");
    await field.fill("retained draft");
    Object.assign(app.media[0], {
      [`${scope}_title`]: "concurrent title",
      [`${scope}_title_revision`]: "2",
      title: "concurrent title",
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator(".media-card h2").first()).toHaveText(
      "concurrent title",
    );
    const request = page.waitForRequest(
      (r) => r.url().endsWith(`/movie/${scope}-title`) && r.method() === "PUT",
    );
    await save.click();
    expect((await request).postDataJSON().expected_revision).toBe("1");
    await expect(page.getByText(/你的草稿已保留/)).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("concurrent title");
    await expect(field).toHaveValue("retained draft");
    expect(app.media[0][`${scope}_title`]).toBe("concurrent title");
    // A further background refresh must not silently advance the acknowledged version.
    Object.assign(app.media[0], {
      [`${scope}_title`]: "third title",
      [`${scope}_title_revision`]: "3",
      title: "third title",
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator(".media-card h2").first()).toHaveText(
      "third title",
    );
    const retry = page.waitForRequest(
      (r) => r.url().endsWith(`/movie/${scope}-title`) && r.method() === "PUT",
    );
    await save.click();
    expect((await retry).postDataJSON().expected_revision).toBe("2");
    await expect(page.getByRole("dialog")).toContainText("third title");
    await save.click();
    await expect(page.getByText("名称已保存", { exact: true })).toBeVisible();
    expect(app.media[0][`${scope}_title`]).toBe("retained draft");
  });
}

for (const recovery of ["focus", "manual"] as const) {
  test(`same revision image recovers by ${recovery} without generation or retry loops`, async ({
    page,
  }) => {
    const app = await appFixture(page);
    let images = 0;
    const generated: string[] = [];
    Object.assign(app.media[0], {
      cover: {
        status: "ready",
        revision: "v1",
        url: "/api/v1/media/movie/cover?revision=v1",
        retry_after_ms: null,
      },
    });
    page.on("request", (r) => {
      if (r.url().endsWith("/media/previews") && r.method() === "POST")
        generated.push(...r.postDataJSON().media_ids);
    });
    await page.route("**/media/movie/cover?revision=v1", async (route) => {
      images++;
      if (images <= 2) return route.abort("failed");
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="red"/></svg>',
      });
    });
    await page.goto("/library");
    await openFixtureSource(page);
    const card = page.locator(".media-card").first();
    await expect.poll(() => images).toBe(1);
    await expect(card.locator("img")).toHaveCount(0);
    await card
      .getByRole("button", { name: "重命名 真实合成测试视频", exact: true })
      .click();
    await expect(page.getByLabel("仅我看到的名称")).toBeEnabled();
    await page.getByRole("button", { name: "关闭弹窗" }).click();
    expect(images).toBe(1); // An unrelated detail/catalog refresh is not image retry intent.
    const recover = async () => {
      if (recovery === "manual")
        await card
          .getByRole("button", { name: "重新加载封面", exact: true })
          .click();
      else {
        const response = page.waitForResponse((r) =>
          /\/media\/browse\?/.test(r.url()),
        );
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await response;
      }
    };
    await recover();
    await expect.poll(() => images).toBe(2);
    await expect(card).toContainText("封面加载失败");
    await page.waitForTimeout(2300); // Cross the preview poll interval: failure must not create a loop.
    expect(images).toBe(2);
    await recover();
    await expect(card.locator("img")).toBeVisible();
    await expect
      .poll(() =>
        card
          .locator("img")
          .evaluate(
            (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
          ),
      )
      .toBe(true);
    expect(images).toBe(3);
    expect(generated).not.toContain("movie");
  });
}
