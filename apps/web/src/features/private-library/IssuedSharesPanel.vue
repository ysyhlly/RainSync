<script setup lang="ts">
import type { IssuedRoomShare } from "./private-library.api";
import Notice from "../../shared/ui/Notice.vue";
defineProps<{
  issuedShares: IssuedRoomShare[];
  issuedBusy: boolean;
  issuedError: string;
  issuedHasMore: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  (event: "load", next?: boolean): void;
  (event: "withdraw", share: IssuedRoomShare): void;
}>();
const loadIssuedShares = (next = false) => emit("load", next);
const requestWithdrawal = (share: IssuedRoomShare) => emit("withdraw", share);
</script>
<template>
  <section class="surface-card page-stack" aria-label="我发出的分享">
    <div class="section-heading">
      <div class="section-heading__copy">
        <h2>我发出的分享</h2>
        <p class="helper">即使媒体库授权已到期，也可以撤销自己发出的分享。</p>
      </div>
      <button :disabled="busy || issuedBusy" @click="loadIssuedShares()">
        刷新分享
      </button>
    </div>
    <Notice :message="issuedError" error />
    <ul v-if="issuedShares.length" class="data-list">
      <li v-for="item in issuedShares" :key="item.id" class="data-row">
        <div class="data-row__body">
          <strong>{{ item.title ?? "无浏览权限的影片" }}</strong>
          <p class="helper">
            房间 {{ item.room_id }} · {{ item.active ? "有效" : "已失效" }} ·
            到期
            {{ new Date(item.expires_at).toLocaleString() }}
          </p>
        </div>
        <button
          class="danger"
          :disabled="busy || issuedBusy"
          @click="requestWithdrawal(item)"
        >
          撤销我的分享
        </button>
      </li>
    </ul>
    <p v-else class="helper">
      {{ issuedBusy ? "正在加载分享…" : "没有待撤销的分享" }}
    </p>
    <button
      v-if="issuedHasMore"
      :disabled="busy || issuedBusy"
      @click="loadIssuedShares(true)"
    >
      加载更多分享
    </button>
  </section>
</template>
