export function safeRedirect(value: unknown) {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !value.startsWith("/login") &&
    !value.startsWith("/register")
    ? value
    : "/rooms";
}
export const watchNavigation = [
  { to: "/rooms", label: "放映室", icon: "rooms" },
  { to: "/library", label: "媒体库", icon: "movie" },
] as const;
export const adminNavigation = [
  { to: "/admin/sources", label: "片源管理", icon: "movie" },
  { to: "/admin/agents", label: "NAS 设备", icon: "server" },
  { to: "/admin/plugins", label: "插件管理", icon: "server" },
  { to: "/admin/registration-invites", label: "账号与注册", icon: "key" },
] as const;
