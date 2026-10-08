import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryHistory } from "vue-router";
const pages = {
  LoginPage: "features/auth/LoginPage.vue",
  InvitationPage: "features/auth/InvitationPage.vue",
  RegisterPage: "features/auth/RegisterPage.vue",
  ProfilePage: "features/account/ProfilePage.vue",
  RoomsPage: "features/rooms/RoomsPage.vue",
  RoomPage: "features/rooms/RoomPage.vue",
  LibraryPage: "features/library/LibraryPage.vue",
  PrivateLibrariesPage: "features/private-library/PrivateLibrariesPage.vue",
  PluginsPage: "features/plugins/PluginsPage.vue",
  SourcesPage: "features/admin/SourcesPage.vue",
  AgentsPage: "features/admin/AgentsPage.vue",
  RegistrationInvitesPage: "features/admin/RegistrationInvitesPage.vue",
  CreateUserPage: "features/admin/CreateUserPage.vue",
  AdminSettingsPage: "features/admin/AdminSettingsPage.vue",
  NotFoundPage: "app/NotFoundPage.vue",
};
let loaded: string[];
const session = {
  user: null as null | {
    admin: boolean;
    guest?: boolean;
    guest_room_id?: string;
  },
  expired: false,
  startupError: "",
  restore: vi.fn(async () => {}),
};
beforeEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  loaded = [];
  session.user = null;
  session.expired = false;
  session.startupError = "";
  session.restore.mockClear();
  vi.doMock("../apps/web/src/features/auth/session.store", () => ({
    useSession: () => session,
  }));
  for (const [name, path] of Object.entries(pages))
    vi.doMock(`../apps/web/src/${path}`, () => {
      loaded.push(name);
      return { default: { name, render: () => null } };
    });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../apps/web/src/features/auth/session.store");
  for (const path of Object.values(pages))
    vi.doUnmock(`../apps/web/src/${path}`);
});
async function router() {
  const { createApplicationRouter } =
    await import("../apps/web/src/app/router");
  vi.stubGlobal("document", { title: "" });
  return createApplicationRouter("/", createMemoryHistory());
}

it("keeps every page including 404 unopened until navigation passes its guard", async () => {
  const app = await router();
  expect(loaded).toEqual([]);
  expect(
    app.getRoutes().filter((route) => route.components?.default),
  ).toHaveLength(15);
  await app.push("/admin/plugins?tab=installed");
  expect(app.currentRoute.value.path).toBe("/login");
  expect(app.currentRoute.value.query.redirect).toBe(
    "/admin/plugins?tab=installed",
  );
  expect(loaded).toEqual(["LoginPage"]);
  expect(session.restore).toHaveBeenCalled();
});
it("blocks administrator chunks for ordinary members and keeps the admin-required notice", async () => {
  session.user = { admin: false };
  const app = await router();
  await app.push("/admin/sources");
  expect(app.currentRoute.value.path).toBe("/rooms");
  expect(app.currentRoute.value.query.notice).toBe("admin-required");
  expect(loaded).toEqual(["RoomsPage"]);
});
it("loads only the admitted administrator page and retains its title", async () => {
  session.user = { admin: true };
  const app = await router();
  await app.push("/admin/plugins");
  expect(loaded).toEqual(["PluginsPage"]);
  expect(document.title).toBe("插件管理 · RainSync");
});
it("redirects guests into their exact room before loading private-library code", async () => {
  session.user = {
    admin: false,
    guest: true,
    guest_room_id: "11111111-1111-4111-8111-111111111111",
  };
  const app = await router();
  await app.push("/libraries");
  expect(app.currentRoute.value.path).toBe(
    "/rooms/11111111-1111-4111-8111-111111111111",
  );
  expect(loaded).toEqual(["RoomPage"]);
});
it("loads the missing-page view lazily for an authenticated unmatched route", async () => {
  session.user = { admin: false };
  const app = await router();
  await app.push("/unknown-page");
  expect(loaded).toEqual(["NotFoundPage"]);
  expect(document.title).toBe("页面不存在 · RainSync");
});
it("opens a public 404 for an anonymous unknown route without redirecting to login", async () => {
  const app = await router();
  await app.push("/nonexistent-xyz");
  expect(app.currentRoute.value.path).toBe("/nonexistent-xyz");
  expect(loaded).toEqual(["NotFoundPage"]);
});
it("admits a same-site invitation page for anonymous and registered viewers", async () => {
  const app = await router();
  const destination =
    "/invite/11111111-1111-4111-8111-111111111111#token=" + "a".repeat(64);
  await app.push(destination);
  expect(app.currentRoute.value.fullPath).toBe(destination);
  expect(loaded).toEqual(["InvitationPage"]);
  session.user = { admin: false };
  await app.push("/rooms");
  await app.push(destination);
  expect(app.currentRoute.value.fullPath).toBe(destination);
});
