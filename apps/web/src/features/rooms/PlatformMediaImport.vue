<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from "vue";
import { useRoomRuntime } from "./room-runtime";
import { useSession } from "../auth/session.store";
import { usePlatformAccount } from "../account/platform-account.store";
import { useMediaCatalog } from "../library/media-catalog.store";
import { roomsApi } from "./rooms.api";
import {
  createPlatformImportFence,
  platformProviderOptions,
  platformProviderLabels,
  platformEpisodeLabel,
  platformVideoPlaceholders,
  selectedPlatformImportItems,
  platformImportFailureMessage,
  platformImportAccountIntent,
  platformCollectionProvider,
  type PlatformImportPreview,
  type PlatformImportOutcome,
} from "./platform-import";
import Notice from "../../shared/ui/Notice.vue";
import AppSelect from "../../shared/ui/AppSelect.vue";
import type { NativePlatformProvider } from "../../shared/api/types";
import type { NativePlatformCredentialMode } from "../../../../../packages/protocol";
const r = useRoomRuntime(),
  session = useSession(),
  account = usePlatformAccount(),
  catalog = useMediaCatalog(),
  api = roomsApi(session.api);
const url = ref(""),
  provider = ref<NativePlatformProvider>("bilibili"),
  credentialMode = ref<NativePlatformCredentialMode>("anonymous"),
  collection = ref(false),
  phase = ref<
    "idle" | "preview" | "preview-page" | "checking-import" | "import-submitted"
  >("idle"),
  error = ref(""),
  preview = ref<PlatformImportPreview>(),
  selected = ref<string[]>([]),
  outcomes = ref<PlatformImportOutcome[]>([]);
const busy = computed(() => phase.value !== "idle");
const workLabel = computed(() => {
  switch (phase.value) {
    case "preview":
      return "正在预览…";
    case "preview-page":
      return "正在预览下一页…";
    case "checking-import":
      return "正在检查导入条件…";
    case "import-submitted":
      return "正在等待导入结果…";
    default:
      return "";
  }
});
const canControl = computed(
    () => r.roomActive && r.can("queue") && r.connected && !!r.room,
  ),
  outcomeByKey = computed(() => new Map(outcomes.value.map((o) => [o.key, o]))),
  retryKeys = computed(() =>
    outcomes.value.filter((o) => o.error?.retryable).map((o) => o.key),
  );
const work = createPlatformImportFence(() => ({
  room: r.room?.id,
  epoch: session.epoch,
  allowed: canControl.value,
}));
function invalidate() {
  work.retire();
  phase.value = "idle";
  preview.value = undefined;
  selected.value = [];
  outcomes.value = [];
  error.value = "";
}
function clear() {
  invalidate();
  url.value = "";
  credentialMode.value = "anonymous";
}
watch(() => [r.room?.id, session.epoch], clear, { flush: "sync" });
watch(
  canControl,
  (allowed) => {
    if (!allowed) invalidate();
  },
  { flush: "sync" },
);
watch([url, provider, collection, credentialMode], invalidate, {
  flush: "sync",
});
onBeforeUnmount(clear);
async function previewVideos(continuation?: string) {
  if (busy.value || !canControl.value || !r.room) return;
  const room = r.room.id,
    request = work.begin(),
    input = url.value,
    chosenProvider = provider.value,
    isCollection = collection.value,
    mode = credentialMode.value;
  phase.value = continuation ? "preview-page" : "preview";
  error.value = "";
  if (!continuation) {
    preview.value = undefined;
    selected.value = [];
    outcomes.value = [];
  }
  try {
    const collectionProvider = isCollection
      ? platformCollectionProvider(input, chosenProvider)
      : undefined;
    const status =
      mode === "own_or_anonymous"
        ? collectionProvider === "youtube"
          ? await account.refreshYoutube(true)
          : collectionProvider === "bilibili"
            ? await account.refresh(true)
            : undefined
        : undefined;
    if (!work.current(request)) return;
    const value = await api.previewPlatform(
      room,
      input,
      chosenProvider,
      isCollection,
      request.signal,
      collectionProvider === "youtube" ||
        (collectionProvider === "bilibili" &&
          /\/(bangumi|cheese)\/play\/ss[1-9]\d*/.test(input))
        ? platformImportAccountIntent(collectionProvider, mode, status, true)
        : undefined,
      continuation,
    );
    if (!work.current(request)) return;
    if (continuation && preview.value) {
      if (
        value.items.length === 0 &&
        value.failures.length > 0 &&
        value.failures.every((failure) => failure.error.retryable)
      ) {
        // An unsuccessful page has not consumed the existing continuation.
        // Keep its exact binding and the reviewed selection for an explicit
        // retry; the server still enforces its original expiry and authority.
        preview.value = { ...preview.value, failures: value.failures };
        return;
      }
      const items = new Map(
        preview.value.items.map((item) => [item.key, item]),
      );
      for (const item of value.items) items.set(item.key, item);
      if (items.size > 2000) throw Error("此合集已达到 2000 条预览上限");
      preview.value = { ...value, items: [...items.values()] };
    } else preview.value = value;
    // A collection stays unselected until the user explicitly chooses items.
    if (!collection.value && value.items.length === 1)
      selected.value = [value.items[0].key];
  } catch (e) {
    if (work.current(request))
      error.value = e instanceof Error ? e.message : "预览失败，请重试";
  } finally {
    if (!request.signal.aborted && work.current(request)) phase.value = "idle";
  }
}
async function importSelected(keys = selected.value) {
  if (
    busy.value ||
    !canControl.value ||
    !r.room ||
    !preview.value ||
    !keys.length
  )
    return;
  const room = r.room.id,
    request = work.begin(),
    reviewed = preview.value,
    mode = credentialMode.value;
  phase.value = "checking-import";
  error.value = "";
  try {
    const shortProviders = [
      ...new Set(
        reviewed.items
          .filter(
            (item) =>
              keys.includes(item.key) &&
              ((item.provider === "bilibili" &&
                (item.url.includes("/bangumi/play/ep") ||
                  item.live_version === 1 ||
                  item.course_version === 1)) ||
                item.provider === "douyin" ||
                item.provider === "tiktok" ||
                item.provider === "youtube"),
          )
          .map(
            (item) =>
              item.provider as "bilibili" | "douyin" | "tiktok" | "youtube",
          ),
      ),
    ];
    const statuses =
      mode === "own_or_anonymous"
        ? Object.fromEntries(
            await Promise.all(
              shortProviders.map(async (provider) => [
                provider,
                await (provider === "bilibili"
                  ? account.refresh(true)
                  : provider === "youtube"
                    ? account.refreshYoutube(true)
                    : account.refreshShort(provider, true)),
              ]),
            ),
          )
        : {};
    if (!work.current(request)) return;
    const items = selectedPlatformImportItems(reviewed, keys, mode, statuses);
    phase.value = "import-submitted";
    const value = await api.importPlatformBatch(room, items, request.signal);
    if (!work.current(request)) return;
    const merged = new Map(outcomes.value.map((o) => [o.key, o]));
    for (const outcome of value.outcomes) merged.set(outcome.key, outcome);
    outcomes.value = [...merged.values()];
    catalog.rememberRoom(
      room,
      value.outcomes.flatMap((o) => (o.media ? [o.media] : [])),
    );
    selected.value = selected.value.filter((key) => !merged.get(key)?.media);
  } catch (e) {
    if (work.current(request))
      error.value =
        (e instanceof Error ? e.message : "导入失败") +
        (phase.value === "import-submitted"
          ? "；结果未确认时可重试同一批条目，房间内不会重复创建"
          : "；本次尚未提交导入，可检查后重试");
  } finally {
    if (!request.signal.aborted && work.current(request)) phase.value = "idle";
  }
}
function cancelWork() {
  if (!busy.value) return;
  const stopped = phase.value;
  work.retire();
  phase.value = "idle";
  error.value =
    stopped === "import-submitted"
      ? "已停止等待导入结果；服务端可能已导入部分条目。可重试同一批所选条目，房间内不会重复创建"
      : stopped === "checking-import"
        ? "已停止导入前检查，本次尚未提交导入；已显示的候选和选择保留"
        : stopped === "preview-page"
          ? "已停止等待本页预览，已显示的候选和选择保留"
          : "已停止等待预览，可重新预览";
}
function selectAll() {
  selected.value =
    preview.value?.items
      .filter((item) => !outcomeByKey.value.get(item.key)?.media)
      .slice(0, 20)
      .map((item) => item.key) ?? [];
}
</script>
<template>
  <section v-if="r.roomActive" class="panel platform-import">
    <h2>平台视频同步观看</h2>
    <p class="helper">
      可粘贴完整链接、官方短链接或分享文字，一次最多 20
      条。先预览，再选择导入到此房间。
    </p>
    <form @submit.prevent="previewVideos()">
      <label
        >无链接的视频编号所属平台<AppSelect
          v-model="provider"
          :options="platformProviderOptions"
          label="视频平台"
          :disabled="busy || !canControl"
      /></label>
      <label
        >视频链接或分享文字<textarea
          v-model="url"
          rows="4"
          maxlength="16384"
          :placeholder="platformVideoPlaceholders[provider]"
          :disabled="busy || !canControl"
        />
      </label>
      <label class="import-check"
        ><input
          v-model="collection"
          type="checkbox"
          :disabled="busy || !canControl"
        />预览合集、播放列表或视频分 P</label
      >
      <p class="helper">
        支持 Bilibili 分 P、UP 合集/列表、整季番剧与课程、YouTube PL 播放列表、
        TikTok collection 与创作者 playlist、抖音 collection。每页最多 20 条，
        由你明确翻页和选择；平台的登录、签名或访问限制可能阻止展开。
      </p>
      <label
        >使用自己的对应平台会话<AppSelect
          v-model="credentialMode"
          label="使用的平台会话"
          :disabled="busy || !canControl"
          :options="[
            { value: 'anonymous', label: '仅匿名' },
            { value: 'own_or_anonymous', label: '自己的对应平台会话或匿名' },
          ]"
      /></label>
      <p class="helper">
        默认匿名；YouTube 播放列表和 Bilibili
        番剧/课程预览可使用自己的对应平台会话。
        翻页绑定同一会话与合集，所选单集仍逐条验证完整观看权限。
      </p>
      <button class="primary" :disabled="busy || !url.trim() || !canControl">
        {{ busy ? workLabel : "预览可导入条目" }}
      </button>
    </form>
    <p class="helper">
      短链接仅跟随对应平台的有限官方跳转；解析可用性取决于服务端配置和平台限制。每位观众仍使用自己的平台会话或匿名观看。
    </p>
    <p class="helper">
      YouTube
      账号导入需服务管理员显式启用；已保存会话仍未验证，私有、付费、年龄限制和
      DRM 内容不受支持。
    </p>
    <p class="helper">
      Bilibili 番剧与课程仅支持平台明确允许的完整、无 DRM 播放；
      合集元数据不能替代每位观众独立的完整观看权限。
    </p>
    <p v-if="!r.can('queue')" class="helper">由房主导入并选择播放。</p>
    <p v-if="busy" class="helper" role="status">{{ workLabel }}</p>
    <button v-if="busy" @click="cancelWork">停止等待</button>
    <Notice :message="error" error />
    <div v-if="preview" class="confirm-panel">
      <p v-if="preview.truncated" class="helper" role="status">
        当前为有限预览。只有点击继续预览才会读取下一页，每次最多导入 20 条。
      </p>
      <p v-if="preview.truncated && !preview.next" class="helper" role="status">
        此列表还有未展开条目，本次没有可核对的下一页；你仍可导入所选条目。
      </p>
      <button
        v-if="preview.next"
        :disabled="busy || !canControl"
        @click="previewVideos(preview.next)"
      >
        {{
          preview.failures.some((failure) => failure.error.retryable)
            ? "重试本页预览"
            : "继续预览下一页"
        }}
      </button>
      <p v-if="preview.omitted" class="helper" role="status">
        已省略 {{ preview.omitted }} 条访问受限的单集元数据
      </p>
      <p
        v-for="failure in preview.failures"
        :key="failure.index"
        class="helper"
        role="status"
      >
        第 {{ failure.index + 1 }} 条：{{
          platformImportFailureMessage(failure.error)
        }}
      </p>
      <p v-if="!preview.items.length" class="helper">
        没有可导入的视频，请修改输入后重新预览。
      </p>
      <template v-else>
        <div class="button-row">
          <button :disabled="busy || !canControl" @click="selectAll">
            选择前 20 条未导入条目</button
          ><button :disabled="busy" @click="selected = []">取消选择</button>
        </div>
        <ul class="import-items">
          <li v-for="item in preview.items" :key="item.key">
            <label class="import-check"
              ><input
                v-model="selected"
                type="checkbox"
                :value="item.key"
                :disabled="
                  busy ||
                  !canControl ||
                  !!outcomeByKey.get(item.key)?.media ||
                  (selected.length >= 20 && !selected.includes(item.key))
                "
              /><span
                >{{ item.title || item.url
                }}<small
                  >{{ platformProviderLabels[item.provider]
                  }}{{ platformEpisodeLabel(item) }}</small
                ></span
              ></label
            >
            <template v-if="outcomeByKey.get(item.key)?.media">
              <p role="status">
                已导入：{{ outcomeByKey.get(item.key)!.media!.title }}
              </p>
              <div class="button-row">
                <button
                  :disabled="!canControl"
                  @click="
                    r.run(() => r.choose(outcomeByKey.get(item.key)!.media!.id))
                  "
                >
                  立即播放</button
                ><button
                  :disabled="!canControl"
                  @click="
                    r.run(() =>
                      r.addQueue(outcomeByKey.get(item.key)!.media!.id),
                    )
                  "
                >
                  加入待播
                </button>
              </div>
            </template>
            <p
              v-else-if="outcomeByKey.get(item.key)?.error"
              class="helper"
              role="status"
            >
              {{
                platformImportFailureMessage(outcomeByKey.get(item.key)!.error!)
              }}
              <span
                v-if="outcomeByKey.get(item.key)!.error!.attempted === false"
              >
                此条目尚未执行导入。
              </span>
              <br />
              <small>
                错误码：{{
                  outcomeByKey.get(item.key)!.error!.code.toUpperCase()
                }}
                <template v-if="outcomeByKey.get(item.key)!.error!.status">
                  · HTTP {{ outcomeByKey.get(item.key)!.error!.status }}
                </template>
                <template v-if="outcomeByKey.get(item.key)!.error!.request_id">
                  · 诊断编号：{{
                    outcomeByKey.get(item.key)!.error!.request_id
                  }}
                </template>
              </small>
            </p>
          </li>
        </ul>
        <div class="button-row">
          <button
            class="primary"
            :disabled="busy || !selected.length || !canControl"
            @click="importSelected()"
          >
            {{ busy ? workLabel : `导入所选 ${selected.length} 条` }}</button
          ><button
            v-if="retryKeys.length"
            :disabled="busy || !canControl"
            @click="importSelected(retryKeys)"
          >
            重试失败或未完成条目（{{ retryKeys.length }}）
          </button>
        </div>
      </template>
      <p class="helper">
        导入成功的条目仅在本房间可见。部分失败不会撤回成功条目；重试同一视频不会重复创建。
      </p>
    </div>
  </section>
</template>
<style scoped>
textarea {
  width: 100%;
  min-height: 6rem;
  resize: vertical;
  font: inherit;
}
.import-check {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
}
.import-check input {
  width: auto;
  flex: 0 0 auto;
  margin-top: 0.25rem;
}
.import-check span {
  overflow-wrap: anywhere;
}
.import-check small {
  display: block;
  opacity: 0.7;
}
.import-items {
  list-style: none;
  padding: 0;
}
.import-items li {
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--border, #8884);
}
</style>
