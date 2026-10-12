import { createRouter, createWebHistory, type RouterHistory } from "vue-router";
import { guestRoomPath } from "../features/auth/guest-session";
import { useSession } from "../features/auth/session.store";
import { authenticationLocation, safeRedirect } from "./navigation";
import { navigationPending, navigationTitle } from "./navigation-progress";
export function createApplicationRouter(
  base = "/",
  history: RouterHistory = createWebHistory(base),
) {
  const router = createRouter({
    history,
    routes: [
      { path: "/", redirect: "/rooms" },
      {
        path: "/register",
        component: () => import("../features/auth/RegisterPage.vue"),
        meta: { public: true, title: "账号注册" },
      },
      {
        path: "/account/profile",
        component: () => import("../features/account/ProfilePage.vue"),
        meta: { title: "个人资料" },
      },
      {
        path: "/login",
        component: () => import("../features/auth/LoginPage.vue"),
        meta: { public: true, title: "登录" },
      },
      {
        path: "/invite/:roomId",
        component: () => import("../features/auth/InvitationPage.vue"),
        meta: { public: true, invitation: true, title: "房间邀请" },
      },
      {
        path: "/rooms",
        component: () => import("../features/rooms/RoomsPage.vue"),
        meta: { title: "放映室" },
      },
      {
        path: "/rooms/:id",
        component: () => import("../features/rooms/RoomPage.vue"),
        meta: { title: "观影", room: true },
      },
      {
        path: "/library",
        component: () => import("../features/library/LibraryPage.vue"),
        meta: { title: "媒体库" },
      },
      {
        path: "/libraries",
        component: () =>
          import("../features/private-library/PrivateLibrariesPage.vue"),
        meta: { title: "私有媒体库" },
      },
      {
        path: "/admin/plugins",
        component: () => import("../features/plugins/PluginsPage.vue"),
        meta: { title: "插件管理", requiresAdmin: true },
      },
      { path: "/admin", redirect: "/admin/settings" },
      {
        path: "/admin/settings",
        component: () => import("../features/admin/AdminSettingsPage.vue"),
        meta: { title: "管理员设置", requiresAdmin: true },
      },
      {
        path: "/admin/sources",
        component: () => import("../features/admin/SourcesPage.vue"),
        meta: { title: "片源管理", requiresAdmin: true },
      },
      {
        path: "/admin/agents",
        component: () => import("../features/admin/AgentsPage.vue"),
        meta: { title: "NAS 设备", requiresAdmin: true },
      },
      {
        path: "/admin/registration-invites",
        component: () =>
          import("../features/admin/RegistrationInvitesPage.vue"),
        meta: { title: "账号与注册", requiresAdmin: true },
      },
      {
        path: "/admin/users",
        component: () => import("../features/admin/CreateUserPage.vue"),
        meta: { title: "手动创建账号", requiresAdmin: true },
      },
      {
        path: "/:pathMatch(.*)*",
        component: () => import("./NotFoundPage.vue"),
        meta: { public: true, notFound: true, title: "页面不存在" },
      },
    ],
    scrollBehavior(to, from, saved) {
      return to.path === from.path ? undefined : (saved ?? { top: 0 });
    },
  });
  router.beforeEach(async (to) => {
    navigationTitle.value = String(to.meta.title ?? "RainSync");
    navigationPending.value = true;
    const session = useSession();
    await session.restore();
    if (session.startupError) return true;
    if (!session.user && !to.meta.public)
      return authenticationLocation("/login", to.fullPath, session.expired);
    const guestHome = guestRoomPath(session.user);
    if (guestHome && to.path !== guestHome) return guestHome;
    if (
      session.user &&
      to.meta.public &&
      !to.meta.invitation &&
      !to.meta.notFound
    )
      return safeRedirect(to.query.redirect);
    if (to.path.startsWith("/admin") && !session.user?.admin)
      return { path: "/rooms", query: { notice: "admin-required" } };
    return true;
  });
  router.afterEach((to) => {
    navigationPending.value = false;
    document.title = String(to.meta.title ?? "RainSync") + " · RainSync";
  });
  router.onError(() => {
    navigationPending.value = false;
  });
  return router;
}
