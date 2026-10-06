<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onBeforeUnmount } from "vue";
import { useSession } from "../auth/session.store";
import type { Profile, Avatar } from "../../shared/api/types";
import { RequestFailure } from "../../errors";
import { validateNickname } from "../auth/account-rules";
import { useAction } from "../../shared/use-action";
import UserAvatar from "../../shared/ui/UserAvatar.vue";
import Notice from "../../shared/ui/Notice.vue";
import AppDialog from "../../shared/ui/AppDialog.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import PlatformAccountPanel from "./PlatformAccountPanel.vue";
import AccountExitPanel from "./AccountExitPanel.vue";
import ShortPlatformAccountPanel from "./ShortPlatformAccountPanel.vue";
import YoutubePlatformAccountPanel from "./YoutubePlatformAccountPanel.vue";
import AvatarCropDialog from "./avatar/AvatarCropDialog.vue";
import { decodeAvatar } from "./avatar/image-input";
const session = useSession(),
  identity = session.user!.id,
  initialUser = session.user!,
  currentUser = computed(() => session.user ?? initialUser),
  { busy, error, message, run } = useAction();
const loaded = ref(false),
  nickname = ref(""),
  fileInput = ref<HTMLInputElement>(),
  selected = shallowRef<ImageBitmap>(),
  cropOpen = ref(false),
  decoding = ref(false),
  avatarBusy = ref(false),
  avatarError = ref(""),
  avatarMessage = ref(""),
  removeOpen = ref(false);
type Operation = {
  id: string;
  version: string | null;
  method: "PUT" | "DELETE";
  body?: Blob;
};
const pending = shallowRef<Operation>();
let selection = 0,
  alive = true;
async function load() {
  const profile = await session.api<Profile>("/users/me/profile");
  if (!alive) return;
  session.updateProfile(profile, identity);
  nickname.value = profile.custom_display_name ?? "";
  loaded.value = true;
}
async function saveName() {
  const invalid = validateNickname(nickname.value);
  if (invalid) throw Error(invalid);
  const profile = await session.api<Profile>("/users/me/profile", "PATCH", {
    display_name: nickname.value,
  });
  if (!alive) return;
  session.updateProfile(
    {
      display_name: profile.display_name,
      custom_display_name: profile.custom_display_name,
    },
    identity,
  );
  nickname.value = profile.custom_display_name ?? "";
  message.value = "昵称已保存";
}
async function choose(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const serial = ++selection;
  decoding.value = true;
  avatarError.value = "";
  avatarMessage.value = "";
  try {
    const bitmap = await decodeAvatar(file);
    if (!alive || serial !== selection) {
      bitmap.close();
      return;
    }
    selected.value?.close();
    selected.value = bitmap;
    pending.value = undefined;
    cropOpen.value = true;
  } catch (e) {
    if (alive && serial === selection)
      avatarError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (serial === selection) decoding.value = false;
  }
}
function closeCrop(open: boolean) {
  cropOpen.value = open;
  if (!open) {
    ++selection;
    selected.value?.close();
    selected.value = undefined;
    if (pending.value)
      avatarMessage.value =
        "保存结果尚待确认，可刷新头像状态确认；关闭弹窗不能撤回已发送的请求。";
  }
}
async function refreshAvatar() {
  const profile = await session.api<Profile>("/users/me/profile");
  if (alive)
    session.updateProfile(
      {
        avatar_url: profile.avatar_url,
        avatar_version: profile.avatar_version,
      },
      identity,
    );
  return profile;
}
function done(value: Avatar) {
  session.updateProfile(value, identity);
  pending.value = undefined;
  avatarError.value = "";
  avatarMessage.value = value.avatar_url ? "头像已保存" : "已恢复默认头像";
  closeCrop(false);
  removeOpen.value = false;
}
async function execute(operation: Operation) {
  avatarBusy.value = true;
  avatarError.value = "";
  avatarMessage.value = "";
  try {
    const value = await session.api<Avatar>(
      "/users/me/avatar",
      operation.method,
      operation.body,
      AbortSignal.timeout(20000),
      {
        "x-avatar-operation-id": operation.id,
        "If-Match": JSON.stringify(operation.version ?? "none"),
      },
    );
    if (alive) done(value);
  } catch (e) {
    if (!alive) return;
    try {
      const current = await refreshAvatar();
      if (current.avatar_version === operation.id) {
        done(current);
        return;
      }
    } catch {
      /* Preserve uncertain operation; no automatic overwrite or new operation ID. */
    }
    if (e instanceof RequestFailure) {
      pending.value = undefined;
      avatarError.value =
        e.code === "AVATAR_VERSION_CONFLICT"
          ? "头像已在其他位置更新，已尝试刷新。请检查后重新确认保存。"
          : e.message;
    } else
      avatarError.value =
        "头像保存结果尚未确认。旧头像暂时保留，可重试同一保存操作或刷新状态确认。";
  } finally {
    avatarBusy.value = false;
  }
}
async function saveAvatar(blob: Blob) {
  if (avatarBusy.value) return;
  const operation = pending.value ?? {
    id: crypto.randomUUID(),
    version: session.user!.avatar_version,
    method: "PUT" as const,
    body: blob,
  };
  pending.value = operation;
  await execute(operation);
}
async function remove() {
  if (avatarBusy.value) return;
  const operation =
    pending.value?.method === "DELETE"
      ? pending.value
      : {
          id: crypto.randomUUID(),
          version: session.user!.avatar_version,
          method: "DELETE" as const,
        };
  pending.value = operation;
  await execute(operation);
}
async function confirmAvatar() {
  await run(async () => {
    const value = await refreshAvatar();
    if (pending.value && value.avatar_version === pending.value.id) done(value);
    else avatarMessage.value = "已读取当前头像状态";
  });
}
onMounted(() => run(load));
onBeforeUnmount(() => {
  alive = false;
  ++selection;
  selected.value?.close();
  selected.value = undefined;
});
</script>
<template>
  <section class="page profile-page">
    <div class="page-title">
      <div>
        <p class="section-label">账号设置</p>
        <h1>个人资料</h1>
        <p>昵称和头像分别保存，登录账号保持不变。</p>
      </div>
    </div>
    <Notice :message="error" error /><button
      v-if="!loaded && error"
      @click="run(load)"
    >
      重新加载
    </button>
    <p v-if="!loaded && busy" role="status">正在加载个人资料…</p>
    <div v-if="loaded" class="profile-grid">
      <section class="panel avatar-panel">
        <h2>头像</h2>
        <UserAvatar
          :name="currentUser.display_name"
          :url="currentUser.avatar_url"
          :size="128"
        />
        <p class="helper">
          静态
          JPG、PNG、WebP，原图不超过10MiB。支持拖动和缩放取景，保存512×512图片。
        </p>
        <input
          ref="fileInput"
          class="sr-only"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label="选择头像图片"
          @change="choose"
        />
        <div class="button-row">
          <button
            class="primary"
            :disabled="decoding || avatarBusy"
            @click="fileInput?.click()"
          >
            <AppIcon name="photo" />{{
              decoding
                ? "正在解码…"
                : currentUser.avatar_url
                  ? "更换头像"
                  : "上传头像"
            }}</button
          ><button
            v-if="currentUser.avatar_url"
            :disabled="avatarBusy"
            @click="removeOpen = true"
          >
            恢复默认
          </button>
        </div>
        <Notice
          v-if="!cropOpen && !removeOpen"
          :message="avatarError"
          error
        /><Notice :message="avatarMessage" /><button
          v-if="pending && !cropOpen && !removeOpen"
          @click="confirmAvatar"
        >
          刷新头像状态
        </button>
      </section>
      <section class="panel">
        <h2>显示资料</h2>
        <form @submit.prevent="run(saveName)">
          <label
            >登录账号<input
              :value="currentUser.username"
              readonly
              aria-describedby="profile-account-help"
          /></label>
          <p id="profile-account-help" class="helper">
            账号唯一且不可修改，登录时仍使用此账号。
          </p>
          <label
            >昵称<input
              v-model="nickname"
              autocomplete="nickname"
              aria-describedby="profile-name-help"
              :disabled="busy"
          /></label>
          <p id="profile-name-help" class="helper">
            可选、可重复，最多50个字符。留空显示登录账号。
          </p>
          <Notice :message="message" /><button class="primary" :disabled="busy">
            {{ busy ? "正在保存…" : "保存昵称" }}
          </button>
        </form>
      </section>
    </div>
    <PlatformAccountPanel />
    <ShortPlatformAccountPanel provider="douyin" />
    <ShortPlatformAccountPanel provider="tiktok" />
    <YoutubePlatformAccountPanel />
    <AccountExitPanel />
    <AvatarCropDialog
      v-if="selected"
      :image="selected"
      :model-value="cropOpen"
      :saving="avatarBusy"
      :locked="!!pending"
      :error="avatarError"
      @update:model-value="closeCrop"
      @save="saveAvatar"
    /><AppDialog v-model="removeOpen" title="恢复默认头像" :busy="avatarBusy"
      ><p>仅清除头像，昵称和登录账号不会改变。</p>
      <Notice :message="avatarError" error />
      <div class="dialog-actions">
        <button :disabled="avatarBusy" @click="removeOpen = false">取消</button
        ><button class="danger" :disabled="avatarBusy" @click="remove">
          {{ avatarBusy ? "正在恢复…" : "确认恢复默认" }}
        </button>
      </div></AppDialog
    >
  </section>
</template>
