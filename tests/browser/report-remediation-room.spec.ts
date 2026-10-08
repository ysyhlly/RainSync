import {
  test,
  expect,
  type Page,
  type Route,
  type WebSocketRoute,
} from "@playwright/test";
import { appFixture } from "./fixtures/application";
import { widget, geometry, layoutKey } from "./fixtures/room-layout";

const longName = [..."昵称很长的窄屏成员测试".repeat(5)].slice(0, 50).join("");
async function roomFixture(page: Page, onlyOwner = false) {
  const app = await appFixture(page, { admin: false });
  const room = Object.assign(app.room, {
    lifecycle: "active",
    lifecycle_epoch: 1,
  });
  const people = [
    {
      id: "owner",
      username: "owner",
      display_name: longName,
      avatar_url: null,
    },
    ...(!onlyOwner
      ? [
          {
            id: "viewer",
            username: "viewer",
            display_name: "观看成员",
            avatar_url: null,
          },
        ]
      : []),
  ];
  app.identity.display_name = longName;
  const mutations: { path: string; method: string; body: unknown }[] = [];
  await page.route("**/api/v1/rooms/room/members", (route) =>
    route.fulfill({ json: people }),
  );
  await page.route("**/api/v1/rooms/room/permissions", (route) =>
    route.fulfill({
      json: { owner_id: "owner", self_permissions: [], members: [] },
    }),
  );
  await page.route(
    /\/api\/v1\/rooms\/room\/(?:permissions|members)\//,
    (route) => {
      mutations.push({
        path: new URL(route.request().url()).pathname,
        method: route.request().method(),
        body: route.request().postData(),
      });
      return route.fulfill({ json: { ok: true } });
    },
  );
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/v1/ws", (ws) => {
    socket = ws;
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.type === "RESUME")
        ws.send(
          JSON.stringify({
            type: "SNAPSHOT",
            state: app.state,
            control_epoch: {
              id: "control",
              expires_at_ms: Date.now() + 3600000,
            },
            presence_connection_id: "reported-connection",
            presence: {
              room_id: "room",
              presence_epoch: "report-presence",
              presence_seq: 1,
              members: [{ user_id: "owner", connection_count: 3 }],
            },
          }),
        );
      else if (frame.type === "CLOCK_SYNC")
        ws.send(
          JSON.stringify({
            type: "CLOCK_SYNC_REPLY",
            t1: frame.t1,
            t2: frame.t1,
            t3: frame.t1,
            clock_epoch: app.state.clock_epoch,
          }),
        );
      else if (frame.command_id) app.commands.push(frame);
    });
  });
  return {
    ...app,
    room,
    people,
    mutations,
    send: (value: unknown) => socket!.send(JSON.stringify(value)),
  };
}
async function enter(page: Page) {
  await page.goto("/rooms/room");
  await expect(page.getByTestId("room-layout-canvas")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "周末放映室", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".page-enter-active, .page-leave-active"),
  ).toHaveCount(0);
}
async function management(page: Page) {
  await page.getByRole("button", { name: "房间管理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "房间管理", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
test("H5: members includes the owner but owner permissions and removal stay read-only", async ({
  page,
}) => {
  const app = await roomFixture(page);
  await enter(page);
  await management(page);
  await page.getByRole("button", { name: "成员与权限", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "成员与权限", exact: true });
  const members = panel.getByRole("combobox", {
    name: "房间成员",
    exact: true,
  });
  await expect(members).toBeEnabled();
  await expect(members.locator("option[value=owner]")).toContainText("房主");
  await expect(members.locator("option[value=viewer]")).toContainText(
    "观看成员",
  );
  await members.selectOption("owner");
  await expect(panel).toContainText("房主拥有此房间的全部管理权限");
  for (const name of ["保存权限", "撤销权限", "移出选中成员"])
    await expect(panel.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  expect(app.mutations).toEqual([]);
  expect(app.errors).toEqual([]);
});
test("H5: a room with only its owner shows a clear empty state and retains that owner option", async ({
  page,
}) => {
  const app = await roomFixture(page, true);
  await enter(page);
  await management(page);
  await page.getByRole("button", { name: "成员与权限", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "成员与权限", exact: true });
  await expect(panel).toContainText("目前只有房主");
  await expect(
    panel
      .getByRole("combobox", { name: "房间成员", exact: true })
      .locator("option"),
  ).toHaveCount(2);
  expect(app.mutations).toEqual([]);
  expect(app.errors).toEqual([]);
});

async function cleanupFixture(page: Page) {
  const app = await roomFixture(page, true);
  Object.assign(app.room, { lifecycle: "closing", lifecycle_epoch: 2 });
  Object.assign(app.state, {
    media_id: null,
    media_generation: 0,
    revision: 8,
  });
  const cleanup = {
    attempts: 3,
    completed: false,
    phase: "waiting",
    blockers: ["playback_requests", "static_hls"],
    last_error: "lease waiting",
    elapsed_ms: 12345,
    next_attempt_at_ms: Date.now() + 3000,
    lease_active: false,
    retryable: true,
  };
  let reads = 0;
  await page.route("**/api/v1/rooms/room/lifecycle", (route) => {
    reads++;
    return route.fulfill({
      json: {
        lifecycle: app.room.lifecycle,
        lifecycle_epoch: app.room.lifecycle_epoch,
        owner_id: "owner",
        state: app.state,
        cleanup,
      },
    });
  });
  const panel = page.getByRole("region", { name: "房间关闭进度", exact: true });
  return { ...app, cleanup, panel, reads: () => reads };
}
test("H4: closing reports blockers, elapsed time and attempts, refreshes, and reaches the terminal state", async ({
  page,
}, info) => {
  const app = await cleanupFixture(page);
  await enter(page);
  await expect(app.panel).toContainText("已检查 3 次");
  await expect(app.panel).toContainText("已等待 12 秒");
  await expect(app.panel).toContainText("播放准备请求");
  await expect(app.panel).toContainText("视频分片与读取");
  expect(app.preparations()).toBe(0);
  const first = app.reads();
  app.cleanup.attempts = 4;
  await app.panel
    .getByRole("button", { name: "刷新进度", exact: true })
    .click();
  await expect(app.panel).toContainText("已检查 4 次");
  expect(app.reads()).toBeGreaterThan(first);
  await page.screenshot({
    path: info.outputPath("closing-progress-blockers.png"),
    fullPage: false,
  });
  Object.assign(app.cleanup, {
    completed: true,
    phase: "completed",
    blockers: [],
    last_error: null,
  });
  app.room.lifecycle = "closed";
  await app.panel
    .getByRole("button", { name: "刷新进度", exact: true })
    .click();
  await expect(app.panel).toHaveCount(0);
  await expect(page.locator(".room-permanent-status")).toContainText("已关闭");
  expect(app.errors).toEqual([]);
});
for (const scheduled of [true, false])
  test(`H4: retry forwards the current revision and reports scheduled=${scheduled} faithfully`, async ({
    page,
  }) => {
    const app = await cleanupFixture(page);
    app.cleanup.lease_active = !scheduled;
    const bodies: unknown[] = [];
    await page.route("**/api/v1/rooms/room/cleanup/retry", (route) => {
      bodies.push(route.request().postDataJSON());
      return route.fulfill({ json: { cleanup: { scheduled } } });
    });
    await enter(page);
    if (!scheduled)
      await expect(app.panel).toContainText("正在停止播放并释放媒体资源");
    await app.panel
      .getByRole("button", { name: "重新尝试清理", exact: true })
      .click();
    await expect(app.panel).toContainText(
      scheduled ? "已重新安排清理" : "清理任务仍在运行，已保留原任务",
    );
    expect(bodies).toEqual([{ expected_revision: 8 }]);
    if (!scheduled) await expect(app.panel).not.toContainText("已重新安排清理");
    await expect(
      app.panel.getByRole("button", { name: "重新尝试清理", exact: true }),
    ).toBeEnabled();
    expect(app.errors).toEqual([]);
  });
test("H4: a malformed retry receipt stays uncertain instead of claiming success", async ({
  page,
}) => {
  const app = await cleanupFixture(page);
  await page.route("**/api/v1/rooms/room/cleanup/retry", (route) =>
    route.fulfill({ json: { cleanup: {} } }),
  );
  await enter(page);
  await app.panel
    .getByRole("button", { name: "重新尝试清理", exact: true })
    .click();
  await expect(app.panel.getByRole("alert")).toContainText(
    "清理重试结果尚未确认",
  );
  await expect(app.panel).not.toContainText("已重新安排清理");
  await expect(
    app.panel.getByRole("button", { name: "重新尝试清理", exact: true }),
  ).toBeEnabled();
  expect(app.errors).toEqual([]);
});
test("H4: a held retry times out and restores a usable retry control", async ({
  page,
}) => {
  const app = await cleanupFixture(page);
  let pending: Route | undefined;
  await page.route("**/api/v1/rooms/room/cleanup/retry", (route) => {
    pending = route;
  });
  await enter(page);
  const retry = app.panel.getByRole("button", {
    name: "重新尝试清理",
    exact: true,
  });
  await retry.click();
  await expect.poll(() => !!pending).toBe(true);
  await expect(retry).toBeDisabled();
  await expect(retry).toBeEnabled({ timeout: 20000 });
  await expect(app.panel.getByRole("alert")).not.toHaveText("");
  await expect(app.panel).not.toContainText("已重新安排清理");
  expect(app.errors).toEqual([]);
});
test("H4: a late retry result cannot show an old success after logout", async ({
  page,
}) => {
  const app = await cleanupFixture(page);
  let pending: Route | undefined;
  await page.route("**/api/v1/rooms/room/cleanup/retry", (route) => {
    pending = route;
  });
  await enter(page);
  await app.panel
    .getByRole("button", { name: "重新尝试清理", exact: true })
    .click();
  await expect.poll(() => !!pending).toBe(true);
  await page
    .getByRole("button", { name: "退出登录", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "登录", exact: true }),
  ).toBeVisible();
  await pending!
    .fulfill({ json: { cleanup: { scheduled: true } } })
    .catch(() => {});
  await expect(page.locator("body")).not.toContainText("已重新安排清理");
  await expect(app.panel).toHaveCount(0);
  expect(app.errors).toEqual([]);
});
test("H4: a terminal GET recovers without a closed WebSocket event, retries one failed state refresh, and reopens with the new revision", async ({
  page,
}) => {
  const app = await cleanupFixture(page);
  let terminal = false,
    terminalReads = 0;
  const reopenBodies: unknown[] = [];
  await page.route("**/api/v1/rooms/room/lifecycle", (route) => {
    if (terminal && ++terminalReads === 2)
      return route.fulfill({
        status: 503,
        json: {
          error: { code: "SERVICE_UNAVAILABLE", message: "终态同步暂时失败" },
        },
      });
    return route.fulfill({
      json: {
        lifecycle: terminal ? "closed" : "closing",
        lifecycle_epoch: 2,
        owner_id: "owner",
        state: { ...app.state, revision: terminal ? 9 : 8 },
        cleanup: {
          ...app.cleanup,
          completed: terminal,
          phase: terminal ? "completed" : "waiting",
          retryable: !terminal,
          blockers: terminal ? [] : app.cleanup.blockers,
        },
      },
    });
  });
  await page.route("**/api/v1/rooms/room/reopen", (route) => {
    reopenBodies.push(route.request().postDataJSON());
    Object.assign(app.room, { lifecycle: "active", lifecycle_epoch: 3 });
    app.state.revision = 10;
    return route.fulfill({
      json: {
        lifecycle: "active",
        lifecycle_epoch: 3,
        owner_id: "owner",
        state: app.state,
        event_id: "44444444-4444-4444-8444-444444444444",
      },
    });
  });
  await enter(page);
  await expect(app.panel).toContainText("已检查 3 次");
  terminal = true;
  await app.panel
    .getByRole("button", { name: "刷新进度", exact: true })
    .click();
  await expect.poll(() => terminalReads).toBeGreaterThanOrEqual(2);
  await expect(app.panel).toBeVisible();
  await expect(page.locator(".room-permanent-status")).toContainText(
    "正在关闭",
  );
  // No server event or room-list mutation can supply the closed transition:
  // only the subsequent successful lifecycle GET may advance the client.
  await expect
    .poll(() => terminalReads, { timeout: 9000 })
    .toBeGreaterThanOrEqual(4);
  await expect(app.panel).toHaveCount(0);
  await expect(page.locator(".room-permanent-status")).toContainText("已关闭");
  await management(page);
  await page.getByRole("button", { name: "重新开放", exact: true }).click();
  await page
    .getByRole("button", { name: "确认重新开放房间", exact: true })
    .click();
  await expect.poll(() => reopenBodies.length).toBe(1);
  expect(reopenBodies).toEqual([{ expected_revision: 9 }]);
  await expect(
    page.getByRole("dialog", { name: "房间管理", exact: true }),
  ).toContainText("房间开放中");
  expect(app.errors).toEqual([]);
});

test("M4: a blank room name has a local Chinese field error and cannot create a room", async ({
  page,
}) => {
  const app = await roomFixture(page);
  const writes: unknown[] = [];
  await page.route("**/api/v1/rooms", (route) => {
    if (route.request().method() === "POST")
      writes.push(route.request().postDataJSON());
    return route.fallback();
  });
  await page.goto("/rooms");
  await page.getByRole("button", { name: "创建房间", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "创建房间", exact: true });
  await panel.getByRole("button", { name: "创建并进入", exact: true }).click();
  await expect(panel.locator("#room-name-error")).toHaveText("请输入房间名称");
  await expect(
    panel.getByRole("textbox", { name: "房间名称", exact: true }),
  ).toBeFocused();
  expect(writes).toEqual([]);
  expect(app.errors).toEqual([]);
});
for (const width of [560, 600, 630])
  test(`M5: ${width}px online members wrap long names and keep connection counts inside the card`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1100 });
    const app = await roomFixture(page, true);
    await enter(page);
    const panel = page.getByRole("region", {
      name: "房间在线情况",
      exact: true,
    });
    await expect(
      panel.getByText(`${longName}（你）`, { exact: true }),
    ).toBeVisible();
    await expect(panel.getByText("3 个连接", { exact: true })).toBeVisible();
    await expect(panel).toContainText("其他成员状态未知");
    const dimensions = await panel.locator("li").evaluate((element) => {
      const card = element
        .closest("[data-widget-type=members]")!
        .getBoundingClientRect();
      const name = element.querySelector<HTMLElement>(".presence-name")!,
        count = element.lastElementChild!.getBoundingClientRect();
      const nameBox = name.getBoundingClientRect();
      return {
        horizontal: name.scrollWidth <= name.clientWidth + 1,
        nameInside:
          nameBox.left >= card.left &&
          nameBox.right <= card.right &&
          nameBox.top >= card.top &&
          nameBox.bottom <= card.bottom,
        inlineCount: count.left >= nameBox.right,
        card: {
          left: card.left,
          right: card.right,
          top: card.top,
          bottom: card.bottom,
        },
        count: {
          left: count.left,
          right: count.right,
          top: count.top,
          bottom: count.bottom,
        },
        countInside:
          count.left >= card.left &&
          count.right <= card.right &&
          count.top >= card.top &&
          count.bottom <= card.bottom,
      };
    });
    await widget(page, "members").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`members-width-${width}.png`),
      fullPage: false,
    });
    expect(dimensions.horizontal, JSON.stringify(dimensions)).toBe(true);
    expect(dimensions.nameInside, JSON.stringify(dimensions)).toBe(true);
    expect(dimensions.inlineCount, JSON.stringify(dimensions)).toBe(true);
    expect(dimensions.countInside, JSON.stringify(dimensions)).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await widget(page, "members").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`members-width-${width}.png`),
      fullPage: false,
    });
    expect(app.errors).toEqual([]);
  });
test("L9: defaults give queue the player width and shorter members while saved custom geometry survives reload", async ({
  page,
}) => {
  const app = await roomFixture(page);
  await enter(page);
  expect((await geometry(widget(page, "player"))).w).toBe(18);
  expect((await geometry(widget(page, "queue"))).w).toBe(18);
  expect((await geometry(widget(page, "members"))).h).toBe(14);
  const playerBox = await widget(page, "player").boundingBox(),
    queueBox = await widget(page, "queue").boundingBox();
  expect(queueBox!.width).toBeCloseTo(playerBox!.width, 0);
  expect(queueBox!.x).toBeCloseTo(playerBox!.x, 0);
  await page.getByRole("button", { name: "编辑布局", exact: true }).click();
  await widget(page, "queue")
    .getByRole("button", { name: /^调整(?!.*位置和).*大小$/ })
    .focus();
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(async () => (await geometry(widget(page, "queue"))).w)
    .toBe(17);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  const customWidth = (await widget(page, "queue").boundingBox())!.width;
  expect(
    await page.evaluate((key) => !!localStorage.getItem(key), layoutKey()),
  ).toBe(true);
  await page.reload();
  await expect(widget(page, "queue")).toBeVisible();
  expect((await geometry(widget(page, "queue"))).w).toBe(17);
  expect((await widget(page, "queue").boundingBox())!.width).toBeCloseTo(
    customWidth,
    0,
  );
  expect(app.errors).toEqual([]);
});
test("L13: guest access shares drawer presentation and has its own accessible close name", async ({
  page,
}) => {
  const app = await roomFixture(page);
  await page.route("**/api/v1/rooms/room/guest-access", (route) =>
    route.fulfill({ json: { enabled: false, guests_enabled: true } }),
  );
  await enter(page);
  await management(page);
  await page.getByRole("button", { name: "游客访问", exact: true }).click();
  const guest = page.getByRole("dialog", { name: "游客访问", exact: true });
  await expect(guest).toHaveClass(/drawer/);
  await expect(
    guest.getByRole("button", { name: "关闭游客访问", exact: true }),
  ).toBeVisible();
  await guest
    .getByRole("button", { name: "关闭游客访问", exact: true })
    .click();
  await expect(guest).not.toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "房间管理", exact: true }),
  ).toBeVisible();
  expect(app.errors).toEqual([]);
});
test("L14: transfer shows loading immediately and replaces the management dialog", async ({
  page,
}, info) => {
  const app = await roomFixture(page, true);
  await enter(page);
  await management(page);
  let pending: Route | undefined;
  await page.route("**/api/v1/rooms/room/members", (route) => {
    pending = route;
  });
  await page.getByRole("button", { name: "转让房间", exact: true }).click();
  const transfer = page.getByRole("dialog", { name: "转让房间", exact: true });
  await expect(
    transfer.getByText("正在加载可接任的成员…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "房间管理", exact: true }),
  ).not.toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await expect.poll(() => !!pending).toBe(true);
  await pending!.fulfill({ json: app.people });
  await expect(transfer).toContainText("请先邀请其他成员加入房间");
  await expect(
    transfer.getByRole("button", { name: "确认转让", exact: true }),
  ).toBeDisabled();
  await expect(
    transfer.getByRole("button", { name: "关闭转让房间", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("transfer-empty-single-drawer.png"),
    fullPage: false,
  });
  expect(app.errors).toEqual([]);
});
for (const phase of ["failed", "preparing", "autoplay"] as const)
  test(`L15: ${phase} playback overlays disappear while editing the player widget`, async ({
    page,
  }) => {
    const app = await roomFixture(page);
    if (phase === "autoplay") {
      await page.addInitScript(() => {
        HTMLMediaElement.prototype.play = () => {
          (window as any).__fixturePlayCalls =
            ((window as any).__fixturePlayCalls ?? 0) + 1;
          return Promise.reject(
            new DOMException("fixture autoplay denied", "NotAllowedError"),
          );
        };
      });
    } else
      await page.route("**/api/v1/playback-sessions", (route) =>
        phase === "failed"
          ? route.fulfill({
              status: 503,
              json: {
                error: {
                  code: "SERVICE_UNAVAILABLE",
                  message: "fixture preparation failure",
                },
              },
            })
          : undefined,
      );
    await enter(page);
    if (phase === "autoplay") {
      await expect(page.locator("video")).toHaveJSProperty("readyState", 4);
      Object.assign(app.state, {
        playback_status: "playing",
        anchor_server_time_ms: Date.now(),
        revision: app.state.revision + 1,
      });
      app.send({ type: "EVENT", state: app.state, action: { type: "PLAY" } });
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).__fixturePlayCalls ?? 0),
        )
        .toBeGreaterThan(0);
    }
    const overlay = page.locator(
      phase === "autoplay"
        ? ".playback-host .autoplay"
        : `.preparation-overlay[data-phase='${phase}']`,
    );
    await expect(overlay).toBeVisible();
    await page.getByRole("button", { name: "编辑布局", exact: true }).click();
    await expect(page.locator(".playback-host")).toHaveAttribute("inert", "");
    await expect(
      page.locator(
        ".playback-host .preparation-overlay, .playback-host .autoplay, .playback-host .buffering",
      ),
    ).toHaveCount(0);
    await expect(
      widget(page, "player").getByRole("button", { name: /^移动/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(overlay).toBeVisible();
    expect(app.errors).toEqual([]);
  });

async function timelineFixture(page: Page) {
  const app = await roomFixture(page);
  const activity = () => ({
    id:
      app.state.media_generation === 1
        ? "11111111-1111-4111-8111-111111111111"
        : "22222222-2222-4222-8222-222222222222",
    media_id: "33333333-3333-4333-8333-333333333333",
    media_generation: app.state.media_generation,
    lifecycle_epoch: app.room.lifecycle_epoch,
    versioned: true,
    duration_ms: 30000,
  });
  let posted = false;
  const posts: unknown[] = [];
  await page.route("**/api/v1/rooms/room/timeline/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/current"))
      return route.fulfill({
        json: {
          activity: activity(),
          can_moderate: false,
          can_assign_moderator: false,
        },
      });
    if (url.pathname.endsWith("/activities"))
      return route.fulfill({ json: { items: [activity()] } });
    if (url.pathname.endsWith("/reactions")) {
      if (route.request().method() === "POST") {
        posts.push(route.request().postDataJSON());
        posted = true;
        return route.fulfill({ json: { ok: true } });
      }
      const now = Date.now();
      return route.fulfill({
        json: {
          items: posted
            ? [{ id: "reaction-one", emoji: "🎉", expires_at: now + 7000 }]
            : [],
          server_now_ms: now,
        },
      });
    }
    return route.fulfill({
      json: { items: [], next_before: null, next_after: null },
    });
  });
  return { ...app, posts };
}
async function timeline(page: Page) {
  await page
    .getByRole("button", { name: "时间轴评论与表情", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "时间轴评论", exact: true });
  await expect(
    panel.getByRole("button", { name: "发送表情 🎉", exact: true }),
  ).toBeEnabled();
  return panel;
}
test("L16: successful reactions visibly acknowledge sending and the panel can collapse", async ({
  page,
}) => {
  const app = await timelineFixture(page);
  await enter(page);
  const panel = await timeline(page);
  await panel.getByRole("button", { name: "发送表情 🎉", exact: true }).click();
  await expect(panel).toContainText("已发送 🎉");
  await expect(panel.locator(".recent-reactions")).toContainText("🎉");
  expect(app.posts).toHaveLength(1);
  await panel
    .getByRole("button", { name: "收起时间轴评论", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "发送表情 🎉", exact: true }),
  ).toHaveCount(0);
  expect(app.errors).toEqual([]);
});
test("L16: failed reactions show an error and never report sent", async ({
  page,
}) => {
  const app = await timelineFixture(page);
  await page.route("**/api/v1/rooms/room/timeline/reactions", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 503,
          json: {
            error: { code: "SERVICE_UNAVAILABLE", message: "表情发送失败" },
          },
        })
      : route.fallback(),
  );
  await enter(page);
  const panel = await timeline(page);
  await panel.getByRole("button", { name: "发送表情 🎉", exact: true }).click();
  await expect(panel.getByRole("alert")).not.toHaveText("");
  await expect(panel).not.toContainText("已发送 🎉");
  await expect(
    panel.getByRole("button", { name: "发送表情 🎉", exact: true }),
  ).toBeEnabled();
  expect(app.errors).toEqual([]);
});
test("L16: a late reaction acknowledgement cannot leak into a new media generation", async ({
  page,
}) => {
  const app = await timelineFixture(page);
  let pending: Route | undefined;
  await page.route("**/api/v1/rooms/room/timeline/reactions", (route) => {
    if (route.request().method() === "POST") pending = route;
    else return route.fallback();
  });
  await enter(page);
  const panel = await timeline(page);
  await panel.getByRole("button", { name: "发送表情 🎉", exact: true }).click();
  await expect.poll(() => !!pending).toBe(true);
  await expect(panel).toContainText("正在发送表情");
  Object.assign(app.state, {
    media_id: "movie-1",
    media_generation: 2,
    revision: app.state.revision + 1,
  });
  app.send({
    type: "EVENT",
    state: app.state,
    action: { type: "CHANGE_MEDIA" },
  });
  await expect(panel).not.toContainText("正在发送表情");
  await pending!.fulfill({ json: { ok: true } }).catch(() => {});
  await expect(panel).not.toContainText("已发送 🎉");
  await expect(
    panel.getByRole("button", { name: "发送表情 🎉", exact: true }),
  ).toBeEnabled();
  expect(app.errors).toEqual([]);
});
