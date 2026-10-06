import {
  inject,
  provide,
  ref,
  shallowRef,
  type InjectionKey,
  type Ref,
  type ShallowRef,
} from "vue";

/** Layout changes move only the host's CSS box, never its media DOM. */
export interface PlaybackPlacement {
  anchor: ShallowRef<HTMLElement | null>;
  editing: Ref<boolean>;
}
const placementKey: InjectionKey<PlaybackPlacement> = Symbol(
  "room-playback-placement",
);

export function providePlaybackPlacement(): PlaybackPlacement {
  const placement = {
    anchor: shallowRef<HTMLElement | null>(null),
    editing: ref(false),
  };
  provide(placementKey, placement);
  return placement;
}

export function usePlaybackPlacement(): PlaybackPlacement | undefined {
  return inject(placementKey, undefined);
}
