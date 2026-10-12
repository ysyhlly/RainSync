<script setup lang="ts">
import SourceSettingsDialog from "../admin/SourceSettingsDialog.vue";
import Notice from "../../shared/ui/Notice.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import { useRoute } from "vue-router";
import { useSession } from "../auth/session.store";
import { useRoomRuntime } from "../rooms/room-runtime";
import { usePrivateLibraries } from "./use-private-libraries";
import LibraryManagementPanel from "./LibraryManagementPanel.vue";
import LibraryMediaPanel from "./LibraryMediaPanel.vue";
import LibraryRoomSharesPanel from "./LibraryRoomSharesPanel.vue";
import LibrarySourcesPanel from "./LibrarySourcesPanel.vue";
import LibraryAccessPanel from "./LibraryAccessPanel.vue";
import IssuedSharesPanel from "./IssuedSharesPanel.vue";
import LibraryDialogs from "./LibraryDialogs.vue";
const session = useSession(),
  runtime = useRoomRuntime(),
  route = useRoute();
const screen = usePrivateLibraries({
  session,
  runtime,
  query: () => route.query,
});
const {
  configurationLoaded,
  confirmationOpen,
  shareEditOpen,
  s3EditOpen,
  withdrawalOpen,
  libraryBrowser,
  libraries,
  selected,
  enabled,
  listBusy,
  detailBusy,
  selectedId,
  busy,
  error,
  notice,
  issuedShares,
  issuedBusy,
  issuedError,
  issuedHasMore,
  withdrawal,
  loadIssuedShares,
  requestWithdrawal,
  confirmWithdrawal,
  transferName,
  media,
  mediaBusy,
  mediaError,
  hasMore,
  scans,
  settingsSource,
  shareEdit,
  s3Edit,
  editGrant,
  cancelGrantEdit,
  editShare,
  saveShare,
  editSource,
  saveS3,
  sourceSaved,
  pendingChange,
  initialize,
  select,
  loadMedia,
  create,
  addGrant,
  addSource,
  scan,
  share,
  canQueue,
  choose,
  requestChange,
  confirmChange,
  rename,
  libraryFormModel,
  sourceFormModel,
  grantFormModel,
  shareFormModel,
  mediaFormModel,
  readScanStatus,
} = screen;
</script>
<template>
  <section class="page private-library-page">
    <div class="page-title">
      <div class="page-intro">
        <p class="section-label">观看区</p>
        <h1>我的媒体库与授权</h1>
        <p>管理可访问的影片、片源和共享范围。房间分享只授权指定影片。</p>
      </div>
      <RouterLink to="/library" class="button"
        ><AppIcon name="movie" />浏览影片</RouterLink
      >
    </div>
    <div class="page-stack">
      <div
        v-if="
          error &&
          !confirmationOpen &&
          !shareEditOpen &&
          !s3EditOpen &&
          !withdrawalOpen
        "
        class="surface-card surface-card--compact"
      >
        <Notice :message="error" error />
        <button
          v-if="!selected"
          :disabled="listBusy || detailBusy"
          @click="selectedId ? select(selectedId) : initialize()"
        >
          <AppIcon name="refresh" />重新加载媒体库
        </button>
      </div>
      <Notice :message="notice" />
      <p v-if="configurationLoaded && !enabled" class="notice">
        私人媒体库功能尚未开启，请联系管理员。
      </p>
      <div
        v-if="listBusy && !configurationLoaded"
        class="loading-state"
        role="status"
      >
        正在加载媒体库…
      </div>
      <div
        v-if="configurationLoaded && !libraries.length"
        class="empty-state empty-state--compact surface-card"
      >
        <span class="empty-state__icon"
          ><AppIcon name="movie" :size="28"
        /></span>
        <h2>还没有可访问的媒体库</h2>
        <p>
          {{
            enabled
              ? "在下方创建私人库并添加片源，或请库所有者向你的固定登录账号授权。"
              : "请管理员确认可访问的片源与媒体库授权。"
          }}
        </p>
      </div>
      <div class="library-workspace">
        <LibraryManagementPanel
          :enabled="enabled"
          :busy="busy"
          :libraries="libraries"
          :selected="selected"
          :selected-id="selectedId"
          :user-id="session.user?.id"
          v-model:form="libraryFormModel"
          @create="create"
          @select="select"
          @rename="rename"
          @delete-library="
            (id, name) => requestChange('deleteLibrary', id, name)
          "
        />
        <div class="library-content page-stack">
          <div
            v-if="detailBusy && !selected"
            class="loading-state"
            role="status"
          >
            正在打开媒体库…
          </div>
          <template v-if="selected">
            <LibraryMediaPanel
              v-if="selected.permissions.browse"
              ref="libraryBrowser"
              :selected="selected"
              :busy="busy"
              :media="media"
              :media-busy="mediaBusy"
              :media-error="mediaError"
              :has-more="hasMore"
              :can-queue="canQueue"
              :runtime="runtime"
              v-model:form="mediaFormModel"
              v-model:share-form="shareFormModel"
              @load="loadMedia"
              @choose="choose"
            />
            <section
              v-else
              class="surface-card empty-state empty-state--compact"
            >
              <span class="empty-state__icon"
                ><AppIcon name="key" :size="28"
              /></span>
              <h2>当前账号没有浏览权限</h2>
              <p>
                已有的播放授权与浏览权限独立。需要查看库内影片时，请联系库所有者。
              </p>
            </section>

            <LibraryRoomSharesPanel
              :selected="selected"
              :enabled="enabled"
              :busy="busy"
              :media="media"
              :room="runtime.room"
              v-model:form="shareFormModel"
              @share="share"
              @edit-share="editShare"
              @request-change="requestChange"
            />

            <LibrarySourcesPanel
              :selected="selected"
              :busy="busy"
              :enabled="enabled"
              :is-admin="!!session.user?.admin"
              :scans="scans"
              v-model:form="sourceFormModel"
              @add="addSource"
              @scan="scan"
              @read-status="readScanStatus"
              @edit="editSource"
              @request-change="requestChange"
            />

            <LibraryAccessPanel
              :enabled="enabled"
              :user-id="session.user?.id"
              :selected="selected"
              :busy="busy"
              v-model:form="grantFormModel"
              @save="addGrant"
              @edit="editGrant"
              @cancel="cancelGrantEdit"
              @request-change="requestChange"
            />

            <details
              v-if="selected.owner_id === session.user?.id && enabled"
              class="surface-card library-details"
            >
              <summary>转移媒体库所有权</summary>
              <form
                class="library-inline-form"
                @submit.prevent="requestChange('transfer', transferName)"
              >
                <p class="helper library-wide">
                  房间所有权保持独立。转移会终止旧库授权，且不会给你保留默认访问权。
                </p>
                <label
                  >新所有者的固定登录账号<input v-model="transferName" required
                /></label>
                <button class="danger" :disabled="busy">转移所有权</button>
              </form>
            </details>
            <details v-if="selected.audit" class="surface-card library-details">
              <summary>最近管理审计</summary>
              <ul v-if="selected.audit.length" class="data-list">
                <li
                  v-for="entry in selected.audit"
                  :key="entry.id"
                  class="data-row"
                >
                  <span class="helper">{{
                    new Date(entry.created_at).toLocaleString()
                  }}</span
                  ><span>{{ entry.action }}</span>
                </li>
              </ul>
              <p v-else class="helper">暂无管理记录。</p>
            </details>
          </template>
        </div>
      </div>
      <IssuedSharesPanel
        :issued-shares="issuedShares"
        :issued-busy="issuedBusy"
        :issued-error="issuedError"
        :issued-has-more="issuedHasMore"
        :busy="busy"
        @load="loadIssuedShares"
        @withdraw="requestWithdrawal"
      />
    </div>
    <SourceSettingsDialog
      v-if="selected"
      :source="settingsSource"
      :api-base="`/libraries/${encodeURIComponent(selected.id)}/sources`"
      :require-admin="false"
      @close="settingsSource = undefined"
      @saved="sourceSaved"
    />

    <LibraryDialogs
      :busy="busy"
      :error="error"
      :is-admin="!!session.user?.admin"
      v-model:withdrawal="withdrawal"
      v-model:share-edit="shareEdit"
      v-model:s3-edit="s3Edit"
      v-model:pending-change="pendingChange"
      @withdraw="confirmWithdrawal"
      @save-share="saveShare"
      @save-s3="saveS3"
      @confirm="confirmChange"
    />
  </section>
</template>
<style src="./private-library-page.css"></style>
