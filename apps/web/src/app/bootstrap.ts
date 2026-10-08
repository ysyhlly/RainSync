import { createApp } from "vue";
import { createPinia } from "pinia";
import { createApplicationRouter } from "./router";
import AppShell from "./AppShell.vue";
import { installGlobalErrorHandlers } from "./global-errors";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/layout.css";
import "../styles/motion.css";
import "../styles/account.css";
import "../styles/admin.css";
import "../styles/selection.css";
import "../styles/design-system.css";
import "../styles/player-overlay.css";
export function start(base = "/") {
  const app = createApp(AppShell);
  app.use(createPinia());
  const router = createApplicationRouter(base);
  app.onUnmount(installGlobalErrorHandlers(app, router));
  app.use(router);
  app.mount("#app");
}
