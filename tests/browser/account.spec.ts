import { test, expect, type Page } from "@playwright/test";
import { appFixture, appBase } from "./fixtures/application";
async function registration(page: Page) {
  const app = await appFixture(page, { loggedIn: false, admin: false });
  await page.route("**/auth/registration-invites/validate", (r) =>
    r.fulfill({
      json: {
        code_suffix: "ABCD",
        expires_at: Date.now() + 86400000,
        server_time: Date.now(),
      },
    }),
  );
  await page.goto(appBase + "/register");
  await page
    .getByLabel("注册邀请码", { exact: true })
    .fill("RS-SYNTHETIC-ABCD");
  await page.getByRole("button", { name: "验证并继续" }).click();
  await expect(page.getByLabel("登录账号", { exact: true })).toBeFocused();
  return app;
}
test("two-step registration preserves password spaces and auto logs in without joining a room", async ({
  page,
}) => {
  const app = await registration(page);
  let submitted: any,
    joined = 0;
  await page.route("**/rooms", (r) => r.fulfill({ json: [] }));
  page.on("request", (r) => {
    if (r.url().includes("/join")) joined++;
  });
  await page.route("**/auth/register", async (r) => {
    submitted = r.request().postDataJSON();
    app.signIn({
      username: submitted.username,
      display_name: submitted.display_name,
      admin: false,
    });
    await r.fulfill({
      status: 201,
      json: {
        ...app.identity,
        username: submitted.username,
        display_name: submitted.display_name,
        admin: false,
      },
    });
  });
  await page.getByLabel("登录账号", { exact: true }).fill("new.user");
  await page.getByLabel("昵称（可选）").fill("中文😀昵称");
  await page.getByLabel("密码", { exact: true }).fill("中文password");
  await page.getByLabel("确认密码", { exact: true }).fill("中文password");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.getByRole("alert")).toContainText("不支持中文");
  await expect(page.getByLabel("密码", { exact: true })).toBeFocused();
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(submitted).toBeUndefined();
  await page.getByLabel("密码", { exact: true }).fill(" pass 12");
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "false",
  );
  await page.getByLabel("确认密码", { exact: true }).fill(" pass 12");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(
    page.getByRole("heading", { name: "放映室", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("还没有加入放映室")).toBeVisible();
  expect(submitted.password).toBe(" pass 12");
  expect(submitted.username).toBe("new.user");
  expect(submitted.admin).toBeUndefined();
  expect(joined).toBe(0);
  expect(app.errors).toEqual([]);
});
test("unknown registration result confirms through login without a second registration POST", async ({
  page,
}) => {
  const app = await registration(page);
  let posts = 0;
  await page.route("**/auth/register", (r) => {
    posts++;
    return r.abort("connectionfailed");
  });
  await page.getByLabel("登录账号", { exact: true }).fill("owner");
  await page.getByLabel("密码", { exact: true }).fill(" pass 12");
  await page.getByLabel("确认密码", { exact: true }).fill(" pass 12");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.getByRole("alert")).toContainText("尚未确认");
  await page.getByRole("button", { name: "使用刚设置的账号登录确认" }).click();
  await expect(
    page.getByRole("heading", { name: "放映室", exact: true }),
  ).toBeVisible();
  expect(posts).toBe(1);
  expect(app.errors).toEqual([]);
});
async function sourceImage(page: Page, width = 1600, height = 900) {
  return Buffer.from(
    await page.evaluate(
      ({ width, height }) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#ff0000";
        ctx.fillRect(0, 0, width / 2, height);
        ctx.fillStyle = "#0000ff";
        ctx.fillRect(width / 2, 0, width / 2, height);
        return canvas.toDataURL("image/png").split(",")[1];
      },
      { width, height },
    ),
    "base64",
  );
}
test("profile saves nickname independently and exports square pixels from draggable landscape crop", async ({
  page,
}, info) => {
  const app = await appFixture(page);
  let profile = { ...app.identity },
    upload: Buffer | null = null;
  await page.route("**/users/me/profile", (r) => {
    if (r.request().method() === "PATCH") {
      profile.display_name = r.request().postDataJSON().display_name;
      profile.custom_display_name = profile.display_name;
      Object.assign(app.identity, profile);
    }
    return r.fulfill({ json: profile });
  });
  await page.route("**/users/me/avatar", (r) => {
    if (r.request().method() === "PUT") upload = r.request().postDataBuffer();
    profile.avatar_url = (
      r.request().method() === "PUT"
        ? "/api/v1/users/owner/avatar?v=version"
        : null
    ) as any;
    profile.avatar_version = r.request().headers()[
      "x-avatar-operation-id"
    ] as any;
    Object.assign(app.identity, profile);
    return r.fulfill({
      json: {
        avatar_url: profile.avatar_url,
        avatar_version: profile.avatar_version,
      },
    });
  });
  await page.route("**/users/owner/avatar?*", (r) =>
    r.fulfill({ contentType: "image/png", body: upload ?? Buffer.alloc(0) }),
  );
  await page.goto(appBase + "/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await page.evaluate(
    () => ((window as any).__originalVideo = document.querySelector("video")),
  );
  await page
    .getByRole("link", { name: "个人资料", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.getByLabel("登录账号")).toHaveValue("owner");
  await expect(page.getByLabel("登录账号")).toHaveAttribute("readonly", "");
  await page.getByLabel("昵称", { exact: true }).fill("尚未保存的昵称");
  await page.getByLabel("选择头像图片").setInputFiles({
    name: "wide.png",
    mimeType: "image/png",
    buffer: await sourceImage(page),
  });
  await expect(page.getByRole("dialog", { name: "调整头像" })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.getByLabel("缩放", { exact: true }).fill("2");
  const crop = page.getByLabel("头像取景区域，方向键移动取景");
  const box = (await crop.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  await crop.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await page.screenshot({ path: info.outputPath("crop-landscape.png") });
  await page.getByRole("button", { name: "保存头像", exact: true }).click();
  await expect(page.getByText("头像已保存", { exact: true })).toBeVisible();
  const saved = upload as unknown as Buffer;
  expect(saved.readUInt32BE(16)).toBe(512);
  expect(saved.readUInt32BE(20)).toBe(512);
  const pixel = await page.evaluate(
    async (bytes) => {
      const image = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: "image/png" }),
      );
      const c = document.createElement("canvas");
      c.width = 512;
      c.height = 512;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      image.close();
      return [...ctx.getImageData(256, 256, 1, 1).data];
    },
    [...saved],
  );
  expect(pixel[0]).toBeGreaterThan(240);
  expect(pixel[2]).toBeLessThan(15);
  await expect(page.getByLabel("昵称", { exact: true })).toHaveValue(
    "尚未保存的昵称",
  );
  expect(profile.display_name).toBe("放映用户");
  await page.getByRole("button", { name: "保存昵称" }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "保存昵称" }).click();
  await expect(page.getByText("昵称已保存", { exact: true })).toBeVisible();
  expect(profile.avatar_url).not.toBeNull();
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await page.getByRole("button", { name: "确认恢复默认" }).click();
  await expect(page.getByText("已恢复默认头像", { exact: true })).toBeVisible();
  expect(profile.display_name).toBe("尚未保存的昵称");
  expect(app.preparations()).toBe(1);
  expect(app.connections()).toBe(1);
  expect(
    await page.evaluate(
      () => (window as any).__originalVideo === document.querySelector("video"),
    ),
  ).toBe(true);
  expect(app.errors).toEqual([]);
});
test("cancel and invalid images send no avatar request; touch pinch changes independent crop zoom", async ({
  page,
}, info) => {
  const app = await appFixture(page);
  let uploads = 0;
  await page.route("**/users/me/profile", (r) =>
    r.fulfill({ json: app.identity }),
  );
  await page.route("**/users/me/avatar", (r) => {
    uploads++;
    return r.fulfill({
      status: 503,
      json: {
        error: { code: "AVATAR_PROCESSING_FAILED", message: "编码失败" },
      },
    });
  });
  await page.goto(appBase + "/account/profile");
  await page.getByLabel("选择头像图片").setInputFiles({
    name: "fake.png",
    mimeType: "image/png",
    buffer: Buffer.from("<svg/>"),
  });
  await expect(page.getByRole("alert")).toContainText("静态");
  expect(uploads).toBe(0);
  await page.getByLabel("选择头像图片").setInputFiles({
    name: "portrait.png",
    mimeType: "image/png",
    buffer: await sourceImage(page, 900, 1600),
  });
  await expect(page.getByRole("dialog")).toBeVisible();
  if (info.project.name === "mobile") {
    const box = (await page
      .getByLabel("头像取景区域，方向键移动取景")
      .boundingBox())!;
    const client = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: x - 25, y, id: 1 },
        { x: x + 25, y, id: 2 },
      ],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: x - 60, y, id: 1 },
        { x: x + 60, y, id: 2 },
      ],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(async () =>
        Number(await page.getByLabel("缩放", { exact: true }).inputValue()),
      )
      .toBeGreaterThan(1);
    await client.detach();
  }
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(uploads).toBe(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test("avatar failures retain the old version and a truncated committed response is confirmed without replay", async ({
  page,
}) => {
  const app = await appFixture(page);
  let profile = {
      ...app.identity,
      avatar_url: "/api/v1/users/owner/avatar?v=old",
      avatar_version: "old",
    },
    attempts = 0;
  const image = await sourceImage(page, 900, 1600);
  await page.route("**/users/me/profile", (r) => r.fulfill({ json: profile }));
  await page.route("**/users/owner/avatar?*", (r) =>
    r.fulfill({ contentType: "image/png", body: image }),
  );
  await page.route("**/users/me/avatar", async (r) => {
    attempts++;
    if (attempts === 1)
      return r.fulfill({
        status: 503,
        json: {
          error: {
            code: "AVATAR_PROCESSING_FAILED",
            message: "编码失败，请重试",
          },
        },
      });
    profile = {
      ...profile,
      avatar_version: r.request().headers()["x-avatar-operation-id"],
      avatar_url: "/api/v1/users/owner/avatar?v=new",
    };
    return r.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{truncated",
    });
  });
  await page.goto(appBase + "/account/profile");
  await page.getByLabel("选择头像图片").setInputFiles({
    name: "portrait.png",
    mimeType: "image/png",
    buffer: image,
  });
  await page.getByRole("button", { name: "保存头像", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "编码失败",
  );
  expect(profile.avatar_version).toBe("old");
  await expect(page.locator(".avatar-panel img")).toHaveAttribute(
    "src",
    /v=old/,
  );
  await page.getByRole("button", { name: "保存头像", exact: true }).click();
  await expect(page.getByText("头像已保存", { exact: true })).toBeVisible();
  expect(attempts).toBe(2);
  await expect(page.locator(".avatar-panel img")).toHaveAttribute(
    "src",
    /v=new/,
  );
  expect(app.errors).toEqual([]);
});
