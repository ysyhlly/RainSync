import { computed, ref } from "vue";
import type { LibraryWorkflow } from "./library-workflow";
export type ChangeKind =
  | "revoke"
  | "revokeShare"
  | "transfer"
  | "attach"
  | "deleteLibrary"
  | "deleteSource";
export interface LibraryChange {
  kind: ChangeKind;
  libraryId: string;
  libraryName: string;
  revision: string;
  target: string;
  targetLabel: string;
  sourceRevision?: string;
}
export const confirmationTitles: Record<ChangeKind, string> = {
  revoke: "撤销账户授权",
  revokeShare: "撤销房间分享",
  transfer: "转移媒体库所有权",
  attach: "迁移片源归属",
  deleteLibrary: "删除私人媒体库",
  deleteSource: "删除片源配置",
};
export const confirmationLabels: Record<ChangeKind, string> = {
  revoke: "确认撤销授权",
  revokeShare: "确认撤销分享",
  transfer: "确认转移所有权",
  attach: "确认迁入当前库",
  deleteLibrary: "确认删除媒体库",
  deleteSource: "确认删除片源",
};
/** Destructive intents keep their original library/source revisions until consumed. */
export function useLibraryChanges(
  ctx: LibraryWorkflow,
  clearLibraryDrafts: () => void,
) {
  const { api, session, selected, selectedId, busy, error, media, run } = ctx;
  const pendingChange = ref<{
    kind: ChangeKind;
    libraryId: string;
    libraryName: string;
    revision: string;
    target: string;
    targetLabel: string;
    sourceRevision?: string;
  } | null>(null);
  const confirmationOpen = computed({
    get: () => pendingChange.value !== null,
    set: (open: boolean) => {
      if (!open) pendingChange.value = null;
    },
  });
  function requestChange(
    kind: ChangeKind,
    target: string,
    targetLabel = target,
  ) {
    const lib = selected.value;
    if (!lib || busy.value || !target.trim()) return;
    if (
      kind === "deleteLibrary" &&
      (lib.visibility !== "private" || lib.owner_id !== session.user?.id)
    )
      return;
    if (
      kind === "deleteSource" &&
      !lib.sources?.find((source) => source.id === target)?.revision
    )
      return;
    error.value = "";
    pendingChange.value = {
      kind,
      libraryId: lib.id,
      libraryName: lib.name,
      revision: lib.revision,
      target: target.trim(),
      targetLabel,
      sourceRevision:
        kind === "deleteSource"
          ? lib.sources?.find((source) => source.id === target)?.revision
          : undefined,
    };
  }
  async function confirmChange() {
    const change = pendingChange.value;
    const lib = selected.value;
    if (!change || !lib || busy.value) return;
    if (change.libraryId !== lib.id || change.revision !== lib.revision) {
      error.value = "媒体库已变化，请关闭确认窗口，核对最新内容后重新操作。";
      return;
    }
    const messages: Record<ChangeKind, string> = {
      revoke: "授权已撤销，相关播放已失效",
      revokeShare: "房间分享已撤销；其他有效分享仍保留，已有播放需重新打开",
      transfer: "所有权已转移，原所有者不保留默认权限",
      attach: "片源归属已迁移。旧授权已失效",
      deleteLibrary: "媒体库已删除，原始媒体文件未删除",
      deleteSource: "片源配置已删除，原始媒体文件未删除",
    };
    await run(async (current) => {
      const args = [change.libraryId, change.target, change.revision] as const;
      if (change.kind === "revoke") await api.revoke(...args);
      else if (change.kind === "revokeShare") await api.revokeShare(...args);
      else if (change.kind === "attach") await api.attach(...args);
      else if (change.kind === "deleteSource") {
        if (!change.sourceRevision) throw new Error("请重新加载片源后操作");
        await api.removeSource(
          change.libraryId,
          change.target,
          change.sourceRevision,
          change.revision,
        );
      } else if (change.kind === "deleteLibrary") {
        await api.remove(change.libraryId, change.revision);
        if (!current()) return;
        clearLibraryDrafts();
        selected.value = null;
        selectedId.value = "";
        media.value = [];
      } else {
        await api.transfer(...args);
        if (!current()) return;
        clearLibraryDrafts();
        selected.value = null;
        selectedId.value = "";
      }
      if (!current()) return;
      // The mutation is complete. A later refresh failure must not leave a
      // live confirmation that could submit the completed action again.
      pendingChange.value = null;
    }, messages[change.kind]);
  }
  return {
    pendingChange,
    confirmationOpen,
    confirmationTitles,
    confirmationLabels,
    requestChange,
    confirmChange,
  };
}
