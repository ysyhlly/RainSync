import { ref } from "vue";
export type ThemePreference = "system" | "light" | "dark";
const key = "rainsync.theme";
export const themePreference = ref<ThemePreference>("system");
let media: MediaQueryList | undefined;
function apply() {
  document.documentElement.dataset.theme =
    themePreference.value === "system"
      ? media?.matches
        ? "dark"
        : "light"
      : themePreference.value;
}
export function setThemePreference(value: ThemePreference) {
  if (!["system", "light", "dark"].includes(value)) return;
  themePreference.value = value;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* A blocked storage must not prevent changing the theme. */
  }
  apply();
}
export function initializeTheme() {
  try {
    const stored = localStorage.getItem(key);
    if (stored === "light" || stored === "dark" || stored === "system")
      themePreference.value = stored;
  } catch {
    /* System preference remains available without storage. */
  }
  media = window.matchMedia?.("(prefers-color-scheme: dark)");
  apply();
  media?.addEventListener("change", apply);
  const sync = (event: StorageEvent) => {
    if (event.key !== key) return;
    themePreference.value =
      event.newValue === "light" || event.newValue === "dark"
        ? event.newValue
        : "system";
    apply();
  };
  window.addEventListener("storage", sync);
  return () => {
    media?.removeEventListener("change", apply);
    window.removeEventListener("storage", sync);
  };
}
