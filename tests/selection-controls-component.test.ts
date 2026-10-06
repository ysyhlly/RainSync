import { readFileSync } from "node:fs";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { useSelectPopup } from "../apps/web/src/shared/ui/use-select-popup";

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((unmount) => unmount());
  vi.unstubAllGlobals();
});
const renderer = Vue.createRenderer<any, any>({
  patchProp() {},
  insert() {},
  remove() {},
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  setText() {},
  setElementText() {},
  parentNode: () => null,
  nextSibling: () => null,
});
function eventTarget() {
  const listeners = new Map<string, Set<Function>>();
  return {
    addEventListener: vi.fn((name: string, handler: Function) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(handler);
    }),
    removeEventListener: vi.fn((name: string, handler: Function) => {
      listeners.get(name)?.delete(handler);
    }),
    fire(name: string, event: unknown) {
      listeners.get(name)?.forEach((handler) => handler(event));
    },
    count: () =>
      [...listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0),
  };
}
function environment() {
  const document = eventTarget(),
    window = eventTarget(),
    viewport = eventTarget();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {
    ...window,
    visualViewport: { ...viewport, height: 900, offsetTop: 0 },
  });
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("innerWidth", 1440);
  return {
    document,
    window,
    viewport,
    count: () => document.count() + window.count() + viewport.count(),
  };
}
function elements() {
  let visible = false;
  const scrollIntoView = vi.fn();
  const trigger = {
    getBoundingClientRect: () => ({
      left: 100,
      top: 100,
      right: 300,
      bottom: 144,
      width: 200,
    }),
    contains: (target: unknown) => target === trigger,
    focus: vi.fn(),
  };
  const menu = {
    showPopover: vi.fn(() => {
      visible = true;
    }),
    hidePopover: vi.fn(() => {
      visible = false;
    }),
    matches: () => visible,
    style: {} as Record<string, string>,
    scrollHeight: 120,
    contains: (target: unknown) => target === menu,
    querySelector: () => ({ scrollIntoView }),
  };
  return { trigger, menu, scrollIntoView };
}
function popup(disabled: () => boolean = () => false) {
  const nodes = elements(),
    changed = vi.fn();
  const trigger = Vue.shallowRef(nodes.trigger as unknown as HTMLElement);
  const menu = Vue.shallowRef<HTMLElement | undefined>(
    nodes.menu as unknown as HTMLElement,
  );
  let controls!: ReturnType<typeof useSelectPopup>;
  const app = renderer.createApp({
    setup() {
      controls = useSelectPopup(trigger, menu, changed, disabled);
      return () => null;
    },
  });
  app.mount({});
  const unmount = vi.fn(() => app.unmount());
  mounted.push(() => {
    if (!unmount.mock.calls.length) unmount();
  });
  return { controls, changed, nodes, menu, unmount };
}

it("cancels show before nextTick without opening a popover or installing listeners", async () => {
  const env = environment(),
    p = popup();
  const opening = p.controls.show();
  p.controls.close();
  await opening;
  expect(p.controls.open.value).toBe(false);
  expect(p.changed.mock.calls).toEqual([[true], [false]]);
  expect(p.nodes.menu.showPopover).not.toHaveBeenCalled();
  expect(env.document.addEventListener).not.toHaveBeenCalled();
  expect(env.count()).toBe(0);
});
it("only the current generation opens after an immediate close and reopen", async () => {
  const env = environment(),
    p = popup();
  const old = p.controls.show();
  p.controls.close();
  const current = p.controls.show();
  await Promise.all([old, current]);
  expect(p.nodes.menu.showPopover).toHaveBeenCalledOnce();
  expect(env.count()).toBe(5);
  p.controls.close();
  p.controls.close();
  expect(p.nodes.menu.hidePopover).toHaveBeenCalledOnce();
  expect(p.changed.mock.calls).toEqual([[true], [false], [true], [false]]);
  expect(env.count()).toBe(0);
});
it("repeated show calls retain one opening and one listener set", async () => {
  const env = environment(),
    p = popup();
  await Promise.all([p.controls.show(), p.controls.show()]);
  await p.controls.show();
  expect(p.nodes.menu.showPopover).toHaveBeenCalledOnce();
  expect(p.changed.mock.calls).toEqual([[true]]);
  expect(env.count()).toBe(5);
});
it("another selector cancels a pending popup and replaces an established popup", async () => {
  const env = environment(),
    first = popup(),
    second = popup();
  await Promise.all([first.controls.show(), second.controls.show()]);
  expect(first.nodes.menu.showPopover).not.toHaveBeenCalled();
  expect(first.controls.open.value).toBe(false);
  expect(second.nodes.menu.showPopover).toHaveBeenCalledOnce();
  await first.controls.show();
  expect(second.nodes.menu.hidePopover).toHaveBeenCalledOnce();
  expect(env.count()).toBe(5);
});
it("unmount invalidates a pending opening and prevents later show calls", async () => {
  const env = environment(),
    p = popup();
  const opening = p.controls.show();
  p.unmount();
  await opening;
  await p.controls.show();
  expect(p.nodes.menu.showPopover).not.toHaveBeenCalled();
  expect(p.controls.open.value).toBe(false);
  expect(env.count()).toBe(0);
});
it("a disabled continuation closes without a transient popover", async () => {
  const env = environment();
  let disabled = false;
  const p = popup(() => disabled),
    opening = p.controls.show();
  disabled = true;
  await opening;
  await p.controls.show();
  expect(p.nodes.menu.showPopover).not.toHaveBeenCalled();
  expect(p.changed.mock.calls).toEqual([[true], [false]]);
  expect(env.count()).toBe(0);
});
it("missing popup elements cancel the opening rather than leave active listeners", async () => {
  const env = environment(),
    p = popup();
  const opening = p.controls.show();
  p.menu.value = undefined;
  await opening;
  expect(p.controls.open.value).toBe(false);
  expect(env.count()).toBe(0);
});
it("ordinary opening positions the popup and outside dismissal removes every listener", async () => {
  const env = environment(),
    p = popup();
  await p.controls.show();
  expect(p.nodes.menu.style).toMatchObject({
    width: "200px",
    left: "100px",
    maxHeight: "300px",
    top: "148px",
  });
  env.document.fire("pointerdown", { target: p.nodes.trigger });
  expect(p.controls.open.value).toBe(true);
  env.document.fire("pointerdown", { target: p.nodes.menu });
  expect(p.controls.open.value).toBe(true);
  env.document.fire("pointerdown", { target: {} });
  expect(p.controls.open.value).toBe(false);
  expect(p.nodes.menu.hidePopover).toHaveBeenCalledOnce();
  expect(env.count()).toBe(0);
});
it("unmount removes listeners from an already open popup", async () => {
  const env = environment(),
    p = popup();
  await p.controls.show();
  p.unmount();
  expect(p.nodes.menu.hidePopover).toHaveBeenCalledOnce();
  expect(env.count()).toBe(0);
});

function select(initial: Record<string, unknown>) {
  const env = environment();
  const source = readFileSync(
    new URL("../apps/web/src/shared/ui/AppSelect.vue", import.meta.url),
    "utf8",
  );
  const script = compileScript(parse(source).descriptor, {
    id: "selection-regression",
  }).content;
  const js = ts
    .transpileModule(script, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.replace(/import[\s\S]*?from\s+["'][^"']+["'];?\s*/g, "")
    .replace("export default", "return");
  const imports = {
    ref: Vue.ref,
    computed: Vue.computed,
    watch: Vue.watch,
    nextTick: Vue.nextTick,
    useId: Vue.useId,
    _defineComponent: Vue.defineComponent,
    useSelectPopup,
    AppIcon: {},
  };
  const component = new Function(...Object.keys(imports), js)(
    ...Object.values(imports),
  );
  const props = Vue.reactive(initial),
    emitted = vi.fn(),
    setup = component.setup;
  let controls: any;
  component.setup = (p: any, context: any) => {
    controls = setup(p, context);
    return () => {
      // The real template depends on open, so expansion queues a Vue render.
      void controls.open.value;
      return null;
    };
  };
  const app = renderer.createApp({
    render: () =>
      Vue.h(component, {
        ...props,
        "onUpdate:modelValue": (value: unknown) => emitted("update", value),
        onChange: (value: unknown) => emitted("change", value),
      }),
  });
  app.mount({});
  mounted.push(() => app.unmount());
  const nodes = elements();
  controls.trigger.value = nodes.trigger;
  controls.menu.value = nodes.menu;
  return { controls, props, emitted, nodes, env };
}
function key(name: string) {
  return {
    key: name,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  };
}
const options = [
  { value: "one", label: "Alpha" },
  { value: "disabled", label: "Beta unavailable", disabled: true },
  { value: "three", label: "Bravo" },
];
it("retains the full selected label and placeholder text independently of visual ellipsis", async () => {
  const fullLabel = "RainSync_" + "Long_Media_Title_".repeat(30) + ".mkv";
  const p = select({
    modelValue: "long",
    label: "Film",
    options: [{ value: "long", label: fullLabel }],
  });
  expect(p.controls.displayLabel.value).toBe(fullLabel);
  p.props.modelValue = "missing";
  p.props.placeholder = "Select a film";
  await Vue.nextTick();
  expect(p.controls.displayLabel.value).toBe("Select a film");
});
it("preserves Home/End, disabled-option skipping, typeahead, choice emission and focus", async () => {
  const p = select({ modelValue: "one", label: "Film", options });
  await p.controls.expand();
  await p.controls.key(key("ArrowDown"));
  expect(p.controls.active.value).toBe(2);
  await p.controls.key(key("Home"));
  expect(p.controls.active.value).toBe(0);
  await p.controls.key(key("End"));
  expect(p.controls.active.value).toBe(2);
  await p.controls.key(key("Home"));
  await p.controls.key(key("b"));
  expect(p.controls.active.value).toBe(2);
  await p.controls.key(key("Enter"));
  expect(p.emitted.mock.calls).toEqual([
    ["update", "three"],
    ["change", "three"],
  ]);
  expect(p.nodes.trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(p.controls.open.value).toBe(false);
  expect(p.env.count()).toBe(0);
});
it("Escape closes only the menu while Tab keeps native focus navigation", async () => {
  const p = select({ modelValue: "one", label: "Film", options });
  await p.controls.expand();
  const escape = key("Escape");
  await p.controls.key(escape);
  expect(escape.preventDefault).toHaveBeenCalledOnce();
  expect(escape.stopPropagation).toHaveBeenCalledOnce();
  expect(p.controls.open.value).toBe(false);
  await p.controls.expand();
  const tab = key("Tab");
  await p.controls.key(tab);
  expect(tab.preventDefault).not.toHaveBeenCalled();
  expect(p.controls.open.value).toBe(false);
});
it("empty and all-disabled menus never emit a selection", async () => {
  const p = select({ modelValue: "", label: "Film", options: [] });
  await p.controls.key(key("ArrowDown"));
  await p.controls.key(key("Enter"));
  expect(p.controls.active.value).toBe(-1);
  p.props.options = [options[1]];
  await Vue.nextTick();
  await p.controls.key(key("Home"));
  await p.controls.key(key("Enter"));
  expect(p.controls.active.value).toBe(-1);
  expect(p.emitted).not.toHaveBeenCalled();
});
it("disabling during expansion cancels popover, reveal and later selection attempts", async () => {
  const p = select({
    modelValue: "one",
    label: "Film",
    disabled: false,
    options,
  });
  const opening = p.controls.expand();
  p.props.disabled = true;
  await opening;
  await Vue.nextTick();
  await p.controls.expand();
  await p.controls.key(key("Enter"));
  p.controls.choose(2);
  expect(p.controls.open.value).toBe(false);
  expect(p.nodes.menu.showPopover).not.toHaveBeenCalled();
  expect(p.nodes.scrollIntoView).not.toHaveBeenCalled();
  expect(p.emitted).not.toHaveBeenCalled();
  expect(p.env.count()).toBe(0);
});
