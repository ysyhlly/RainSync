<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
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
const session = useSession(),
  runtime = useRoomRuntime(),
  route = useRoute(),
  api = privateLibraryApi(session.api);
const libraries = ref<Library[]>([]),
  selected = ref<LibraryDetail | null>(null),
  enabled = ref(false),
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
  cursor = ref<string>(),
  hasMore = ref(false),
  scans = ref<Record<string, ScanStatus>>({});
const shareMedia = ref(""),
  shareMode = ref<"room_members" | "library_members">("library_members"),
  minutes = ref(120);
let serial = 0,
  controller: AbortController | undefined;
function fail(e: unknown) {
  error.value = e instanceof Error ? e.message : String(e);
}
async function loadList(signal?: AbortSignal) {
  const value = await api.list(signal);
  libraries.value = value.items;
  enabled.value = value.enabled;
}
async function select(id: string) {
  const mine = ++serial;
  controller?.abort();
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
    if (mine === serial) fail(e);
  }
}
async function refresh() {
  await loadList();
  if (selected.value) await select(selected.value.id);
}
async function loadMedia(next = false) {
  const lib = selected.value;
  if (!lib) return;
  const id = lib.id,
    mine = serial;
  const values = await api.media(
    id,
    search.value,
    next ? cursor.value : undefined,
    controller?.signal,
  );
  if (mine !== serial || selected.value?.id !== id) return;
  media.value = next ? [...media.value, ...values] : values;
  cursor.value = values.at(-1)?.id;
  hasMore.value = values.length === 50;
}
async function run(
  action: () => Promise<unknown>,
  success: string,
  refreshAfter = true,
) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await action();
    notice.value = success;
    if (refreshAfter) await refresh();
  } catch (e) {
    fail(e); // Preserve form drafts. Read current revision, but never retry the mutation.
    if (selected.value) {
      try {
        const fresh = await api.detail(selected.value.id);
        selected.value = fresh;
      } catch {}
    }
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
async function choose(id: string) {
  if (!runtime.room) return;
  await runtime.run(() => runtime.addQueue(id));
}
onMounted(async () => {
  try {
    await loadList();
    const id =
      typeof route.query.library === "string"
        ? route.query.library
        : libraries.value[0]?.id;
    if (id) await select(id);
  } catch (e) {
    fail(e);
  }
});
watch(
  () => session.epoch,
  () => {
    ++serial;
    controller?.abort();
    libraries.value = [];
    selected.value = null;
    media.value = [];
  },
);
onBeforeUnmount(() => {
  ++serial;
  controller?.abort();
});
</script>
<template>
  <section class="page private-library-page">
    <div class="page-title">
      <div>
        <p class="section-label">观看区</p>
        <h1>我的媒体库与授权</h1>
        <p>片源、媒体所有权和房间控制权分别管理。房间分享只授权指定影片。</p>
      </div>
      <RouterLink to="/library" class="button">浏览影片</RouterLink>
    </div>
    <Notice :message="error" error /><Notice :message="notice" />
    <p v-if="!enabled" class="notice">
      私人库创建与分享未开启。管理员可在部署配置中开启
      PRIVATE_LIBRARIES_ENABLED。
    </p>
    <form v-if="enabled" class="panel" @submit.prevent="create">
      <h2>创建私人库</h2>
      <label>名称<input v-model="createName" maxlength="100" required /></label
      ><button class="primary" :disabled="busy">创建</button>
    </form>
    <nav aria-label="媒体库选择" class="library-tabs">
      <button
        v-for="library in libraries"
        :key="library.id"
        :aria-pressed="selected?.id === library.id"
        :disabled="busy"
        @click="select(library.id)"
      >
        {{ library.name }} ·
        {{ library.visibility === "private" ? "私人" : "实例共享" }}
      </button>
    </nav>
    <div v-if="selected" class="panel">
      <h2>{{ selected.name }}</h2>
      <p>
        权限版本 {{ selected.permission_epoch }} ·
        {{ selected.permissions.browse ? "可浏览" : "不可浏览" }} ·
        {{ selected.permissions.play ? "可播放" : "不可播放" }}
      </p>
      <template v-if="selected.permissions.manage">
        <form
          @submit.prevent="
            run(
              () => api.rename(selected!.id, editName, selected!.revision),
              '名称已保存',
            )
          "
        >
          <label
            >媒体库名称<input
              v-model="editName"
              maxlength="100"
              required /></label
          ><button :disabled="busy">保存名称</button>
        </form>
        <h3>片源与索引</h3>
        <ul>
          <li v-for="source in selected.sources" :key="source.id">
            {{ source.name }} · {{ source.kind }}
            <template v-if="source.kind === 's3' || source.kind === 'http'"
              ><button :disabled="busy" @click="scan(source.id, true)">
                重新扫描</button
              ><button
                :disabled="busy || scans[source.id]?.status === 'completed'"
                @click="scan(source.id, false)"
              >
                继续扫描</button
              ><button
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
                读取状态</button
              ><span v-if="scans[source.id]"
                >{{ scans[source.id].status }} ·
                {{ scans[source.id].item_count }} 部 ·
                {{ scans[source.id].page_count }} 页</span
              ></template
            ><span v-else>由管理员在片源管理中扫描</span>
          </li>
        </ul>
        <form v-if="enabled" @submit.prevent="addSource">
          <h3>添加读取片源</h3>
          <label
            >片源名称<input
              v-model="sourceName"
              required
              maxlength="100" /></label
          ><label
            >类型<select v-model="sourceKind">
              <option value="http">HTTP</option>
              <option v-if="session.user?.admin" value="s3">
                S3（管理员绑定凭据引用）
              </option>
            </select></label
          ><label
            >地址<input
              v-model="sourceUrl"
              type="url"
              required
              placeholder="https://media.example/" /></label
          ><label
            >配置 JSON<textarea
              v-model="sourceConfig"
              rows="5"
              spellcheck="false"
            />
          </label>
          <p class="helper">
            S3 使用 s3.region、bucket、prefix、credential_ref 中的 RAINSYNC_S3_*
            环境变量名。不要在配置中填写密钥值。
          </p>
          <button :disabled="busy">添加片源</button>
        </form>
        <form
          v-if="enabled && session.user?.admin"
          @submit.prevent="
            run(
              () => api.attach(selected!.id, attachId, selected!.revision),
              '片源归属已迁移。旧授权已失效',
            )
          "
        >
          <h3>迁移已有片源（管理员）</h3>
          <label>片源 ID<input v-model="attachId" required /></label>
          <p class="helper">
            这是审计记录中的管理操作，将改变整份片源的可见范围。
          </p>
          <button :disabled="busy">迁入当前库</button>
        </form>
      </template>
      <template v-if="selected.owner_id === session.user?.id && enabled">
        <form @submit.prevent="addGrant">
          <h3>账户授权</h3>
          <label>固定登录账号<input v-model="grantName" required /></label>
          <div class="permission-fields">
            <label><input v-model="browse" type="checkbox" />浏览</label
            ><label><input v-model="play" type="checkbox" />播放</label
            ><label
              ><input v-model="shareRight" type="checkbox" />再分享到房间</label
            ><label><input v-model="manage" type="checkbox" />管理片源</label>
          </div>
          <label
            >有效小时<input
              v-model.number="hours"
              type="number"
              min="1"
              max="720"
              required /></label
          ><button :disabled="busy">保存授权</button>
        </form>
        <ul>
          <li v-for="grant in selected.grants" :key="grant.user_id">
            {{ grant.username }} · 到期
            {{ new Date(grant.expires_at).toLocaleString()
            }}<button
              :disabled="busy"
              @click="
                run(
                  () =>
                    api.revoke(selected!.id, grant.user_id, selected!.revision),
                  '授权已撤销，相关播放已失效',
                )
              "
            >
              撤销
            </button>
          </li>
        </ul>
        <form
          @submit.prevent="
            run(
              async () => {
                await api.transfer(
                  selected!.id,
                  transferName,
                  selected!.revision,
                );
                selected = null;
                await loadList();
              },
              '所有权已转移，原所有者不保留默认权限',
              false,
            )
          "
        >
          <h3>转移媒体库所有权</h3>
          <label
            >新所有者的固定登录账号<input v-model="transferName" required
          /></label>
          <p class="helper">
            房间所有权保持独立。转移会终止旧库授权，且不会给你保留默认访问权。
          </p>
          <button :disabled="busy">确认转移所有权</button>
        </form>
      </template>
      <template v-if="selected.permissions.browse">
        <form
          role="search"
          @submit.prevent="run(() => loadMedia(false), '影片已更新', false)"
        >
          <label>搜索当前库<input v-model="search" type="search" /></label
          ><button :disabled="busy">搜索</button>
        </form>
        <ul class="private-media-list">
          <li v-for="item in media" :key="item.id">
            <span>{{ item.title }}</span
            ><button
              v-if="selected.permissions.share_to_room"
              :disabled="busy"
              @click="shareMedia = item.id"
            >
              选择分享</button
            ><button
              :disabled="busy || !runtime.room || !runtime.owner"
              @click="choose(item.id)"
            >
              加入当前房间待播
            </button>
          </li>
        </ul>
        <button
          v-if="hasMore"
          :disabled="busy"
          @click="run(() => loadMedia(true), '下一页已加载', false)"
        >
          下一页
        </button>
      </template>
      <form
        v-if="enabled && selected.permissions.share_to_room"
        @submit.prevent="share"
      >
        <h3>只分享一部影片到当前房间</h3>
        <p v-if="!runtime.room">先进入一个房间，再返回这里。</p>
        <label
          >影片<select v-model="shareMedia" required>
            <option value="" disabled>选择影片</option>
            <option v-for="item in media" :key="item.id" :value="item.id">
              {{ item.title }}
            </option>
          </select></label
        ><label
          >观看范围<select v-model="shareMode">
            <option value="library_members">仅已有库播放权限的房间成员</option>
            <option value="room_members">允许本房间有效成员观看此影片</option>
          </select></label
        ><label
          >有效分钟<input
            v-model.number="minutes"
            type="number"
            min="1"
            max="1440"
            required
        /></label>
        <p class="helper">分享不开放整库浏览。撤销不能收回已经下载的数据。</p>
        <button :disabled="busy || !runtime.room || !shareMedia">
          确认分享指定影片
        </button>
      </form>
      <ul>
        <li v-for="shareItem in selected.room_shares" :key="shareItem.id">
          {{ shareItem.title }} ·
          {{ shareItem.mode === "room_members" ? "房间成员" : "库授权成员" }} ·
          {{ shareItem.active ? "未撤销" : "已失效" }} · 到期
          {{ new Date(shareItem.expires_at).toLocaleString()
          }}<button
            :disabled="busy || !shareItem.active"
            @click="
              run(
                () =>
                  api.revokeShare(
                    selected!.id,
                    shareItem.id,
                    selected!.revision,
                  ),
                '房间分享已撤销',
              )
            "
          >
            撤销分享
          </button>
        </li>
      </ul>
      <details v-if="selected.audit">
        <summary>最近管理审计</summary>
        <ul>
          <li v-for="entry in selected.audit" :key="entry.id">
            {{ new Date(entry.created_at).toLocaleString() }} ·
            {{ entry.action }}
          </li>
        </ul>
      </details>
    </div>
  </section>
</template>
<style scoped>
.panel {
  margin: 1rem 0;
  padding: 1rem;
  border: 1px solid var(--border-subtle);
  border-radius: 1rem;
  background: var(--surface-panel);
}
form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.8rem;
  align-items: end;
  margin: 1rem 0;
}
form h2,
form h3,
form p {
  flex-basis: 100%;
}
label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 12rem;
  flex: 1;
}
input,
select,
textarea {
  max-width: 100%;
  padding: 0.6rem;
  border: 1px solid var(--border-control);
  border-radius: 0.5rem;
  background: var(--surface-panel);
  color: var(--text-primary);
}
textarea {
  width: 100%;
  min-width: 15rem;
}
.permission-fields,
.library-tabs {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.permission-fields label {
  flex-direction: row;
  min-width: auto;
  align-items: center;
}
.private-media-list li,
li {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
  padding: 0.5rem 0;
}
.private-media-list span {
  flex: 1;
  min-width: 10rem;
}
button[aria-pressed="true"] {
  background: var(--accent);
  color: var(--text-on-accent);
}
h3 {
  margin-top: 1.2rem;
}
@media (max-width: 600px) {
  label {
    min-width: 100%;
  }
  li {
    align-items: flex-start;
  }
  textarea {
    min-width: 0;
  }
}
</style>
