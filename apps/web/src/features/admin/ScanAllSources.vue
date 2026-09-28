<script setup lang="ts">
import { useSourceScans } from "./source-scans.store";
import AppIcon from "../../shared/ui/AppIcon.vue";
import Notice from "../../shared/ui/Notice.vue";
const scans = useSourceScans();
const emit = defineEmits<{ complete: [] }>();
async function scan() {
  await scans.scanAll();
  emit("complete");
}
</script>
<template>
  <div class="scan-all-sources">
    <button :disabled="scans.busy" @click="scan">
      <AppIcon name="refresh" />{{
        scans.busy ? "正在扫描片源…" : "扫描所有片源"
      }}
    </button>
    <Notice :message="scans.error" error />
    <details
      v-if="scans.batch && Object.keys(scans.results).length"
      class="scan-results"
      open
    >
      <summary>扫描结果</summary>
      <ul aria-live="polite">
        <li
          v-for="(result, id) in scans.results"
          :key="id"
          :class="{ 'scan-failed': result.failed }"
        >
          <b>{{ result.name }}</b
          >：{{ result.message }}
        </li>
      </ul>
    </details>
  </div>
</template>
