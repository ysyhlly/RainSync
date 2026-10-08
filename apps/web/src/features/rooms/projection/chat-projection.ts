import type { Message } from "../../../shared/api/types";

export type ChatProjection = {
  messages: Message[];
  deleted: ReadonlySet<string>;
  lastDeletion: string | undefined;
};

export function emptyChatProjection(): ChatProjection {
  return { messages: [], deleted: new Set(), lastDeletion: undefined };
}

function conceal(messages: Message[], deleted: ReadonlySet<string>) {
  return messages.map((message) =>
    deleted.has(message.id) ? { ...message, body: "", deleted: true } : message,
  );
}

/** Deletions are tombstones: neither late history nor duplicate live chat revives them. */
export function projectChatHistory(
  current: ChatProjection,
  before: Message[],
  recovered: Message[],
): ChatProjection {
  const deleted = new Set(current.deleted);
  for (const message of recovered) if (message.deleted) deleted.add(message.id);
  const messages = [
    ...new Map(
      [...before, ...recovered, ...current.messages].map((message) => [
        message.id,
        message,
      ]),
    ).values(),
  ].slice(-2000);
  return { ...current, deleted, messages: conceal(messages, deleted) };
}

export function projectChatDeletions(
  current: ChatProjection,
  ids: string[],
): ChatProjection {
  const deleted = new Set([...current.deleted, ...ids]);
  return { ...current, deleted, messages: conceal(current.messages, deleted) };
}

export function projectChatMessage(
  current: ChatProjection,
  message: Message,
): ChatProjection {
  let next = current;
  if (message.deleted) next = projectChatDeletions(current, [message.id]);
  if (next.messages.some((existing) => existing.id === message.id)) return next;
  return {
    ...next,
    messages: conceal([...next.messages, message].slice(-2000), next.deleted),
  };
}

export function projectChatDeletion(
  current: ChatProjection,
  id: string,
): ChatProjection {
  return { ...projectChatDeletions(current, [id]), lastDeletion: id };
}
