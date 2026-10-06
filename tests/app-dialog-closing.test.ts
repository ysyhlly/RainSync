import { afterEach, expect, it, vi } from "vitest";
import { nextTick, reactive, useId } from "vue";
import { mountSetup } from "./helpers/mount-setup";

const dispose: (() => void)[] = [];
afterEach(async () => {
  for (const stop of dispose.splice(0)) stop();
  await nextTick();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function dialogFixture(
  options: {
    busy?: boolean;
    canClose?: () => boolean;
    reducedMotion?: boolean;
  } = {},
) {
  vi.useFakeTimers();
  const opener = { isConnected: true, disabled: false, focus: vi.fn() };
  const modals: { contains: (target: unknown) => boolean }[] = [];
  vi.stubGlobal("document", {
    activeElement: opener,
    querySelectorAll: () => modals,
  });
  vi.stubGlobal("matchMedia", () => ({ matches: !!options.reducedMotion }));
  const updated = vi.fn();
  const props = reactive({
    modelValue: true,
    title: "Closing fixture",
    busy: options.busy ?? false,
    canClose: options.canClose,
    "onUpdate:modelValue": updated,
  });
  const panel = mountSetup(
    new URL("../apps/web/src/shared/ui/AppDialog.vue", import.meta.url),
    { AppIcon: {}, useId },
    props,
  );
  const listeners = new Map<string, (event: unknown) => void>();
  const element = {
    open: false,
    addEventListener: vi.fn(
      (type: string, handler: (event: unknown) => void) => {
        listeners.set(type, handler);
      },
    ),
    removeEventListener: vi.fn((type: string) => {
      listeners.delete(type);
    }),
    showModal: vi.fn(() => {
      element.open = true;
    }),
    close: vi.fn(() => {
      element.open = false;
    }),
  };
  panel.controls.dialog.value = element;
  dispose.push(panel.unmount);
  await panel.controls.sync();
  const interaction = (type = "submit") => {
    const event = {
      type,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    listeners.get(type)?.(event);
    return event;
  };
  const setOpen = async (open: boolean) => {
    props.modelValue = open;
    await nextTick();
    await panel.controls.sync();
  };
  return {
    ...panel,
    props,
    updated,
    opener,
    element,
    listeners,
    modals,
    interaction,
    setOpen,
  };
}

it("suppresses submit, click and keyboard interaction as soon as an accepted close begins", async () => {
  const p = await dialogFixture();
  expect(p.listeners.size).toBe(0);
  p.controls.close();
  expect(p.controls.closing.value).toBe(true);
  expect(p.element.open).toBe(true);
  for (const type of ["keydown", "click", "submit"])
    expect(p.element.addEventListener).toHaveBeenCalledWith(
      type,
      p.controls.blockClosingInteraction,
      true,
    );
  for (const type of ["keydown", "click", "submit"]) {
    const event = p.interaction(type);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  }
  await vi.advanceTimersByTimeAsync(299);
  expect(p.element.open).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(p.element.close).toHaveBeenCalledOnce();
  expect(p.listeners.size).toBe(0);
  expect(p.opener.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(p.updated).toHaveBeenCalledExactlyOnceWith(false);
});

it("keeps the form interactive when canClose vetoes dismissal", async () => {
  const canClose = vi.fn(() => false);
  const p = await dialogFixture({ canClose });
  p.controls.close();
  expect(canClose).toHaveBeenCalledOnce();
  expect(p.controls.closing.value).toBe(false);
  expect(p.listeners.size).toBe(0);
  const event = p.interaction();
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300);
  expect(p.element.close).not.toHaveBeenCalled();
  expect(p.updated).not.toHaveBeenCalled();
});

it("keeps a busy dialog open and does not suppress its existing handlers", async () => {
  const canClose = vi.fn(() => true);
  const p = await dialogFixture({ busy: true, canClose });
  p.controls.close();
  expect(canClose).not.toHaveBeenCalled();
  expect(p.controls.closing.value).toBe(false);
  expect(p.interaction().preventDefault).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300);
  expect(p.element.close).not.toHaveBeenCalled();
});

it("rapid reopening cancels the close timer and restores interaction without emitting a stale close", async () => {
  const p = await dialogFixture();
  p.controls.close();
  await p.setOpen(false);
  await p.setOpen(true);
  expect(p.controls.closing.value).toBe(false);
  expect(p.interaction().preventDefault).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(p.element.open).toBe(true);
  expect(p.element.close).not.toHaveBeenCalled();
  expect(p.element.showModal).toHaveBeenCalledOnce();
  expect(p.opener.focus).not.toHaveBeenCalled();
  expect(p.updated).not.toHaveBeenCalled();
});

it("programmatic dismissal also suppresses interaction but does not emit another model update", async () => {
  const p = await dialogFixture();
  await p.setOpen(false);
  expect(p.controls.closing.value).toBe(true);
  expect(p.interaction().preventDefault).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(300);
  expect(p.element.close).toHaveBeenCalledOnce();
  expect(p.updated).not.toHaveBeenCalled();
});

it("nested animation events cannot finish the outer dialog close", async () => {
  const p = await dialogFixture();
  p.controls.close();
  p.controls.animationEnded({ target: {}, animationName: "drawer-leave" });
  p.controls.animationEnded({
    target: p.controls.dialog.value,
    animationName: "drawer-enter",
  });
  expect(p.controls.closing.value).toBe(true);
  expect(p.element.close).not.toHaveBeenCalled();
  p.controls.animationEnded({
    target: p.controls.dialog.value,
    animationName: "drawer-leave",
  });
  expect(p.element.close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(500);
  expect(p.element.close).toHaveBeenCalledOnce();
  expect(p.updated).toHaveBeenCalledExactlyOnceWith(false);
});

it("reduced motion closes immediately and reopening does not leave stale interaction suppression", async () => {
  const p = await dialogFixture({ reducedMotion: true });
  p.controls.close();
  expect(p.element.open).toBe(false);
  expect(p.controls.closing.value).toBe(false);
  expect(p.updated).toHaveBeenCalledExactlyOnceWith(false);
  await p.setOpen(false);
  await p.setOpen(true);
  expect(p.element.open).toBe(true);
  expect(p.interaction().preventDefault).not.toHaveBeenCalled();
});

it("restores focus only after the close update lets the parent re-enable its trigger", async () => {
  const p = await dialogFixture();
  p.opener.disabled = true;
  const focusedWhileDisabled: boolean[] = [];
  p.opener.focus.mockImplementation(() => {
    focusedWhileDisabled.push(p.opener.disabled);
  });
  p.updated.mockImplementation(() => {
    void nextTick(() => {
      p.opener.disabled = false;
    });
  });
  p.controls.close();
  p.controls.finishClose();
  expect(p.updated).toHaveBeenCalledExactlyOnceWith(false);
  expect(p.opener.focus).not.toHaveBeenCalled();
  await nextTick();
  expect(focusedWhileDisabled).toEqual([false]);
});

it("a same-tick reopen cancels deferred restoration before opening the dialog again", async () => {
  const p = await dialogFixture();
  p.controls.close();
  p.controls.finishClose();
  await p.controls.sync();
  await nextTick();
  expect(p.element.open).toBe(true);
  expect(p.opener.focus).not.toHaveBeenCalled();
  expect(p.listeners.size).toBe(0);
});

it("does not steal focus from a different modal opened during the close update", async () => {
  const p = await dialogFixture();
  p.controls.close();
  p.controls.finishClose();
  p.modals.push({ contains: () => false });
  await nextTick();
  expect(p.opener.focus).not.toHaveBeenCalled();
});

it("can return to the opener inside an existing parent modal", async () => {
  const p = await dialogFixture();
  p.modals.push({ contains: (target) => target === p.opener });
  p.controls.close();
  p.controls.finishClose();
  await nextTick();
  expect(p.opener.focus).toHaveBeenCalledExactlyOnceWith({
    preventScroll: true,
  });
});

it("ignores an opener removed before deferred focus restoration", async () => {
  const p = await dialogFixture();
  p.controls.close();
  p.controls.finishClose();
  p.opener.isConnected = false;
  await nextTick();
  expect(p.opener.focus).not.toHaveBeenCalled();
});

it("does not install capture guards or stamp open-dialog child events under a frozen clock", async () => {
  const p = await dialogFixture();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  for (const type of ["click", "keydown", "submit"]) {
    const event = p.interaction(type);
    expect(p.listeners.size).toBe(0);
    expect(event).not.toHaveProperty("_vts");
    expect(event.preventDefault).not.toHaveBeenCalled();
  }
});
