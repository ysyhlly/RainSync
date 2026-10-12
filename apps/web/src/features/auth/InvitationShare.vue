<script setup lang="ts">
import { computed } from "vue";
import { buildRoomInvitationLink } from "./guest-session";
import { useAction } from "../../shared/use-action";
import Notice from "../../shared/ui/Notice.vue";
const props = defineProps<{ invitation: { room_id: string; token: string } }>();
const link = computed(() => {
  try {
    return buildRoomInvitationLink(props.invitation, window.location.origin);
  } catch {
    return "";
  }
});
const { busy, error, message, run } = useAction();
async function copy() {
  if (!link.value) throw Error("邀请信息无效，请重新生成邀请。");
  if (!navigator.clipboard)
    throw Error("浏览器暂不支持自动复制，请选中链接后复制。");
  await navigator.clipboard.writeText(link.value);
  message.value = "邀请链接已复制。";
}
</script>
<template>
  <section class="page-stack invitation-share" aria-label="分享房间邀请">
    <p v-if="!link" role="alert" class="error">
      邀请信息无效，请重新生成邀请。
    </p>
    <label
      >可分享的邀请链接<input
        :value="link"
        readonly
        autocomplete="off"
        aria-label="可分享的邀请链接"
    /></label>
    <button type="button" :disabled="busy || !link" @click="run(copy)">
      复制邀请链接
    </button>
    <Notice :message="message" /><Notice :message="error" error />
    <details>
      <summary>高级选项：邀请数据</summary>
      <textarea
        :value="JSON.stringify(invitation, null, 2)"
        readonly
        aria-label="邀请 JSON"
        autocomplete="off"
      />
    </details>
  </section>
</template>
<style scoped>
.invitation-share {
  gap: var(--space-3);
}
.invitation-share textarea {
  margin-top: var(--space-3);
}
</style>
