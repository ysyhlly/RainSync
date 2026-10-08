<script setup lang="ts">
import type {
  LibraryDetail,
  LibrarySource,
  ScanStatus,
} from "./private-library.api";
import type { LibrarySourceDraft } from "./use-library-settings";
import type { ChangeKind } from "./use-library-changes";
defineProps<{
  selected: LibraryDetail;
  busy: boolean;
  enabled: boolean;
  isAdmin: boolean;
  scans: Record<string, ScanStatus>;
}>();
const emit = defineEmits<{
  (event: "add"): void;
  (event: "scan", id: string, restart: boolean): void;
  (event: "readStatus", id: string): void;
  (event: "edit", source: LibrarySource): void;
  (event: "requestChange", kind: ChangeKind, id: string, label?: string): void;
}>();
const readScanStatus = (id: string) => emit("readStatus", id);
const addSource = () => emit("add");
const scan = (id: string, restart: boolean) => emit("scan", id, restart);
const editSource = (source: LibrarySource) => emit("edit", source);
const requestChange = (kind: ChangeKind, id: string, label?: string) =>
  emit("requestChange", kind, id, label);
const form = defineModel<LibrarySourceDraft>("form", { required: true });
</script>
<template>
  <section v-if="selected.permissions.manage" class="surface-card page-stack">
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
      <li v-for="source in selected.sources" :key="source.id" class="data-row">
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
          <button :disabled="busy" @click="editSource(source)">设置</button>
          <button
            class="danger"
            :disabled="busy"
            @click="requestChange('deleteSource', source.id, source.name)"
          >
            删除
          </button>
          <button :disabled="busy" @click="scan(source.id, true)">
            重新扫描
          </button>
          <button
            :disabled="busy || scans[source.id]?.status === 'completed'"
            @click="scan(source.id, false)"
          >
            继续扫描
          </button>
          <button :disabled="busy" @click="readScanStatus(source.id)">
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
          >片源名称<input v-model="form.sourceName" required maxlength="100"
        /></label>
        <label
          >类型<select v-model="form.sourceKind">
            <option value="http">HTTP</option>
            <option v-if="isAdmin" value="s3">S3（管理员绑定凭据引用）</option>
          </select></label
        >
        <label class="library-wide"
          >地址<input
            v-model="form.sourceUrl"
            type="url"
            required
            placeholder="https://media.example/"
        /></label>
        <label class="library-wide"
          >配置 JSON<textarea
            v-model="form.sourceConfig"
            rows="5"
            spellcheck="false"
          />
        </label>
        <p class="helper library-wide">
          S3 使用 s3.region、bucket、prefix、credential_ref 中的 RAINSYNC_S3_*
          环境变量名。不要在配置中填写密钥值。
        </p>
        <div class="button-row library-wide">
          <button class="primary" :disabled="busy">添加片源</button>
        </div>
      </form>
    </details>
    <details v-if="enabled && isAdmin" class="library-details">
      <summary>迁移已有片源（管理员）</summary>
      <form
        class="library-inline-form"
        @submit.prevent="requestChange('attach', form.attachId)"
      >
        <p class="helper library-wide">
          这是审计记录中的管理操作，将改变整份片源的可见范围。确认前请核对片源
          ID。
        </p>
        <label>片源 ID<input v-model="form.attachId" required /></label>
        <button :disabled="busy">迁入当前库</button>
      </form>
    </details>
  </section>
</template>
