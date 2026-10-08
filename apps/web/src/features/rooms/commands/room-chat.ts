import { computed, ref, shallowRef } from "vue";
import type { ApiClient } from "../../../shared/api/client";
import type { Message } from "../../../shared/api/types";
import { RequestFailure } from "../../../errors";
import {
  emptyChatProjection,
  projectChatDeletion,
  projectChatDeletions,
  projectChatHistory,
  projectChatMessage,
} from "../projection/chat-projection";
import type { RoomScopePort } from "./room-scope";

export function createRoomChat(options: {
  api: ApiClient;
  scope: RoomScopePort;
  active: () => boolean;
  connected: () => boolean;
  send: (payload: unknown) => boolean;
  error: (message: string) => void;
}) {
  const projection = shallowRef(emptyChatProjection());
  const messages = computed({
    get: () => projection.value.messages,
    set: (messages: Message[]) => {
      projection.value = { ...projection.value, messages };
    },
  });
  const chat = ref(""),
    chatPending = ref(false),
    chatFailed = ref(false);
  let pending: { id: string; body: string } | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  async function catchUp() {
    const scope = options.scope.capture();
    if (!scope) return;
    const before = [...messages.value],
      recovered: Message[] = [];
    let after = before.at(-1)?.id;
    const visited = new Set<string>();
    do {
      let history: Message[],
        resetCursor = false;
      try {
        history = await options.api<Message[]>(
          `/rooms/${scope.room}/messages${after ? `?after=${encodeURIComponent(after)}` : ""}`,
        );
      } catch (failure) {
        if (
          !after ||
          !(failure instanceof RequestFailure) ||
          failure.code !== "CHAT_CURSOR_NOT_FOUND"
        )
          throw failure;
        history = await options.api<Message[]>(`/rooms/${scope.room}/messages`);
        resetCursor = true;
      }
      if (!options.scope.current(scope)) return;
      recovered.push(...history);
      projection.value = projectChatHistory(
        projection.value,
        before,
        recovered,
      );
      if (resetCursor || history.length < 100) break;
      after = history.at(-1)?.id;
      if (!after || visited.has(after)) break;
      visited.add(after);
    } while (after);
    // Revalidate cached IDs too: disconnected deletions may precede the cursor.
    const cached = messages.value.map((message) => message.id);
    for (let i = 0; i < cached.length; i += 100) {
      if (!options.scope.current(scope)) return;
      const history = await options.api<Message[]>(
        `/rooms/${scope.room}/messages?check_ids=${cached.slice(i, i + 100).join(",")}`,
      );
      if (!options.scope.current(scope)) return;
      projection.value = projectChatDeletions(
        projection.value,
        history
          .filter((message) => message.deleted)
          .map((message) => message.id),
      );
    }
  }
  function disconnected() {
    clearTimeout(timer);
    chatPending.value = false;
    chatFailed.value = !!pending;
  }
  function accept(message: Message & { client_message_id?: string }) {
    projection.value = projectChatMessage(projection.value, message);
    if (pending && message.client_message_id === pending.id) {
      clearTimeout(timer);
      if (chat.value === pending.body) chat.value = "";
      pending = undefined;
      chatPending.value = false;
      chatFailed.value = false;
    }
  }
  function send() {
    const scope = options.scope.capture();
    if (
      !scope ||
      !options.active() ||
      !chat.value.trim() ||
      !options.connected() ||
      chatPending.value
    )
      return;
    if ([...chat.value].length > 2000) {
      options.error("聊天消息不能超过 2000 个字符");
      return;
    }
    if (!pending || pending.body !== chat.value)
      pending = { id: crypto.randomUUID(), body: chat.value };
    chatPending.value = true;
    chatFailed.value = false;
    clearTimeout(timer);
    const id = pending.id;
    timer = setTimeout(() => {
      if (!options.scope.currentRoom(scope) || pending?.id !== id) return;
      chatPending.value = false;
      chatFailed.value = true;
    }, 10000);
    options.send({
      type: "CHAT",
      body: chat.value,
      client_message_id: pending.id,
    });
  }
  function clearPending() {
    clearTimeout(timer);
    chatPending.value = false;
    chatFailed.value = false;
    pending = undefined;
  }
  function reset() {
    clearPending();
    projection.value = emptyChatProjection();
    chat.value = "";
  }
  return {
    messages,
    lastChatDeletion: computed(() => projection.value.lastDeletion),
    chat,
    chatPending,
    chatFailed,
    catchUp,
    disconnected,
    accept,
    remove: (id: string) => {
      projection.value = projectChatDeletion(projection.value, id);
    },
    send,
    clearPending,
    reset,
  };
}
