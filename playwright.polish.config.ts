import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Never reuse a user server; missed mocks must not reach a live backend.
export default defineConfig(base, {
  workers: 2,
  use: { ...base.use, baseURL: "http://127.0.0.1:5198" },
  webServer: {
    command: "node node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port 5198 --strictPort",
    url: "http://127.0.0.1:5198",
    reuseExistingServer: false,
    env: {
      RAINSYNC_SERVER_PROXY_URL: "http://127.0.0.1:1",
      RAINSYNC_WORKER_PROXY_URL: "http://127.0.0.1:1",
    },
  },
});
