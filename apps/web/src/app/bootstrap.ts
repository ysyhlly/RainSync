import { createApp } from "vue";
import { createPinia } from "pinia";
import { createApplicationRouter } from "./router";
import AppShell from "./AppShell.vue";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/layout.css";
import "../styles/motion.css";
import "../styles/account.css";
import "../styles/admin.css";
import "../styles/selection.css";
import "../styles/player-overlay.css";
export function start(base = "/") {
  const app = createApp(AppShell);
  app.use(createPinia());
  app.use(createApplicationRouter(base));
  app.mount("#app");
}
