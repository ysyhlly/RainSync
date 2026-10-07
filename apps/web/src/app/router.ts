import { createRouter, createWebHistory } from "vue-router";
import { guestRoomPath } from "../features/auth/guest-session";
import { useSession } from "../features/auth/session.store";
import LoginPage from "../features/auth/LoginPage.vue";
import RegisterPage from "../features/auth/RegisterPage.vue";
import ProfilePage from "../features/account/ProfilePage.vue";
import RoomsPage from "../features/rooms/RoomsPage.vue";
import LibraryPage from "../features/library/LibraryPage.vue";
import RoomPage from "../features/rooms/RoomPage.vue";
import NotFoundPage from "./NotFoundPage.vue";
import PrivateLibrariesPage from "../features/private-library/PrivateLibrariesPage.vue";
import PluginsPage from "../features/plugins/PluginsPage.vue";
import SourcesPage from "../features/admin/SourcesPage.vue";
import AgentsPage from "../features/admin/AgentsPage.vue";
import RegistrationInvitesPage from "../features/admin/RegistrationInvitesPage.vue";
import CreateUserPage from "../features/admin/CreateUserPage.vue";
import AdminSettingsPage from "../features/admin/AdminSettingsPage.vue";
import { authenticationLocation, safeRedirect } from "./navigation";
export function createApplicationRouter(base = "/") {
  const router = createRouter({
    history: createWebHistory(base),
    routes: [
      { path: "/", redirect: "/rooms" },
      {
        path: "/register",
        component: RegisterPage,
        meta: { public: true, title: "账号注册" },
      },
      {
        path: "/account/profile",
        component: ProfilePage,
        meta: { title: "个人资料" },
      },
      {
        path: "/login",
        component: LoginPage,
        meta: { public: true, title: "登录" },
      },
      { path: "/rooms", component: RoomsPage, meta: { title: "放映室" } },
      {
        path: "/rooms/:id",
        component: RoomPage,
        meta: { title: "观影", room: true },
      },
      { path: "/library", component: LibraryPage, meta: { title: "媒体库" } },
      {
        path: "/libraries",
        component: PrivateLibrariesPage,
        meta: { title: "私有媒体库" },
      },
      {
        path: "/admin/plugins",
        component: PluginsPage,
        meta: { title: "插件管理", requiresAdmin: true },
      },
      { path: "/admin", redirect: "/admin/settings" },
      {
        path: "/admin/settings",
        component: AdminSettingsPage,
        meta: { title: "管理员设置", requiresAdmin: true },
      },
      {
        path: "/admin/sources",
        component: SourcesPage,
        meta: { title: "片源管理", requiresAdmin: true },
      },
      {
        path: "/admin/agents",
        component: AgentsPage,
        meta: { title: "NAS 设备", requiresAdmin: true },
      },
      {
        path: "/admin/registration-invites",
        component: RegistrationInvitesPage,
        meta: { title: "账号与注册", requiresAdmin: true },
      },
      {
        path: "/admin/users",
        component: CreateUserPage,
        meta: { title: "手动创建账号", requiresAdmin: true },
      },
      {
        path: "/:pathMatch(.*)*",
        component: NotFoundPage,
        meta: { title: "页面不存在" },
      },
    ],
    scrollBehavior(to, from, saved) {
      return to.path === from.path ? undefined : (saved ?? { top: 0 });
    },
  });
  router.beforeEach(async (to) => {
    const session = useSession();
    await session.restore();
    if (session.startupError) return true;
    if (!session.user && !to.meta.public)
      return authenticationLocation("/login", to.fullPath, session.expired);
    const guestHome = guestRoomPath(session.user);
    if (guestHome && to.path !== guestHome) return guestHome;
    if (session.user && to.meta.public) return safeRedirect(to.query.redirect);
    if (to.path.startsWith("/admin") && !session.user?.admin)
      return { path: "/rooms", query: { notice: "admin-required" } };
    return true;
  });
  router.afterEach((to) => {
    document.title = String(to.meta.title ?? "RainSync") + " · RainSync";
  });
  return router;
}
