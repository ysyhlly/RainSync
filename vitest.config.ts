import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  cacheDir: process.env.RAINSYNC_ARTIFACT_DIR
    ? resolve(process.env.RAINSYNC_ARTIFACT_DIR, "vitest-cache") : undefined,
  test: {
    include: [
      "tests/**/*.test.ts",
      "apps/web/src/features/playback/static-hls-child-intent.test.ts",
      "apps/web/src/features/playback/static-hls-child-runtime.test.ts",
    ],
  },
});
