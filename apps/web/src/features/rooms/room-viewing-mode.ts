import { computed, ref } from "vue";

type FullscreenDocument = Pick<
  Document,
  | "documentElement"
  | "fullscreenElement"
  | "fullscreenEnabled"
  | "exitFullscreen"
  | "addEventListener"
  | "removeEventListener"
>;

/** Local presentation only: never writes layout, room state or media state. */
export function createRoomViewingMode(doc: FullscreenDocument) {
  const webpage = ref(false);
  const browser = ref(false);
  const chatVisible = ref(true);
  const pending = ref(false);
  const error = ref("");
  const expanded = computed(() => webpage.value || browser.value);
  const mode = computed(() =>
    browser.value ? "browser" : webpage.value ? "webpage" : "normal",
  );
  const target = doc.documentElement;
  let generation = 0;
  let disposed = false;
  let active = true;
  let wanted = false;
  let owned = false;
  let entering = false;
  let releasing: Promise<void> | undefined;

  // The root includes the persistent PlaybackHost and all body Teleports.
  // A nested video-only fullscreen does not transfer ownership of that root.
  async function release() {
    if (!owned || !doc.fullscreenElement) return;
    if (releasing) return releasing;
    releasing = (async () => {
      await doc.exitFullscreen();
      // Some browsers pop a nested player first, revealing our root again.
      if (doc.fullscreenElement === target) await doc.exitFullscreen();
    })();
    try {
      await releasing;
    } finally {
      releasing = undefined;
    }
  }

  function changed() {
    const current = doc.fullscreenElement;
    if (current === target && (wanted || pending.value)) owned = true;
    browser.value = !disposed && active && owned && current === target;
    if (!current) {
      owned = false;
      wanted = false;
    }
  }
  doc.addEventListener("fullscreenchange", changed);

  async function exitBrowser() {
    const serial = ++generation;
    wanted = false;
    error.value = "";
    pending.value = true;
    try {
      await release();
    } catch {
      if (!disposed && serial === generation)
        error.value = "未能退出浏览器全屏，请按 Esc 退出后重试。";
    } finally {
      if (!disposed && serial === generation) {
        pending.value = false;
        changed();
      }
    }
  }

  async function toggleBrowser() {
    if (disposed || pending.value || entering) return;
    if (browser.value) return exitBrowser();
    active = true;
    error.value = "";
    if (!doc.fullscreenEnabled || !target.requestFullscreen) {
      error.value = "此浏览器不支持浏览器全屏，可使用网页全屏。";
      return;
    }
    if (doc.fullscreenElement) {
      error.value = "请先退出仅视频全屏，再切换浏览器全屏。";
      return;
    }
    const serial = ++generation;
    entering = true;
    pending.value = true;
    wanted = true;
    try {
      // Called synchronously from the click handler: preserve user activation.
      await target.requestFullscreen();
      if (disposed || serial !== generation) {
        if (doc.fullscreenElement === target) owned = true;
        await release();
        return;
      }
      changed();
      if (!browser.value)
        error.value = "浏览器未进入全屏，请重试或使用网页全屏。";
    } catch {
      if (!disposed && serial === generation) {
        wanted = false;
        error.value = "无法进入浏览器全屏，请检查浏览器权限或使用网页全屏。";
      }
    } finally {
      entering = false;
      if (!disposed && serial === generation) {
        pending.value = false;
        changed();
      } else pending.value = false;
    }
  }

  async function toggleWebpage() {
    if (disposed || pending.value) return;
    active = true;
    error.value = "";
    if (browser.value) {
      webpage.value = true;
      await exitBrowser();
    } else webpage.value = !webpage.value;
  }

  function toggleChat() {
    if (expanded.value) chatVisible.value = !chatVisible.value;
  }

  // A pending native request cannot be cancelled. Invalidate its result and
  // release a late entry when its promise settles, even after route disposal.
  async function reset() {
    ++generation;
    active = false;
    wanted = false;
    webpage.value = false;
    browser.value = false;
    pending.value = entering;
    error.value = "";
    try {
      await release();
    } catch {
      // Presentation is already restored; the browser still owns Escape.
    }
  }

  function dispose() {
    disposed = true;
    doc.removeEventListener("fullscreenchange", changed);
    return reset();
  }

  return {
    webpage,
    browser,
    chatVisible,
    pending,
    error,
    expanded,
    mode,
    toggleWebpage,
    toggleBrowser,
    toggleChat,
    reset,
    dispose,
  };
}
