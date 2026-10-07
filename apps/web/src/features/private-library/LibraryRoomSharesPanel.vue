<script setup lang="ts">
import type { Media, Room } from "../../shared/api/types";
import type { LibraryDetail, RoomShare } from "./private-library.api";
import type { LibrarySharingDraft } from "./use-library-settings";
import type { ChangeKind } from "./use-library-changes";
const props = defineProps<{
  selected: LibraryDetail;
  enabled: boolean;
  busy: boolean;
  media: Media[];
  room: Room | null;
}>();
const emit = defineEmits<{
  (event: "share"): void;
  (event: "editShare", value: RoomShare): void;
  (event: "requestChange", kind: ChangeKind, id: string, label: string): void;
}>();
const runtime = {
  get room() {
    return props.room;
  },
};
const share = () => emit("share");
const editShare = (value: RoomShare) => emit("editShare", value);
const requestChange = (kind: ChangeKind, id: string, label: string) =>
  emit("requestChange", kind, id, label);
const form = defineModel<LibrarySharingDraft>("form", { required: true });
</script>
<template>
  <section
    v-if="
      (enabled && selected.permissions.share_to_room) ||
      selected.room_shares?.length
    "
    class="surface-card page-stack"
  >
    <div class="section-heading">
      <div class="section-heading__copy">
        <h2>房间分享</h2>
        <p class="helper">只分享一部影片，不开放整库浏览</p>
      </div>
      <span class="status-badge"
        >{{
          selected.room_shares?.filter((item) => item.active).length ?? 0
        }}
        个有效分享</span
      >
    </div>
    <form
      v-if="enabled && selected.permissions.share_to_room"
      class="library-form-grid"
      @submit.prevent="share"
    >
      <p v-if="!runtime.room" class="notice library-wide">
        先进入一个房间，再返回这里。<RouterLink to="/rooms"
          >选择放映室</RouterLink
        >
      </p>
      <p v-else class="helper library-wide">分享至：{{ runtime.room.name }}</p>
      <label
        >影片<select v-model="form.shareMedia" required>
          <option value="" disabled>选择影片</option>
          <option
            v-if="
              form.shareMedia &&
              !media.some((item) => item.id === form.shareMedia)
            "
            :value="form.shareMedia"
          >
            已选中的影片
          </option>
          <option v-for="item in media" :key="item.id" :value="item.id">
            {{ item.title }}
          </option>
        </select></label
      >
      <label
        >观看范围<select v-model="form.shareMode">
          <option value="library_members">仅已有库播放权限的房间成员</option>
          <option value="room_members">允许本房间有效成员观看此影片</option>
        </select></label
      >
      <label
        >有效分钟<input
          v-model.number="form.minutes"
          type="number"
          min="1"
          max="1440"
          required
      /></label>
      <p class="helper library-wide">
        分享不开放整库浏览。撤销不能收回已经下载的数据。
      </p>
      <div class="button-row library-wide">
        <button
          class="primary"
          :disabled="busy || !runtime.room || !form.shareMedia"
        >
          确认分享指定影片
        </button>
      </div>
    </form>
    <ul v-if="selected.room_shares?.length" class="data-list">
      <li
        v-for="shareItem in selected.room_shares"
        :key="shareItem.id"
        class="data-row"
      >
        <div class="data-row__body">
          <strong>{{ shareItem.title }}</strong>
          <p class="helper">
            {{ shareItem.mode === "room_members" ? "房间成员" : "库授权成员" }}
            · {{ shareItem.active ? "未撤销" : "已失效" }} · 到期
            {{ new Date(shareItem.expires_at).toLocaleString() }}
          </p>
        </div>
        <div class="data-row__actions">
          <button
            :disabled="
              busy || !shareItem.active || !selected.permissions.share_to_room
            "
            @click="editShare(shareItem)"
          >
            设置
          </button>
          <button
            class="danger"
            :disabled="busy || !shareItem.active"
            @click="requestChange('revokeShare', shareItem.id, shareItem.title)"
          >
            撤销分享
          </button>
        </div>
      </li>
    </ul>
    <p v-else class="helper">
      还没有房间分享。选择影片和观看范围后，即可建立限时授权。
    </p>
  </section>
</template>
