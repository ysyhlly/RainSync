<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { useSession } from "../auth/session.store";
import type {
  InviteBatch,
  InvitePage,
  InviteStatus,
  RegistrationInvite,
} from "../../shared/api/types";
import { RequestFailure } from "../../errors";
import { StaleIdentity } from "../../shared/api/client";
import { formatDate } from "../../shared/use-action";
import AccountTabs from "./AccountTabs.vue";
import AppSelect from "../../shared/ui/AppSelect.vue";
import AppDialog from "../../shared/ui/AppDialog.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import Notice from "../../shared/ui/Notice.vue";
import CopyField from "../../shared/ui/CopyField.vue";
type Operation = {
  batch_id: string;
  count: number;
  valid_days: number;
  note: string;
};
const session = useSession(),
  rows = ref<RegistrationInvite[]>([]),
  status = ref<InviteStatus | "all">("all"),
  cursors = ref<(string | null)[]>([null]),
  page = ref(0),
  next = ref<string | null>(null),
  loaded = ref(false),
  loading = ref(false),
  error = ref(""),
  serverTime = ref(0),
  open = ref(false),
  busy = ref(false),
  operationError = ref(""),
  count = ref(1),
  days = ref(7),
  note = ref(""),
  batch = ref<InviteBatch | null>(null),
  pending = ref<Operation | null>(null),
  recovery = ref<RegistrationInvite[] | null>(null),
  copied = ref(new Set<string>()),
  closeWarning = ref(false),
  revoking = ref<RegistrationInvite | null>(null),
  revokeOpen = ref(false),
  revokeError = ref("");
const labels: Record<InviteStatus | "all", string> = {
  all: "全部",
  unused: "未使用",
  used: "已使用",
  expired: "已过期",
  revoked: "已撤销",
};
const allCodes = computed(
  () => batch.value?.items.map((x) => x.code).join("\n") ?? "",
);
const uncopied = computed(
  () => !!batch.value && copied.value.size < batch.value.items.length,
);
const storageKey = "rainsync:invite-batch:" + session.user?.id;
let alive = true,
  serial = 0,
  controller: AbortController | undefined;
function remember(value: Operation | null) {
  pending.value = value;
  try {
    // Only operation metadata is persisted in this tab. Raw codes never enter storage.
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
  } catch {
    /* The live operation still retains its id if browser storage is disabled. */
  }
}
function failure(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
async function load() {
  const id = ++serial;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  error.value = "";
  const query = new URLSearchParams({ status: status.value, limit: "25" });
  if (cursors.value[page.value])
    query.set("cursor", cursors.value[page.value]!);
  try {
    const value = await session.api<InvitePage>(
      "/admin/registration-invites?" + query,
      "GET",
      undefined,
      AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    );
    if (!alive || id !== serial) return;
    rows.value = value.items;
    next.value = value.next_cursor;
    serverTime.value = value.server_time;
    loaded.value = true;
  } catch (e) {
    if (
      alive &&
      id === serial &&
      !(e instanceof StaleIdentity) &&
      !(e instanceof DOMException && e.name === "AbortError")
    )
      error.value = failure(e);
  } finally {
    if (alive && id === serial) loading.value = false;
  }
}
function paginate(direction: number) {
  if (loading.value) return;
  if (direction > 0 && next.value) {
    cursors.value[page.value + 1] = next.value;
    page.value++;
  } else if (direction < 0 && page.value > 0) page.value--;
  void load();
}
watch(status, () => {
  page.value = 0;
  cursors.value = [null];
  void load();
});
function start() {
  operationError.value = "";
  closeWarning.value = false;
  open.value = true;
  if (!pending.value) {
    count.value = 1;
    days.value = 7;
    note.value = "";
    recovery.value = null;
  }
}
async function recover() {
  if (!pending.value) return;
  const id = pending.value.batch_id;
  try {
    const value = await session.api<InvitePage>(
      "/admin/registration-invites?limit=100&batch_id=" +
        encodeURIComponent(id),
      "GET",
      undefined,
      AbortSignal.timeout(15000),
    );
    if (!alive || pending.value?.batch_id !== id) return;
    recovery.value = value.items;
    operationError.value = value.items.length
      ? "已确认本批生成成功，但完整邀请码无法重新显示。请在列表撤销丢失的未使用代码，再生成新批次。"
      : "尚未查到此批次，原请求可能仍在处理。可再次查询，或使用同一批次和相同参数重试。";
    await load();
  } catch (e) {
    if (alive && !(e instanceof StaleIdentity))
      operationError.value = "结果尚未确认：" + failure(e);
  }
}
async function check() {
  if (busy.value) return;
  busy.value = true;
  try {
    await recover();
  } finally {
    busy.value = false;
  }
}
async function generate(retry = false) {
  if (busy.value || (pending.value && !retry)) return;
  if (
    !retry &&
    (!Number.isInteger(count.value) ||
      count.value < 1 ||
      count.value > 50 ||
      Array.from(note.value.trim()).length > 60)
  ) {
    operationError.value = "数量须为1–50，备注最多60个字符";
    return;
  }
  if (!pending.value)
    remember({
      batch_id: crypto.randomUUID(),
      count: count.value,
      valid_days: days.value,
      note: note.value.trim(),
    });
  const operation = pending.value!;
  busy.value = true;
  operationError.value = "";
  try {
    const value = await session.api<InviteBatch>(
      "/admin/registration-invites",
      "POST",
      operation,
      AbortSignal.timeout(20000),
    );
    if (!alive) return;
    batch.value = value;
    copied.value = new Set();
    recovery.value = null;
    await load();
  } catch (e) {
    if (!alive || e instanceof StaleIdentity) return;
    if (
      e instanceof RequestFailure &&
      [
        "INVALID_REQUEST",
        "RATE_LIMITED",
        "FORBIDDEN",
        "CSRF_REJECTED",
        "ORIGIN_REJECTED",
      ].includes(e.code)
    ) {
      remember(null);
      operationError.value = failure(e);
    } else await recover();
  } finally {
    busy.value = false;
  }
}
function canClose() {
  if (uncopied.value) {
    closeWarning.value = true;
    return false;
  }
  return true;
}
function discard() {
  closeWarning.value = false;
  open.value = false;
}
watch(open, (value) => {
  if (value) return;
  if (batch.value || recovery.value?.length) remember(null);
  batch.value = null;
  copied.value = new Set();
  closeWarning.value = false;
});
async function revoke() {
  if (!revoking.value || busy.value) return;
  busy.value = true;
  revokeError.value = "";
  try {
    await session.api<RegistrationInvite>(
      "/admin/registration-invites/" + revoking.value.id,
      "DELETE",
      undefined,
      AbortSignal.timeout(15000),
    );
    if (!alive) return;
    revokeOpen.value = false;
    await load();
  } catch (e) {
    if (alive && !(e instanceof StaleIdentity)) revokeError.value = failure(e);
  } finally {
    busy.value = false;
  }
}
function unload(event: BeforeUnloadEvent) {
  if (uncopied.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
onBeforeRouteLeave(
  () =>
    !session.user ||
    !uncopied.value ||
    window.confirm(
      "仍有邀请码尚未复制。离开后无法再次查看完整代码，确定离开？",
    ),
);
onMounted(() => {
  try {
    const raw = JSON.parse(
      sessionStorage.getItem(storageKey) ?? "null",
    ) as Operation | null;
    if (
      raw &&
      /^[0-9a-f-]{36}$/i.test(raw.batch_id) &&
      Number.isInteger(raw.count) &&
      raw.count >= 1 &&
      raw.count <= 50 &&
      [1, 7, 30].includes(raw.valid_days) &&
      typeof raw.note === "string" &&
      Array.from(raw.note).length <= 60
    ) {
      pending.value = raw;
      open.value = true;
      void check();
    }
  } catch {
    /* Invalid browser metadata is ignored. */
  }
  void load();
  window.addEventListener("beforeunload", unload);
});
onBeforeUnmount(() => {
  alive = false;
  ++serial;
  controller?.abort();
  batch.value = null;
  window.removeEventListener("beforeunload", unload);
});
</script>
<template>
  <section class="page registration-invites-page">
    <div class="page-title">
      <div class="page-intro">
        <p class="section-label">管理</p>
        <h1>账号与注册</h1>
        <p>每个邀请码仅可注册一个普通账号。注册成功后自动登录。</p>
      </div>
      <button class="primary" @click="start">
        <AppIcon name="plus" />{{ pending ? "查看本批结果" : "生成邀请码" }}
      </button>
    </div>
    <AccountTabs />
    <div class="admin-filters toolbar">
      <label
        >状态<AppSelect
          v-model="status"
          label="状态"
          :options="
            Object.entries(labels).map(([value, label]) => ({ value, label }))
          " /></label
      ><button :disabled="loading" @click="load">
        <AppIcon name="refresh" />刷新列表
      </button>
    </div>
    <Notice :message="error" error />
    <p v-if="loading" class="loading-state loading-state--inline" role="status">
      正在加载邀请码…
    </p>
    <div
      v-if="loaded && !loading && !error && !rows.length"
      class="empty-state surface-card"
    >
      <span class="empty-state__icon"><AppIcon name="key" :size="28" /></span>
      <h2>{{ status === "all" ? "暂无注册邀请码" : "没有符合筛选的记录" }}</h2>
      <p>注册邀请码与放映室邀请相互独立。</p>
    </div>
    <div class="invite-list" :aria-busy="loading">
      <article
        v-for="row in rows"
        :key="row.id"
        class="invite-card surface-card"
      >
        <header>
          <h2>尾号 {{ row.code_suffix }}</h2>
          <span
            class="status-tag status-badge"
            :class="{
              'status-badge--success': row.status === 'unused',
              'status-badge--warning': row.status === 'expired',
              'status-badge--danger': row.status === 'revoked',
            }"
            :data-status="row.status"
            >{{ labels[row.status] }}</span
          >
        </header>
        <p v-if="row.note">{{ row.note }}</p>
        <dl>
          <div>
            <dt>创建时间</dt>
            <dd>{{ formatDate(row.created_at) }}</dd>
          </div>
          <div>
            <dt>有效期至</dt>
            <dd>{{ formatDate(row.expires_at) }}</dd>
          </div>
          <div>
            <dt>使用者</dt>
            <dd>
              {{
                row.used_by
                  ? `${row.used_by_display_name ?? row.used_by_username}（${row.used_by_username}）`
                  : "未使用"
              }}
            </dd>
          </div>
          <div v-if="row.used_at">
            <dt>使用时间</dt>
            <dd>{{ formatDate(row.used_at) }}</dd>
          </div>
          <div v-if="row.revoked_at">
            <dt>撤销时间</dt>
            <dd>{{ formatDate(row.revoked_at) }}</dd>
          </div>
        </dl>
        <button
          v-if="row.status === 'unused'"
          class="danger"
          :disabled="loading || busy"
          @click="
            revoking = row;
            revokeError = '';
            revokeOpen = true;
          "
        >
          撤销尾号 {{ row.code_suffix }}
        </button>
      </article>
    </div>
    <div v-if="loaded" class="pagination">
      <button :disabled="page === 0 || loading" @click="paginate(-1)">
        上一页</button
      ><span>第 {{ page + 1 }} 页 · 本页 {{ rows.length }} 条</span
      ><button :disabled="!next || loading" @click="paginate(1)">下一页</button>
    </div>
    <p v-if="serverTime" class="helper server-time">
      状态截至服务器时间 {{ formatDate(serverTime) }}，刷新可查看最新状态。
    </p>
    <AppDialog
      v-model="open"
      title="生成注册邀请码"
      drawer
      :busy="busy"
      :can-close="canClose"
    >
      <template v-if="batch">
        <p>请复制保存，关闭后无法再次查看完整邀请码。</p>
        <CopyField
          label="全部邀请码"
          :value="allCodes"
          @copied="copied = new Set(batch.items.map((x) => x.id))"
        />
        <div
          v-for="(item, index) in batch.items"
          :key="item.id"
          class="invite-result"
        >
          <CopyField
            :label="'邀请码 ' + (index + 1)"
            :value="item.code"
            @copied="copied.add(item.id)"
          />
          <p class="helper">有效期至 {{ formatDate(item.expires_at) }}</p>
        </div>
        <div v-if="closeWarning" class="confirm-panel" role="alert">
          <p>仍有邀请码尚未复制。关闭后无法再次查看，但代码不会自动撤销。</p>
          <button @click="closeWarning = false">继续复制</button
          ><button @click="discard">仍然关闭</button>
        </div>
      </template>
      <template v-else-if="pending">
        <p>正在确认本次 {{ pending.count }} 个邀请码的生成结果。</p>
        <p class="helper">本批次编号：{{ pending.batch_id }}</p>
        <Notice :message="operationError" error />
        <p v-if="recovery?.length">
          已找到 {{ recovery.length }} 条批次记录，可关闭后在列表查看。
        </p>
        <button :disabled="busy" @click="check">再次查询本批结果</button>
        <button
          v-if="recovery?.length === 0"
          :disabled="busy"
          @click="generate(true)"
        >
          使用同一批次重试
        </button>
        <button v-if="recovery?.length" @click="discard">关闭并查看列表</button>
      </template>
      <form v-else @submit.prevent="generate()">
        <label
          >数量<input
            v-model.number="count"
            type="number"
            min="1"
            max="50"
            required
            autofocus
        /></label>
        <label
          >有效期<AppSelect
            v-model="days"
            label="有效期"
            :options="
              [1, 7, 30].map((value) => ({ value, label: value + ' 天' }))
            "
        /></label>
        <label>备注（可选）<textarea v-model="note" /></label>
        <p class="helper">最多60个字符。每个邀请码仅可注册一个普通账号。</p>
        <Notice :message="operationError" error /><button
          class="primary"
          :disabled="busy"
        >
          {{ busy ? "正在生成…" : "生成 " + count + " 个邀请码" }}
        </button>
      </form>
    </AppDialog>
    <AppDialog v-model="revokeOpen" title="撤销注册邀请码" :busy="busy"
      ><p>
        撤销尾号
        {{ revoking?.code_suffix }}
        后，此邀请码将无法用于注册。已创建的账号不受影响。
      </p>
      <Notice :message="revokeError" error />
      <div class="dialog-actions">
        <button :disabled="busy" @click="revokeOpen = false">取消</button
        ><button class="danger" :disabled="busy" @click="revoke">
          确认撤销邀请码
        </button>
      </div></AppDialog
    >
  </section>
</template>

<style scoped>
.registration-invites-page > .admin-filters {
  align-items: flex-end;
}
@media (min-width: 1100px) {
  .registration-invites-page > .page-title {
    margin-bottom: var(--space-5);
  }
  .registration-invites-page > :deep(.section-tabs),
  .registration-invites-page > .admin-filters {
    margin-bottom: var(--space-4);
  }
}
</style>
