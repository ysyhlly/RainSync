export function safeRedirect(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/")) return "/rooms";
  try {
    const path = decodeURIComponent(value.split(/[?#]/, 1)[0]!);
    if (
      path.startsWith("//") ||
      value.includes("\\") ||
      path.includes("\\") ||
      /[\u0000-\u0020\u007f]/.test(value) ||
      /[\u0000-\u0020\u007f]/.test(path) ||
      path.startsWith("/login") ||
      path.startsWith("/register")
    )
      return "/rooms";
    return value;
  } catch {
    return "/rooms";
  }
}
export function authenticationLocation(
  path: "/login" | "/register",
  target: unknown,
  expired = false,
) {
  return {
    path,
    query: {
      redirect: safeRedirect(target),
      ...(expired ? { notice: "session-expired" } : {}),
    },
  };
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
