import { computed, ref } from "vue";
import type { IssuedRoomShare } from "./private-library.api";
import type { LibraryWorkflow } from "./library-workflow";
import { createLibraryRead } from "./library-requests";
/** Issued shares stay withdrawable even after the library itself is inaccessible. */
export function useIssuedShares(ctx: LibraryWorkflow) {
  const { api, session, busy, error, run } = ctx;
  const issuedShares = ref<IssuedRoomShare[]>([]),
    issuedBusy = ref(false),
    issuedError = ref(""),
    issuedHasMore = ref(false),
    withdrawal = ref<IssuedRoomShare>();
  const withdrawalOpen = computed({
    get: () => !!withdrawal.value,
    set: (open: boolean) => {
      if (!open) withdrawal.value = undefined;
    },
  });
  const issuedRead = createLibraryRead(() => session.epoch, ctx.alive);
  async function loadIssuedShares(next = false) {
    if (next && (issuedBusy.value || !issuedHasMore.value)) return;
    const read = issuedRead.begin();
    issuedBusy.value = true;
    issuedError.value = "";
    try {
      const value = await api.issuedShares(
        next ? issuedShares.value.at(-1)?.id : undefined,
        read.signal,
      );
      if (!read.current()) return;
      if (
        !value ||
        !Array.isArray(value.items) ||
        typeof value.has_more !== "boolean" ||
        (value.has_more && value.items.length === 0) ||
        value.items.some(
          (item) =>
            !item ||
            ![item.id, item.library_id, item.media_id, item.room_id].every(
              (id) => typeof id === "string" && id.length > 0,
            ) ||
            typeof item.revision !== "string" ||
            !/^[1-9]\d*$/.test(item.revision) ||
            (item.title !== null && typeof item.title !== "string") ||
            !["room_members", "library_members"].includes(item.mode) ||
            !Number.isSafeInteger(item.expires_at) ||
            typeof item.active !== "boolean",
        )
      )
        throw new Error("分享列表响应不完整，请刷新分享后重试");
      issuedShares.value = next
        ? [...issuedShares.value, ...value.items]
        : value.items;
      issuedHasMore.value = value.has_more;
    } catch (e) {
      if (read.current())
        issuedError.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (read.current()) issuedBusy.value = false;
    }
  }
  function requestWithdrawal(share: IssuedRoomShare) {
    if (!busy.value && !issuedBusy.value) withdrawal.value = { ...share };
  }
  async function confirmWithdrawal() {
    const change = withdrawal.value;
    if (!change || busy.value) return;
    const currentShare = issuedShares.value.find(
      (item) => item.id === change.id,
    );
    if (!currentShare || currentShare.revision !== change.revision) {
      error.value = "分享记录已变化，请关闭确认窗口，刷新后重新操作。";
      return;
    }
    await run(
      async (current) => {
        try {
          await api.revokeShare(change.library_id, change.id, change.revision);
        } catch (e) {
          if (current()) await loadIssuedShares();
          throw e;
        }
        if (!current()) return;
        withdrawal.value = undefined;
        issuedShares.value = issuedShares.value.filter(
          (item) => item.id !== change.id,
        );
      },
      "房间分享已撤销；其他有效分享仍保留，已有播放需重新打开",
      true,
      false,
    );
  }
  function resetIssuedShares() {
    issuedRead.cancel();
    issuedShares.value = [];
    issuedBusy.value = issuedHasMore.value = false;
    issuedError.value = "";
    withdrawal.value = undefined;
  }
  return {
    issuedShares,
    issuedBusy,
    issuedError,
    issuedHasMore,
    withdrawal,
    withdrawalOpen,
    loadIssuedShares,
    requestWithdrawal,
    confirmWithdrawal,
    resetIssuedShares,
  };
}
