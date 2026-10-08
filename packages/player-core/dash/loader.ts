import type { DashModuleBridge, DashModuleLoader } from "../dash";

let dashModule: Promise<DashModuleBridge> | undefined;
/** Share only the SDK import. Preloading creates no player or media request. A
 * failed chunk load is evicted so a later user retry can try again. */
export const loadDashJs: DashModuleLoader = () => {
  if (dashModule) return dashModule;
  const pending = import("dashjs")
    .then((sdk) => ({
      createPlayer: () => sdk.MediaPlayer().create(),
      events: {
        ready: sdk.MediaPlayer.events.STREAM_INITIALIZED,
        error: sdk.MediaPlayer.events.ERROR,
      },
    }))
    .catch((failure) => {
      if (dashModule === pending) dashModule = undefined;
      throw failure;
    });
  dashModule = pending;
  return pending;
};
