import { ref, readonly } from "vue";
/** UI state only: never sends playback commands or owns the media element. */
export function createPlayerChrome(touch = false) {
  const visible = ref(false),
    fullscreen = ref(false),
    hideCursor = ref(false);
  let inside = false,
    menu = false,
    drag = false,
    keyboard = false,
    hidden = false,
    disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const locked = () => menu || drag || keyboard;
  function clear() {
    clearTimeout(timer);
    timer = undefined;
  }
  function show(value: boolean) {
    visible.value = value;
    hideCursor.value = fullscreen.value && !value && !hidden;
  }
  function schedule() {
    clear();
    if (disposed || hidden || locked()) return;
    if (fullscreen.value || touch) {
      if (visible.value)
        timer = setTimeout(() => {
          timer = undefined;
          show(false);
        }, 5000);
    } else if (!inside) show(false);
  }
  function activity() {
    if (disposed) return;
    show(true);
    schedule();
  }
  function lock(kind: "menu" | "drag" | "keyboard", value: boolean) {
    if (kind === "menu") menu = value;
    if (kind === "drag") drag = value;
    if (kind === "keyboard") keyboard = value;
    if (value) show(true);
    schedule();
  }
  return {
    visible: readonly(visible),
    fullscreen: readonly(fullscreen),
    hideCursor: readonly(hideCursor),
    pointerEnter() {
      inside = true;
      if (!touch) activity();
    },
    pointerLeave() {
      inside = false;
      if (!touch) schedule();
    },
    activity,
    toggleFromSurface() {
      if (!touch && !fullscreen.value) return;
      if (locked()) return;
      show(!visible.value);
      schedule();
    },
    setMenuOpen: (v: boolean) => lock("menu", v),
    setDragging: (v: boolean) => lock("drag", v),
    setKeyboardFocus: (v: boolean) => lock("keyboard", v),
    setFullscreen(value: boolean) {
      fullscreen.value = value;
      hideCursor.value = false;
      show(value || inside || locked());
      schedule();
    },
    setPageHidden(value: boolean) {
      hidden = value;
      clear();
      hideCursor.value = false;
      if (!value) activity();
    },
    dispose() {
      disposed = true;
      clear();
      hideCursor.value = false;
    },
  };
}
