import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
const artifacts = process.env.RAINSYNC_ARTIFACT_DIR;
export default defineConfig({
  outputDir: artifacts ? resolve(artifacts, "playwright-results") : "test-results",
  reporter: [["list"], ["html", {
    outputFolder: artifacts ? resolve(artifacts, "playwright-report") : "playwright-report",
    open: "never",
  }]],
  testDir: "./tests/browser",
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI && !artifacts,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
