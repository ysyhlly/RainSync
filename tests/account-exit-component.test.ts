import { mountSetup } from "./helpers/mount-setup";
import * as Vue from "vue";
import { createPinia, setActivePinia } from "pinia";
import { expect, it, vi } from "vitest";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { useAction } from "../apps/web/src/shared/use-action";

function panel(api: any) {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept({
    id: "00000000-0000-0000-0000-000000000001",
    username: "fixture",
    admin: false,
    csrf: "fixture",
  });
  session.api = api;
  const replace = vi.fn(),
    router = { replace };
  const { controls, unmount } = mountSetup(
    new URL(
      "../apps/web/src/features/account/AccountExitPanel.vue",
      import.meta.url,
    ),
    {
      useRouter: () => router,
      useSession,
      useAction,
      Notice: {},
      AppDialog: {},
    },
  );
  return { controls, session, replace, unmount };
}

it("requires current ownership preflight and exact confirmation before sending account deletion", async () => {
  const api = vi.fn(async () => ({
    can_delete: false,
    last_admin: false,
    rooms: [{ id: "room", name: "owned", lifecycle: "active" }],
    libraries: [],
  }));
  const p = panel(api);
  await p.controls.begin();
  p.controls.password.value = "password123";
  p.controls.confirmation.value = "DELETE";
  await p.controls.retire();
  expect(api).toHaveBeenCalledTimes(1);
  p.controls.preview.value.can_delete = true;
  p.controls.confirmation.value = "wrong";
  await p.controls.retire();
  expect(api).toHaveBeenCalledTimes(1);
  expect(p.session.user).not.toBeNull();
  p.unmount();
});

it("clears the password when dismissed and clears all local identity after successful deletion", async () => {
  const api = vi.fn(async () => ({
    can_delete: true,
    last_admin: false,
    rooms: [],
    libraries: [],
  }));
  const p = panel(api);
  await p.controls.begin();
  p.controls.password.value = "secret";
  p.controls.confirmation.value = "DELETE";
  p.controls.open.value = false;
  await Vue.nextTick();
  expect(p.controls.password.value).toBe("");
  expect(p.controls.confirmation.value).toBe("");
  await p.controls.begin();
  p.controls.password.value = "password123";
  p.controls.confirmation.value = "DELETE";
  await p.controls.retire();
  expect(api).toHaveBeenLastCalledWith("/users/me/deletion", "POST", {
    password: "password123",
    confirmation: "DELETE",
  });
  expect(p.session.user).toBeNull();
  expect(p.replace).toHaveBeenCalledWith("/login");
  expect(p.controls.password.value).toBe("");
  p.unmount();
});

it("discards a deletion draft when the active account changes", async () => {
  const api = vi.fn(async () => ({
    can_delete: true,
    last_admin: false,
    rooms: [],
    libraries: [],
  }));
  const p = panel(api);
  await p.controls.begin();
  p.controls.password.value = "password123";
  p.controls.confirmation.value = "DELETE";
  p.session.accept({
    id: "00000000-0000-0000-0000-000000000002",
    username: "other",
    admin: false,
    csrf: "other-csrf",
  });
  await Vue.nextTick();
  expect(p.controls.open.value).toBe(false);
  expect(p.controls.password.value).toBe("");
  expect(p.controls.preview.value).toBeUndefined();
  await expect(p.controls.retire()).rejects.toThrow("账号已变化");
  expect(api).toHaveBeenCalledTimes(1);
  p.unmount();
});
