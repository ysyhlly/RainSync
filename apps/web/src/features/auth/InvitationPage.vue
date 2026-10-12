<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { parseGuestInvitation } from "./guest-session";
import { useSession } from "./session.store";
import { useAction } from "../../shared/use-action";
import LoginPanel from "./LoginPanel.vue";
import Notice from "../../shared/ui/Notice.vue";
import {
  rememberInvitation,
  pendingInvitation,
  clearInvitation,
} from "./invitation-intent";
import { RequestFailure } from "../../errors";
const route = useRoute(),
  router = useRouter(),
  session = useSession();
const { busy, error, run } = useAction();
let controller = new AbortController();
const invitation = computed(() => {
  if (!route.hash && !route.query.token && !route.query.invite)
    return pendingInvitation(route.params.roomId);
  try {
    return parseGuestInvitation(route.fullPath, window.location.origin);
  } catch {
    return null;
  }
});
watch(
  () => route.fullPath,
  () => {
    controller.abort();
    controller = new AbortController();
    error.value = "";
    try {
      rememberInvitation(
        parseGuestInvitation(route.fullPath, window.location.origin),
      );
    } catch {
      /* Invalid links never replace a known invitation. */
    }
  },
  { immediate: true },
);
let active = true;
onBeforeUnmount(() => {
  active = false;
  controller.abort();
});
async function join() {
  if (busy.value || !invitation.value || !session.user || session.user.guest)
    return;
  const current = invitation.value;
  const target = route.fullPath,
    epoch = session.epoch;
  await run(async () => {
    try {
      await session.api(
        `/rooms/${encodeURIComponent(current.room_id)}/join`,
        "POST",
        { token: current.token },
        controller.signal,
      );
    } catch (cause) {
      if (!active || route.fullPath !== target || session.epoch !== epoch)
        throw new DOMException("邀请页面已改变", "AbortError");
      if (
        cause instanceof RequestFailure &&
        [
          "FORBIDDEN",
          "INVALID_INVITE",
          "GUEST_ACCESS_DISABLED",
          "ROOM_CLOSED",
          "NOT_FOUND",
        ].includes(cause.code)
      )
        clearInvitation();
      throw cause;
    }
    if (active && route.fullPath === target && session.epoch === epoch) {
      clearInvitation();
      await router.replace(`/rooms/${current.room_id}`);
    }
  });
}
</script>
<template>
  <section v-if="!invitation" class="auth-page" aria-labelledby="invite-title">
    <div class="auth-panel page-stack">
      <h1 id="invite-title">邀请链接不完整</h1>
      <p>请向房主索取完整的房间邀请链接。</p>
      <RouterLink class="button" to="/login">返回登录</RouterLink>
    </div>
  </section>
  <section
    v-else-if="!session.user"
    class="auth-page login-page"
    aria-labelledby="login-title"
  >
    <RouterLink class="brand" to="/">RainSync</RouterLink>
    <LoginPanel :invitation="invitation" :return-path="route.fullPath" />
  </section>
  <section v-else class="page empty-state" aria-labelledby="invite-title">
    <h1 id="invite-title">加入受邀房间</h1>
    <p>邀请将在确认加入时验证。过期或已撤销的邀请无法使用。</p>
    <Notice :message="error" error />
    <button class="primary" :disabled="busy" @click="join">
      {{ busy ? "正在加入…" : "确认加入房间" }}
    </button>
    <RouterLink class="button" to="/rooms">返回放映室</RouterLink>
  </section>
</template>
