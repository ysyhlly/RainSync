<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSession } from "../features/auth/session.store";
import { useRoomRuntime } from "../features/rooms/room-runtime";
import { useAction } from "../shared/use-action";
import { watchNavigation, adminNavigation } from "./navigation";
import AppIcon from "../shared/ui/AppIcon.vue";
import UserAvatar from "../shared/ui/UserAvatar.vue";
import Notice from "../shared/ui/Notice.vue";
import PlaybackHost from "../features/playback/PlaybackHost.vue";
const session = useSession(),
  runtime = useRoomRuntime(),
  route = useRoute(),
  router = useRouter(),
  { busy, error, run } = useAction();
watch(
  () => session.user,
  (user) => {
    if (!user && session.loaded && !route.meta.public && !session.startupError)
      void router.replace({
        path: "/login",
        query: { redirect: route.fullPath },
      });
  },
);
const inRoom = computed(
    () => !!route.meta.room && String(route.params.id) === runtime.room?.id,
  ),
  keyboard = ref(false);
function viewport() {
  document.documentElement.style.setProperty(
    "--viewport-height",
    (window.visualViewport?.height ?? window.innerHeight) + "px",
  );
  keyboard.value =
    !!window.visualViewport &&
    window.innerHeight - window.visualViewport.height > 160;
}
onMounted(() => {
  viewport();
  window.visualViewport?.addEventListener("resize", viewport);
});
onBeforeUnmount(() => {
  window.visualViewport?.removeEventListener("resize", viewport);
  document.documentElement.style.removeProperty("--viewport-height");
  runtime.$dispose();
});
async function logout() {
  await runtime.leave();
  await session.logout();
  await router.replace("/login");
}
async function retry() {
  session.loaded = false;
  await session.restore();
  if (!session.startupError)
    await router.replace(session.user ? "/rooms" : "/login");
}
</script>
<template>
  <div
    class="app-layout"
    :class="{
      authenticated: !!session.user,
      'has-mini': !!runtime.room && !inRoom,
      'keyboard-open': keyboard,
    }"
  >
    <a v-if="session.user" class="skip-link" href="#main-content">跳转到内容</a>
    <aside v-if="session.user" class="sidebar">
      <RouterLink class="brand" to="/rooms">RainSync</RouterLink>
      <nav aria-label="主导航">
        <RouterLink v-for="item in watchNavigation" :key="item.to" :to="item.to"
          ><AppIcon :name="item.icon" />{{ item.label }}</RouterLink
        >
        <div v-if="session.user.admin" class="navigation-group">
          <p>管理</p>
          <RouterLink
            v-for="item in adminNavigation"
            :key="item.to"
            :to="item.to"
            ><AppIcon :name="item.icon" />{{ item.label }}</RouterLink
          >
        </div>
      </nav>
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
      <div v-if="error || runtime.error" class="global-notice">
        <Notice :message="error || runtime.error" error
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
      <PlaybackHost :full="inRoom" /><template
        v-if="session.loaded && !session.startupError"
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
    <nav v-if="session.user" class="bottom-nav" aria-label="移动导航">
      <RouterLink to="/rooms"><AppIcon name="rooms" />放映室</RouterLink
      ><RouterLink to="/library"><AppIcon name="movie" />媒体库</RouterLink
      ><RouterLink v-if="session.user.admin" to="/admin/sources"
        ><AppIcon name="settings" />管理</RouterLink
      >
    </nav>
  </div>
</template>
