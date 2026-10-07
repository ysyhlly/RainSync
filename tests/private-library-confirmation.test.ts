import { mountSetup } from "./helpers/mount-setup";
import * as Vue from "vue";
import { expect, it, vi } from "vitest";
import { privateLibraryApi } from "../apps/web/src/features/private-library/private-library.api";
import { usePrivateLibraries } from "../apps/web/src/features/private-library/use-private-libraries";

function library(id = "private") {
  return {
    id,
    name: "私人片库",
    owner_id: "owner",
    visibility: "private",
    revision: "1",
    permission_epoch: "1",
    permissions: {
      browse: true,
      play: true,
      share_to_room: true,
      manage: true,
    },
    sources: [],
    grants: [],
    room_shares: [],
    audit: [],
  };
}

async function page() {
  const session = Vue.reactive({
    epoch: 0,
    user: { id: "owner", admin: true },
    api: vi.fn(
      async (
        path: string,
        method = "GET",
        _body?: unknown,
        _signal?: AbortSignal,
      ): Promise<any> => {
        if (path === "/libraries") return { enabled: true, items: [library()] };
        if (path.startsWith("/libraries/issued-shares"))
          return { items: [], has_more: false };
        if (path.includes("/media?")) return [];
        return library(path.split("/")[2]);
      },
    ),
  });
  const imports = {
    useRoute: () => ({ query: {} }),
    useSession: () => session,
    useRoomRuntime: () => ({ room: null }),
    privateLibraryApi,
    usePrivateLibraries,
    LibraryManagementPanel: {},
    LibraryMediaPanel: {},
    LibraryRoomSharesPanel: {},
    LibrarySourcesPanel: {},
    LibraryAccessPanel: {},
    IssuedSharesPanel: {},
    LibraryDialogs: {},
    Notice: {},
    QueueFeedback: {},
    AppDialog: {},
    AppIcon: {},
    SourceSettingsDialog: {},
    LibraryBrowser: {},
  };
  const { controls: pageControls, unmount } = mountSetup(
    new URL(
      "../apps/web/src/features/private-library/PrivateLibrariesPage.vue",
      import.meta.url,
    ),
    imports,
  );
  const controls = pageControls.screen;
  await vi.waitFor(() => expect(controls.selected.value?.id).toBe("private"));
  session.api.mockClear();
  return { controls, session, unmount };
}

it.each([
  ["revoke", "viewer", "/libraries/private/grants/viewer", "DELETE"],
  ["revokeShare", "share", "/libraries/private/room-shares/share", "DELETE"],
  ["transfer", "new-owner", "/libraries/private/transfer", "POST"],
  ["attach", "source", "/libraries/private/attach-source", "POST"],
  ["deleteLibrary", "private", "/libraries/private", "DELETE"],
])(
  "requires explicit confirmation for %s, and cancellation sends nothing",
  async (kind, target, path, method) => {
    const p = await page();
    p.controls.requestChange(kind, target);
    expect(p.controls.confirmationOpen.value).toBe(true);
    expect(p.session.api).not.toHaveBeenCalled();
    p.controls.confirmationOpen.value = false;
    await p.controls.confirmChange();
    expect(p.session.api).not.toHaveBeenCalled();
    p.controls.requestChange(kind, target);
    await p.controls.confirmChange();
    const mutation = p.session.api.mock.calls.filter(
      (call) => call[1] === method && call[0] === path,
    );
    expect(mutation).toHaveLength(1);
    expect(mutation[0]?.[2]).toMatchObject({ expected_revision: "1" });
    if (kind === "transfer")
      expect(mutation[0]?.[2]).toMatchObject({ username: target });
    if (kind === "attach")
      expect(mutation[0]?.[2]).toMatchObject({ source_id: target });
    expect(p.controls.confirmationOpen.value).toBe(false);
    p.unmount();
  },
);

it("a superseded library read cannot clear the newer loading state or select its result", async () => {
  const p = await page();
  const releases: ((value: unknown) => void)[] = [];
  const signals: AbortSignal[] = [];
  p.session.api.mockImplementation(async (path, _method, _body, signal) => {
    if (path === "/libraries") {
      signals.push(signal!);
      return new Promise((resolve) => releases.push(resolve));
    }
    if (path.startsWith("/libraries/issued-shares"))
      return { items: [], has_more: false };
    if (path.includes("/media?")) return [];
    return library(path.split("/")[2]);
  });
  const old = p.controls.initialize(),
    newer = p.controls.initialize();
  expect(signals[0].aborted).toBe(true);
  releases[0]({ enabled: true, items: [library("old")] });
  await old;
  expect(p.controls.listBusy.value).toBe(true);
  expect(p.controls.selected.value.id).toBe("private");
  releases[1]({ enabled: true, items: [library("new")] });
  await newer;
  expect(p.controls.selected.value.id).toBe("new");
  expect(p.controls.listBusy.value).toBe(false);
  p.unmount();
});

it("unmount aborts owned reads and late responses cannot restore private state", async () => {
  const p = await page();
  const signals: AbortSignal[] = [],
    releases: (() => void)[] = [];
  p.session.api.mockImplementation(async (path, _method, _body, signal) => {
    signals.push(signal!);
    return new Promise((resolve) =>
      releases.push(() =>
        resolve(
          path === "/libraries"
            ? { enabled: true, items: [library("late")] }
            : path.includes("issued-shares")
              ? { items: [], has_more: false }
              : library("late"),
        ),
      ),
    );
  });
  const detail = p.controls.select("late"),
    initialize = p.controls.initialize();
  p.controls.sourceUrl.value = "https://fixture.invalid/credential-draft";
  p.unmount();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(p.controls.sourceUrl.value).toBe("");
  releases.forEach((release) => release());
  await Promise.all([detail, initialize]);
  expect(p.controls.selected.value).toBeNull();
  expect(p.controls.libraries.value).toEqual([]);
  expect(p.controls.busy.value).toBe(false);
});

it("an old-account initialization error cannot overwrite the new account's feedback", async () => {
  const p = await page();
  let reject!: (failure: Error) => void;
  p.session.api.mockImplementation(async (path) => {
    if (path === "/libraries")
      return new Promise((_resolve, fail) => (reject = fail));
    return { items: [], has_more: false };
  });
  const old = p.controls.initialize();
  p.session.epoch++;
  p.controls.notice.value = "Current account feedback";
  reject(new Error("Previous account read failed"));
  await old;
  expect(p.controls.error.value).toBe("");
  expect(p.controls.notice.value).toBe("Current account feedback");
  p.unmount();
});

it("explicit form model updates retain the refs used by permission commands", async () => {
  const p = await page();
  p.controls.grantFormModel.value = {
    ...p.controls.grantForm,
    grantName: "viewer",
    play: false,
  };
  expect(p.controls.grantName.value).toBe("viewer");
  expect(p.controls.play.value).toBe(false);
  await p.controls.addGrant();
  expect(p.session.api).toHaveBeenCalledWith(
    "/libraries/private/grants",
    "POST",
    expect.objectContaining({
      username: "viewer",
      play: false,
      expected_revision: "1",
    }),
  );
  p.unmount();
});

it("invalidates confirmation when the selected library or active account changes", async () => {
  const p = await page();
  p.controls.requestChange("transfer", "new-owner");
  await p.controls.select("other");
  expect(p.controls.confirmationOpen.value).toBe(false);
  p.session.api.mockClear();
  await p.controls.confirmChange();
  expect(p.session.api).not.toHaveBeenCalled();
  p.controls.requestChange("revoke", "viewer");
  p.session.epoch++;
  expect(p.controls.confirmationOpen.value).toBe(false);
  expect(p.controls.selected.value).toBeNull();
  await p.controls.confirmChange();
  expect(p.session.api).not.toHaveBeenCalled();
  p.unmount();
});

it("does not reuse a confirmation after a revision conflict or retry a mutation automatically", async () => {
  const p = await page();
  p.session.api.mockImplementation(async (path, method = "GET") => {
    if (method === "DELETE") throw new Error("媒体库已变化");
    return { ...library(), revision: "2" };
  });
  p.controls.requestChange("revoke", "viewer");
  await p.controls.confirmChange();
  expect(p.controls.selected.value.revision).toBe("2");
  expect(p.controls.confirmationOpen.value).toBe(true);
  await p.controls.confirmChange();
  expect(p.controls.error.value).toContain("核对最新内容后重新操作");
  expect(
    p.session.api.mock.calls.filter((call) => call[1] === "DELETE"),
  ).toHaveLength(1);
  p.unmount();
});

it("consumes a successful transfer before a failed list refresh and preserves its receipt", async () => {
  const p = await page();
  let transferCount = 0;
  p.session.api.mockImplementation(async (path, method = "GET") => {
    if (path === "/libraries/private/transfer" && method === "POST") {
      transferCount++;
      return { transferred: true };
    }
    if (path === "/libraries") throw new Error("转移后的列表刷新失败");
    return library();
  });
  p.controls.requestChange("transfer", "new-owner");
  await p.controls.confirmChange();
  expect(transferCount).toBe(1);
  expect(p.controls.selected.value).toBeNull();
  expect(p.controls.confirmationOpen.value).toBe(false);
  expect(p.controls.busy.value).toBe(false);
  expect(p.controls.notice.value).toBe("所有权已转移，原所有者不保留默认权限");
  expect(p.controls.error.value).toBe("转移后的列表刷新失败");
  await p.controls.confirmChange();
  expect(transferCount).toBe(1);
  p.session.api.mockImplementation(async () => ({ enabled: true, items: [] }));
  await p.controls.initialize();
  expect(p.controls.libraries.value).toEqual([]);
  expect(p.controls.error.value).toBe("");
  expect(p.controls.notice.value).toBe("所有权已转移，原所有者不保留默认权限");
  expect(transferCount).toBe(1);
  p.unmount();
});

it("prefills an existing account grant and cancellation clears the editing target", async () => {
  const p = await page();
  p.controls.editGrant({
    user_id: "viewer",
    username: "fixed-user",
    browse: false,
    play: true,
    share_to_room: true,
    manage: false,
    expires_at: Date.now() + 2 * 3_600_000,
  });
  expect(p.controls.editingGrant.value).toBe("viewer");
  expect(p.controls.grantName.value).toBe("fixed-user");
  expect(p.controls.browse.value).toBe(false);
  expect(p.controls.shareRight.value).toBe(true);
  expect(p.controls.hours.value).toBe(2);
  p.controls.cancelGrantEdit();
  expect(p.controls.editingGrant.value).toBeUndefined();
  expect(p.session.api).not.toHaveBeenCalled();
  p.unmount();
});

it("requires both source and library revisions when removing a private source", async () => {
  const p = await page();
  p.controls.selected.value.sources = [
    {
      id: "source",
      name: "Private HTTP",
      kind: "http",
      revision: "7",
      access_policy_revision: 2,
    },
  ];
  p.controls.requestChange("deleteSource", "source", "Private HTTP");
  expect(p.session.api).not.toHaveBeenCalled();
  await p.controls.confirmChange();
  expect(p.session.api).toHaveBeenCalledWith(
    "/libraries/private/sources/source",
    "DELETE",
    { expected_revision: "7", expected_library_revision: "1" },
  );
  p.unmount();
});

it("does not expose deletion confirmation for a shared library or non-owner", async () => {
  const p = await page();
  p.controls.selected.value.visibility = "instance_shared";
  p.controls.requestChange("deleteLibrary", "private");
  expect(p.controls.confirmationOpen.value).toBe(false);
  p.controls.selected.value.visibility = "private";
  p.controls.selected.value.owner_id = "other";
  p.controls.requestChange("deleteLibrary", "private");
  expect(p.controls.confirmationOpen.value).toBe(false);
  p.unmount();
});

it("keeps room share identity, validates its original expiry ceiling and fences stale revisions", async () => {
  const p = await page();
  const expires = Date.now() + 60 * 60_000;
  p.controls.editShare({
    id: "share",
    title: "One movie",
    mode: "library_members",
    active: true,
    expires_at: expires,
    max_expires_at: expires + 60 * 60_000,
  });
  expect(p.controls.shareEdit.value.mode).toBe("library_members");
  p.controls.shareEdit.value.expires = p.controls.localDateTime(
    expires + 3 * 60 * 60_000,
  );
  await p.controls.saveShare();
  expect(p.session.api).not.toHaveBeenCalled();
  p.controls.shareEdit.value.expires = p.controls.localDateTime(expires);
  p.controls.selected.value.revision = "2";
  await p.controls.saveShare();
  expect(p.session.api).not.toHaveBeenCalled();
  expect(p.controls.error.value).toContain("重新打开");
  p.unmount();
});

it("consumes successful library deletion even if its list refresh fails", async () => {
  const p = await page();
  p.session.api.mockImplementation(async (path, method = "GET") => {
    if (path === "/libraries/private" && method === "DELETE")
      return { deleted: true };
    throw new Error("列表刷新失败");
  });
  p.controls.sourceUrl.value =
    "https://fixture.invalid/file?secret=deleted-library";
  p.controls.sourceConfig.value =
    '{"headers":{"Authorization":"deleted-library"}}';
  p.controls.requestChange("deleteLibrary", "private");
  await p.controls.confirmChange();
  expect(p.controls.selected.value).toBeNull();
  expect(p.controls.confirmationOpen.value).toBe(false);
  expect(p.controls.sourceUrl.value).toBe("");
  expect(p.controls.sourceConfig.value).toBe("{}");
  expect(p.controls.notice.value).toContain("媒体库已删除");
  await p.controls.confirmChange();
  expect(
    p.session.api.mock.calls.filter((call) => call[1] === "DELETE"),
  ).toHaveLength(1);
  p.unmount();
});

it("clears credential drafts on account change and ignores a late destructive response", async () => {
  const p = await page();
  let finish!: (value: unknown) => void;
  p.session.api.mockImplementation(async (_path, method = "GET") => {
    if (method === "DELETE")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return library();
  });
  p.controls.sourceUrl.value = "https://fixture.invalid/file?secret=sensitive";
  p.controls.sourceConfig.value = '{"headers":{"Authorization":"sensitive"}}';
  p.controls.requestChange("deleteLibrary", "private");
  const saving = p.controls.confirmChange();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  p.session.epoch++;
  expect(p.controls.sourceUrl.value).toBe("");
  expect(p.controls.sourceConfig.value).toBe("{}");
  p.controls.selected.value = library("new-account-library");
  p.controls.notice.value = "New account feedback";
  finish({ deleted: true });
  await saving;
  expect(p.controls.selected.value.id).toBe("new-account-library");
  expect(p.controls.notice.value).toBe("New account feedback");
  expect(p.session.api).toHaveBeenCalledTimes(1);
  p.unmount();
});

it("clears library-scoped credential and sharing drafts before changing libraries", async () => {
  const p = await page();
  p.controls.sourceName.value = "Library A source";
  p.controls.sourceUrl.value = "https://fixture.invalid/file?secret=library-a";
  p.controls.sourceConfig.value = '{"headers":{"Authorization":"library-a"}}';
  p.controls.sourceKind.value = "s3";
  p.controls.attachId.value = "library-a-source";
  p.controls.transferName.value = "library-a-owner";
  p.controls.shareMedia.value = "library-a-media";
  p.controls.shareMode.value = "room_members";
  p.controls.minutes.value = 1440;
  let finish!: (value: unknown) => void;
  p.session.api.mockImplementation(async (path) => {
    if (path === "/libraries/other")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return [];
  });
  const switching = p.controls.select("other");
  expect(p.controls.sourceName.value).toBe("");
  expect(p.controls.sourceUrl.value).toBe("");
  expect(p.controls.sourceConfig.value).toBe("{}");
  expect(p.controls.sourceKind.value).toBe("http");
  expect(p.controls.attachId.value).toBe("");
  expect(p.controls.transferName.value).toBe("");
  expect(p.controls.shareMedia.value).toBe("");
  expect(p.controls.shareMode.value).toBe("library_members");
  expect(p.controls.minutes.value).toBe(120);
  finish(library("other"));
  await switching;
  expect(p.controls.selected.value.id).toBe("other");
  p.unmount();
});

it("restores the least-broad sharing draft when the active account changes", async () => {
  const p = await page();
  p.controls.shareMedia.value = "old-account-media";
  p.controls.shareMode.value = "room_members";
  p.controls.minutes.value = 1440;
  p.session.epoch++;
  expect(p.controls.shareMedia.value).toBe("");
  expect(p.controls.shareMode.value).toBe("library_members");
  expect(p.controls.minutes.value).toBe(120);
  p.unmount();
});

it("lets a former library member confirm withdrawal without selecting an inaccessible library", async () => {
  const p = await page();
  const share = {
    id: "mine",
    library_id: "expired",
    revision: "7",
    media_id: "media",
    room_id: "room",
    title: null,
    mode: "room_members",
    expires_at: Date.now() + 60_000,
    active: false,
  };
  p.controls.selected.value = null;
  p.controls.issuedShares.value = [share];
  p.controls.requestWithdrawal(share);
  expect(p.controls.withdrawalOpen.value).toBe(true);
  expect(p.session.api).not.toHaveBeenCalled();
  p.controls.withdrawalOpen.value = false;
  await p.controls.confirmWithdrawal();
  expect(p.session.api).not.toHaveBeenCalled();
  p.controls.requestWithdrawal(share);
  await p.controls.confirmWithdrawal();
  expect(p.session.api).toHaveBeenCalledWith(
    "/libraries/expired/room-shares/mine",
    "DELETE",
    { expected_revision: "7" },
  );
  expect(p.controls.withdrawalOpen.value).toBe(false);
  await p.controls.confirmWithdrawal();
  expect(
    p.session.api.mock.calls.filter((call) => call[1] === "DELETE"),
  ).toHaveLength(1);
  p.unmount();
});

it("refreshes a conflicting own-share revision without retrying the withdrawal", async () => {
  const p = await page();
  const share = {
    id: "mine",
    library_id: "private",
    revision: "7",
    media_id: "media",
    room_id: "room",
    title: null,
    mode: "room_members",
    expires_at: Date.now() + 60_000,
    active: true,
  };
  p.controls.issuedShares.value = [share];
  p.session.api.mockImplementation(async (path, method = "GET") => {
    if (method === "DELETE") throw new Error("revision conflict");
    if (path === "/libraries/issued-shares")
      return { items: [{ ...share, revision: "8" }], has_more: false };
    return library();
  });
  p.controls.requestWithdrawal(share);
  await p.controls.confirmWithdrawal();
  await p.controls.confirmWithdrawal();
  expect(p.controls.error.value).toContain("分享记录已变化");
  expect(
    p.session.api.mock.calls.filter((call) => call[1] === "DELETE"),
  ).toHaveLength(1);
  p.session.epoch++;
  expect(p.controls.withdrawalOpen.value).toBe(false);
  expect(p.controls.issuedShares.value).toEqual([]);
  p.unmount();
});

it("discards an issued-share response after an identity switch", async () => {
  const p = await page();
  let resolve!: (value: unknown) => void;
  p.session.api.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const loading = p.controls.loadIssuedShares();
  p.session.epoch++;
  resolve({ items: [{ id: "previous-account-share" }], has_more: true });
  await loading;
  expect(p.controls.issuedShares.value).toEqual([]);
  expect(p.controls.issuedHasMore.value).toBe(false);
  expect(p.controls.issuedBusy.value).toBe(false);
  p.unmount();
});

it.each(["http", "s3"])(
  "uses the scoped settings and deletion routes for shared %s",
  async (kind) => {
    const p = await page();
    p.controls.selected.value.visibility = "instance_shared";
    const source = {
      id: "shared-source",
      name: "Shared source",
      kind,
      revision: "4",
      access_policy_revision: 1,
    };
    p.controls.selected.value.sources = [source];
    p.session.api.mockImplementation(async (path, method = "GET") => {
      if (path.endsWith("/sources/shared-source") && method === "GET")
        return {
          ...source,
          config: { url: "https://fixture.example", s3: { bucket: "fixture" } },
          credentials: {},
        };
      if (path === "/libraries/issued-shares")
        return { items: [], has_more: false };
      if (path === "/libraries") return { enabled: true, items: [library()] };
      return library();
    });
    await p.controls.editSource(source);
    if (kind === "s3")
      expect(p.session.api).toHaveBeenCalledWith(
        "/libraries/private/sources/shared-source",
        "GET",
        undefined,
        expect.any(AbortSignal),
      );
    else expect(p.controls.settingsSource.value).toEqual(source);
    p.controls.requestChange("deleteSource", source.id, source.name);
    await p.controls.confirmChange();
    expect(p.session.api).toHaveBeenCalledWith(
      "/libraries/private/sources/shared-source",
      "DELETE",
      { expected_revision: "4", expected_library_revision: "1" },
    );
    p.unmount();
  },
);

it.each([
  {},
  { items: null, has_more: false },
  { items: [], has_more: "false" },
  { items: [], has_more: true },
  { items: [null], has_more: false },
  { items: [{ id: "incomplete-share" }], has_more: false },
])(
  "keeps valid library and share state when an issued-share page is malformed: %j",
  async (malformed) => {
    const p = await page();
    const share = {
      id: "mine",
      library_id: "private",
      revision: "7",
      media_id: "media",
      room_id: "room",
      title: null,
      mode: "room_members",
      expires_at: Date.now() + 60_000,
      active: false,
    };
    p.controls.issuedShares.value = [share];
    p.controls.issuedHasMore.value = true;
    p.session.api
      .mockResolvedValueOnce(malformed)
      .mockResolvedValueOnce({ items: [share], has_more: false });
    await p.controls.loadIssuedShares();
    expect(p.controls.selected.value.id).toBe("private");
    expect(p.controls.issuedShares.value).toEqual([share]);
    expect(p.controls.issuedHasMore.value).toBe(true);
    expect(p.controls.issuedError.value).toBe(
      "分享列表响应不完整，请刷新分享后重试",
    );
    expect(p.controls.issuedBusy.value).toBe(false);
    await p.controls.loadIssuedShares();
    expect(p.controls.issuedShares.value).toEqual([share]);
    expect(p.controls.issuedError.value).toBe("");
    expect(p.controls.issuedHasMore.value).toBe(false);
    expect(p.session.api.mock.calls.every((call) => call[1] === "GET")).toBe(
      true,
    );
    p.unmount();
  },
);
