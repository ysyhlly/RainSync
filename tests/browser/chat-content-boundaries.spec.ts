import { expect, test, type Page, type Route } from "@playwright/test";
import { appFixture } from "./fixtures/application";
import type { TimelineComment } from "../../apps/web/src/features/rooms/timeline-chat";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const currentId = uuid(1),
  historyId = uuid(2),
  secondHistoryId = uuid(3);
const timelineMessage = (
  index: number,
  activity = currentId,
): TimelineComment => ({
  id: uuid(100 + index),
  user_id: uuid(10),
  activity_id: activity,
  username: "viewer",
  display_name: "时间轴测试成员",
  body: `时间轴记录 ${index}`,
  created_at: 1791244800000 + index,
  media_time_ms: 60000,
  anchor_source: "client_reported",
  deleted: false,
});

async function contentFixture(page: Page, count = 0) {
  const app = await appFixture(page);
  const deletedIds = new Set<string>();
  const ordinary = Array.from({ length: count }, (_, i) => ({
    id: `chat-${i}`,
    username: "viewer",
    display_name: "聊天测试成员",
    body: `普通聊天记录 ${i}`,
    created_at: 1791244800000 + i,
  }));
  await page.route("**/api/v1/rooms/room/messages**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.has("check_ids"))
      return route.fulfill({
        json: (params.get("check_ids") ?? "")
          .split(",")
          .filter((id) => deletedIds.has(id))
          .map((id) => ({ id, deleted: true })),
      });
    const after = params.get("after");
    const start = after ? ordinary.findIndex((m) => m.id === after) + 1 : 0;
    return route.fulfill({ json: ordinary.slice(start, start + 100) });
  });
  let activity = currentId,
    canModerate = false;
  const rows = new Map<string, TimelineComment[]>([
    [currentId, [timelineMessage(1)]],
    [historyId, [timelineMessage(2, historyId)]],
    [secondHistoryId, [timelineMessage(3, secondHistoryId)]],
  ]);
  const submissions: Record<string, unknown>[] = [];
  let post: (
    route: Route,
    body: Record<string, unknown>,
  ) => Promise<void> = async (route, body) =>
    route.fulfill({
      json: {
        message: {
          ...timelineMessage(9000, String(body.activity_id)),
          body: body.body,
          media_time_ms: body.media_time_ms ?? 0,
          anchor_source: body.anchor_source,
        },
      },
    });
  let currentReads = 0;
  await page.route("**/api/v1/rooms/room/timeline/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname.endsWith("/current")) {
      currentReads++;
      return route.fulfill({
        json: {
          activity: {
            id: activity,
            media_id: uuid(20),
            media_generation: app.state.media_generation,
            lifecycle_epoch: 1,
            versioned: true,
            duration_ms: 300000,
          },
          can_moderate: canModerate,
          can_assign_moderator: false,
        },
      });
    }
    if (url.pathname.endsWith("/activities"))
      return route.fulfill({
        json: {
          items: [activity, historyId, secondHistoryId].map((id, i) => ({
            id,
            media_id: uuid(20),
            media_generation: i + 1,
            lifecycle_epoch: 1,
            versioned: true,
            duration_ms: 300000,
          })),
        },
      });
    if (url.pathname.endsWith("/reactions"))
      return route.fulfill({ json: { items: [], server_now_ms: Date.now() } });
    if (url.pathname.endsWith("/moderation")) {
      const messageId = request.postDataJSON().message_id;
      deletedIds.add(messageId);
      for (const [id, items] of rows)
        rows.set(
          id,
          items.map((message) =>
            message.id === messageId
              ? { ...message, deleted: true, body: "" }
              : message,
          ),
        );
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      submissions.push(body);
      return post(route, body);
    }
    const selected = url.searchParams.get("activity_id")!,
      before = url.searchParams.get("before");
    const all = rows.get(selected) ?? [];
    const end = before ? all.findIndex((m) => m.id === before) : all.length;
    const start = Math.max(0, end - 100),
      items = all.slice(start, end);
    return route.fulfill({
      json: {
        items,
        next_before: start ? items[0].id : null,
        next_after: null,
      },
    });
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/rooms/room");
  await expect(page.getByLabel("聊天消息", { exact: true })).toBeEnabled();
  return {
    ...app,
    rows,
    deletedIds,
    submissions,
    setPost: (handler: typeof post) => {
      post = handler;
    },
    currentReads: () => currentReads,
    setActivity: (id: string) => {
      activity = id;
    },
    allowModeration: () => {
      canModerate = true;
    },
  };
}
const timeline = (page: Page) =>
  page.getByRole("region", { name: "时间轴评论", exact: true });
async function openTimeline(page: Page) {
  await page
    .getByRole("button", { name: "时间轴评论与表情", exact: true })
    .click();
  await expect(timeline(page).getByLabel("观影场次")).toHaveValue(currentId);
}
const sendChat = (
  app: Awaited<ReturnType<typeof contentFixture>>,
  index: number,
) =>
  app.socket()!.send(
    JSON.stringify({
      type: "CHAT",
      id: `chat-${index}`,
      username: "viewer",
      display_name: "聊天测试成员",
      body: `新增聊天 ${index}`,
    }),
  );

test("chat tail identity still prompts and follows at the 2000-message boundary", async ({
  page,
}) => {
  const app = await contentFixture(page, 1999),
    log = page.getByRole("log", { name: "聊天记录" });
  await expect(log.locator("article")).toHaveCount(1999);
  await log.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  sendChat(app, 1999);
  const unread = page.getByRole("button", { name: "有新消息" });
  await expect(unread).toBeVisible();
  await expect(log.locator("article")).toHaveCount(2000);
  await unread.click();
  await expect(unread).toBeHidden();
  await log.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  sendChat(app, 2000);
  await expect(unread).toBeVisible();
  await expect(log.locator("article")).toHaveCount(2000);
  expect(await log.evaluate((el) => el.scrollTop)).toBeLessThan(100);
  await unread.click();
  await expect(unread).toBeHidden();
  await log.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  sendChat(app, 2000);
  app.socket()!.send(JSON.stringify({ type: "CHAT_DELETED", id: "chat-2000" }));
  await expect(log.locator("article").last()).toContainText("消息已删除");
  await expect(unread).toBeHidden();
  await log.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
  sendChat(app, 2001);
  await expect(log.locator("article").last()).toContainText("新增聊天 2001");
  await expect
    .poll(() =>
      log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    )
    .toBeLessThan(48);
  await expect(unread).toBeHidden();
  expect(app.errors).toEqual([]);
});

test("historical spoiler cutoffs are explicit, activity-specific and independent of the playing film", async ({
  page,
}) => {
  const app = await contentFixture(page);
  await openTimeline(page);
  const panel = timeline(page),
    selection = panel.getByLabel("观影场次"),
    log = panel.locator(".timeline-log");
  await selection.selectOption(historyId);
  await expect(log).toContainText("请设置此历史场次的浏览截止");
  await expect(log.locator("article")).toHaveCount(0);
  await panel.getByLabel("历史浏览截止（秒）").fill("120");
  await expect(log).toContainText("时间轴记录 2");
  app.state.anchor_position_ms = 20000;
  app.state.revision++;
  app.socket()!.send(
    JSON.stringify({
      type: "EVENT",
      state: app.state,
      action: { type: "SEEK" },
    }),
  );
  await expect(log).toContainText("时间轴记录 2");
  await selection.selectOption(secondHistoryId);
  await expect(panel.getByLabel("历史浏览截止（秒）")).toHaveValue("");
  await expect(log.locator("article")).toHaveCount(0);
  await selection.selectOption(historyId);
  await expect(panel.getByLabel("历史浏览截止（秒）")).toHaveValue("120");
  await expect(log).toContainText("时间轴记录 2");
  await selection.selectOption(currentId);
  await expect(panel.getByLabel("历史浏览截止（秒）")).toHaveCount(0);
  await expect(log.locator("article")).toHaveCount(0);
  expect(app.commands).toEqual([]);
  expect(app.errors).toEqual([]);
});

test("older timeline pages remain reachable beyond 2000 while live polling leaves the reading window intact", async ({
  page,
}) => {
  const app = await contentFixture(page);
  const rows = Array.from({ length: 2101 }, (_, i) => timelineMessage(i));
  app.rows.set(currentId, rows);
  await openTimeline(page);
  const panel = timeline(page),
    log = panel.locator(".timeline-log");
  await panel.getByLabel("隐藏当前进度之后的评论").uncheck();
  await expect(log.locator("article")).toHaveCount(100);
  for (let i = 0; i < 21; i++) {
    await panel
      .getByRole("button", { name: "加载更早评论", exact: true })
      .click();
    await expect(log.locator("article").first()).toContainText(
      `时间轴记录 ${Math.max(0, 1901 - i * 100)}`,
    );
  }
  await expect(log.locator("article")).toHaveCount(2000);
  await expect(
    panel.getByRole("button", { name: "加载更早评论", exact: true }),
  ).toHaveCount(0);
  rows.push(timelineMessage(2101));
  await expect(panel.getByRole("status")).toContainText("有新评论", {
    timeout: 15000,
  });
  await expect(log.locator("article").first()).toContainText("时间轴记录 0");
  await expect(log).not.toContainText("时间轴记录 2101");
  await panel
    .getByRole("button", { name: "返回最新评论", exact: true })
    .click();
  await expect(log).toContainText("时间轴记录 2101");
  await expect(log.locator("article")).toHaveCount(100);
  await panel
    .getByRole("button", { name: "加载更早评论", exact: true })
    .click();
  await expect(log.locator("article")).toHaveCount(200);
  expect(app.errors).toEqual([]);
});

test("collapse keeps an unconfirmed submission immutable and retry uses its original id and position", async ({
  page,
}) => {
  const app = await contentFixture(page);
  app.setPost(async (route) =>
    route.fulfill({
      status: 504,
      json: { error: { code: "TIMEOUT", message: "结果未确认" } },
    }),
  );
  await openTimeline(page);
  const panel = timeline(page),
    input = panel.getByLabel("时间轴评论", { exact: true });
  await input.fill("未确认的时间轴草稿");
  await panel.getByRole("button", { name: "发送评论", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "用原编号重试", exact: true }),
  ).toBeVisible();
  const original = app.submissions[0];
  await panel
    .getByRole("button", { name: "收起时间轴评论", exact: true })
    .click();
  const reads = app.currentReads();
  app.state.anchor_position_ms = 20000;
  app.state.revision++;
  app.socket()!.send(
    JSON.stringify({
      type: "EVENT",
      state: app.state,
      action: { type: "SEEK" },
    }),
  );
  await page.waitForTimeout(3200);
  expect(app.currentReads()).toBe(reads);
  await openTimeline(page);
  await expect(input).toHaveValue("未确认的时间轴草稿");
  await expect(input).toBeDisabled();
  expect(app.submissions).toHaveLength(1);
  await panel
    .getByRole("button", { name: "用原编号重试", exact: true })
    .click();
  await expect.poll(() => app.submissions.length).toBe(2);
  expect(app.submissions[1]).toEqual(original);
  await panel
    .getByRole("button", { name: "放弃未确认消息", exact: true })
    .click();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("未确认的时间轴草稿");
  expect(app.errors).toEqual([]);
});

test("an in-flight confirmation is still consumed while the timeline is collapsed", async ({
  page,
}) => {
  const app = await contentFixture(page);
  let complete!: () => Promise<void>;
  app.setPost(async (route, body) => {
    await new Promise<void>((resolve) => {
      complete = async () => {
        await route.fulfill({
          json: {
            message: {
              ...timelineMessage(8000),
              body: body.body,
              media_time_ms: body.media_time_ms,
            },
          },
        });
        resolve();
      };
    });
  });
  await openTimeline(page);
  const panel = timeline(page),
    input = panel.getByLabel("时间轴评论", { exact: true });
  await input.fill("等待中的评论");
  await panel.getByRole("button", { name: "发送评论", exact: true }).click();
  await expect.poll(() => app.submissions.length).toBe(1);
  await panel
    .getByRole("button", { name: "收起时间轴评论", exact: true })
    .click();
  await complete();
  await openTimeline(page);
  await expect(input).toHaveValue("");
  await expect(
    panel.getByRole("button", { name: "用原编号重试", exact: true }),
  ).toHaveCount(0);
  expect(app.submissions).toHaveLength(1);
  expect(app.errors).toEqual([]);
});

test("a changed media activity discards old pending identity and draft", async ({
  page,
}) => {
  const app = await contentFixture(page);
  app.setPost(async (route) =>
    route.fulfill({
      status: 504,
      json: { error: { code: "TIMEOUT", message: "结果未确认" } },
    }),
  );
  await openTimeline(page);
  const panel = timeline(page),
    input = panel.getByLabel("时间轴评论", { exact: true });
  await input.fill("旧场次草稿");
  await panel.getByRole("button", { name: "发送评论", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "用原编号重试", exact: true }),
  ).toBeVisible();
  app.setActivity(uuid(4));
  app.state.media_generation++;
  app.state.revision++;
  app.socket()!.send(
    JSON.stringify({
      type: "EVENT",
      state: app.state,
      action: { type: "SELECT" },
    }),
  );
  await expect(panel.getByLabel("观影场次")).toHaveValue(uuid(4));
  await expect(input).toHaveValue("");
  await expect(input).toBeEnabled();
  await input.fill("新场次草稿");
  await panel.getByRole("button", { name: "发送评论", exact: true }).click();
  await expect.poll(() => app.submissions.length).toBe(2);
  expect(app.submissions[1].client_message_id).not.toBe(
    app.submissions[0].client_message_id,
  );
  expect(app.submissions[1].activity_id).toBe(uuid(4));
  expect(app.errors).toEqual([]);
});

test("reopening after a collapsed reconnect revalidates deletions in retained older pages", async ({
  page,
}) => {
  const app = await contentFixture(page);
  app.rows.set(
    currentId,
    Array.from({ length: 101 }, (_, i) => timelineMessage(i)),
  );
  await openTimeline(page);
  const panel = timeline(page),
    log = panel.locator(".timeline-log");
  await panel.getByLabel("隐藏当前进度之后的评论").uncheck();
  await panel
    .getByRole("button", { name: "加载更早评论", exact: true })
    .click();
  await expect(log.locator("article").first()).toContainText("时间轴记录 0");
  await panel
    .getByRole("button", { name: "收起时间轴评论", exact: true })
    .click();
  app.deletedIds.add(timelineMessage(0).id);
  await app.socket()!.close({ code: 1012, reason: "synthetic reconnect" });
  await expect
    .poll(() => app.connections(), { timeout: 15000 })
    .toBeGreaterThan(1);
  await expect(page.getByLabel("聊天消息", { exact: true })).toBeEnabled();
  await openTimeline(page);
  await expect(log.locator("article").first()).toContainText("消息已删除");
  await expect(log.locator("article").first()).not.toContainText(
    "时间轴记录 0",
  );
  expect(app.errors).toEqual([]);
});

test("successful moderation tombstones both windows before a failing latest refresh", async ({
  page,
}) => {
  const app = await contentFixture(page);
  app.allowModeration();
  app.rows.set(
    currentId,
    Array.from({ length: 101 }, (_, i) => timelineMessage(i)),
  );
  await page.route("**/api/v1/rooms/room/members", (route) =>
    route.fulfill({ json: [] }),
  );
  await openTimeline(page);
  const panel = timeline(page),
    log = panel.locator(".timeline-log");
  await panel.getByLabel("隐藏当前进度之后的评论").uncheck();
  await panel
    .getByRole("button", { name: "加载更早评论", exact: true })
    .click();
  await expect(log.locator("article")).toHaveCount(101);
  await panel.getByRole("button", { name: "管理聊天", exact: true }).click();
  await panel.getByLabel("管理原因").fill("测试已确认删除");
  const row = log
    .locator("article")
    .filter({ has: page.getByText("时间轴记录 100", { exact: true }) });
  await row.getByRole("button", { name: "删除", exact: true }).click();
  await expect(log.locator("article").last()).toContainText("消息已删除");
  // No CHAT_DELETED is sent. The local success receipt must update both caches.
  await page.route("**/api/v1/rooms/room/timeline/current", (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: "UNAVAILABLE", message: "刷新暂不可用" } },
    }),
  );
  await panel
    .getByRole("button", { name: "返回最新评论", exact: true })
    .click();
  await expect(log.locator("article")).toHaveCount(100);
  await expect(log.locator("article").last()).toContainText("消息已删除");
  await expect(log).not.toContainText("时间轴记录 100");
  await expect(panel.getByRole("alert")).toContainText("刷新暂不可用");
  await expect(log.locator("article").last()).toContainText("消息已删除");
  expect(app.errors).toEqual([]);
});

test("a transient retained-history deletion check retries while the timeline stays open", async ({
  page,
}) => {
  const app = await contentFixture(page);
  app.rows.set(
    currentId,
    Array.from({ length: 101 }, (_, i) => timelineMessage(i)),
  );
  await openTimeline(page);
  const panel = timeline(page),
    log = panel.locator(".timeline-log");
  await panel.getByLabel("隐藏当前进度之后的评论").uncheck();
  await panel
    .getByRole("button", { name: "加载更早评论", exact: true })
    .click();
  await expect(log.locator("article").first()).toContainText("时间轴记录 0");
  await panel
    .getByRole("button", { name: "收起时间轴评论", exact: true })
    .click();
  await app.socket()!.close({ code: 1012, reason: "synthetic reconnect" });
  await expect
    .poll(() => app.connections(), { timeout: 15000 })
    .toBeGreaterThan(1);
  await expect(page.getByLabel("聊天消息", { exact: true })).toBeEnabled();
  let checks = 0,
    inFlight = 0,
    peak = 0;
  await page.route(
    "**/api/v1/rooms/room/messages?check_ids=**",
    async (route) => {
      checks++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Let refresh overlap the first check, proving the in-flight guard.
      if (checks === 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await route.fulfill({
          status: 503,
          json: { error: { code: "UNAVAILABLE", message: "删除核对暂不可用" } },
        });
      } else {
        await route.fulfill({
          json: [{ id: timelineMessage(0).id, deleted: true }],
        });
      }
      inFlight--;
    },
  );
  await openTimeline(page);
  await expect(panel.getByRole("alert")).toContainText("删除核对暂不可用");
  await expect(log.locator("article").first()).toContainText("消息已删除", {
    timeout: 15000,
  });
  expect(checks).toBeGreaterThan(1);
  expect(peak).toBe(1);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "收起时间轴评论", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(app.connections()).toBe(2);
  expect(app.errors).toEqual([]);
});

test("a stalled retained-history check times out and recovers on the polling cycle", async ({
  page,
}) => {
  test.setTimeout(60000);
  const app = await contentFixture(page);
  app.rows.set(
    currentId,
    Array.from({ length: 101 }, (_, i) => timelineMessage(i)),
  );
  await openTimeline(page);
  const panel = timeline(page),
    log = panel.locator(".timeline-log");
  await panel.getByLabel("隐藏当前进度之后的评论").uncheck();
  await panel
    .getByRole("button", { name: "加载更早评论", exact: true })
    .click();
  await expect(log.locator("article").first()).toContainText("时间轴记录 0");
  await panel
    .getByRole("button", { name: "收起时间轴评论", exact: true })
    .click();
  await app.socket()!.close({ code: 1012, reason: "synthetic reconnect" });
  await expect
    .poll(() => app.connections(), { timeout: 15000 })
    .toBeGreaterThan(1);
  await expect(page.getByLabel("聊天消息", { exact: true })).toBeEnabled();
  let checks = 0,
    aborted = 0;
  page.on("requestfailed", (request) => {
    if (request.url().includes("/messages?check_ids=")) aborted++;
  });
  await page.route(
    "**/api/v1/rooms/room/messages?check_ids=**",
    async (route) => {
      if (++checks === 1) return; // Intentionally leave the first request unanswered.
      await route.fulfill({
        json: [{ id: timelineMessage(0).id, deleted: true }],
      });
    },
  );
  await openTimeline(page);
  await expect.poll(() => checks).toBe(1);
  await expect(log.locator("article").first()).toContainText("消息已删除", {
    timeout: 40000,
  });
  expect(checks).toBeGreaterThan(1);
  expect(aborted).toBeGreaterThan(0);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(app.connections()).toBe(2);
  expect(app.errors).toEqual([]);
});

test("a recovered history check cannot dismiss a newer action error with identical text", async ({
  page,
}) => {
  const app = await contentFixture(page);
  const message = "同样的服务器错误";
  app.setPost(async (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: "UNAVAILABLE", message } },
    }),
  );
  app.rows.set(
    currentId,
    Array.from({ length: 101 }, (_, i) => timelineMessage(i)),
  );
  await openTimeline(page);
  const panel = timeline(page),
    log = panel.locator(".timeline-log");
  await panel.getByLabel("隐藏当前进度之后的评论").uncheck();
  await panel
    .getByRole("button", { name: "加载更早评论", exact: true })
    .click();
  await expect(log.locator("article").first()).toContainText("时间轴记录 0");
  await panel
    .getByRole("button", { name: "收起时间轴评论", exact: true })
    .click();
  await app.socket()!.close({ code: 1012, reason: "synthetic reconnect" });
  await expect
    .poll(() => app.connections(), { timeout: 15000 })
    .toBeGreaterThan(1);
  await expect(page.getByLabel("聊天消息", { exact: true })).toBeEnabled();
  let checks = 0,
    allowRecovery = false,
    releaseRecovery: (() => void) | undefined;
  await page.route(
    "**/api/v1/rooms/room/messages?check_ids=**",
    async (route) => {
      if (++checks === 1)
        return route.fulfill({
          status: 503,
          json: { error: { code: "UNAVAILABLE", message } },
        });
      // Recovery must happen after the newer action failure, even if the
      // refresh chain retries before the first alert has been painted.
      if (!allowRecovery)
        await new Promise<void>((resolve) => {
          releaseRecovery = resolve;
        });
      return route.fulfill({
        json: [{ id: timelineMessage(0).id, deleted: true }],
      });
    },
  );
  await openTimeline(page);
  await expect(panel.getByRole("alert")).toContainText(message);
  await panel.getByLabel("时间轴评论", { exact: true }).fill("此消息尚未确认");
  await panel.getByRole("button", { name: "发送评论", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "用原编号重试", exact: true }),
  ).toBeVisible();
  allowRecovery = true;
  releaseRecovery?.();
  await expect(log.locator("article").first()).toContainText("消息已删除", {
    timeout: 15000,
  });
  await expect(panel.getByRole("alert")).toContainText(message);
  expect(app.submissions).toHaveLength(1);
  expect(app.errors).toEqual([]);
});
