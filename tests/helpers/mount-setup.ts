import { readFileSync } from "node:fs";
import { parse, compileScript } from "@vue/compiler-sfc";
import ts from "typescript";
import * as Vue from "vue";

/** Exercise the real SFC setup and Vue lifecycle with an in-memory renderer. */
export function mountSetup(
  url: URL,
  imports: Record<string, unknown>,
  props: Record<string, unknown> = {},
) {
  const descriptor = parse(readFileSync(url, "utf8")).descriptor;
  const script = compileScript(descriptor, {
    id: "first-round-regression",
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
  const bindings = {
    _defineComponent: Vue.defineComponent,
    _useModel: Vue.useModel,
    _mergeModels: Vue.mergeModels,
    ref: Vue.ref,
    computed: Vue.computed,
    watch: Vue.watch,
    onMounted: Vue.onMounted,
    onBeforeUnmount: Vue.onBeforeUnmount,
    nextTick: Vue.nextTick,
    ...imports,
  };
  const component = new Function(...Object.keys(bindings), js)(
    ...Object.values(bindings),
  );
  let controls: any;
  const setup = component.setup;
  component.setup = (props: any, context: any) => {
    controls = setup(props, context);
    return () => null;
  };
  const renderer = Vue.createRenderer<any, any>({
    patchProp() {},
    insert(node, parent) {
      node.parent = parent;
    },
    remove() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: (node) => node.parent,
    nextSibling: () => null,
  });
  const currentProps = Vue.reactive(props);
  const app = renderer.createApp({
    render: () => Vue.h(component, currentProps),
  });
  app.mount({});
  return {
    controls,
    setProps: (patch: Record<string, unknown>) =>
      Object.assign(currentProps, patch),
    unmount: () => app.unmount(),
  };
}
