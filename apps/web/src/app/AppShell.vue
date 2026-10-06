<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSession } from "../features/auth/session.store";
import { useRoomRuntime } from "../features/rooms/room-runtime";
import { useAction } from "../shared/use-action";
import { adminNavigation, authenticationLocation, safeRedirect } from "./navigation";
import AnimatedNavigation from "./AnimatedNavigation.vue";
import AppIcon from "../shared/ui/AppIcon.vue";
import UserAvatar from "../shared/ui/UserAvatar.vue";
import Notice from "../shared/ui/Notice.vue";
import PlaybackHost from "../features/playback/PlaybackHost.vue";
import { playbackFailureOwnsNotice } from "../features/playback/playback-preparation";
import { keyboardViewportOpen, hasEditableFocus } from "../shared/keyboard-viewport";
const session = useSession(),
  runtime = useRoomRuntime(),
  route = useRoute(),
  router = useRouter(),
  { busy, error, run } = useAction();
watch(
  () => session.user,
  (user) => {
    if (!user && session.loaded && !route.meta.public && !session.startupError)
      void router.replace(authenticationLocation("/login", route.fullPath, session.expired));
  },
);
const inRoom = computed(
    () => !!route.meta.room && String(route.params.id) === runtime.room?.id,
  ),
  keyboard = ref(false);
const miniHeight = ref(112);
const runtimeNotice = computed(() => {
  const failure =
    runtime.preparation?.phase === "failed"
      ? runtime.preparation.failure
      : undefined;
  // The player owns this diagnostic across pages. Keep unrelated room and
  // connection errors visible, even while the local player has failed.
  if (playbackFailureOwnsNotice(failure, runtime.error)) return "";
  return runtime.error;
});
function viewport() {
  document.documentElement.style.setProperty(
    "--viewport-height",
    (window.visualViewport?.height ?? window.innerHeight) + "px",
  );
  const visual = window.visualViewport;
  keyboard.value = !!visual && keyboardViewportOpen({
    layoutHeight: window.innerHeight,
    viewportHeight: visual.height,
    scale: visual.scale,
    editable: hasEditableFocus(document.activeElement),
  });
}
onMounted(() => {
  viewport();
  window.visualViewport?.addEventListener("resize", viewport);
  window.addEventListener("resize", viewport);
  document.addEventListener("focusin", viewport);
  document.addEventListener("focusout", viewport);
});
onBeforeUnmount(() => {
  window.visualViewport?.removeEventListener("resize", viewport);
  window.removeEventListener("resize", viewport);
  document.removeEventListener("focusin", viewport);
  document.removeEventListener("focusout", viewport);
  document.documentElement.style.removeProperty("--viewport-height");
  runtime.$dispose();
});
async function logout() {
  // leave() stops local media and reconnection synchronously. Remote cleanup
  // retains failed request keys and must never gate revoking authentication.
  void runtime.leave().catch(() => {});
  await session.logout();
  await router.replace("/login");
}
async function retry() {
  const target = route.meta.public ? route.query.redirect : route.fullPath;
  session.loaded = false;
  await session.restore();
  if (!session.startupError)
    await router.replace(session.user ? safeRedirect(target) : authenticationLocation("/login", target, session.expired));
}
</script>
<template>
  <div
    class="app-layout"
    :style="{ '--mini-height': miniHeight + 'px' }"
    :class="{
      authenticated: !!session.user,
      'has-mini': !!runtime.room && !inRoom,
      'keyboard-open': keyboard,
    }"
  >
    <a v-if="session.user" class="skip-link" href="#main-content">跳转到内容</a>
    <aside v-if="session.user" class="sidebar">
      <RouterLink class="brand" to="/rooms">RainSync</RouterLink>
      <AnimatedNavigation variant="sidebar" :admin="session.user.admin" />
      <div class="sidebar-account">
        <RouterLink
          to="/account/profile"
          class="profile-link"
          aria-label="个人资料"
          ><UserAvatar
            :name="session.user.display_name"
            :url="session.user.avatar_url"
          /><span
            ><b>{{ session.user.display_name }}</b
            ><small>个人资料</small></span
          ></RouterLink
        ><button
          class="icon-button"
          aria-label="退出登录"
          :disabled="busy"
          @click="run(logout)"
        >
          <AppIcon name="logout" />
        </button>
      </div>
    </aside>
    <header v-if="session.user" class="mobile-header">
      <RouterLink class="brand" to="/rooms">RainSync</RouterLink
      ><RouterLink to="/account/profile" aria-label="个人资料"
        ><UserAvatar
          :name="session.user.display_name"
          :url="session.user.avatar_url"
          :size="36" /></RouterLink
      ><button class="icon-button" aria-label="退出登录" @click="run(logout)">
        <AppIcon name="logout" />
      </button>
    </header>
    <main
      id="main-content"
      class="workspace"
      :class="{ 'watch-layout': inRoom }"
      tabindex="-1"
    >
      <div v-if="!session.loaded" class="page loading-state" role="status">
        正在恢复登录状态…
      </div>
      <div v-else-if="session.startupError" class="page empty-state">
        <h1>暂时无法连接</h1>
        <Notice :message="session.startupError" error /><button
          class="primary"
          @click="retry"
        >
          重试连接
        </button>
      </div>
      <div v-if="error || runtimeNotice" class="global-notice">
        <Notice :message="error || runtimeNotice" error
          ><button
            class="text-button"
            @click="
              error = '';
              runtime.error = '';
            "
          >
            关闭提示
          </button></Notice
        >
      </div>
      <PlaybackHost
        :full="inRoom"
        @mini-resize="miniHeight = $event"
      /><template v-if="session.loaded && !session.startupError && (session.user || route.meta.public)"
        ><nav
          v-if="session.user?.admin && route.path.startsWith('/admin')"
          class="mobile-admin-nav"
          aria-label="管理导航"
        >
          <RouterLink
            v-for="item in adminNavigation"
            :key="item.to"
            :to="item.to"
            >{{ item.label }}</RouterLink
          >
        </nav>
        <Notice
          v-if="route.query.notice === 'admin-required'"
          class="permission-notice"
          message="此页面仅管理员可访问。"
          error /><RouterView v-slot="{ Component }"
          ><Transition name="page" mode="out-in"
            ><component :is="Component" /></Transition></RouterView
      ></template>
    </main>
    <AnimatedNavigation
      v-if="session.user"
      variant="bottom"
      :admin="session.user.admin"
    />
  </div>
</template>
