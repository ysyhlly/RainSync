// Isolated compatibility fixture; never point this at an existing personal server.
import { setupUpstreamFixture } from "./fixtures/upstream-setup.mjs";

await setupUpstreamFixture({
  base: "http://127.0.0.1:18096",
  credentialFile: ".runtime/jellyfin-fixture.json",
  expectedVersion: "10.11.0",
  needsStartup: (info) => !info.StartupWizardCompleted,
  serverUrl: "http://rainsync-jellyfin-verification:8096",
  readLibraries: (api) => api("/Library/VirtualFolders"),
});
