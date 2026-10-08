// Isolated compatibility fixture; never point this at an existing personal server.
import { setupUpstreamFixture } from "./fixtures/upstream-setup.mjs";

await setupUpstreamFixture({
  base: "http://127.0.0.1:18097/emby",
  credentialFile: ".runtime/emby-fixture.json",
  expectedVersion: "4.10.0.40",
  needsStartup: (_info, credentials) => !credentials.user_id,
  serverUrl: "http://rainsync-emby-verification:8096/emby",
  readLibraries: async (api) =>
    (await api("/Library/VirtualFolders/Query")).Items,
});
