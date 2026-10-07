import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
const artifactDir = process.env.RAINSYNC_ARTIFACT_DIR;
export default defineConfig({
  cacheDir: artifactDir ? resolve(artifactDir, "vite-cache") : undefined,
  build: {
    manifest: true,
    outDir: artifactDir ? resolve(artifactDir, "web-dist") : "dist",
    emptyOutDir: true,
  },
  plugins: [vue()],
  worker: { format: "es" },
  optimizeDeps: {
    include: ["vue", "pinia", "vue-router", "hls.js", "@tabler/icons-vue"],
  },
  server: {
    proxy: {
      "/api": {
        target:
          process.env.RAINSYNC_SERVER_PROXY_URL ?? "http://127.0.0.1:8080",
        ws: true,
      },
      "/media-delivery":
        process.env.RAINSYNC_WORKER_PROXY_URL ?? "http://127.0.0.1:8081",
      "/agent-data": {
        target:
          process.env.RAINSYNC_WORKER_PROXY_URL ?? "http://127.0.0.1:8081",
        ws: true,
      },
    },
  },
});
