import { expect, it, vi } from "vitest";
import {
  createRenderer,
  defineComponent,
  h,
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
} from "vue";
import { usePersistentPlaybackHost } from "../apps/web/src/app/playback-host";

it("defers an idle host, then retains its instance through full/mini and transient empty room state", async () => {
  type Node = { parent?: Node };
  const renderer = createRenderer<Node, Node>({
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
    parentNode: (node) => node.parent ?? null,
    nextSibling: () => null,
  });
  const attached = vi.fn(),
    detached = vi.fn(),
    full = ref(true),
    room = ref(false);
  const host = defineComponent({
    props: { full: Boolean },
    setup() {
      const videoIdentity = {};
      onMounted(() => attached(videoIdentity));
      onBeforeUnmount(detached);
      return () => h("video");
    },
  });
  let resolve!: (value: typeof host) => void;
  const load = vi.fn(
    () =>
      new Promise<typeof host>((done) => {
        resolve = done;
      }),
  );
  const app = renderer.createApp({
    setup() {
      const player = usePersistentPlaybackHost(() => room.value, load);
      return () =>
        player.shown.value ? h(player.component, { full: full.value }) : null;
    },
  });
  app.mount({});
  expect(load).not.toHaveBeenCalled();
  room.value = true;
  await nextTick();
  expect(load).toHaveBeenCalledOnce();
  expect(attached).not.toHaveBeenCalled();
  full.value = false;
  room.value = false;
  await nextTick();
  resolve(host);
  await vi.waitFor(() => expect(attached).toHaveBeenCalledOnce());
  full.value = true;
  room.value = true;
  await nextTick();
  full.value = false;
  await nextTick();
  expect(load).toHaveBeenCalledOnce();
  expect(attached).toHaveBeenCalledOnce();
  expect(detached).not.toHaveBeenCalled();
  app.unmount();
  expect(detached).toHaveBeenCalledOnce();
});
