<script setup lang="ts">
import QueueFeedback from "../rooms/QueueFeedback.vue";
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { useRoute } from "vue-router";
import { useSession } from "../auth/session.store";
import { useRoomRuntime } from "../rooms/room-runtime";
import {
  privateLibraryApi,
  type Library,
  type LibraryDetail,
  type ScanStatus,
} from "./private-library.api";
import type { Media } from "../../shared/api/types";
import Notice from "../../shared/ui/Notice.vue";
import AppDialog from "../../shared/ui/AppDialog.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
const session = useSession(),
  runtime = useRoomRuntime(),
  route = useRoute(),
  api = privateLibraryApi(session.api);
const libraries = ref<Library[]>([]),
  selected = ref<LibraryDetail | null>(null),
  enabled = ref(false),
  configurationLoaded = ref(false),
  listBusy = ref(false),
  detailBusy = ref(false),
  selectedId = ref(""),
  busy = ref(false),
  error = ref(""),
  notice = ref("");
const createName = ref(""),
  editName = ref(""),
  grantName = ref(""),
  transferName = ref(""),
  hours = ref(168);
const browse = ref(true),
  play = ref(true),
  shareRight = ref(false),
  manage = ref(false);
const sourceName = ref(""),
  sourceKind = ref("http"),
  sourceUrl = ref(""),
  sourceConfig = ref("{}"),
  attachId = ref("");
const media = ref<Media[]>([]),
  search = ref(""),
  appliedQuery = ref(""),
  mediaBusy = ref(false),
  mediaError = ref(""),
  cursor = ref<string>(),
  hasMore = ref(false),
  scans = ref<Record<string, ScanStatus>>({});
const shareMedia = ref(""),
  shareMode = ref<"room_members" | "library_members">("library_members"),
  minutes = ref(120);
type ChangeKind = "revoke" | "revokeShare" | "transfer" | "attach";
const pendingChange = ref<{
  kind: ChangeKind;
  libraryId: string;
  libraryName: string;
  revision: string;
  target: string;
  targetLabel: string;
} | null>(null);
const confirmationOpen = computed({
  get: () => pendingChange.value !== null,
  set: (open: boolean) => {
    if (!open) pendingChange.value = null;
  },
});
const confirmationTitles: Record<ChangeKind, string> = {
  revoke: "撤销账户授权",
  revokeShare: "撤销房间分享",
  transfer: "转移媒体库所有权",
  attach: "迁移片源归属",
};
const confirmationLabels: Record<ChangeKind, string> = {
  revoke: "确认撤销授权",
  revokeShare: "确认撤销分享",
  transfer: "确认转移所有权",
  attach: "确认迁入当前库",
};
let alive = true,
  listSerial = 0,
  listController: AbortController | undefined,
  serial = 0,
  controller: AbortController | undefined,
  mediaSerial = 0,
  mediaController: AbortController | undefined;
function fail(e: unknown) {
  error.value = e instanceof Error ? e.message : String(e);
}
async function loadList() {
  const mine = ++listSerial;
  listController?.abort();
  listController = new AbortController();
  listBusy.value = true;
  try {
    const value = await api.list(listController.signal);
    if (!alive || mine !== listSerial) return false;
    libraries.value = value.items;
    enabled.value = value.enabled;
    configurationLoaded.value = true;
    return true;
  } finally {
    if (mine === listSerial) listBusy.value = false;
  }
}
async function initialize() {
  error.value = "";
  try {
    if (!(await loadList())) return;
    const id =
      typeof route.query.library === "string"
        ? route.query.library
        : libraries.value[0]?.id;
    if (id) await select(id);
  } catch (e) {
    if (alive && !(e instanceof DOMException && e.name === "AbortError"))
      fail(e);
  }
}
async function select(id: string) {
  const mine = ++serial;
  selectedId.value = id;
  detailBusy.value = true;
  pendingChange.value = null;
  controller?.abort();
  ++mediaSerial;
  mediaController?.abort();
  mediaBusy.value = false;
  mediaError.value = "";
  appliedQuery.value = "";
  hasMore.value = false;
  controller = new AbortController();
  error.value = "";
  selected.value = null;
  media.value = [];
  scans.value = {};
  try {
    const value = await api.detail(id, controller.signal);
    if (mine !== serial) return;
    selected.value = value;
    editName.value = value.name;
    cursor.value = undefined;
    search.value = "";
    shareMedia.value =
      typeof route.query.media === "string" ? route.query.media : "";
    if (value.permissions.browse) await loadMedia(false);
  } catch (e) {
    if (mine === serial && !controller.signal.aborted) fail(e);
  } finally {
    if (mine === serial) detailBusy.value = false;
  }
}
async function refresh() {
  if (!(await loadList())) return;
  if (selected.value) await select(selected.value.id);
}
async function loadMedia(next = false) {
  const lib = selected.value;
  if (!lib || (next && (mediaBusy.value || !hasMore.value))) return;
  const id = lib.id,
    selection = serial,
    mine = ++mediaSerial,
    query = next ? appliedQuery.value : search.value;
  mediaController?.abort();
  mediaController = new AbortController();
  const signal = controller
    ? AbortSignal.any([controller.signal, mediaController.signal])
    : mediaController.signal;
  mediaBusy.value = true;
  mediaError.value = "";
  try {
    const values = await api.media(
      id,
      query,
      next ? cursor.value : undefined,
      signal,
    );
    if (
      mine !== mediaSerial ||
      selection !== serial ||
      signal.aborted ||
      selected.value?.id !== id
    )
      return;
    media.value = next ? [...media.value, ...values] : values;
    appliedQuery.value = query;
    cursor.value = values.at(-1)?.id;
    hasMore.value = values.length === 50;
  } catch (e) {
    if (mine === mediaSerial && selection === serial && !signal.aborted)
      mediaError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (mine === mediaSerial) mediaBusy.value = false;
  }
}
async function run(
  action: () => Promise<unknown>,
  success: string,
  refreshAfter = true,
) {
  if (busy.value) return false;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await action();
    notice.value = success;
    if (refreshAfter) await refresh();
    return true;
  } catch (e) {
    fail(e); // Preserve form drafts. Read current revision, but never retry the mutation.
    if (selected.value) {
      try {
        const fresh = await api.detail(selected.value.id);
        selected.value = fresh;
      } catch {}
    }
    return false;
  } finally {
    busy.value = false;
  }
}
async function create() {
  await run(
    async () => {
      const value = await api.create(createName.value);
      createName.value = "";
      await loadList();
      await select(value.id);
    },
    "私人媒体库已创建",
    false,
  );
}
function addGrant() {
  const lib = selected.value;
  if (lib)
    void run(
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
  void run(() => {
    const config = JSON.parse(sourceConfig.value);
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error("片源配置必须是 JSON 对象");
    return api.source(lib.id, {
      name: sourceName.value,
      kind: sourceKind.value,
      config: { ...config, url: sourceUrl.value },
    });
  }, "片源已添加，请扫描索引");
}
function scan(source: string, restart: boolean) {
  const lib = selected.value;
  if (!lib) return;
  void run(
    async () => {
      scans.value[source] = await api.scan(lib.id, source, restart);
      await loadMedia(false);
    },
    "本页索引已保存，可继续扫描",
    false,
  );
}
function share() {
  const lib = selected.value,
    room = runtime.room;
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
const canQueue = computed(() => !!runtime.room && runtime.can("queue"));
async function choose(id: string) {
  if (!canQueue.value) return;
  await runtime.run(() => runtime.addQueue(id));
}
function requestChange(kind: ChangeKind, target: string, targetLabel = target) {
  const lib = selected.value;
  if (!lib || busy.value || !target.trim()) return;
  error.value = "";
  pendingChange.value = {
    kind,
    libraryId: lib.id,
    libraryName: lib.name,
    revision: lib.revision,
    target: target.trim(),
    targetLabel,
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
    revokeShare: "房间分享已撤销",
    transfer: "所有权已转移，原所有者不保留默认权限",
    attach: "片源归属已迁移。旧授权已失效",
  };
  await run(async () => {
    const args = [change.libraryId, change.target, change.revision] as const;
    if (change.kind === "revoke") await api.revoke(...args);
    else if (change.kind === "revokeShare") await api.revokeShare(...args);
    else if (change.kind === "attach") await api.attach(...args);
    else {
      await api.transfer(...args);
      selected.value = null;
      selectedId.value = "";
      transferName.value = "";
    }
    // The mutation is complete. A later refresh failure must not leave a
    // live confirmation that could submit the completed action again.
    pendingChange.value = null;
  }, messages[change.kind]);
}
onMounted(initialize);
watch(
  () => session.epoch,
  () => {
    ++listSerial;
    listController?.abort();
    listBusy.value = false;
    detailBusy.value = false;
    selectedId.value = "";
    pendingChange.value = null;
    ++serial;
    controller?.abort();
    ++mediaSerial;
    mediaController?.abort();
    configurationLoaded.value = false;
    enabled.value = false;
    mediaBusy.value = false;
    mediaError.value = "";
    libraries.value = [];
    selected.value = null;
    media.value = [];
  },
  { flush: "sync" },
);
onBeforeUnmount(() => {
  alive = false;
  ++listSerial;
  listController?.abort();
  ++serial;
  controller?.abort();
  ++mediaSerial;
  mediaController?.abort();
});
</script>
<template>
  <section class="page private-library-page">
    <div class="page-title">
      <div class="page-intro">
        <p class="section-label">观看区</p>
        <h1>我的媒体库与授权</h1>
        <p>管理可访问的影片、片源和共享范围。房间分享只授权指定影片。</p>
      </div>
      <RouterLink to="/library" class="button"
        ><AppIcon name="movie" />浏览影片</RouterLink
      >
    </div>
    <div class="page-stack">
      <div
        v-if="error && !confirmationOpen"
        class="surface-card surface-card--compact"
      >
        <Notice :message="error" error />
        <button
          v-if="!selected"
          :disabled="listBusy || detailBusy"
          @click="selectedId ? select(selectedId) : initialize()"
        >
          <AppIcon name="refresh" />重新加载媒体库
        </button>
      </div>
      <Notice :message="notice" />
      <p v-if="configurationLoaded && !enabled" class="notice">
        私人库创建与分享未开启。管理员可在部署配置中开启
        PRIVATE_LIBRARIES_ENABLED。
      </p>
      <div
        v-if="listBusy && !configurationLoaded"
        class="loading-state"
        role="status"
      >
        正在加载媒体库…
      </div>
      <div
        v-if="configurationLoaded && !libraries.length"
        class="empty-state empty-state--compact surface-card"
      >
        <span class="empty-state__icon"
          ><AppIcon name="movie" :size="28"
        /></span>
        <h2>还没有可访问的媒体库</h2>
        <p>
          {{
            enabled
              ? "在下方创建私人库并添加片源，或请库所有者向你的固定登录账号授权。"
              : "请管理员确认可访问的片源与媒体库授权。"
          }}
        </p>
      </div>
      <div class="library-workspace">
        <div class="library-management page-stack">
          <form
            v-if="enabled"
            class="surface-card surface-card--compact library-create"
            @submit.prevent="create"
          >
            <div>
              <h2>创建私人库</h2>
              <p class="helper">片源与授权独立管理</p>
            </div>
            <label
              >名称<input
                v-model="createName"
                maxlength="100"
                required
                placeholder="例如：家庭影院"
            /></label>
            <button class="primary" :disabled="busy || !createName.trim()">
              <AppIcon name="plus" />创建
            </button>
          </form>
          <section
            v-if="libraries.length"
            class="surface-card surface-card--compact library-picker"
          >
            <div class="section-heading">
              <h2>选择媒体库</h2>
              <span class="helper"
                >{{ libraries.length }} 个可访问的媒体库</span
              >
            </div>
            <nav aria-label="媒体库选择" class="library-tabs segmented-nav">
              <button
                v-for="library in libraries"
                :key="library.id"
                :aria-pressed="selectedId === library.id"
                :disabled="busy"
                @click="select(library.id)"
              >
                <AppIcon name="movie" :size="18" />
                {{ library.name }} ·
                {{ library.visibility === "private" ? "私人" : "实例共享" }}
              </button>
            </nav>
          </section>
          <section v-if="selected" class="surface-card library-summary">
            <div class="section-heading">
              <div class="section-heading__copy">
                <p class="section-label">当前媒体库</p>
                <h2>{{ selected.name }}</h2>
                <p class="helper">权限版本 {{ selected.permission_epoch }}</p>
              </div>
              <div class="button-row">
                <span class="status-badge">{{
                  selected.visibility === "private" ? "私人媒体库" : "实例共享"
                }}</span>
                <span
                  class="status-badge"
                  :class="{
                    'status-badge--success': selected.permissions.browse,
                  }"
                  >{{
                    selected.permissions.browse ? "可浏览" : "不可浏览"
                  }}</span
                >
                <span
                  class="status-badge"
                  :class="{
                    'status-badge--success': selected.permissions.play,
                  }"
                  >{{ selected.permissions.play ? "可播放" : "不可播放" }}</span
                >
              </div>
            </div>
            <form
              v-if="selected.permissions.manage"
              class="library-inline-form"
              @submit.prevent="
                run(
                  () => api.rename(selected!.id, editName, selected!.revision),
                  '名称已保存',
                )
              "
            >
              <label
                >媒体库名称<input v-model="editName" maxlength="100" required
              /></label>
              <button :disabled="busy">保存名称</button>
            </form>
          </section>
        </div>
        <div class="library-content page-stack">
          <div
            v-if="detailBusy && !selected"
            class="loading-state"
            role="status"
          >
            正在打开媒体库…
          </div>
          <template v-if="selected">
            <section
              v-if="selected.permissions.browse"
              class="surface-card page-stack library-media"
            >
              <div class="section-heading">
                <div class="section-heading__copy">
                  <h2>库内影片</h2>
                  <p class="helper">
                    已加载 {{ media.length }} 部影片{{
                      hasMore ? "，可继续加载" : ""
                    }}
                  </p>
                </div>
                <span v-if="runtime.room" class="status-badge"
                  >当前房间 · {{ runtime.room.name }}</span
                >
              </div>
              <form
                class="library-inline-form"
                role="search"
                @submit.prevent="loadMedia(false)"
              >
                <label
                  ><span class="sr-only">搜索当前库</span
                  ><input
                    v-model="search"
                    type="search"
                    placeholder="搜索当前库的影片标题"
                /></label>
                <button :disabled="mediaBusy">
                  <AppIcon name="search" />搜索
                </button>
              </form>
              <div v-if="mediaError">
                <Notice :message="mediaError" error />
                <button :disabled="mediaBusy" @click="loadMedia(false)">
                  重新加载影片
                </button>
              </div>
              <p
                v-if="mediaBusy"
                class="loading-state loading-state--inline"
                role="status"
              >
                正在加载当前库的影片…
              </p>
              <p
                v-if="media.length && (search !== appliedQuery || mediaError)"
                class="helper"
                role="status"
              >
                仍显示{{
                  appliedQuery ? `“${appliedQuery}”搜索` : "全部影片"
                }}的已加载结果。
                输入新关键词后点击搜索；加载更多沿用当前结果的查询。
              </p>
              <div
                v-if="!mediaBusy && !mediaError && !media.length"
                class="empty-state empty-state--compact"
              >
                <span class="empty-state__icon"
                  ><AppIcon
                    :name="appliedQuery ? 'search' : 'movie'"
                    :size="28"
                /></span>
                <h3>
                  {{
                    appliedQuery ? "没有找到匹配影片" : "这个媒体库还没有影片"
                  }}
                </h3>
                <p>
                  {{
                    appliedQuery
                      ? "换个标题关键词再试，或清除搜索查看全部影片。"
                      : selected.permissions.manage
                        ? "添加片源并完成扫描后，影片会出现在这里。"
                        : "请库管理者确认片源和扫描结果。"
                  }}
                </p>
                <button
                  v-if="appliedQuery"
                  @click="
                    search = '';
                    loadMedia(false);
                  "
                >
                  清除搜索
                </button>
              </div>
              <p v-if="media.length && !runtime.room" class="helper">
                先进入放映室，再将影片加入待播或分享到房间。<RouterLink
                  to="/rooms"
                  >选择放映室</RouterLink
                >
              </p>
              <ul class="private-media-list data-list" :aria-busy="mediaBusy">
                <li v-for="item in media" :key="item.id" class="data-row">
                  <div class="data-row__body">
                    <strong>{{ item.title }}</strong>
                    <p class="helper">{{ item.kind }}</p>
                  <QueueFeedback :media-id="item.id" />
                  </div>
                  <div class="data-row__actions">
                    <button
                      v-if="selected.permissions.share_to_room"
                      :aria-pressed="shareMedia === item.id"
                      :disabled="busy"
                      @click="shareMedia = item.id"
                    >
                      {{ shareMedia === item.id ? "已选择分享" : "选择分享" }}
                    </button>
                    <button
                      :disabled="
                        busy ||
                        !canQueue ||
                        runtime.queuePending('add', item.id)
                      "
                      :aria-busy="runtime.queuePending('add', item.id)"
                      @click="choose(item.id)"
                    >
                      <AppIcon name="plus" />加入当前房间待播
                    </button>
                  </div>
                </li>
              </ul>
              <button
                v-if="hasMore"
                :disabled="mediaBusy"
                @click="loadMedia(true)"
              >
                加载更多
              </button>
            </section>
            <section
              v-else
              class="surface-card empty-state empty-state--compact"
            >
              <span class="empty-state__icon"
                ><AppIcon name="key" :size="28"
              /></span>
              <h2>当前账号没有浏览权限</h2>
              <p>
                已有的播放授权与浏览权限独立。需要查看库内影片时，请联系库所有者。
              </p>
            </section>

            <section
              v-if="
                (enabled && selected.permissions.share_to_room) ||
                selected.room_shares?.length
              "
              class="surface-card page-stack"
            >
              <div class="section-heading">
                <div class="section-heading__copy">
                  <h2>房间分享</h2>
                  <p class="helper">只分享一部影片，不开放整库浏览</p>
                </div>
                <span class="status-badge"
                  >{{
                    selected.room_shares?.filter((item) => item.active)
                      .length ?? 0
                  }}
                  个有效分享</span
                >
              </div>
              <form
                v-if="enabled && selected.permissions.share_to_room"
                class="library-form-grid"
                @submit.prevent="share"
              >
                <p v-if="!runtime.room" class="notice library-wide">
                  先进入一个房间，再返回这里。<RouterLink to="/rooms"
                    >选择放映室</RouterLink
                  >
                </p>
                <p v-else class="helper library-wide">
                  分享至：{{ runtime.room.name }}
                </p>
                <label
                  >影片<select v-model="shareMedia" required>
                    <option value="" disabled>选择影片</option>
                    <option
                      v-for="item in media"
                      :key="item.id"
                      :value="item.id"
                    >
                      {{ item.title }}
                    </option>
                  </select></label
                >
                <label
                  >观看范围<select v-model="shareMode">
                    <option value="library_members">
                      仅已有库播放权限的房间成员
                    </option>
                    <option value="room_members">
                      允许本房间有效成员观看此影片
                    </option>
                  </select></label
                >
                <label
                  >有效分钟<input
                    v-model.number="minutes"
                    type="number"
                    min="1"
                    max="1440"
                    required
                /></label>
                <p class="helper library-wide">
                  分享不开放整库浏览。撤销不能收回已经下载的数据。
                </p>
                <div class="button-row library-wide">
                  <button
                    class="primary"
                    :disabled="busy || !runtime.room || !shareMedia"
                  >
                    确认分享指定影片
                  </button>
                </div>
              </form>
              <ul v-if="selected.room_shares?.length" class="data-list">
                <li
                  v-for="shareItem in selected.room_shares"
                  :key="shareItem.id"
                  class="data-row"
                >
                  <div class="data-row__body">
                    <strong>{{ shareItem.title }}</strong>
                    <p class="helper">
                      {{
                        shareItem.mode === "room_members"
                          ? "房间成员"
                          : "库授权成员"
                      }}
                      · {{ shareItem.active ? "未撤销" : "已失效" }} · 到期
                      {{ new Date(shareItem.expires_at).toLocaleString() }}
                    </p>
                  </div>
                  <button
                    class="danger"
                    :disabled="busy || !shareItem.active"
                    @click="
                      requestChange(
                        'revokeShare',
                        shareItem.id,
                        shareItem.title,
                      )
                    "
                  >
                    撤销分享
                  </button>
                </li>
              </ul>
              <p v-else class="helper">
                还没有房间分享。选择影片和观看范围后，即可建立限时授权。
              </p>
            </section>

            <section
              v-if="selected.permissions.manage"
              class="surface-card page-stack"
            >
              <div class="section-heading">
                <div class="section-heading__copy">
                  <h2>片源与索引</h2>
                  <p class="helper">扫描片源后，影片才会加入媒体库</p>
                </div>
                <span class="status-badge"
                  >{{ selected.sources?.length ?? 0 }} 个片源</span
                >
              </div>
              <ul v-if="selected.sources?.length" class="data-list">
                <li
                  v-for="source in selected.sources"
                  :key="source.id"
                  class="data-row"
                >
                  <div class="data-row__body">
                    <strong>{{ source.name }}</strong>
                    <p class="helper">{{ source.kind }}</p>
                    <p v-if="scans[source.id]" class="helper" role="status">
                      {{
                        {
                          not_started: "尚未开始",
                          running: "扫描中",
                          failed: "扫描失败",
                          completed: "扫描完成",
                        }[scans[source.id].status]
                      }}
                      · {{ scans[source.id].item_count }} 部 ·
                      {{ scans[source.id].page_count }} 页
                    </p>
                    <p
                      v-if="scans[source.id]?.last_error"
                      class="field-error"
                      role="alert"
                    >
                      {{ scans[source.id].last_error }}
                    </p>
                  </div>
                  <div
                    v-if="source.kind === 's3' || source.kind === 'http'"
                    class="data-row__actions"
                  >
                    <button :disabled="busy" @click="scan(source.id, true)">
                      重新扫描
                    </button>
                    <button
                      :disabled="
                        busy || scans[source.id]?.status === 'completed'
                      "
                      @click="scan(source.id, false)"
                    >
                      继续扫描
                    </button>
                    <button
                      :disabled="busy"
                      @click="
                        run(
                          async () => {
                            scans[source.id] = await api.scanStatus(
                              selected!.id,
                              source.id,
                            );
                          },
                          '扫描状态已更新',
                          false,
                        )
                      "
                    >
                      读取状态
                    </button>
                  </div>
                  <span v-else class="helper">由管理员在片源管理中扫描</span>
                </li>
              </ul>
              <p v-else class="helper">
                尚未添加片源。添加可读取的地址后，再扫描影片索引。
              </p>
              <details v-if="enabled" class="library-details">
                <summary>添加读取片源</summary>
                <form class="library-form-grid" @submit.prevent="addSource">
                  <label
                    >片源名称<input
                      v-model="sourceName"
                      required
                      maxlength="100"
                  /></label>
                  <label
                    >类型<select v-model="sourceKind">
                      <option value="http">HTTP</option>
                      <option v-if="session.user?.admin" value="s3">
                        S3（管理员绑定凭据引用）
                      </option>
                    </select></label
                  >
                  <label class="library-wide"
                    >地址<input
                      v-model="sourceUrl"
                      type="url"
                      required
                      placeholder="https://media.example/"
                  /></label>
                  <label class="library-wide"
                    >配置 JSON<textarea
                      v-model="sourceConfig"
                      rows="5"
                      spellcheck="false"
                    />
                  </label>
                  <p class="helper library-wide">
                    S3 使用 s3.region、bucket、prefix、credential_ref 中的
                    RAINSYNC_S3_* 环境变量名。不要在配置中填写密钥值。
                  </p>
                  <div class="button-row library-wide">
                    <button class="primary" :disabled="busy">添加片源</button>
                  </div>
                </form>
              </details>
              <details
                v-if="enabled && session.user?.admin"
                class="library-details"
              >
                <summary>迁移已有片源（管理员）</summary>
                <form
                  class="library-inline-form"
                  @submit.prevent="requestChange('attach', attachId)"
                >
                  <p class="helper library-wide">
                    这是审计记录中的管理操作，将改变整份片源的可见范围。确认前请核对片源
                    ID。
                  </p>
                  <label>片源 ID<input v-model="attachId" required /></label>
                  <button :disabled="busy">迁入当前库</button>
                </form>
              </details>
            </section>

            <section
              v-if="selected.owner_id === session.user?.id && enabled"
              class="surface-card page-stack"
            >
              <div class="section-heading">
                <div class="section-heading__copy">
                  <h2>账户授权</h2>
                  <p class="helper">按固定登录账号授予权限，并设置到期时间</p>
                </div>
                <span class="status-badge"
                  >{{ selected.grants?.length ?? 0 }} 个账户授权</span
                >
              </div>
              <form class="library-form-grid" @submit.prevent="addGrant">
                <label
                  >固定登录账号<input v-model="grantName" required
                /></label>
                <label
                  >有效小时<input
                    v-model.number="hours"
                    type="number"
                    min="1"
                    max="720"
                    required
                /></label>
                <fieldset class="library-wide">
                  <legend>允许的操作</legend>
                  <div class="permission-fields">
                    <label
                      ><input v-model="browse" type="checkbox" />浏览</label
                    >
                    <label><input v-model="play" type="checkbox" />播放</label>
                    <label
                      ><input
                        v-model="shareRight"
                        type="checkbox"
                      />再分享到房间</label
                    >
                    <label
                      ><input v-model="manage" type="checkbox" />管理片源</label
                    >
                  </div>
                </fieldset>
                <p class="helper library-wide">
                  保存授权会使旧播放与分享失效，需要重新分享。
                </p>
                <div class="button-row library-wide">
                  <button class="primary" :disabled="busy">保存授权</button>
                </div>
              </form>
              <ul v-if="selected.grants?.length" class="data-list">
                <li
                  v-for="grant in selected.grants"
                  :key="grant.user_id"
                  class="data-row"
                >
                  <div class="data-row__body">
                    <strong>{{ grant.username }}</strong>
                    <p class="helper">
                      到期 {{ new Date(grant.expires_at).toLocaleString() }}
                    </p>
                  </div>
                  <button
                    class="danger"
                    :disabled="busy"
                    @click="
                      requestChange('revoke', grant.user_id, grant.username)
                    "
                  >
                    撤销
                  </button>
                </li>
              </ul>
              <p v-else class="helper">
                还没有向其他账号授权，私人库默认仅所有者可访问。
              </p>
            </section>

            <details
              v-if="selected.owner_id === session.user?.id && enabled"
              class="surface-card library-details"
            >
              <summary>转移媒体库所有权</summary>
              <form
                class="library-inline-form"
                @submit.prevent="requestChange('transfer', transferName)"
              >
                <p class="helper library-wide">
                  房间所有权保持独立。转移会终止旧库授权，且不会给你保留默认访问权。
                </p>
                <label
                  >新所有者的固定登录账号<input v-model="transferName" required
                /></label>
                <button class="danger" :disabled="busy">转移所有权</button>
              </form>
            </details>
            <details v-if="selected.audit" class="surface-card library-details">
              <summary>最近管理审计</summary>
              <ul v-if="selected.audit.length" class="data-list">
                <li
                  v-for="entry in selected.audit"
                  :key="entry.id"
                  class="data-row"
                >
                  <span class="helper">{{
                    new Date(entry.created_at).toLocaleString()
                  }}</span
                  ><span>{{ entry.action }}</span>
                </li>
              </ul>
              <p v-else class="helper">暂无管理记录。</p>
            </details>
          </template>
        </div>
      </div>
    </div>
    <AppDialog
      v-model="confirmationOpen"
      :title="
        pendingChange ? confirmationTitles[pendingChange.kind] : '确认操作'
      "
      :busy="busy"
    >
      <form v-if="pendingChange" @submit.prevent="confirmChange">
        <p>媒体库：{{ pendingChange.libraryName }}</p>
        <div class="confirm-panel">
          <template v-if="pendingChange.kind === 'transfer'">
            <p>将所有权转移给 {{ pendingChange.targetLabel }}？</p>
            <p class="helper">
              旧库授权将终止，你不会保留默认访问权限。房间所有权不会随之改变。
            </p>
          </template>
          <template v-else-if="pendingChange.kind === 'attach'">
            <p>将片源 {{ pendingChange.targetLabel }} 迁入当前库？</p>
            <p class="helper">
              整份片源的可见范围将改变，旧授权将失效。这项操作会写入管理审计。
            </p>
          </template>
          <template v-else-if="pendingChange.kind === 'revoke'">
            <p>撤销 {{ pendingChange.targetLabel }} 的账户授权？</p>
            <p class="helper">
              相关播放将失效。对方再次访问时，需要重新获得授权。
            </p>
          </template>
          <template v-else>
            <p>撤销“{{ pendingChange.targetLabel }}”的房间分享？</p>
            <p class="helper">
              依赖这份分享的房间成员将失去播放授权，已经下载的数据无法收回。
            </p>
          </template>
        </div>
        <Notice :message="error" error />
        <div class="dialog-actions">
          <button
            type="button"
            :disabled="busy"
            @click="confirmationOpen = false"
          >
            取消
          </button>
          <button class="danger" :disabled="busy">
            {{ busy ? "正在处理…" : confirmationLabels[pendingChange.kind] }}
          </button>
        </div>
      </form>
    </AppDialog>
  </section>
</template>
<style scoped>
.library-workspace {
  display: grid;
  gap: var(--space-6);
  min-width: 0;
}
.library-management,
.library-content {
  align-content: start;
}
.library-create {
  display: grid;
  grid-template-columns: minmax(10rem, auto) minmax(0, 1fr) auto;
  align-items: end;
  gap: var(--space-5);
}
.library-tabs {
  margin-top: var(--space-4);
}
.library-tabs button {
  overflow-wrap: anywhere;
}
.library-inline-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-4);
  align-items: end;
}
.section-heading + .library-inline-form {
  margin-top: var(--space-5);
}
.library-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
  align-items: end;
}
.library-wide {
  grid-column: 1 / -1;
}
.permission-fields {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-5);
  margin-top: var(--space-2);
}
.permission-fields label {
  flex-direction: row;
  align-items: center;
  min-height: var(--control-height);
}
.library-details > form,
.library-details > ul,
.library-details > p {
  margin-top: var(--space-4);
}
.private-media-list {
  margin: 0;
}
.data-row__body strong {
  overflow-wrap: anywhere;
}
@media (min-width: 1100px) {
  .private-library-page > .page-title {
    margin-bottom: var(--space-5);
  }
  .library-workspace {
    grid-template-columns: minmax(17rem, 20rem) minmax(0, 1fr);
    align-items: start;
  }
  .library-management,
  .library-content,
  .library-content > .page-stack {
    gap: var(--space-4);
  }
  .library-management .surface-card {
    padding: var(--space-4);
  }
  .library-management .section-heading {
    display: grid;
    gap: var(--space-2);
    margin: 0;
  }
  .library-management .section-heading__copy {
    gap: var(--space-1);
  }
  .library-management .section-heading__copy h2 {
    overflow-wrap: anywhere;
  }
  .library-management .button-row {
    gap: var(--space-2);
  }
  .library-create,
  .library-summary .library-inline-form {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-3);
  }
  .library-create > button,
  .library-summary .library-inline-form > button {
    justify-self: start;
    margin: 0;
  }
  .library-tabs {
    display: grid;
    gap: var(--space-1);
    margin-top: var(--space-3);
  }
  .library-tabs button {
    justify-content: flex-start;
    text-align: left;
  }
  .library-content .section-heading {
    margin-bottom: 0;
  }
  .library-content .library-form-grid,
  .library-content .library-inline-form {
    width: 100%;
    max-width: 52rem;
  }
  .library-content .section-heading + .library-inline-form {
    margin-top: 0;
  }
  .library-media .private-media-list {
    padding: 0;
    list-style: none;
  }
}
@media (max-width: 767px) {
  .library-workspace {
    gap: var(--space-5);
  }
}
@media (max-width: 700px) {
  .library-create,
  .library-form-grid,
  .library-inline-form {
    grid-template-columns: minmax(0, 1fr);
  }
  .library-create > button,
  .library-inline-form > button {
    justify-self: start;
  }
  .private-media-list .data-row__actions {
    flex-basis: 100%;
  }
}
</style>
