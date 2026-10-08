import { expect, type Locator, type Page } from "@playwright/test";
import { appFixture } from "./application";

export const widgetTypes = [
  "room-info",
  "player",
  "media-info",
  "chat",
  "queue",
  "members",
] as const;
export type WidgetType = (typeof widgetTypes)[number];
export const layoutKey = (user = "owner", breakpoint = "wide") =>
  `rainsync:room-layout:v1:${encodeURIComponent(user)}:${breakpoint}`;

/** Only synthetic local routes: no Rust service, database, or remote media. */
export async function roomLayoutFixture(
  page: Page,
  options: { empty?: boolean; history?: number; admin?: boolean } = {},
) {
  const app = await appFixture(page, { admin: options.admin });
  if (options.empty) app.state.media_id = null as unknown as string;
  const mediaRequests: string[] = [];
  const writes: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname === "/fixture-video.mp4") mediaRequests.push(request.url());
    if (pathname.startsWith("/api/v1/") && request.method() !== "GET")
      writes.push(`${request.method()} ${pathname}`);
  });
  const history = Array.from({ length: options.history ?? 0 }, (_, index) => ({
    id: `layout-message-${index}`,
    username: "fixture-viewer",
    display_name: "测试成员",
    body: `布局回归测试消息 ${index + 1}`,
    created_at: 1791244800000 + index * 60000,
  }));
  await page.route("**/api/v1/rooms/room/messages**", (route) =>
    route.fulfill({ json: history }),
  );
  await page.route("**/api/v1/rooms/room/members", (route) =>
    route.fulfill({
      json: [
        {
          id: "owner",
          username: "owner",
          display_name: "放映用户",
          avatar_url: null,
        },
      ],
    }),
  );
  return { ...app, mediaRequests, writes, history };
}
export type RoomLayoutFixture = Awaited<ReturnType<typeof roomLayoutFixture>>;

export const canvas = (page: Page) => page.getByTestId("room-layout-canvas");
export const widget = (page: Page, type: WidgetType) =>
  canvas(page).locator(`[data-widget-type="${type}"]`);
export const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });

export async function enterLayoutRoom(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto("/rooms/room");
  await expect(canvas(page)).toBeVisible();
  await expect(widget(page, "player")).toBeVisible();
  await expect(page.getByLabel("聊天消息", { exact: true })).toBeEnabled();
}

export async function geometry(frame: Locator) {
  return frame.evaluate((element) => ({
    x: Number(element.getAttribute("data-layout-x")),
    y: Number(element.getAttribute("data-layout-y")),
    w: Number(element.getAttribute("data-layout-w")),
    h: Number(element.getAttribute("data-layout-h")),
  }));
}

export async function visibleLayout(page: Page) {
  return canvas(page)
    .locator("[data-widget-type]")
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({
          type: element.getAttribute("data-widget-type"),
          x: Number(element.getAttribute("data-layout-x")),
          y: Number(element.getAttribute("data-layout-y")),
          w: Number(element.getAttribute("data-layout-w")),
          h: Number(element.getAttribute("data-layout-h")),
        }))
        .sort((a, b) => String(a.type).localeCompare(String(b.type))),
    );
}

export async function rememberPlayback(page: Page, app: RoomLayoutFixture) {
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((video: HTMLVideoElement) => video.readyState),
    )
    .toBeGreaterThanOrEqual(1);
  await page.evaluate(() => {
    const video = document.querySelector("video")!;
    (window as any).__roomLayoutPlayback = {
      video,
      src: video.currentSrc,
      loadStarts: 0,
    };
    video.addEventListener("loadstart", () => {
      (window as any).__roomLayoutPlayback.loadStarts++;
    });
  });
  return {
    preparations: app.preparations(),
    connections: app.connections(),
    requests: app.mediaRequests.length,
    commands: app.commands.length,
  };
}

export async function expectPlaybackUnchanged(
  page: Page,
  app: RoomLayoutFixture,
  before: Awaited<ReturnType<typeof rememberPlayback>>,
) {
  await expect(page.locator("video")).toHaveCount(1);
  expect(
    await page.evaluate(() => {
      const saved = (window as any).__roomLayoutPlayback;
      const current = document.querySelector("video");
      return {
        same: saved.video === current,
        connected: saved.video.isConnected,
        src: current?.currentSrc === saved.src,
        loads: saved.loadStarts,
      };
    }),
  ).toEqual({ same: true, connected: true, src: true, loads: 0 });
  expect(app.preparations()).toBe(before.preparations);
  expect(app.connections()).toBe(before.connections);
  expect(app.mediaRequests).toHaveLength(before.requests);
  expect(app.commands).toHaveLength(before.commands);
  expect(app.errors).toEqual([]);
}

export async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  expect(
    await canvas(page)
      .locator("button:visible, input:visible")
      .evaluateAll((elements) =>
        elements
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.left < -1 || rect.right > innerWidth + 1;
          })
          .map(
            (element) =>
              element.getAttribute("aria-label") || element.textContent,
          ),
      ),
  ).toEqual([]);
}

export async function expectReachable(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport();
  expect(
    await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return element === hit || element.contains(hit);
    }),
  ).toBe(true);
}

/** A real pointer sequence rather than directly mutating Vue/controller state. */
export async function dragBy(
  page: Page,
  handle: Locator,
  dx: number,
  dy: number,
) {
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const start = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 8 });
  await page.mouse.up();
}

/** Wait for Vue's page transform, then compare the actual rendered rectangles. */
export async function expectPlayerAligned(page: Page) {
  await expect(
    page.locator(".room-modular-page.page-enter-active"),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const anchor = document
          .querySelector(".room-player-anchor")
          ?.getBoundingClientRect();
        const host = document
          .querySelector(".playback-host.modular-player")
          ?.getBoundingClientRect();
        if (!anchor || !host) return Number.POSITIVE_INFINITY;
        return Math.max(
          Math.abs(anchor.left - host.left),
          Math.abs(anchor.top - host.top),
          Math.abs(anchor.width - host.width),
          Math.abs(anchor.height - host.height),
        );
      }),
    )
    .toBeLessThanOrEqual(1);
  const video = (await page.locator("video").boundingBox())!;
  expect(
    Math.abs(video.height - (video.width * 9) / 16),
    `Video rectangle must stay 16:9: ${JSON.stringify(video)}`,
  ).toBeLessThanOrEqual(1);
  await expect(page.locator("video")).toHaveCSS("object-fit", "contain");
}
