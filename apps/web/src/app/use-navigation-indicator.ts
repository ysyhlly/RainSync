import { onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";

type Rect = { x: number; y: number; width: number; height: number };
const axes = ["x", "y", "width", "height"] as const;
const zeroVelocity = (): Rect => ({ x: 0, y: 0, width: 0, height: 0 });

/** One moving background per navigation; route changes never wait for motion. */
export function useNavigationIndicator(
  container: Ref<HTMLElement | null>,
  selected: Readonly<Ref<string | null>>,
) {
  const rect = ref<Rect | null>(null);
  const paused = ref(document.hidden);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let target: Rect | null = null;
  let velocity = zeroVelocity();
  let frame = 0;
  let previousTime = 0;
  let observer: ResizeObserver | undefined;

  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
    velocity = zeroVelocity();
  }

  function tick(time: number) {
    frame = 0;
    if (!rect.value || !target) return;
    const next = { ...rect.value };
    // Small integration steps keep the spring stable after dropped frames.
    const elapsed = previousTime
      ? Math.min((time - previousTime) / 1000, 0.032)
      : 1 / 60;
    previousTime = time;
    const steps = Math.ceil(elapsed / (1 / 120));
    const dt = elapsed / steps;
    for (let step = 0; step < steps; step++) {
      for (const axis of axes) {
        velocity[axis] +=
          (440 * (target[axis] - next[axis]) - 32 * velocity[axis]) * dt;
        next[axis] += velocity[axis] * dt;
      }
    }
    const settled = axes.every(
      (axis) =>
        Math.abs(next[axis] - target![axis]) < 0.05 &&
        Math.abs(velocity[axis]) < 0.5,
    );
    rect.value = settled ? { ...target } : next;
    if (settled) stop();
    else frame = requestAnimationFrame(tick);
  }

  function measure(animate: boolean) {
    const root = container.value;
    const active = root?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!root || !selected.value || !active || !root.getClientRects().length) {
      stop();
      target = null;
      rect.value = null;
      return;
    }
    const parentBox = root.getBoundingClientRect();
    const box = active.getBoundingClientRect();
    target = {
      x: box.left - parentBox.left - root.clientLeft + root.scrollLeft,
      y: box.top - parentBox.top - root.clientTop + root.scrollTop,
      width: box.width,
      height: box.height,
    };
    if (!animate || !rect.value || reducedMotion.matches || paused.value) {
      stop();
      rect.value = { ...target };
    } else if (!frame) {
      frame = requestAnimationFrame(tick);
    }
  }

  function reposition() {
    measure(false);
  }
  function visibility() {
    paused.value = document.hidden;
    reposition();
  }

  watch(selected, () => measure(true), { flush: "post" });
  onMounted(() => {
    observer = new ResizeObserver(reposition);
    if (container.value) {
      observer.observe(container.value);
      container.value
        .querySelectorAll("a")
        .forEach((link) => observer!.observe(link));
    }
    reducedMotion.addEventListener("change", reposition);
    window.addEventListener("resize", reposition);
    document.addEventListener("visibilitychange", visibility);
    reposition();
  });
  onBeforeUnmount(() => {
    stop();
    observer?.disconnect();
    reducedMotion.removeEventListener("change", reposition);
    window.removeEventListener("resize", reposition);
    document.removeEventListener("visibilitychange", visibility);
  });
  return { rect, paused };
}
