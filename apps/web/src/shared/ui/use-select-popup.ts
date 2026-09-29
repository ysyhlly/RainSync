import { nextTick, onBeforeUnmount, ref, type Ref } from "vue";
let activeClose: (() => void) | undefined;
export function useSelectPopup(
  trigger: Ref<HTMLElement | undefined>,
  menu: Ref<HTMLElement | undefined>,
  changed: (open: boolean) => void,
) {
  const open = ref(false);
  function position() {
    const button = trigger.value,
      popup = menu.value;
    if (!button || !popup || !open.value) return;
    const rect = button.getBoundingClientRect(),
      viewport = window.visualViewport;
    const bottom =
        (viewport?.height ?? innerHeight) + (viewport?.offsetTop ?? 0),
      top = viewport?.offsetTop ?? 0;
    const below = bottom - rect.bottom - 8,
      above = rect.top - top - 8;
    const height = Math.min(300, Math.max(below, above)),
      width = Math.min(Math.max(rect.width, 180), innerWidth - 16);
    popup.style.maxHeight = `${height}px`;
    popup.style.width = `${width}px`;
    popup.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
    popup.style.top = `${below >= Math.min(220, height) ? rect.bottom + 4 : Math.max(top + 8, rect.top - Math.min(popup.scrollHeight, height) - 4)}px`;
  }
  function close() {
    if (!open.value) return;
    open.value = false;
    if (menu.value?.matches(":popover-open")) menu.value.hidePopover();
    if (activeClose === close) activeClose = undefined;
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("resize", position);
    document.removeEventListener("scroll", position, true);
    window.visualViewport?.removeEventListener("resize", position);
    window.visualViewport?.removeEventListener("scroll", position);
    changed(false);
  }
  function outside(event: PointerEvent) {
    const target = event.target as Node;
    if (!trigger.value?.contains(target) && !menu.value?.contains(target))
      close();
  }
  async function show() {
    activeClose?.();
    activeClose = close;
    open.value = true;
    changed(true);
    await nextTick();
    if (menu.value?.showPopover) menu.value.showPopover();
    position();
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
  }
  onBeforeUnmount(close);
  return { open, show, close, position };
}
