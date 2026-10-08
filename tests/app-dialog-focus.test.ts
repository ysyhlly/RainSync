import { afterEach, expect, it, vi } from "vitest";
import { useId } from "vue";
import { mountSetup } from "./helpers/mount-setup";

type FocusItem = {
  selector: string;
  tabIndex: number;
  disabled: boolean;
  visible: boolean;
  focus: () => void;
  matches: (selector: string) => boolean;
  getClientRects: () => unknown[];
};
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const stop of dispose.splice(0)) stop();
  vi.unstubAllGlobals();
});

function focusTrap() {
  const document = { activeElement: null as FocusItem | null };
  vi.stubGlobal("document", document);
  const item = (
    selector: string,
    options: Partial<Pick<FocusItem, "tabIndex" | "disabled" | "visible">> = {},
  ): FocusItem => {
    const element: FocusItem = {
      selector,
      tabIndex: 0,
      disabled: false,
      visible: true,
      ...options,
      focus: vi.fn(() => {
        document.activeElement = element;
      }),
      matches: (selector) => selector === ":disabled" && element.disabled,
      getClientRects: () => (element.visible ? [{}] : []),
    };
    return element;
  };
  const close = item("button"),
    url = item("input"),
    summary = item("details > summary:first-of-type"),
    headers = item("textarea", { visible: false }),
    assets = item("textarea", { visible: false }),
    cancel = item("button"),
    save = item("button"),
    heading = item("[tabindex]", { tabIndex: -1 });
  const order = [heading, close, url, summary, headers, assets, cancel, save];
  const panel = mountSetup(
    new URL("../apps/web/src/shared/ui/AppDialog.vue", import.meta.url),
    { AppIcon: {}, useId },
    { modelValue: false, title: "Focus fixture" },
  );
  dispose.push(panel.unmount);
  panel.controls.dialog.value = {
    // Match candidate types in DOM order, independently of their tab order.
    querySelectorAll: (selector: string) => {
      const selectors = selector.split(",").map((value) => value.trim());
      return order.filter((element) => selectors.includes(element.selector));
    },
    querySelector: () => heading,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(),
  };
  const tab = (shiftKey = false) => {
    const event = { key: "Tab", shiftKey, preventDefault: vi.fn() };
    panel.controls.trapTab(event);
    // The DOM-less fixture models the browser's default sequential focus step.
    // The browser regression verifies this same path using actual key presses.
    if (!event.preventDefault.mock.calls.length) {
      const nativeOrder = order.filter(
        (element) =>
          element.tabIndex >= 0 && !element.disabled && element.visible,
      );
      const index = nativeOrder.indexOf(document.activeElement!);
      nativeOrder[index + (shiftKey ? -1 : 1)]?.focus();
    }
    return event;
  };
  return {
    document,
    order,
    close,
    url,
    summary,
    headers,
    assets,
    cancel,
    save,
    heading,
    tab,
  };
}

it("preserves forward and backward movement through a collapsed native summary", () => {
  const p = focusTrap();
  p.url.focus();
  expect(p.tab().preventDefault).not.toHaveBeenCalled();
  expect(p.document.activeElement).toBe(p.summary);
  expect(p.tab(true).preventDefault).not.toHaveBeenCalled();
  expect(p.document.activeElement).toBe(p.url);
  p.summary.focus();
  expect(p.tab().preventDefault).not.toHaveBeenCalled();
  expect(p.document.activeElement).toBe(p.cancel);
  expect(p.tab(true).preventDefault).not.toHaveBeenCalled();
  expect(p.document.activeElement).toBe(p.summary);
});

it("keeps expanded details controls in native order in both directions", () => {
  const p = focusTrap();
  p.headers.visible = p.assets.visible = true;
  p.url.focus();
  for (const next of [p.summary, p.headers, p.assets, p.cancel, p.save]) {
    expect(p.tab().preventDefault).not.toHaveBeenCalled();
    expect(p.document.activeElement).toBe(next);
  }
  for (const previous of [p.cancel, p.assets, p.headers, p.summary, p.url]) {
    expect(p.tab(true).preventDefault).not.toHaveBeenCalled();
    expect(p.document.activeElement).toBe(previous);
  }
});

it("wraps from the real first and last controls and from the dialog heading", () => {
  const p = focusTrap();
  p.save.focus();
  expect(p.tab().preventDefault).toHaveBeenCalledOnce();
  expect(p.document.activeElement).toBe(p.close);
  expect(p.tab(true).preventDefault).toHaveBeenCalledOnce();
  expect(p.document.activeElement).toBe(p.save);
  p.heading.focus();
  expect(p.tab(true).preventDefault).toHaveBeenCalledOnce();
  expect(p.document.activeElement).toBe(p.save);
});

it("includes a summary at the boundary while excluding disabled, hidden and negative-tabindex controls", () => {
  const p = focusTrap();
  p.cancel.disabled = true;
  p.save.tabIndex = -1;
  p.summary.focus();
  expect(p.tab().preventDefault).toHaveBeenCalledOnce();
  expect(p.document.activeElement).toBe(p.close);
  expect(p.tab(true).preventDefault).toHaveBeenCalledOnce();
  expect(p.document.activeElement).toBe(p.summary);
  p.summary.visible = false;
  p.close.focus();
  p.tab(true);
  expect(p.document.activeElement).toBe(p.url);
});

it("keeps focus on the dialog heading if no controls are tabbable", () => {
  const p = focusTrap();
  for (const element of p.order) element.tabIndex = -1;
  expect(p.tab().preventDefault).toHaveBeenCalledOnce();
  expect(p.document.activeElement).toBe(p.heading);
});
