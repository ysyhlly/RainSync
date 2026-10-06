import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";

const requestId = "00000000-0000-4000-8000-000000000123";

test("playback denial has one diagnostic and preserves room controls with unknown duration", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.route("**/api/v1/playback-sessions", (route) =>
    route.fulfill({
      status: 422,
      json: {
        error: {
          code: "NATIVE_PLATFORM_ACCESS_DENIED",
          message: "upstream private detail",
          retryable: false,
          request_id: requestId,
        },
      },
    }),
  );
  await page.goto("/rooms/room");
  const failure = page.locator('.preparation-overlay[data-phase="failed"]');
  await expect(failure).toContainText("平台拒绝访问此视频");
  await expect(failure).toContainText(requestId);
  await expect(
    failure.getByRole("link", { name: "检查平台账号" }),
  ).toBeVisible();
  await expect(page.locator(".global-notice")).toHaveCount(0);
  await page
    .locator(".video-frame")
    .dispatchEvent("pointermove", { pointerType: "mouse" });
  await expect(page.locator(".playback-time")).toContainText("时长未知");
  await expect(page.getByRole("slider", { name: "房间播放进度" })).toBeDisabled();
  await page
    .locator(".video-frame")
    .dispatchEvent("pointermove", { pointerType: "mouse" });
  const play = page.getByRole("button", { name: "开始房间播放" });
  await expect(play).toBeEnabled();
  await page.locator(".video-frame").hover();
  await play.click();
  await expect
    .poll(() => app.commands.some((command) => command.type === "PLAY"))
    .toBe(true);
});

test("the verified account QR remains visible when polling has an unknown result", async ({
  page,
}) => {
  await appFixture(page);
  await page.clock.install();
  await page.route("**/platform-accounts/bilibili", (route) =>
    route.fulfill({
      json: {
        id: null,
        provider: "bilibili",
        revision: null,
        state: "revoked",
      },
    }),
  );
  let starts = 0;
  await page.route("**/platform-accounts/bilibili/login", (route) => {
    starts++;
    const now = Date.now();
    return route.fulfill({
      json: {
        id: route.request().postDataJSON().idempotency_key,
        provider: "bilibili",
        status: "pending",
        stage: "waiting",
        qr_payload:
          "https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=synthetic-qr-capability-0123456789&from=",
        server_time: now,
        next_poll_at: now + 3000,
        expires_at: now + 180000,
      },
    });
  });
  await page.route("**/platform-accounts/bilibili/login/*/poll", (route) =>
    route.fulfill({
      status: 502,
      json: {
        error: {
          code: "PLATFORM_LOGIN_UPSTREAM_FAILED",
          retryable: true,
          request_id: requestId,
        },
      },
    }),
  );
  await page.goto("/account/profile");
  await page.getByRole("button", { name: "扫码连接", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "连接 Bilibili 账号" });
  await dialog
    .getByRole("checkbox", {
      name: "我同意在此服务器保存自己的平台登录凭据",
      exact: true,
    })
    .check();
  await dialog.getByRole("button", { name: "生成登录二维码" }).click();
  const qr = dialog.getByRole("img", { name: "Bilibili 账号连接二维码" });
  await expect(qr).toBeVisible();
  const src = await qr.getAttribute("src");
  await page.clock.runFor(3100);
  await expect(dialog).toContainText("登录结果尚未确认");
  await expect(dialog).toContainText(requestId);
  await expect(qr).toBeVisible();
  await expect(qr).toHaveAttribute("src", src!);
  expect(starts).toBe(1);
});

test("collapsing the mini player preserves the video and playback connection", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.goto("/rooms/room");
  await expect.poll(() => app.preparations()).toBe(1);
  await page.evaluate(() => {
    (window as any).__originalVideo = document.querySelector("video");
  });
  await page
    .getByRole("link", { name: "媒体库", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  const mini = page.locator(".mini-player");
  await page.getByRole("button", { name: "折叠播放器" }).click();
  await expect(mini).toHaveClass(/mini-collapsed/);
  await page.getByRole("button", { name: "展开播放器" }).click();
  expect(
    await page.evaluate(
      () => (window as any).__originalVideo === document.querySelector("video"),
    ),
  ).toBe(true);
  expect(app.preparations()).toBe(1);
  expect(app.connections()).toBe(1);
});

test("failed mini player collapses and reserves its measured height across viewports", async ({
  page,
}, testInfo) => {
  await appFixture(page);
  await page.route("**/api/v1/playback-sessions", (route) =>
    route.fulfill({
      status: 422,
      json: {
        error: {
          code: "NATIVE_PLATFORM_ACCESS_DENIED",
          retryable: false,
          request_id: requestId,
        },
      },
    }),
  );
  await page.goto("/rooms/room");
  await page.getByRole("link", { name: "选择其他影片" }).click();
  const mini = page.locator(".mini-player");
  await expect(mini).toHaveClass(/mini-collapsed/);
  await expect(mini).toContainText(requestId);
  await expect(page.locator(".global-notice")).toHaveCount(0);
  for (const width of [1180, 390]) {
    await page.setViewportSize({ width, height: 747 });
    for (const collapsed of [true, false]) {
      if (!collapsed)
        await page.getByRole("button", { name: "展开播放器" }).click();
      await expect
        .poll(async () => {
          const height = (await mini.boundingBox())!.height;
          const padding = await page
            .locator(".workspace")
            .evaluate((element) =>
              Number.parseFloat(getComputedStyle(element).paddingBottom),
            );
          return padding - height;
        })
        .toBeGreaterThanOrEqual(32);
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      const content = await page.locator(".media-grid").boundingBox();
      const player = await mini.boundingBox();
      expect(content!.y + content!.height).toBeLessThanOrEqual(player!.y);
      await page.screenshot({
        path: testInfo.outputPath(`mini-${width}-${collapsed}.png`),
      });
      if (!collapsed)
        await page.getByRole("button", { name: "折叠播放器" }).click();
    }
  }
});

test("QR generation failure shows a diagnostic and requires restarting the consent flow", async ({
  page,
}) => {
  await appFixture(page);
  await page.route("**/platform-accounts/bilibili", (route) =>
    route.fulfill({
      json: {
        id: null,
        provider: "bilibili",
        revision: null,
        state: "revoked",
      },
    }),
  );
  await page.route("**/platform-accounts/bilibili/login", (route) =>
    route.fulfill({
      status: 502,
      json: {
        error: {
          code: "PLATFORM_LOGIN_UPSTREAM_FAILED",
          retryable: true,
          request_id: requestId,
        },
      },
    }),
  );
  await page.goto("/account/profile");
  await page.getByRole("button", { name: "扫码连接", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "连接 Bilibili 账号" });
  await dialog
    .getByRole("checkbox", {
      name: "我同意在此服务器保存自己的平台登录凭据",
      exact: true,
    })
    .check();
  await dialog.getByRole("button", { name: "生成登录二维码" }).click();
  await expect(dialog).toContainText("本次平台登录已失败");
  await expect(dialog).toContainText("PLATFORM_LOGIN_UPSTREAM_FAILED");
  await expect(dialog).toContainText(requestId);
  await expect(
    dialog.getByRole("button", { name: "重试同一登录" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "关闭后重新确认登录" }),
  ).toBeVisible();
});

test("short zoomed viewport keeps the source title above the empty room mini player", async ({
  page,
}, testInfo) => {
  const app = await appFixture(page);
  Object.assign(app.state, { media_id: null, duration_ms: null });
  await page.setViewportSize({ width: 582, height: 378 });
  await page.goto("/rooms/room");
  await expect(page.locator(".player-empty")).toBeVisible();
  await page
    .getByRole("link", { name: "管理", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  const mini = page.locator(".mini-player");
  await expect(mini).toBeVisible();
  await expect(mini).toHaveClass(/mini-collapsed/);
  await page.evaluate(() => window.scrollTo(0, 0));
  const title = page.getByRole("heading", { name: "片源管理", exact: true });
  await expect(title).toBeVisible();
  const heading = (await title.boundingBox())!;
  const player = (await mini.boundingBox())!;
  expect(heading.y + heading.height).toBeLessThanOrEqual(player.y);
  const returnRoom = (await mini
    .getByRole("link", { name: "返回房间" })
    .boundingBox())!;
  expect(returnRoom.y).toBeGreaterThanOrEqual(player.y);
  expect(returnRoom.y + returnRoom.height).toBeLessThanOrEqual(
    player.y + player.height,
  );
  expect(
    await title.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      );
    }),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    582,
  );
  await page.screenshot({
    path: testInfo.outputPath("zoom-200-empty-room.png"),
  });
  expect(app.preparations()).toBe(0);
});

test("platform import failures show a safe reason, code, HTTP status and item diagnostic", async ({
  page,
}) => {
  await appFixture(page);
  const key = "a".repeat(64);
  await page.route("**/platform-media/preview", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            key,
            provider: "youtube",
            url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
            part: 1,
            title: "Big Buck Bunny",
          },
        ],
        failures: [],
        truncated: false,
        limit: 20,
      },
    }),
  );
  await page.route("**/platform-media/batch", (route) =>
    route.fulfill({
      json: {
        outcomes: [
          {
            key,
            error: {
              code: "native_platform_extractor_unavailable",
              retryable: false,
              attempted: true,
              status: 503,
              request_id: requestId,
              message: "private provider content",
            },
          },
        ],
        stopped: null,
      },
    }),
  );
  await page.goto("/rooms/room");
  const queueTab = page.getByRole("tab", { name: "待播", exact: true });
  if (await queueTab.isVisible()) await queueTab.click();
  await page
    .getByRole("textbox", { name: /平台视频链接|视频链接|链接或分享文本/ })
    .fill("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
  await page.getByRole("button", { name: "预览可导入条目" }).click();
  await page.getByRole("checkbox", { name: /Big Buck Bunny/ }).check();
  await page.getByRole("button", { name: /导入所选/ }).click();
  await expect(page.locator(".confirm-panel")).toContainText(
    "YouTube 提取器未启用",
  );
  await expect(page.locator(".confirm-panel")).toContainText(
    "NATIVE_PLATFORM_EXTRACTOR_UNAVAILABLE",
  );
  await expect(page.locator(".confirm-panel")).toContainText("HTTP 503");
  await expect(page.locator(".confirm-panel")).toContainText(requestId);
  await expect(page.locator(".confirm-panel")).not.toContainText(
    "private provider content",
  );
});
