import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";

test("in-room source picker preserves library navigation, playback, chat and browser history", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.goto("/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await page
    .getByRole("link", { name: "媒体库", exact: true })
    .filter({ visible: true })
    .click();
  await page
    .getByRole("button", { name: "打开片源 测试片源", exact: true })
    .click();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".media-card")).toHaveCount(6);
  await page.getByRole("link", { name: "返回房间", exact: true }).click();
  // The route transition mounts RoomPage after the persistent player has already
  // moved back; capture the chat only once the new room subtree is present.
  await expect(page.locator("#room-chat")).toBeVisible();
  const history = await page.evaluate(() => {
    (window as any).__pickerVideo = document.querySelector("video");
    (window as any).__pickerChat = document.querySelector("#room-chat");
    if (!(window as any).__pickerChat)
      throw Error("Room chat must be mounted before capture");
    return window.history.length;
  });
  const trigger = page.getByRole("button", { name: "选择影片", exact: true });
  await trigger.click();
  const picker = page.getByRole("dialog", { name: "选择影片", exact: true });
  await picker
    .getByRole("button", { name: "打开片源 测试片源", exact: true })
    .click();
  await expect(picker.locator(".picker-media-row")).toHaveCount(24);
  await picker.getByLabel("搜索影片", { exact: true }).fill("测试影片 29");
  await expect(picker.locator(".picker-media-row")).toHaveCount(1);
  await expect(page).toHaveURL(/\/rooms\/room$/);
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(
    await page.evaluate(() => ({
      history: window.history.length,
      video: (window as any).__pickerVideo === document.querySelector("video"),
      chat:
        (window as any).__pickerChat === document.querySelector("#room-chat"),
    })),
  ).toEqual({ history, video: true, chat: true });
  expect(app.connections()).toBe(1);
  expect(app.preparations()).toBe(1);
  expect(app.commands).toEqual([]);
  await page
    .getByRole("link", { name: "媒体库", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.locator(".media-card")).toHaveCount(6);
  await expect(page.getByLabel("搜索影片", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("navigation", { name: "媒体库目录" }),
  ).toContainText("测试片源");
  expect(app.errors).toEqual([]);
});

test("play stays in-room and does not mistake a socket send for confirmed playback", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.goto("/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await page.getByRole("button", { name: "选择影片", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "选择影片", exact: true });
  await picker
    .getByRole("button", { name: "打开片源 测试片源", exact: true })
    .click();
  const play = picker.getByRole("button", {
    name: "立即播放 测试影片 1",
    exact: true,
  });
  await play.click();
  await expect(play).toBeDisabled();
  await expect(picker.locator('[data-media-id="movie-1"]')).toContainText(
    "已发送播放请求，等待房间确认",
  );
  expect(
    app.commands.filter((frame) => frame.type === "CHANGE_MEDIA"),
  ).toHaveLength(1);
  await expect(page).toHaveURL(/\/rooms\/room$/);
  app.state.media_id = "movie-1";
  app.state.media_generation++;
  app.state.revision++;
  app.socket()!.send(
    JSON.stringify({
      type: "EVENT",
      state: app.state,
      action: { type: "CHANGE_MEDIA" },
    }),
  );
  await expect(picker).toBeHidden();
  await expect(
    page.getByRole("button", { name: "选择影片", exact: true }),
  ).toBeFocused();
  expect(app.errors).toEqual([]);
});

for (const permission of ["queue", "change_media"])
  test(`${permission}-only members receive only their granted media action`, async ({
    page,
  }) => {
    const app = await appFixture(page, { admin: false });
    app.room.owner_id = app.state.controller_user_id = "another-owner";
    await page.route("**/api/v1/rooms/room/permissions", (route) =>
      route.fulfill({
        json: {
          self_permissions: [permission],
          members: [{ user_id: "owner", expires_at: null }],
        },
      }),
    );
    await page.goto("/rooms/room");
    await page.getByRole("button", { name: "选择影片", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "选择影片", exact: true });
    await picker
      .getByRole("button", { name: "打开片源 测试片源", exact: true })
      .click();
    const action =
      permission === "queue" ? "加入待播 测试影片 1" : "立即播放 测试影片 1";
    const denied =
      permission === "queue" ? "立即播放 测试影片 1" : "加入待播 测试影片 1";
    await expect(
      picker.getByRole("button", { name: action, exact: true }),
    ).toBeEnabled();
    await expect(
      picker.getByRole("button", { name: denied, exact: true }),
    ).toHaveCount(0);
    expect(app.errors).toEqual([]);
  });
