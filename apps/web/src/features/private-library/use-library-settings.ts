import { computed, reactive, ref, toRefs } from "vue";
import type {
  LibraryGrant,
  LibrarySource,
  RoomShare,
} from "./private-library.api";
import type { SourceSettingsSaved } from "../admin/source-settings";
import type { LibraryWorkflow } from "./library-workflow";
export interface LibraryBasicsDraft {
  createName: string;
  editName: string;
  transferName: string;
}
export interface LibrarySourceDraft {
  sourceName: string;
  sourceKind: string;
  sourceUrl: string;
  sourceConfig: string;
  attachId: string;
}
export interface LibraryGrantDraft {
  grantName: string;
  hours: number;
  editingGrant: string | undefined;
  browse: boolean;
  play: boolean;
  shareRight: boolean;
  manage: boolean;
}
export interface LibrarySharingDraft {
  shareMedia: string;
  shareMode: "room_members" | "library_members";
  minutes: number;
}
export interface ShareSettingsDraft {
  id: string;
  libraryId: string;
  revision: string;
  title: string;
  mode: RoomShare["mode"];
  expires: string;
  maxExpires: number;
}
export interface S3SettingsDraft {
  id: string;
  libraryId: string;
  revision: string;
  name: string;
  url: string;
  urlRedacted: boolean;
  replaceUrl: boolean;
  config: string;
  originalConfig: string;
  originalUrl: string;
}

export function localDateTime(value: number) {
  const date = new Date(value);
  return new Date(value - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
/** Library-scoped drafts and settings commands share the coordinator's mutation fence. */
export function useLibrarySettings(ctx: LibraryWorkflow) {
  const {
    api,
    session,
    selected,
    busy,
    error,
    notice,
    scans,
    run,
    loadList,
    select,
    loadMedia,
    fail,
  } = ctx;
  const libraryForm = reactive<LibraryBasicsDraft>({
    createName: "",
    editName: "",
    transferName: "",
  });
  const sourceForm = reactive<LibrarySourceDraft>({
    sourceName: "",
    sourceKind: "http",
    sourceUrl: "",
    sourceConfig: "{}",
    attachId: "",
  });
  const grantForm = reactive<LibraryGrantDraft>({
    grantName: "",
    hours: 168,
    editingGrant: undefined,
    browse: true,
    play: true,
    shareRight: false,
    manage: false,
  });
  const shareForm = reactive<LibrarySharingDraft>({
    shareMedia: "",
    shareMode: "library_members",
    minutes: 120,
  });
  const { createName, editName, transferName } = toRefs(libraryForm);
  const { sourceName, sourceKind, sourceUrl, sourceConfig, attachId } =
    toRefs(sourceForm);
  const { grantName, hours, editingGrant, browse, play, shareRight, manage } =
    toRefs(grantForm);
  const { shareMedia, shareMode, minutes } = toRefs(shareForm);
  const settingsSource = ref<LibrarySource>(),
    shareEdit = ref<ShareSettingsDraft>(),
    s3Edit = ref<S3SettingsDraft>();
  const shareEditOpen = computed({
    get: () => !!shareEdit.value,
    set: (value: boolean) => {
      if (!value) shareEdit.value = undefined;
    },
  });
  const s3EditOpen = computed({
    get: () => !!s3Edit.value,
    set: (value: boolean) => {
      if (!value) s3Edit.value = undefined;
    },
  });
  function editGrant(grant: LibraryGrant) {
    if (busy.value) return;
    editingGrant.value = grant.user_id;
    grantName.value = grant.username;
    browse.value = grant.browse;
    play.value = grant.play;
    shareRight.value = grant.share_to_room;
    manage.value = grant.manage;
    hours.value = Math.max(
      1,
      Math.min(720, Math.ceil((grant.expires_at - Date.now()) / 3_600_000)),
    );
  }
  function cancelGrantEdit() {
    editingGrant.value = undefined;
    grantName.value = "";
    browse.value = play.value = true;
    shareRight.value = manage.value = false;
    hours.value = 168;
  }
  function editShare(share: RoomShare) {
    const lib = selected.value;
    if (!lib || busy.value || !share.active) return;
    error.value = "";
    shareEdit.value = {
      id: share.id,
      libraryId: lib.id,
      revision: lib.revision,
      title: share.title,
      mode: share.mode,
      expires: localDateTime(share.expires_at),
      maxExpires: share.max_expires_at,
    };
  }
  async function saveShare() {
    const draft = shareEdit.value,
      lib = selected.value;
    if (!draft || !lib || busy.value) return;
    if (draft.libraryId !== lib.id || draft.revision !== lib.revision) {
      error.value = "媒体库已变化，请关闭设置并重新打开后再保存。";
      return;
    }
    const expires = new Date(draft.expires).getTime();
    if (
      !Number.isFinite(expires) ||
      expires <= Date.now() ||
      expires > draft.maxExpires
    ) {
      error.value = "到期时间须晚于现在，且不超过本次分享创建后 24 小时。";
      return;
    }
    await run(async (current) => {
      await api.updateShare(lib.id, draft.id, {
        mode: draft.mode,
        expires_at: expires,
        expected_revision: draft.revision,
      });
      if (current()) shareEdit.value = undefined;
    }, "分享设置已保存，已有播放需重新打开；其他有效分享仍保留");
  }
  async function editSource(source: LibrarySource) {
    const lib = selected.value;
    if (!lib || busy.value) return;
    if (source.kind === "http") {
      settingsSource.value = source;
      return;
    }
    if (source.kind !== "s3") return;
    const selection = ctx.selection();
    await run(
      async () => {
        const value = await api.sourceSettings(lib.id, source.id, ctx.signal());
        if (
          !ctx.alive() ||
          selection !== ctx.selection() ||
          selected.value?.id !== lib.id
        )
          return;
        const config = JSON.stringify(value.config.s3, null, 2);
        s3Edit.value = {
          id: value.id,
          libraryId: lib.id,
          revision: value.revision,
          name: value.name,
          url: value.config.url ?? "",
          urlRedacted: !!value.credentials.url_redacted,
          replaceUrl: false,
          config,
          originalConfig: config,
          originalUrl: value.config.url ?? "",
        };
      },
      "",
      false,
    );
  }
  async function saveS3() {
    const draft = s3Edit.value,
      lib = selected.value;
    if (!draft || !lib || draft.libraryId !== lib.id || busy.value) return;
    await run(async (current) => {
      const config: Record<string, unknown> = {};
      if (session.user?.admin) {
        if (draft.config !== draft.originalConfig)
          config.s3 = JSON.parse(draft.config);
        if (
          (!draft.urlRedacted && draft.url !== draft.originalUrl) ||
          draft.replaceUrl
        )
          config.url = draft.url;
      }
      await api.updateSource(lib.id, draft.id, {
        name: draft.name,
        expected_revision: draft.revision,
        ...(Object.keys(config).length ? { config } : {}),
      });
      if (current()) s3Edit.value = undefined;
    }, "片源设置已保存。连接配置变化后需重新扫描");
  }
  async function sourceSaved(value: SourceSettingsSaved) {
    notice.value = value.rescan_required
      ? "片源设置已保存，请重新扫描索引"
      : "片源名称已保存";
    // Keep the settings dialog open; update only its enclosing library revision.
    const id = selected.value?.id,
      selection = ctx.selection();
    if (!id) return;
    try {
      const detail = await api.detail(id, ctx.signal());
      if (
        ctx.alive() &&
        selection === ctx.selection() &&
        selected.value?.id === id
      )
        selected.value = detail;
    } catch (e) {
      if (selection === ctx.selection()) fail(e);
    }
  }
  async function create() {
    await run(
      async (current) => {
        const value = await api.create(createName.value);
        if (!current()) return;
        createName.value = "";
        if ((await loadList()) && current()) await select(value.id);
      },
      "私人媒体库已创建",
      false,
      false,
    );
  }
  async function addGrant() {
    const lib = selected.value;
    if (lib)
      await run(
        () =>
          api.grant(lib.id, {
            username: grantName.value,
            browse: browse.value,
            play: play.value,
            share_to_room: shareRight.value,
            manage: manage.value,
            expires_in_hours: hours.value,
            expected_revision: lib.revision,
          }),
        "授权已保存。旧播放与分享已失效，请重新分享",
      );
  }
  function addSource() {
    const lib = selected.value;
    if (!lib) return;
    void run(async (current) => {
      const config = JSON.parse(sourceConfig.value);
      if (!config || typeof config !== "object" || Array.isArray(config))
        throw new Error("片源配置必须是 JSON 对象");
      await api.source(lib.id, {
        name: sourceName.value,
        kind: sourceKind.value,
        config: { ...config, url: sourceUrl.value },
      });
      if (current()) {
        sourceName.value = sourceUrl.value = "";
        sourceConfig.value = "{}";
      }
    }, "片源已添加，请扫描索引");
  }
  function scan(source: string, restart: boolean) {
    const lib = selected.value;
    if (!lib) return;
    void run(
      async (current) => {
        const status = await api.scan(lib.id, source, restart);
        if (!current()) return;
        scans.value[source] = status;
        await loadMedia(false);
        if (current()) await ctx.refreshBrowser();
      },
      "本页索引已保存，可继续扫描",
      false,
    );
  }
  function share() {
    const lib = selected.value,
      room = ctx.runtime.room;
    if (!lib || !room) return;
    void run(
      async () => {
        const result = await api.share(lib.id, {
          media_id: shareMedia.value,
          room_id: room.id,
          mode: shareMode.value,
          expires_in_minutes: minutes.value,
          expected_revision: lib.revision,
        });
        lib.revision = result.revision;
      },
      "当前影片的房间授权已建立",
      true,
    );
  }
  function clearLibraryDrafts() {
    sourceUrl.value = sourceName.value = attachId.value = "";
    sourceConfig.value = "{}";
    sourceKind.value = "http";
    editName.value = transferName.value = "";
    shareMedia.value = "";
    shareMode.value = "library_members";
    minutes.value = 120;
    settingsSource.value = undefined;
    s3Edit.value = undefined;
    shareEdit.value = undefined;
    cancelGrantEdit();
  }
  function clearSensitiveDrafts() {
    clearLibraryDrafts();
    createName.value = "";
    error.value = notice.value = "";
  }
  function clearEditors() {
    settingsSource.value = undefined;
    s3Edit.value = undefined;
    shareEdit.value = undefined;
    cancelGrantEdit();
  }
  async function readScanStatus(source: string) {
    const lib = selected.value;
    if (!lib) return;
    await run(
      async (current) => {
        const status = await api.scanStatus(lib.id, source);
        if (current()) scans.value[source] = status;
      },
      "扫描状态已更新",
      false,
    );
  }
  async function rename() {
    const lib = selected.value;
    if (lib)
      await run(
        () => api.rename(lib.id, editName.value, lib.revision),
        "名称已保存",
      );
  }
  const libraryFormModel = computed({
    get: () => libraryForm,
    set: (value: typeof libraryForm) => {
      Object.assign(libraryForm, value);
    },
  });
  const sourceFormModel = computed({
    get: () => sourceForm,
    set: (value: typeof sourceForm) => {
      Object.assign(sourceForm, value);
    },
  });
  const grantFormModel = computed({
    get: () => grantForm,
    set: (value: typeof grantForm) => {
      Object.assign(grantForm, value);
    },
  });
  const shareFormModel = computed({
    get: () => shareForm,
    set: (value: typeof shareForm) => {
      Object.assign(shareForm, value);
    },
  });
  return {
    readScanStatus,
    libraryFormModel,
    sourceFormModel,
    grantFormModel,
    shareFormModel,
    libraryForm,
    sourceForm,
    grantForm,
    shareForm,
    createName,
    editName,
    grantName,
    transferName,
    hours,
    editingGrant,
    browse,
    play,
    shareRight,
    manage,
    sourceName,
    sourceKind,
    sourceUrl,
    sourceConfig,
    attachId,
    shareMedia,
    shareMode,
    minutes,
    settingsSource,
    shareEdit,
    s3Edit,
    shareEditOpen,
    s3EditOpen,
    localDateTime,
    clearEditors,
    rename,
    editGrant,
    cancelGrantEdit,
    editShare,
    saveShare,
    editSource,
    saveS3,
    sourceSaved,
    create,
    addGrant,
    addSource,
    scan,
    share,
    clearLibraryDrafts,
    clearSensitiveDrafts,
  };
}
