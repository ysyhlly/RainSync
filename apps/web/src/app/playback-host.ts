import {
  defineAsyncComponent,
  ref,
  watch,
  type AsyncComponentLoader,
} from "vue";

/** Load once a room actually exists, then retain the same global host for the
 * app's remaining lifetime. Mini/full transitions and room replacement may
 * briefly clear room state; neither may detach an existing video element. */
export function usePersistentPlaybackHost(
  hasRoom: () => boolean,
  load: AsyncComponentLoader = () =>
    import("../features/playback/PlaybackHost.vue"),
) {
  const shown = ref(false);
  watch(
    hasRoom,
    (active) => {
      if (active) shown.value = true;
    },
    { immediate: true, flush: "sync" },
  );
  return { shown, component: defineAsyncComponent(load) };
}
