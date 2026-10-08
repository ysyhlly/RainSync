import {
  computed,
  onMounted,
  onScopeDispose,
  reactive,
  ref,
  toRefs,
  watch,
} from "vue";
import type { Media } from "../../shared/api/types";
import {
  privateLibraryApi,
  type Library,
  type LibraryDetail,
  type ScanStatus,
} from "./private-library.api";
import { createLibraryRead } from "./library-requests";
import type {
  LibraryRuntime,
  LibrarySession,
  LibraryWorkflow,
} from "./library-workflow";
import { useLibrarySettings } from "./use-library-settings";
import { useLibraryChanges } from "./use-library-changes";
import { useIssuedShares } from "./use-issued-shares";

/** Coordinates selected-library reads and admits one fenced mutation at a time. */
export function usePrivateLibraries(options: {
  session: LibrarySession;
  runtime: LibraryRuntime;
  query: () => Record<string, unknown>;
}) {
  const { session, runtime } = options;
  const api = privateLibraryApi(session.api);
  const libraries = ref<Library[]>([]),
    selected = ref<LibraryDetail | null>(null);
  const enabled = ref(false),
    configurationLoaded = ref(false),
    listBusy = ref(false),
    detailBusy = ref(false);
  const selectedId = ref(""),
    busy = ref(false),
    error = ref(""),
    notice = ref("");
  const media = ref<Media[]>([]),
    mediaBusy = ref(false),
    mediaError = ref("");
  const mediaForm = reactive({ search: "", appliedQuery: "" });
  const { search, appliedQuery } = toRefs(mediaForm);
  const mediaFormModel = computed({
    get: () => mediaForm,
    set: (value: typeof mediaForm) => {
      Object.assign(mediaForm, value);
    },
  });
  const cursor = ref<string>(),
    hasMore = ref(false),
    scans = ref<Record<string, ScanStatus>>({});
  const libraryBrowser = ref<{ refresh(): Promise<unknown> }>();
  let alive = true,
    operationSerial = 0;
  const listRead = createLibraryRead(
    () => session.epoch,
    () => alive,
  );
  const detailRead = createLibraryRead(
    () => session.epoch,
    () => alive,
  );
  const mediaRead = createLibraryRead(
    () => session.epoch,
    () => alive,
  );
  const workflow: LibraryWorkflow = {
    api,
    session,
    runtime,
    selected,
    selectedId,
    busy,
    error,
    notice,
    media,
    scans,
    alive: () => alive,
    selection: () => detailRead.version,
    signal: () => detailRead.signal,
    fail,
    run,
    loadList,
    select,
    loadMedia,
    refreshBrowser: async () => libraryBrowser.value?.refresh(),
  };
  const settings = useLibrarySettings(workflow);
  const changes = useLibraryChanges(workflow, settings.clearLibraryDrafts);
  const issued = useIssuedShares(workflow);
  const canQueue = computed(() => !!runtime.room && runtime.can("queue"));

  function fail(failure: unknown) {
    const code =
      failure && typeof failure === "object" && "code" in failure
        ? String(failure.code)
        : "";
    const messages: Record<string, string> = {
      LIBRARY_MANAGED_SOURCES:
        "库中含有 NAS 设备片源。请管理员先在目标媒体库中明确迁入这些片源，再删除当前库；不会自动迁入共享库或撤销设备。",
      LIBRARY_SHARED_PROTECTED: "实例共享库不能删除。",
      LIBRARY_SHARE_INACTIVE: "这份分享已失效，请重新创建分享。",
      LIBRARY_SHARE_EXPIRY_INVALID:
        "到期时间须晚于现在，且不超过本次分享创建后 24 小时。",
      LIBRARY_CONFLICT: "媒体库已被其他操作修改。请核对最新内容后重新操作。",
      SOURCE_IN_USE:
        "片源仍在播放、准备或清理中。请先停止相关播放，等待清理完成后再删除。",
      SOURCE_CLEANUP_UNCONFIRMED:
        "上游清理结果仍未确认，暂不能删除配置。请管理员检查上游活动和清理记录；单纯等待不会自动解除此限制。",
      SOURCE_CHANGED: "片源配置已变化，请关闭设置并重新打开后再保存。",
      SOURCE_CREDENTIALS_ORIGIN_CHANGED:
        "更换服务域名时，请明确替换或清除已保存请求头，以免将凭据发送到新地址。",
    };
    error.value =
      messages[code] ??
      (failure instanceof Error ? failure.message : String(failure));
  }
  async function loadList() {
    const read = listRead.begin();
    listBusy.value = true;
    try {
      const value = await api.list(read.signal);
      if (!read.current()) return false;
      libraries.value = value.items;
      enabled.value = value.enabled;
      configurationLoaded.value = true;
      return true;
    } finally {
      if (read.current()) listBusy.value = false;
    }
  }
  async function initialize() {
    error.value = "";
    const epoch = session.epoch;
    const list = loadList(),
      request = listRead.version;
    try {
      const [loaded] = await Promise.all([list, issued.loadIssuedShares()]);
      if (!loaded) return;
      const query = options.query();
      const id =
        typeof query.library === "string"
          ? query.library
          : libraries.value[0]?.id;
      if (id) await select(id);
    } catch (failure) {
      if (
        alive &&
        request === listRead.version &&
        epoch === session.epoch &&
        !(failure instanceof DOMException && failure.name === "AbortError")
      )
        fail(failure);
    }
  }
  async function select(id: string) {
    const read = detailRead.begin();
    if (selectedId.value !== id) settings.clearLibraryDrafts();
    selectedId.value = id;
    detailBusy.value = true;
    changes.pendingChange.value = null;
    settings.clearEditors();
    mediaRead.cancel();
    mediaBusy.value = false;
    mediaError.value = "";
    appliedQuery.value = "";
    hasMore.value = false;
    error.value = "";
    selected.value = null;
    media.value = [];
    scans.value = {};
    try {
      const value = await api.detail(id, read.signal);
      if (!read.current()) return;
      selected.value = value;
      settings.editName.value = value.name;
      cursor.value = undefined;
      search.value = "";
      const query = options.query();
      settings.shareMedia.value =
        typeof query.media === "string" ? query.media : "";
      if (value.permissions.browse) await loadMedia(false);
    } catch (failure) {
      if (read.current()) fail(failure);
    } finally {
      if (read.current()) detailBusy.value = false;
    }
  }
  async function refresh() {
    const [loaded] = await Promise.all([loadList(), issued.loadIssuedShares()]);
    if (loaded && selected.value) await select(selected.value.id);
  }
  async function loadMedia(next = false) {
    const lib = selected.value;
    if (!lib || (next && (mediaBusy.value || !hasMore.value))) return;
    const selection = detailRead.version,
      read = mediaRead.begin();
    const query = next ? appliedQuery.value : search.value;
    const signal = detailRead.signal
      ? AbortSignal.any([detailRead.signal, read.signal])
      : read.signal;
    const current = () =>
      read.current() &&
      selection === detailRead.version &&
      !signal.aborted &&
      selected.value?.id === lib.id;
    mediaBusy.value = true;
    mediaError.value = "";
    try {
      const values = await api.media(
        lib.id,
        query,
        next ? cursor.value : undefined,
        signal,
      );
      if (!current()) return;
      media.value = next ? [...media.value, ...values] : values;
      appliedQuery.value = query;
      cursor.value = values.at(-1)?.id;
      hasMore.value = values.length === 50;
    } catch (failure) {
      if (current())
        mediaError.value =
          failure instanceof Error ? failure.message : String(failure);
    } finally {
      if (current()) mediaBusy.value = false;
    }
  }
  async function run(
    action: (current: () => boolean) => Promise<unknown>,
    success: string,
    refreshAfter = true,
    bindSelection = true,
  ) {
    if (busy.value || !alive) return false;
    const operation = ++operationSerial,
      epoch = session.epoch,
      selection = detailRead.version;
    const current = () =>
      alive &&
      operation === operationSerial &&
      epoch === session.epoch &&
      (!bindSelection || selection === detailRead.version);
    busy.value = true;
    error.value = notice.value = "";
    try {
      await action(current);
      if (!current()) return false;
      notice.value = success;
      if (refreshAfter) await refresh();
      return true;
    } catch (failure) {
      if (!current()) return false;
      fail(failure);
      if (selected.value) {
        const id = selected.value.id;
        try {
          const fresh = await api.detail(id, detailRead.signal);
          if (current() && selected.value?.id === id) selected.value = fresh;
        } catch {
          // The mutation's error and form drafts remain authoritative; a
          // best-effort revision read never retries the mutation or hides it.
        }
      }
      return false;
    } finally {
      if (operation === operationSerial && epoch === session.epoch)
        busy.value = false;
    }
  }
  async function choose(id: string) {
    if (canQueue.value) await runtime.run(() => runtime.addQueue(id));
  }
  function clearSession() {
    ++operationSerial;
    listRead.cancel();
    detailRead.cancel();
    mediaRead.cancel();
    settings.clearSensitiveDrafts();
    changes.pendingChange.value = null;
    issued.resetIssuedShares();
    busy.value = listBusy.value = detailBusy.value = mediaBusy.value = false;
    selectedId.value = "";
    configurationLoaded.value = enabled.value = false;
    mediaError.value = "";
    libraries.value = [];
    selected.value = null;
    media.value = [];
    scans.value = {};
    cursor.value = undefined;
    hasMore.value = false;
    mediaForm.search = mediaForm.appliedQuery = "";
  }
  onMounted(initialize);
  watch(() => session.epoch, clearSession, { flush: "sync" });
  onScopeDispose(() => {
    alive = false;
    clearSession();
  });
  return {
    api,
    session,
    runtime,
    libraries,
    selected,
    enabled,
    configurationLoaded,
    listBusy,
    detailBusy,
    selectedId,
    busy,
    error,
    notice,
    media,
    mediaBusy,
    mediaError,
    mediaForm,
    mediaFormModel,
    search,
    appliedQuery,
    cursor,
    hasMore,
    scans,
    libraryBrowser,
    canQueue,
    initialize,
    select,
    refresh,
    loadMedia,
    run,
    choose,
    ...settings,
    ...changes,
    ...issued,
  };
}
