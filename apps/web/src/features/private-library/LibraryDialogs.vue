<script setup lang="ts">
import { computed } from "vue";
import AppDialog from "../../shared/ui/AppDialog.vue";
import Notice from "../../shared/ui/Notice.vue";
import type { IssuedRoomShare } from "./private-library.api";
import {
  localDateTime,
  type ShareSettingsDraft,
  type S3SettingsDraft,
} from "./use-library-settings";
import {
  confirmationTitles,
  confirmationLabels,
  type LibraryChange,
} from "./use-library-changes";
defineProps<{ busy: boolean; error: string; isAdmin: boolean }>();
const emit = defineEmits<{
  (event: "withdraw"): void;
  (event: "saveShare"): void;
  (event: "saveS3"): void;
  (event: "confirm"): void;
}>();
const withdrawal = defineModel<IssuedRoomShare>("withdrawal");
const shareEdit = defineModel<ShareSettingsDraft>("shareEdit");
const s3Edit = defineModel<S3SettingsDraft>("s3Edit");
const pendingChange = defineModel<LibraryChange | null>("pendingChange", {
  default: null,
});
const withdrawalOpen = computed({
  get: () => !!withdrawal.value,
  set: (v: boolean) => {
    if (!v) withdrawal.value = undefined;
  },
});
const shareEditOpen = computed({
  get: () => !!shareEdit.value,
  set: (v: boolean) => {
    if (!v) shareEdit.value = undefined;
  },
});
const s3EditOpen = computed({
  get: () => !!s3Edit.value,
  set: (v: boolean) => {
    if (!v) s3Edit.value = undefined;
  },
});
const confirmationOpen = computed({
  get: () => pendingChange.value !== null,
  set: (v: boolean) => {
    if (!v) pendingChange.value = null;
  },
});
const confirmWithdrawal = () => emit("withdraw");
const saveShare = () => emit("saveShare");
const saveS3 = () => emit("saveS3");
const confirmChange = () => emit("confirm");
</script>
<template>
  <AppDialog v-model="withdrawalOpen" title="撤销我的房间分享" :busy="busy">
    <div v-if="withdrawal" class="page-stack">
      <p>
        {{ withdrawal.title ?? "无浏览权限的影片" }} · 房间
        {{ withdrawal.room_id }}
      </p>
      <p class="helper">
        撤销这份分享后，其他有效分享仍保留。当前库已有播放需要重新打开，已经下载的数据无法收回。
      </p>
      <Notice :message="error" error />
      <div class="dialog-actions">
        <button :disabled="busy" @click="withdrawalOpen = false">取消</button>
        <button class="danger" :disabled="busy" @click="confirmWithdrawal">
          确认撤销我的分享
        </button>
      </div>
    </div>
  </AppDialog>
  <AppDialog v-model="shareEditOpen" title="房间分享设置" :busy="busy">
    <form v-if="shareEdit" class="page-stack" @submit.prevent="saveShare">
      <p>{{ shareEdit.title }}</p>
      <label
        >观看范围<select v-model="shareEdit.mode">
          <option value="library_members">仅已有库播放权限的房间成员</option>
          <option value="room_members">允许本房间有效成员观看此影片</option>
        </select></label
      >
      <label
        >到期时间<input
          v-model="shareEdit.expires"
          type="datetime-local"
          :max="localDateTime(shareEdit.maxExpires)"
          required
      /></label>
      <p class="helper">
        最晚到期
        {{
          new Date(shareEdit.maxExpires).toLocaleString()
        }}。修改会终止当前库的旧播放，请重新打开播放；其他有效分享保持可用。
      </p>
      <Notice :message="error" error />
      <div class="dialog-actions">
        <button type="button" :disabled="busy" @click="shareEditOpen = false">
          取消</button
        ><button class="primary" :disabled="busy">保存分享设置</button>
      </div>
    </form>
  </AppDialog>
  <AppDialog v-model="s3EditOpen" title="S3 片源设置" :busy="busy">
    <form v-if="s3Edit" class="page-stack" @submit.prevent="saveS3">
      <label
        >片源名称<input v-model="s3Edit.name" required maxlength="100"
      /></label>
      <template v-if="isAdmin">
        <label v-if="s3Edit.urlRedacted"
          ><input
            v-model="s3Edit.replaceUrl"
            type="checkbox"
          />替换已保存地址（原地址含敏感参数，不会显示）</label
        >
        <label
          >服务地址<input
            v-model="s3Edit.url"
            type="url"
            :disabled="s3Edit.urlRedacted && !s3Edit.replaceUrl"
            :required="!s3Edit.urlRedacted || s3Edit.replaceUrl"
        /></label>
        <label
          >S3 配置 JSON<textarea
            v-model="s3Edit.config"
            rows="10"
            spellcheck="false"
            required
          />
        </label>
        <p class="helper">
          包含 region、bucket、prefix、addressing_style 和
          credential_ref。凭据只能填写已配置的 RAINSYNC_S3_*
          环境变量名，不填写密钥值。连接变化会使已有播放失效，需重新扫描索引。
        </p>
      </template>
      <p v-else class="helper">
        S3 连接和凭据引用由管理员配置，你可以修改名称。
      </p>
      <Notice :message="error" error />
      <div class="dialog-actions">
        <button type="button" :disabled="busy" @click="s3EditOpen = false">
          取消</button
        ><button class="primary" :disabled="busy">保存片源设置</button>
      </div>
    </form>
  </AppDialog>
  <AppDialog
    v-model="confirmationOpen"
    :title="pendingChange ? confirmationTitles[pendingChange.kind] : '确认操作'"
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
        <template v-else-if="pendingChange.kind === 'deleteLibrary'">
          <p>删除“{{ pendingChange.targetLabel }}”及其中的片源配置？</p>
          <p class="helper">
            所有账户授权和房间分享将撤销，播放会停止，保存的片源凭据会清除。原始媒体文件不受影响，历史与审计记录保留。此页面无法恢复已删除配置。
          </p>
        </template>
        <template v-else-if="pendingChange.kind === 'deleteSource'">
          <p>删除片源“{{ pendingChange.targetLabel }}”？</p>
          <p class="helper">
            保存的连接凭据会清除，影片将从目录隐藏，相关播放与分享失效。不会删除原始媒体文件，也不会把私人影片迁入共享库。
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
            依赖这份分享的房间成员将失去播放授权。其他有效分享仍保留，当前库已有播放需要重新打开，已经下载的数据无法收回。
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
</template>
