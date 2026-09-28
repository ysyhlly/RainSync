<script setup lang="ts">
import { ref, watch } from "vue";
import { useMediaCatalog } from "./media-catalog.store";
import { useSession } from "../auth/session.store";
import AppDialog from "../../shared/ui/AppDialog.vue";
import Notice from "../../shared/ui/Notice.vue";
import { RequestFailure } from "../../errors";
const props = defineProps<{ mediaId: string | null }>();
const emit = defineEmits<{ close: [] }>();
const catalog = useMediaCatalog(),
  session = useSession(),
  personal = ref(""),
  shared = ref(""),
  busy = ref(false),
  error = ref(""),
  message = ref("");
// A draft's compare-and-swap version belongs to its loaded text, not the catalog.
const revisions = { personal: "0", shared: "0" };
const conflict = ref<{ scope: "personal" | "shared"; title: string | null }>();
let serial = 0;
watch(
  () => [props.mediaId, session.epoch] as const,
  async ([id]) => {
    const n = ++serial;
    error.value = "";
    message.value = "";
    conflict.value = undefined;
    if (!id) return;
    busy.value = true;
    try {
      const item = await catalog.ensure(id, true);
      if (n === serial) {
        personal.value = item.personal_title ?? "";
        shared.value = item.shared_title ?? "";
        revisions.personal = item.personal_title_revision;
        revisions.shared = item.shared_title_revision;
      }
    } catch (e) {
      if (n === serial) error.value = String(e);
    } finally {
      if (n === serial) busy.value = false;
    }
  },
  { immediate: true },
);
async function save(scope: "personal" | "shared", clear = false) {
  const id = props.mediaId,
    item = id && catalog.records[id];
  if (!id || !item || busy.value) return;
  const n = serial,
    epoch = session.epoch,
    title = clear
      ? null
      : (scope === "personal" ? personal.value : shared.value).trim();
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const saved = await (
      scope === "personal" ? catalog.renamePersonal : catalog.renameShared
    )(id, title, revisions[scope]);
    if (n === serial && epoch === session.epoch) {
      if (clear) (scope === "personal" ? personal : shared).value = "";
      revisions[scope] = saved[`${scope}_title_revision`];
      conflict.value = undefined;
      message.value = "名称已保存";
    }
  } catch (e) {
    if (n !== serial || epoch !== session.epoch) return;
    if (e instanceof RequestFailure && e.code === "MEDIA_TITLE_CONFLICT") {
      try {
        const latest = await catalog.ensure(id, true);
        if (n !== serial || epoch !== session.epoch) return;
        revisions[scope] = latest[`${scope}_title_revision`];
        conflict.value = { scope, title: latest[`${scope}_title`] };
        error.value =
          "名称已被其他操作修改。已读取最新版本，你的草稿已保留，请核对后再次保存。";
      } catch {
        if (n === serial && epoch === session.epoch)
          error.value =
            "名称已被其他操作修改，最新版本读取失败。你的草稿已保留，请重试。";
      }
    } else if (e instanceof RequestFailure && !e.retryable) {
      error.value = e.message;
    } else {
      try {
        const latest = await catalog.ensure(id, true);
        if (n !== serial || epoch !== session.epoch) return;
        if (latest[`${scope}_title`] === title) {
          revisions[scope] = latest[`${scope}_title_revision`];
          if (clear) (scope === "personal" ? personal : shared).value = "";
          conflict.value = undefined;
          message.value = "已确认名称保存成功";
        } else error.value = "保存结果尚未确认，草稿已保留。请核对后再保存。";
      } catch {
        if (n === serial && epoch === session.epoch)
          error.value = e instanceof Error ? e.message : String(e);
      }
    }
  } finally {
    if (n === serial) busy.value = false;
  }
}
</script>
<template>
  <AppDialog
    :model-value="!!mediaId"
    title="重命名影片"
    drawer
    :busy="busy"
    @update:model-value="!$event && emit('close')"
  >
    <template v-if="mediaId && catalog.records[mediaId]">
      <p>原名：{{ catalog.records[mediaId].original_title }}</p>
      <p class="helper">个人名称优先于全站名称，仅影响显示，不修改片源文件。</p>
      <form @submit.prevent="save('personal')">
        <label
          >仅我看到的名称<input
            v-model="personal"
            maxlength="400"
            :disabled="busy"
        /></label>
        <div class="dialog-actions">
          <button class="primary" :disabled="busy || !personal.trim()">
            保存个人名称</button
          ><button
            type="button"
            :disabled="busy"
            @click="save('personal', true)"
          >
            恢复个人默认
          </button>
        </div>
      </form>
      <form v-if="session.user?.admin" @submit.prevent="save('shared')">
        <label
          >所有人的默认名称<input
            v-model="shared"
            maxlength="400"
            :disabled="busy"
        /></label>
        <p class="helper">
          不会覆盖其他用户的个人名称。当前全站名称：{{
            catalog.records[mediaId].shared_title ?? "未设置"
          }}
        </p>
        <div class="dialog-actions">
          <button class="primary" :disabled="busy || !shared.trim()">
            保存全站名称</button
          ><button type="button" :disabled="busy" @click="save('shared', true)">
            恢复片源原名
          </button>
        </div>
      </form>
    </template>
    <p v-if="busy" role="status">正在保存或读取名称…</p>
    <p v-if="conflict" class="helper">
      本次冲突读取到的{{
        conflict.scope === "personal" ? "个人" : "全站"
      }}名称：{{ conflict.title ?? "未设置" }}
    </p>
    <Notice :message="error" error /><Notice :message="message" />
  </AppDialog>
</template>
