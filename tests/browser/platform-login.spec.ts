import { test, expect } from "@playwright/test";
import { appFixture, appBase } from "./fixtures/application";

const payload =
  "https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=synthetic-qr-capability-0123456789&from=";
function login(id: string, extra = {}) {
  const now = Date.now();
  return {
    id,
    provider: "bilibili",
    status: "pending",
    stage: "waiting",
    qr_payload: payload,
    server_time: now,
    expires_at: now + 180000,
    next_poll_at: now + 3000,
    ...extra,
  };
}

test("Bilibili creation cooldown disables retry, preserves its key and requires an explicit retry", async ({
  page,
}, info) => {
  const app = await appFixture(page);
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  const keys: string[] = [];
  await page.route("**/platform-accounts/bilibili/login", async (route) => {
    const id = route.request().postDataJSON().idempotency_key;
    keys.push(id);
    await route.fulfill(
      keys.length === 1
        ? {
            status: 429,
            json: {
              error: {
                code: "RATE_LIMITED",
                message: "private upstream response",
                retryable: true,
                retry_after_ms: 6500,
                request_id: "00000000-0000-4000-8000-000000000002",
              },
            },
          }
        : { json: login(id) },
    );
  });
  await page.goto(appBase + "/account/profile");
  await page.getByRole("button", { name: "扫码连接", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "连接 Bilibili 账号" });
  await dialog
    .getByLabel("我同意在此服务器保存自己的平台登录凭据", { exact: true })
    .check();
  await dialog.getByRole("button", { name: "生成登录二维码" }).click();
  const waiting = dialog.getByRole("button", { name: "等待 7 秒后重试" });
  await expect(waiting).toBeDisabled();
  await expect(
    dialog.getByText("登录请求过于频繁，请等待 7 秒后重试同一登录。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog).toContainText("00000000-0000-4000-8000-000000000002");
  await expect(dialog).not.toContainText("private upstream response");
  await page.screenshot({
    path: info.outputPath("qr-rate-limit-countdown.png"),
  });
  await page.clock.runFor(6000);
  await expect(
    dialog.getByRole("button", { name: "等待 1 秒后重试" }),
  ).toBeDisabled();
  expect(keys).toHaveLength(1);
  await page.clock.runFor(500);
  const retry = dialog.getByRole("button", {
    name: "重试同一登录",
    exact: true,
  });
  await expect(retry).toBeEnabled();
  expect(keys).toHaveLength(1);
  await retry.click();
  await expect(dialog.getByAltText("Bilibili 账号连接二维码")).toBeVisible();
  expect(keys).toEqual([keys[0], keys[0]]);
  await expect(dialog.getByAltText("Bilibili 账号连接二维码")).toHaveAttribute(
    "src",
    /^data:image\/png/,
  );
  expect(app.errors).toEqual([]);
});

test("Bilibili poll recovery preserves the QR, polls the same login and stops after closing", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  let id = "",
    starts = 0,
    polls = 0,
    cancels = 0;
  await page.route("**/platform-accounts/bilibili/login", async (route) => {
    starts++;
    id = route.request().postDataJSON().idempotency_key;
    await route.fulfill({ json: login(id) });
  });
  await page.route(
    "**/platform-accounts/bilibili/login/*/poll",
    async (route) => {
      expect(new URL(route.request().url()).pathname).toBe(
        `/api/v1/platform-accounts/bilibili/login/${id}/poll`,
      );
      polls++;
      await route.fulfill(
        polls === 1
          ? {
              status: 502,
              json: {
                error: {
                  code: "PLATFORM_LOGIN_UPSTREAM_FAILED",
                  retryable: true,
                },
              },
            }
          : { json: login(id, { qr_payload: null, stage: "scanned" }) },
      );
    },
  );
  await page.route("**/platform-accounts/bilibili/login/*", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    expect(new URL(route.request().url()).pathname).toBe(
      `/api/v1/platform-accounts/bilibili/login/${id}`,
    );
    cancels++;
    await route.fulfill({
      json: login(id, { status: "failed", qr_payload: null }),
    });
  });
  await page.goto(appBase + "/account/profile");
  await page.getByRole("button", { name: "扫码连接", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "连接 Bilibili 账号" });
  await dialog
    .getByLabel("我同意在此服务器保存自己的平台登录凭据", { exact: true })
    .check();
  await dialog.getByRole("button", { name: "生成登录二维码" }).click();
  const qr = dialog.getByAltText("Bilibili 账号连接二维码");
  await expect(qr).toBeVisible();
  const image = await qr.getAttribute("src");
  await page.clock.runFor(3000);
  await expect(
    dialog.getByRole("button", { name: "重试同一登录", exact: true }),
  ).toBeVisible();
  await expect(qr).toHaveAttribute("src", image!);
  await dialog
    .getByRole("button", { name: "重试同一登录", exact: true })
    .click();
  await expect(
    dialog.getByText("已扫码，请在 Bilibili 中确认", { exact: true }),
  ).toBeVisible();
  await expect(qr).toHaveAttribute("src", image!);
  expect(starts).toBe(1);
  expect(polls).toBe(2);
  await dialog.getByRole("button", { name: "停止并关闭" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => cancels).toBe(1);
  await page.clock.runFor(30000);
  expect(polls).toBe(2);
  expect(starts).toBe(1);
  expect(app.errors).toEqual([]);
});
