<script setup lang="ts">
import type { LibraryDetail, LibraryGrant } from "./private-library.api";
import type { LibraryGrantDraft } from "./use-library-settings";
import type { ChangeKind } from "./use-library-changes";
defineProps<{
  selected: LibraryDetail;
  busy: boolean;
  enabled: boolean;
  userId?: string;
}>();
const emit = defineEmits<{
  (event: "save"): void;
  (event: "edit", grant: LibraryGrant): void;
  (event: "cancel"): void;
  (event: "requestChange", kind: ChangeKind, id: string, label: string): void;
}>();
const addGrant = () => emit("save");
const editGrant = (grant: LibraryGrant) => emit("edit", grant);
const cancelGrantEdit = () => emit("cancel");
const requestChange = (kind: ChangeKind, id: string, label: string) =>
  emit("requestChange", kind, id, label);
const form = defineModel<LibraryGrantDraft>("form", { required: true });
</script>
<template>
  <section
    v-if="selected.owner_id === userId && enabled"
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
        >固定登录账号<input
          v-model="form.grantName"
          :readonly="!!form.editingGrant"
          required
      /></label>
      <label
        >{{ form.editingGrant ? "从保存起有效小时" : "有效小时"
        }}<input
          v-model.number="form.hours"
          type="number"
          min="1"
          max="720"
          required
      /></label>
      <fieldset class="library-wide">
        <legend>允许的操作</legend>
        <div class="permission-fields">
          <label><input v-model="form.browse" type="checkbox" />浏览</label>
          <label><input v-model="form.play" type="checkbox" />播放</label>
          <label
            ><input
              v-model="form.shareRight"
              type="checkbox"
            />再分享到房间</label
          >
          <label><input v-model="form.manage" type="checkbox" />管理片源</label>
        </div>
      </fieldset>
      <p class="helper library-wide">
        保存授权会使旧播放与分享失效，需要重新分享。
      </p>
      <div class="button-row library-wide">
        <button class="primary" :disabled="busy">
          {{ form.editingGrant ? "保存授权设置" : "保存授权" }}
        </button>
        <button
          v-if="form.editingGrant"
          type="button"
          :disabled="busy"
          @click="cancelGrantEdit"
        >
          取消编辑
        </button>
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
        <div class="data-row__actions">
          <button :disabled="busy" @click="editGrant(grant)">设置</button>
          <button
            class="danger"
            :disabled="busy"
            @click="requestChange('revoke', grant.user_id, grant.username)"
          >
            撤销
          </button>
        </div>
      </li>
    </ul>
    <p v-else class="helper">
      还没有向其他账号授权，私人库默认仅所有者可访问。
    </p>
  </section>
</template>
