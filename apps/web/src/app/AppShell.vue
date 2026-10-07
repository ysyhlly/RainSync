<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { guestRoomPath } from "../features/auth/guest-session";
import { useSession } from "../features/auth/session.store";
import { useRoomRuntime } from "../features/rooms/room-runtime";
import { useAction } from "../shared/use-action";
import {
  adminNavigation,
  authenticationLocation,
  safeRedirect,
} from "./navigation";
import AnimatedNavigation from "./AnimatedNavigation.vue";
import AppIcon from "../shared/ui/AppIcon.vue";
import UserAvatar from "../shared/ui/UserAvatar.vue";
import Notice from "../shared/ui/Notice.vue";
import PlaybackHost from "../features/playback/PlaybackHost.vue";
import { providePlaybackPlacement } from "../features/playback/playback-placement";
import { useRoomNotice } from "../features/playback/room-notice";
import {
  keyboardViewportOpen,
  hasEditableFocus,
} from "../shared/keyboard-viewport";
const session = useSession(),
  runtime = useRoomRuntime(),
  route = useRoute(),
  router = useRouter(),
  { busy, error, run } = useAction();
watch(
  () => session.user,
  (user) => {
    const home = guestRoomPath(user);
    if (home && route.path !== home) void router.replace(home);
    if (!user && session.loaded && !route.meta.public && !session.startupError)
      void router.replace(
        authenticationLocation("/login", route.fullPath, session.expired),
      );
  },
);
const inRoom = computed(
    () => !!route.meta.room && String(route.params.id) === runtime.room?.id,
  ),
  keyboard = ref(false);
const miniHeight = ref(112);
const { anchor: playbackAnchor, editing: layoutEditing } =
  providePlaybackPlacement();
const currentNotice = useRoomNotice(runtime, error);
function viewport() {
  document.documentElement.style.setProperty(
    "--viewport-height",
    (window.visualViewport?.height ?? window.innerHeight) + "px",
  );
  const visual = window.visualViewport;
  keyboard.value =
    !!visual &&
    keyboardViewportOpen({
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
// A fading route must not accept actions that its teardown will cancel.
function setLeavingPageInert(element: Element) {
  if (element instanceof HTMLElement) element.inert = true;
}
function clearLeavingPageInert(element: Element) {
  if (element instanceof HTMLElement) element.inert = false;
}
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
    await router.replace(
      session.user
        ? safeRedirect(target)
        : authenticationLocation("/login", target, session.expired),
    );
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
      'room-layout-active': inRoom,
    }"
  >
    <a v-if="session.user" class="skip-link" href="#main-content">跳转到内容</a>
    <aside v-if="session.user" class="sidebar">
      <RouterLink class="brand" to="/rooms">RainSync</RouterLink>
      <AnimatedNavigation
        v-if="!session.user.guest"
        :variant="inRoom ? 'room' : 'sidebar'"
        :admin="session.user.admin"
      />
      <RouterLink v-else :to="guestRoomPath(session.user)!" class="button"
        >返回受邀房间</RouterLink
      >
      <div class="sidebar-account">
        <RouterLink
          v-if="!session.user.guest"
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
        >
        <div v-else class="profile-link">
          <UserAvatar :name="session.user.display_name" :size="36" /><span
            ><b>{{ session.user.display_name }}</b
            ><small>受限访客 · 仅当前房间</small></span
          >
        </div>
        <button
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
      ><RouterLink
        v-if="!session.user.guest"
        to="/account/profile"
        aria-label="个人资料"
        ><UserAvatar
          :name="session.user.display_name"
          :url="session.user.avatar_url"
          :size="36" /></RouterLink
      ><span v-else class="helper">受限访客</span
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
      <div
        v-for="notice in currentNotice ? [currentNotice] : []"
        :key="notice.key"
        class="global-notice"
      >
        <Notice :message="notice.message" error
          ><button class="text-button" @click="notice.dismiss">
            关闭提示
          </button></Notice
        >
      </div>
      <template
        v-if="
          session.loaded &&
          !session.startupError &&
          (session.user || route.meta.public)
        "
        ><nav
          v-if="
            session.user?.admin &&
            !session.user.guest &&
            route.path.startsWith('/admin')
          "
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
          ><Transition
            name="page"
            mode="out-in"
            @before-leave="setLeavingPageInert"
            @leave-cancelled="clearLeavingPageInert"
            @before-enter="clearLeavingPageInert"
            ><component :is="Component" /></Transition></RouterView
      ></template>
      <PlaybackHost
        :full="inRoom"
        :anchor="playbackAnchor"
        :layout-editing="layoutEditing"
        @mini-resize="miniHeight = $event"
      />
    </main>
    <AnimatedNavigation
      v-if="session.user && !session.user.guest"
      variant="bottom"
      :admin="session.user.admin"
    />
  </div>
</template>
