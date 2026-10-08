import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { readFileSync } from "node:fs";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { RequestFailure } from "../apps/web/src/errors";
import { mountSetup } from "./helpers/mount-setup";
import * as helpers from "../apps/web/src/features/admin/admin-settings";
import type {
  AdminSettingsSnapshot,
  AdminSettingsOverrides,
} from "../apps/web/src/features/admin/admin-settings";
import { adminNavigation } from "../apps/web/src/app/navigation";

const defaults = {
  playback_session_limit: 4,
  media_queue_limit: 24,
  registration_validate_per_minute: 60,
  registration_per_ten_minutes: 10,
  registration_mode: "invite_only" as const,
  guests_enabled: false,
};
function fixture(
  revision = "7",
  overrides: Partial<AdminSettingsOverrides> = {},
): AdminSettingsSnapshot {
  const allOverrides = Object.fromEntries(
    helpers.adminSettingKeys.map((key) => [key, overrides[key] ?? null]),
  ) as AdminSettingsOverrides;
  return {
    revision,
    defaults: { ...defaults },
    overrides: allOverrides,
    values: Object.fromEntries(
      helpers.adminSettingKeys.map((key) => [
        key,
        allOverrides[key] ?? defaults[key],
      ]),
    ) as typeof defaults,
    bounds: { min: 1, max: 10000 },
    deployment: {
      private_libraries_enabled: true,
      nas_compute_enabled: false,
      p2p_enabled: false,
      other_live_enabled: false,
      preview: {
        concurrency: 2,
        timeout_seconds: 30,
        cache_bytes: 104857600,
        queue_limit: 128,
        input_bytes: 10485760,
      },
    },
    updated_at: null,
  };
}
function deferred<T = AdminSettingsSnapshot>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
}
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((unmount) => unmount());
  vi.unstubAllGlobals();
});
function panel(api = vi.fn(async () => fixture()), admin = true) {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept({
    id: "admin-one",
    username: "admin-one",
    csrf: "csrf-one",
    admin,
  });
  session.api = api;
  const focus = vi.fn(),
    addEventListener = vi.fn(),
    removeEventListener = vi.fn();
  vi.stubGlobal("document", { getElementById: () => ({ focus }) });
  vi.stubGlobal("window", { addEventListener, removeEventListener });
  let leave!: () => boolean | Promise<boolean>;
  const mounted = mountSetup(
    new URL(
      "../apps/web/src/features/admin/AdminSettingsPage.vue",
      import.meta.url,
    ),
    {
      useSession,
      ...helpers,
      onBeforeRouteLeave: (guard: typeof leave) => {
        leave = guard;
      },
      AppDialog: {},
      AppSelect: {},
      AppIcon: {},
      Notice: {},
    },
  );
  cleanup.push(mounted.unmount);
  return {
    ...mounted,
    c: mounted.controls,
    api,
    session,
    focus,
    leave: () => leave(),
    addEventListener,
    removeEventListener,
  };
}
async function ready(p: ReturnType<typeof panel>) {
  await vi.waitFor(() => expect(p.c.loading.value).toBe(false));
}
function edit(p: ReturnType<typeof panel>, value: string | number = 8) {
  p.c.draft.value.playback_session_limit = { mode: "override", value };
}
const mutations = (api: any) =>
  api.mock.calls.filter((call: any[]) => call[1] === "PATCH");
const reads = (api: any) =>
  api.mock.calls.filter((call: any[]) => call[1] === "GET");

it("loads effective values, keeps default-vs-override identity, and leaves clean pages freely", async () => {
  const p = panel(vi.fn(async () => fixture("7", { media_queue_limit: 24 })));
  await ready(p);
  expect(p.c.detail.value.values).toEqual(defaults);
  expect(p.c.draft.value.media_queue_limit.mode).toBe("override");
  expect(p.c.draft.value.playback_session_limit.mode).toBe("default");
  expect(p.c.dirty.value).toBe(false);
  expect(p.leave()).toBe(true);
  await p.c.save();
  expect(mutations(p.api)).toHaveLength(0);
});

it("sends only changed numeric fields with original CAS revision and prevents repeated pending writes", async () => {
  const pending = deferred();
  let count = 0;
  const p = panel(
    vi.fn(async (_path, method = "GET") =>
      method === "PATCH"
        ? pending.promise
        : ++count === 1
          ? fixture()
          : fixture("8", { playback_session_limit: 8 }),
    ),
  );
  await ready(p);
  edit(p);
  const saved = p.c.save();
  await p.c.save();
  expect(mutations(p.api)).toHaveLength(1);
  expect(mutations(p.api)[0].slice(0, 3)).toEqual([
    "/admin/settings",
    "PATCH",
    { expected_revision: "7", changes: { playback_session_limit: 8 } },
  ]);
  expect(p.leave()).toBe(false);
  expect(p.c.navigationMessage.value).toContain("正在保存");
  pending.resolve(fixture("8", { playback_session_limit: 8 }));
  await saved;
  expect(p.c.dirty.value).toBe(false);
  expect(p.c.message.value).toContain("已保存");
  expect(p.c.detail.value.revision).toBe("8");
  expect(reads(p.api)).toHaveLength(2);
});

it.each([
  "",
  " ",
  0,
  -1,
  10001,
  1.5,
  "invalid",
  Infinity,
  Number.MAX_SAFE_INTEGER,
])("rejects invalid custom value %s before sending", async (value) => {
  const p = panel();
  await ready(p);
  edit(p, value);
  await p.c.save();
  expect(mutations(p.api)).toHaveLength(0);
  expect(p.c.invalidField.value).toBe("playback_session_limit");
  expect(p.focus).toHaveBeenCalled();
  expect(p.c.error.value).toContain("1–10000");
});

it("reset is cancelable and produces explicit null removals only after Save", async () => {
  let server = fixture("7", {
    playback_session_limit: 8,
    media_queue_limit: 24,
  });
  const p = panel(
    vi.fn(async (_path, method = "GET") => {
      if (method === "PATCH") server = fixture("8");
      return server;
    }),
  );
  await ready(p);
  p.c.requestDecision("reset");
  p.c.continueEditing();
  expect(p.c.dirty.value).toBe(false);
  p.c.requestDecision("reset");
  p.c.confirmDecision();
  expect(p.c.changedCount.value).toBe(2);
  expect(p.c.message.value).toContain("保存修改");
  expect(mutations(p.api)).toHaveLength(0);
  await p.c.save();
  expect(mutations(p.api)[0][2]).toEqual({
    expected_revision: "7",
    changes: { playback_session_limit: null, media_queue_limit: null },
  });
  expect(p.c.draft.value.playback_session_limit.mode).toBe("default");
});

it("switching to inherited mode visibly uses the actual deployment default", async () => {
  const p = panel(
    vi.fn(async () => fixture("7", { playback_session_limit: 9 })),
  );
  await ready(p);
  p.c.setMode("playback_session_limit", "default");
  expect(p.c.draft.value.playback_session_limit).toEqual({
    mode: "default",
    value: 4,
  });
  expect(helpers.changedSettings(p.c.draft.value, p.c.detail.value)).toEqual({
    playback_session_limit: null,
  });
});

it("dirty navigation cancellation preserves inputs; newer navigation supersedes the older guard", async () => {
  const p = panel();
  await ready(p);
  edit(p);
  const first = p.leave(),
    second = p.leave();
  await expect(first).resolves.toBe(false);
  p.c.decisionOpen.value = false; // Escape / AppDialog close settles the pending guard.
  await expect(second).resolves.toBe(false);
  expect(p.c.draft.value.playback_session_limit.value).toBe(8);
  const third = p.leave();
  p.c.confirmDecision();
  await expect(third).resolves.toBe(true);
  expect(p.c.dirty.value).toBe(false);
  expect(mutations(p.api)).toHaveLength(0);
});

it("cancel changes requires a decision and never writes", async () => {
  const p = panel();
  await ready(p);
  edit(p);
  p.c.requestDecision("discard");
  await p.c.save();
  expect(mutations(p.api)).toHaveLength(0);
  p.c.continueEditing();
  expect(p.c.dirty.value).toBe(true);
  p.c.requestDecision("discard");
  p.c.confirmDecision();
  expect(p.c.dirty.value).toBe(false);
  expect(mutations(p.api)).toHaveLength(0);
});

it("conflict preserves inputs and revision until explicitly reloaded; failed reload preserves them too", async () => {
  let count = 0;
  const p = panel(
    vi.fn(async (_path, method = "GET") => {
      if (method === "PATCH")
        throw new RequestFailure({ error: "settings_revision_conflict" });
      if (++count === 1) return fixture();
      if (count === 2) throw Error("network");
      return fixture("9", { playback_session_limit: 10 });
    }),
  );
  await ready(p);
  edit(p);
  await p.c.save();
  expect(p.c.conflict.value).toBe(true);
  expect(p.c.detail.value.revision).toBe("7");
  expect(p.c.draft.value.playback_session_limit.value).toBe(8);
  await p.c.save();
  expect(mutations(p.api)).toHaveLength(1);
  p.c.requestDecision("reload");
  p.c.continueEditing();
  expect(reads(p.api)).toHaveLength(1);
  p.c.requestDecision("reload");
  p.c.confirmDecision();
  await ready(p);
  expect(p.c.draft.value.playback_session_limit.value).toBe(8);
  expect(p.c.conflict.value).toBe(true);
  expect(p.c.refreshError.value).toContain("保留");
  p.c.requestDecision("reload");
  p.c.confirmDecision();
  await ready(p);
  expect(p.c.detail.value.revision).toBe("9");
  expect(p.c.draft.value.playback_session_limit.value).toBe(10);
  expect(p.c.conflict.value).toBe(false);
});

it("accepted save survives failed and stale refreshes and retries only reads", async () => {
  let count = 0;
  const updated = fixture("8", { playback_session_limit: 8 });
  const p = panel(
    vi.fn(async (_path, method = "GET") => {
      if (method === "PATCH") return updated;
      count++;
      if (count === 1 || count === 3) return fixture();
      if (count === 2) throw Error("failed refresh");
      return updated;
    }),
  );
  await ready(p);
  edit(p);
  await p.c.save();
  expect(p.c.detail.value.revision).toBe("8");
  expect(p.c.message.value).toContain("已保存");
  expect(p.c.error.value).toBe("");
  expect(p.c.refreshError.value).toContain("无需重复保存");
  expect(p.c.saveStatus.value).toBe("已保存，状态待刷新");
  await p.c.load();
  expect(p.c.detail.value.revision).toBe("8");
  expect(p.c.refreshError.value).toContain("较早版本");
  await p.c.load();
  await p.c.save();
  expect(p.c.refreshError.value).toBe("");
  expect(p.c.saveStatus.value).toBe("管理员设置已同步");
  expect(mutations(p.api)).toHaveLength(1);
});

it.each(["unreadable", "wrong-fields", "old-revision", "network"])(
  "uncertain %s write receipt blocks retries until a fresh read",
  async (mode) => {
    const p = panel(
      vi.fn(async (_path, method = "GET") => {
        if (method !== "PATCH") return fixture();
        if (mode === "network") throw Error("connection lost");
        if (mode === "unreadable") return {} as AdminSettingsSnapshot;
        if (mode === "wrong-fields") return fixture("8");
        return fixture("6", { playback_session_limit: 8 });
      }),
    );
    await ready(p);
    edit(p);
    await p.c.save();
    expect(p.c.uncertain.value).toBe(true);
    expect(p.c.message.value).toBe("");
    expect(p.c.dirty.value).toBe(true);
    await p.c.save();
    expect(mutations(p.api)).toHaveLength(1);
    p.c.requestDecision("reload");
    p.c.confirmDecision();
    await ready(p);
    expect(p.c.uncertain.value).toBe(false);
    expect(p.c.dirty.value).toBe(false);
  },
);

it("server validation rejection allows correction without a false success or forced refresh", async () => {
  const p = panel(
    vi.fn(async (_path, method = "GET") => {
      if (method === "PATCH")
        throw new RequestFailure({ error: "invalid_admin_settings" });
      return fixture();
    }),
  );
  await ready(p);
  edit(p);
  await p.c.save();
  expect(p.c.uncertain.value).toBe(false);
  expect(p.c.error.value).toContain("检查整数范围");
  expect(p.c.message.value).toBe("");
});

it.each(["account", "csrf", "role"])(
  "%s change clears drafts and fences deferred save/refresh",
  async (change) => {
    const pending = deferred();
    const p = panel(
      vi.fn(async (_path, method = "GET") =>
        method === "PATCH" ? pending.promise : fixture(),
      ),
    );
    await ready(p);
    edit(p);
    const saved = p.c.save();
    p.session.accept({
      id: change === "account" ? "admin-two" : "admin-one",
      username: "admin",
      csrf: change === "csrf" ? "csrf-two" : "csrf-one",
      admin: change !== "role",
    });
    expect(p.c.detail.value).toBeUndefined();
    expect(p.c.dirty.value).toBe(false);
    pending.resolve(fixture("8", { playback_session_limit: 8 }));
    await saved;
    expect(p.c.detail.value).toBeUndefined();
    expect(p.c.message.value).toBe("");
    expect(reads(p.api)).toHaveLength(1);
    expect(mutations(p.api)[0][3].aborted).toBe(true);
  },
);

it("profile-only updates preserve drafts and permission loss releases a pending route guard", async () => {
  const p = panel();
  await ready(p);
  edit(p);
  p.session.updateProfile(
    { display_name: "new name", custom_display_name: "new name" },
    "admin-one",
  );
  expect(p.c.dirty.value).toBe(true);
  const leaving = p.leave();
  p.session.clear();
  await expect(leaving).resolves.toBe(true);
  expect(p.c.decision.value).toBe("");
  expect(p.c.detail.value).toBeUndefined();
});

it("non-admins never request settings; server denial removes already displayed state", async () => {
  const blocked = panel(
    vi.fn(async () => fixture()),
    false,
  );
  await ready(blocked);
  expect(blocked.api).not.toHaveBeenCalled();
  let count = 0;
  const p = panel(
    vi.fn(async () => {
      if (++count === 1) return fixture();
      throw new RequestFailure({ error: "admin_required" });
    }),
  );
  await ready(p);
  await p.c.load();
  expect(p.c.detail.value).toBeUndefined();
  expect(p.c.unavailable.value).toBe(true);
  await p.c.save();
  expect(mutations(p.api)).toHaveLength(0);
});

it("initial failure is distinct from empty state and reload recovers", async () => {
  let count = 0;
  const p = panel(
    vi.fn(async () => {
      if (++count === 1) throw Error("secret private path should not leak");
      return fixture();
    }),
  );
  await ready(p);
  expect(p.c.detail.value).toBeUndefined();
  expect(p.c.error.value).toBe("设置读取失败，请检查连接后重试。");
  await p.c.load();
  expect(p.c.detail.value.revision).toBe("7");
});

it("newest read wins, even if aborted older mock responds later", async () => {
  const old = deferred(),
    newer = deferred();
  let count = 0;
  const p = panel(
    vi.fn(async () =>
      ++count === 1 ? fixture() : count === 2 ? old.promise : newer.promise,
    ),
  );
  await ready(p);
  const first = p.c.load(),
    second = p.c.load();
  newer.resolve(fixture("9"));
  await second;
  old.resolve(fixture("8"));
  await first;
  expect(p.c.detail.value.revision).toBe("9");
});

it("unmount aborts requests and fences late write success without another read", async () => {
  const pending = deferred();
  const p = panel(
    vi.fn(async (_path, method = "GET") =>
      method === "PATCH" ? pending.promise : fixture(),
    ),
  );
  await ready(p);
  edit(p);
  const saved = p.c.save();
  cleanup.splice(cleanup.indexOf(p.unmount), 1);
  p.unmount();
  pending.resolve(fixture("8", { playback_session_limit: 8 }));
  await saved;
  expect(p.c.message.value).toBe("");
  expect(reads(p.api)).toHaveLength(1);
  expect(mutations(p.api)[0][3].aborted).toBe(true);
  expect(p.removeEventListener).toHaveBeenCalledWith(
    "beforeunload",
    p.c.beforeUnload,
  );
});

it("beforeunload warns for dirty or pending changes only", async () => {
  const p = panel();
  await ready(p);
  const event = { preventDefault: vi.fn(), returnValue: undefined };
  p.c.beforeUnload(event);
  expect(event.preventDefault).not.toHaveBeenCalled();
  edit(p);
  p.c.beforeUnload(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(event.returnValue).toBe("");
});

describe("bounded public schema and route integration", () => {
  it.each(["revision", "values", "defaults", "bounds", "deployment"])(
    "rejects missing %s",
    (field) => {
      const value = fixture() as any;
      delete value[field];
      expect(() => helpers.checkedSettings(value)).toThrow();
    },
  );
  it("rejects null and inconsistent effective values", () => {
    const value = fixture() as any;
    value.values.playback_session_limit = null;
    value.defaults.playback_session_limit = null;
    expect(() => helpers.checkedSettings(value)).toThrow();
    expect(() =>
      helpers.checkedSettings({
        ...fixture(),
        values: { ...defaults, playback_session_limit: 8 },
      }),
    ).toThrow();
  });
  it("compares large revisions without JS numeric truncation", () => {
    expect(
      helpers.olderSettings(
        fixture("9007199254740992"),
        fixture("9007199254740993"),
      ),
    ).toBe(true);
  });
  it("registers the admin-only page and keeps object management separate", () => {
    expect(adminNavigation[0]).toEqual({
      to: "/admin/settings",
      label: "管理员设置",
      icon: "settings",
    });
    const router = readFileSync(
      new URL("../apps/web/src/app/router.ts", import.meta.url),
      "utf8",
    );
    expect(router).toMatch(
      /path: "\/admin\/settings"[\s\S]*?requiresAdmin: true/,
    );
    expect(router).toContain('{ path: "/admin", redirect: "/admin/settings" }');
    const page = readFileSync(
      new URL(
        "../apps/web/src/features/admin/AdminSettingsPage.vue",
        import.meta.url,
      ),
      "utf8",
    );
    expect(page).toContain("AppSelect");
    expect(page).toContain("AppDialog");
    expect(page).not.toContain("JSON.stringify(detail");
    expect(page).toContain("数据库连接、加密密钥");
    expect(page).toContain('id="settings-deployment"');
    expect(helpers.adminSettingFields[1].unit).toBe("个任务 / 全站");
  });
});

it.each(["registration_mode", "guests_enabled"] as const)(
  "opening %s requires risk confirmation and cancellation writes nothing",
  async (key) => {
    let current = fixture();
    const p = panel(
      vi.fn(async (_path, method = "GET", body?: any) => {
        if (method === "PATCH") current = fixture("8", body.changes);
        return current;
      }),
    );
    await ready(p);
    p.c.draft.value[key] = {
      mode: "override",
      value: key === "registration_mode" ? "open" : true,
    };
    await p.c.save();
    expect(p.c.decision.value).toBe("access");
    expect(mutations(p.api)).toHaveLength(0);
    p.c.continueEditing();
    expect(p.c.dirty.value).toBe(true);
    await p.c.save();
    p.c.confirmDecision();
    await vi.waitFor(() =>
      expect(p.c.saving.value || p.c.loading.value).toBe(false),
    );
    expect(mutations(p.api)).toHaveLength(1);
    expect(mutations(p.api)[0][2]).toEqual({
      expected_revision: "7",
      changes: { [key]: key === "registration_mode" ? "open" : true },
    });
    expect(p.c.dirty.value).toBe(false);
  },
);

it("restoring defaults uses explicit nulls for access policies and never silently enables access", async () => {
  const p = panel(
    vi.fn(async () =>
      fixture("7", { registration_mode: "open", guests_enabled: true }),
    ),
  );
  await ready(p);
  p.c.requestDecision("reset");
  p.c.confirmDecision();
  expect(helpers.changedSettings(p.c.draft.value, p.c.detail.value)).toEqual({
    registration_mode: null,
    guests_enabled: null,
  });
  expect(p.c.draft.value.registration_mode.value).toBe("invite_only");
  expect(p.c.draft.value.guests_enabled.value).toBe(false);
  expect(p.c.openingRegistration.value).toBe(false);
  expect(p.c.enablingGuests.value).toBe(false);
});

it.each(["0", "01", "-1", "1e3", "9223372036854775808"])(
  "rejects noncanonical or out-of-range revision %s",
  (revision) => {
    expect(() => helpers.checkedSettings(fixture(revision))).toThrow();
  },
);

it("rejects malformed access settings without exposing arbitrary values", () => {
  const value = fixture() as any;
  value.values.registration_mode = "unknown";
  expect(() => helpers.checkedSettings(value)).toThrow();
  value.values.registration_mode = "invite_only";
  value.overrides.guests_enabled = "true";
  expect(() => helpers.checkedSettings(value)).toThrow();
});
