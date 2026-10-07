import { test, expect, type Page, type Locator } from "@playwright/test";
import { appFixture } from "./fixtures/application";

function navigation(page: Page, mobile: boolean) {
  return page.getByRole("navigation", {
    name: mobile ? "移动导航" : "主导航",
    exact: true,
  });
}

async function aligned(nav: Locator, label: string) {
  const link = nav.getByRole("link", { name: label, exact: true });
  await expect(link).toHaveAttribute("aria-current", "page");
  await expect
    .poll(async () => {
      const target = await link.boundingBox();
      const highlight = await nav
        .locator(".navigation-indicator")
        .boundingBox();
      return (
        !!target &&
        !!highlight &&
        ["x", "y", "width", "height"].every(
          (key) =>
            Math.abs(
              target[key as keyof typeof target] -
                highlight[key as keyof typeof highlight],
            ) < 0.2,
        )
      );
    })
    .toBe(true);
}

test("selection slides with a small rebound on both navigation layouts", async ({
  page,
  isMobile,
}) => {
  const app = await appFixture(page);
  await page.goto("/rooms");
  const nav = navigation(page, isMobile);
  await aligned(nav, "放映室");
  const label = isMobile ? "管理" : "NAS 设备";
  const target = await nav
    .getByRole("link", { name: label, exact: true })
    .boundingBox();
  expect(target).not.toBeNull();
  await nav.evaluate((el, mobile) => {
    const samples: number[] = [];
    (window as any).__navigationSamples = samples;
    const until = performance.now() + 1400;
    function sample() {
      const rect = el
        .querySelector(".navigation-indicator")
        ?.getBoundingClientRect();
      if (rect) samples.push(mobile ? rect.x : rect.y);
      if (performance.now() < until) requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }, isMobile);
  await nav.getByRole("link", { name: label, exact: true }).click();
  await expect(page).toHaveURL(isMobile ? /\/admin\/settings$/ : /\/admin\/agents$/);
  await expect(
    page.getByRole("heading", {
      name: isMobile ? "管理员设置" : label,
      exact: true,
    }),
  ).toBeVisible();
  const endpoint = isMobile ? target!.x : target!.y;
  await expect
    .poll(() =>
      page.evaluate(
        (end) =>
          (window as any).__navigationSamples.some(
            (v: number) => v > end + 0.2,
          ),
        endpoint,
      ),
    )
    .toBe(true);
  await aligned(nav, label);
  const samples = await page.evaluate(
    () => (window as any).__navigationSamples as number[],
  );
  expect(new Set(samples.map(Math.round)).size).toBeGreaterThan(5);
  expect(Math.max(...samples) - endpoint).toBeLessThan(12);
  await nav.getByRole("link", { name: "放映室", exact: true }).click();
  await nav.getByRole("link", { name: "媒体库", exact: true }).click();
  await aligned(nav, "媒体库");
  await page.goBack();
  await aligned(nav, "放映室");
  await expect(nav).toBeVisible();
  await expect(nav.locator(".navigation-indicator")).toHaveCount(1);
  expect(app.errors).toEqual([]);
});

test("selection follows detail routes, profile return and viewport changes", async ({
  page,
  isMobile,
}) => {
  await appFixture(page);
  await page.goto("/rooms/room");
  if (isMobile) await aligned(navigation(page, true), "放映室");
  else {
    // The room uses the approved horizontal header with an active underline.
    const room = navigation(page, false).getByRole("link", {
      name: "放映室",
      exact: true,
    });
    await expect(room).toHaveAttribute("aria-current", "page");
    await expect(room).toBeVisible();
    await expect(room).toHaveCSS("border-bottom-width", "2px");
    await expect(room).toHaveCSS("border-bottom-style", "solid");
    await expect(room).not.toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
  }
  await page.goto("/admin/users");
  await aligned(navigation(page, isMobile), isMobile ? "管理" : "账号与注册");
  for (const width of [390, 1200, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await aligned(
      navigation(page, width < 768),
      width < 768 ? "管理" : "账号与注册",
    );
    await expect(page.locator(".sidebar")).toBeVisible({
      visible: width >= 768,
    });
  }
  await page.setViewportSize({ width: 1200, height: 800 });
  await aligned(navigation(page, false), "账号与注册");
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "个人资料", exact: true })
    .click();
  await expect(
    navigation(page, false).locator(".navigation-indicator"),
  ).toHaveCount(0);
  await page.goBack();
  await aligned(navigation(page, false), "账号与注册");
  const expanded = await page.locator(".sidebar").boundingBox();
  await page.mouse.move(900, 500);
  await expect(page.locator(".sidebar")).toBeVisible();
  expect(await page.locator(".sidebar").boundingBox()).toEqual(expanded);
  await expect(
    navigation(page, false).getByRole("link", {
      name: "账号与注册",
      exact: true,
    }),
  ).toBeInViewport();
});

test("desktop has two circulating gradient beams while mobile has no glow", async ({
  page,
  isMobile,
}, info) => {
  await appFixture(page);
  await page.goto("/rooms");
  const nav = navigation(page, isMobile);
  await aligned(nav, "放映室");
  const glow = nav.locator(".navigation-glow");
  if (isMobile) {
    await expect(glow).toHaveCount(0);
    return;
  }
  await expect(glow).toHaveAttribute("aria-hidden", "true");
  const head = glow.locator(".navigation-beam").last();
  await expect(head).toHaveAttribute("pathLength", "100");
  const initial = await head.evaluate(
    (el) => getComputedStyle(el).strokeDashoffset,
  );
  await expect
    .poll(() => head.evaluate((el) => getComputedStyle(el).strokeDashoffset))
    .not.toBe(initial);
  // Compare rendered pixels, not just an animation's computed property.
  const frames: Buffer[] = [];
  for (const time of [0, 1250, 2500]) {
    await glow.evaluate((el, at) => {
      for (const animation of el.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = at;
      }
    }, time);
    const frame = await nav.locator(".navigation-indicator").screenshot({
      animations: "allow",
      path: info.outputPath(`gradient-${time}ms.png`),
    });
    frames.push(frame);
    await info.attach(`gradient-${time}ms`, {
      body: frame,
      contentType: "image/png",
    });
  }
  expect(frames[0].equals(frames[1])).toBe(false);
  // The two opposite beams make a half turn visually identical.
  expect(frames[0].equals(frames[2])).toBe(true);
  // Equal elapsed times must advance equal arc lengths, including the corners.
  const offsets: number[] = [];
  for (let time = 0; time <= 5000; time += 250) {
    await head.evaluate((el, at) => {
      for (const animation of el.getAnimations()) {
        animation.pause();
        animation.currentTime = at;
      }
    }, time);
    offsets.push(
      await head.evaluate((el) =>
        parseFloat(getComputedStyle(el).strokeDashoffset),
      ),
    );
  }
  for (let i = 1; i < offsets.length - 1; i++) {
    expect(offsets[i - 1] - offsets[i]).toBeCloseTo(5, 2);
  }
  expect(offsets.at(-1)).toBeCloseTo(offsets[0], 2);
  await glow.evaluate((el) =>
    el
      .getAnimations({ subtree: true })
      .forEach((animation) => animation.play()),
  );
  await nav.getByRole("link", { name: "媒体库", exact: true }).focus();
  await page.keyboard.press("Enter");
  await aligned(nav, "媒体库");
  await expect(
    nav.getByRole("link", { name: "媒体库", exact: true }),
  ).toBeFocused();
  expect(await glow.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe(
    "none",
  );
});

test("reduced motion stops ongoing motion and preserves ordinary-account navigation", async ({
  page,
  isMobile,
}) => {
  await appFixture(page, { admin: false });
  await page.goto("/rooms");
  const nav = navigation(page, isMobile);
  await aligned(nav, "放映室");
  await nav.getByRole("link", { name: "媒体库", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await aligned(nav, "媒体库");
  await expect(
    page.getByRole("link", { name: "NAS 设备", exact: true }),
  ).toHaveCount(0);
  await expect(
    nav.getByRole("link", { name: "管理", exact: true }),
  ).toHaveCount(0);
  const positions = await nav
    .locator(".navigation-indicator")
    .evaluate(async (el) => {
      const values: string[] = [];
      for (let i = 0; i < 10; i++) {
        await new Promise(requestAnimationFrame);
        values.push(getComputedStyle(el).transform);
      }
      return values;
    });
  expect(new Set(positions).size).toBe(1);
  if (!isMobile) {
    expect(
      await nav
        .locator(".navigation-beam")
        .evaluateAll((els) =>
          els.every((el) => getComputedStyle(el).animationName === "none"),
        ),
    ).toBe(true);
  }
  await nav.getByRole("link", { name: "放映室", exact: true }).click();
  await aligned(nav, "放映室");
});
