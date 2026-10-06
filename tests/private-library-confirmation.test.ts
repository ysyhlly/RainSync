import { readFileSync } from "node:fs";
import { parse, compileScript } from "@vue/compiler-sfc";
import ts from "typescript";
import * as Vue from "vue";
import { expect, it, vi } from "vitest";
import { privateLibraryApi } from "../apps/web/src/features/private-library/private-library.api";

function library(id = "private") {
  return {
    id,
    name: "私人片库",
    owner_id: "owner",
    visibility: "private",
    revision: "1",
    permission_epoch: "1",
    permissions: {
      browse: true,
      play: true,
      share_to_room: true,
      manage: true,
    },
    sources: [],
    grants: [],
    room_shares: [],
    audit: [],
  };
}

async function page() {
  const session = Vue.reactive({
    epoch: 0,
    user: { id: "owner", admin: true },
    api: vi.fn(
      async (
        path: string,
        method = "GET",
        _body?: unknown,
        _signal?: AbortSignal,
      ): Promise<any> => {
        if (path === "/libraries") return { enabled: true, items: [library()] };
        if (path.includes("/media?")) return [];
        return library(path.split("/")[2]);
      },
    ),
  });
  const source = readFileSync(
    new URL(
      "../apps/web/src/features/private-library/PrivateLibrariesPage.vue",
      import.meta.url,
    ),
    "utf8",
  );
  const script = compileScript(parse(source).descriptor, {
    id: "private-library-fixture",
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
    _defineComponent: Vue.defineComponent,
    ref: Vue.ref,
    computed: Vue.computed,
    watch: Vue.watch,
    onMounted: Vue.onMounted,
    onBeforeUnmount: Vue.onBeforeUnmount,
    useRoute: () => ({ query: {} }),
    useSession: () => session,
    useRoomRuntime: () => ({ room: null }),
    privateLibraryApi,
    Notice: {},
    AppDialog: {},
    AppIcon: {},
  };
  const component = new Function(...Object.keys(imports), js)(
    ...Object.values(imports),
  );
  let controls: any;
  const setup = component.setup;
  component.setup = (props: unknown, context: unknown) => {
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
  const app = renderer.createApp(component);
  app.mount({});
  await vi.waitFor(() => expect(controls.selected.value?.id).toBe("private"));
  session.api.mockClear();
  return { controls, session, unmount: () => app.unmount() };
}

it.each([
  ["revoke", "viewer", "/libraries/private/grants/viewer", "DELETE"],
  ["revokeShare", "share", "/libraries/private/room-shares/share", "DELETE"],
  ["transfer", "new-owner", "/libraries/private/transfer", "POST"],
  ["attach", "source", "/libraries/private/attach-source", "POST"],
])(
  "requires explicit confirmation for %s, and cancellation sends nothing",
  async (kind, target, path, method) => {
    const p = await page();
    p.controls.requestChange(kind, target);
    expect(p.controls.confirmationOpen.value).toBe(true);
    expect(p.session.api).not.toHaveBeenCalled();
    p.controls.confirmationOpen.value = false;
    await p.controls.confirmChange();
    expect(p.session.api).not.toHaveBeenCalled();
    p.controls.requestChange(kind, target);
    await p.controls.confirmChange();
    const mutation = p.session.api.mock.calls.filter(
      (call) => call[1] === method && call[0] === path,
    );
    expect(mutation).toHaveLength(1);
    expect(mutation[0]?.[2]).toMatchObject({ expected_revision: "1" });
    if (kind === "transfer")
      expect(mutation[0]?.[2]).toMatchObject({ username: target });
    if (kind === "attach")
      expect(mutation[0]?.[2]).toMatchObject({ source_id: target });
    expect(p.controls.confirmationOpen.value).toBe(false);
    p.unmount();
  },
);

it("invalidates confirmation when the selected library or active account changes", async () => {
  const p = await page();
  p.controls.requestChange("transfer", "new-owner");
  await p.controls.select("other");
  expect(p.controls.confirmationOpen.value).toBe(false);
  p.session.api.mockClear();
  await p.controls.confirmChange();
  expect(p.session.api).not.toHaveBeenCalled();
  p.controls.requestChange("revoke", "viewer");
  p.session.epoch++;
  expect(p.controls.confirmationOpen.value).toBe(false);
  expect(p.controls.selected.value).toBeNull();
  await p.controls.confirmChange();
  expect(p.session.api).not.toHaveBeenCalled();
  p.unmount();
});

it("does not reuse a confirmation after a revision conflict or retry a mutation automatically", async () => {
  const p = await page();
  p.session.api.mockImplementation(async (path, method = "GET") => {
    if (method === "DELETE") throw new Error("媒体库已变化");
    return { ...library(), revision: "2" };
  });
  p.controls.requestChange("revoke", "viewer");
  await p.controls.confirmChange();
  expect(p.controls.selected.value.revision).toBe("2");
  expect(p.controls.confirmationOpen.value).toBe(true);
  await p.controls.confirmChange();
  expect(p.controls.error.value).toContain("核对最新内容后重新操作");
  expect(
    p.session.api.mock.calls.filter((call) => call[1] === "DELETE"),
  ).toHaveLength(1);
  p.unmount();
});

it("consumes a successful transfer before a failed list refresh and preserves its receipt", async () => {
  const p = await page();
  let transferCount = 0;
  p.session.api.mockImplementation(async (path, method = "GET") => {
    if (path === "/libraries/private/transfer" && method === "POST") {
      transferCount++;
      return { transferred: true };
    }
    if (path === "/libraries") throw new Error("转移后的列表刷新失败");
    return library();
  });
  p.controls.requestChange("transfer", "new-owner");
  await p.controls.confirmChange();
  expect(transferCount).toBe(1);
  expect(p.controls.selected.value).toBeNull();
  expect(p.controls.confirmationOpen.value).toBe(false);
  expect(p.controls.busy.value).toBe(false);
  expect(p.controls.notice.value).toBe("所有权已转移，原所有者不保留默认权限");
  expect(p.controls.error.value).toBe("转移后的列表刷新失败");
  await p.controls.confirmChange();
  expect(transferCount).toBe(1);
  p.session.api.mockImplementation(async () => ({ enabled: true, items: [] }));
  await p.controls.initialize();
  expect(p.controls.libraries.value).toEqual([]);
  expect(p.controls.error.value).toBe("");
  expect(p.controls.notice.value).toBe("所有权已转移，原所有者不保留默认权限");
  expect(transferCount).toBe(1);
  p.unmount();
});
