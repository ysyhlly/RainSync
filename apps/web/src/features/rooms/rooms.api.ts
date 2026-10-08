import type { ApiClient } from "../../shared/api/client";
import {
  validatePlatformImportPreview,
  validatePlatformImportBatch,
  platformImportInput,
  platformCollectionProvider,
  type PlatformImportAccountIntent,
  type PlatformImportBatchItem,
} from "./platform-import";
import type {
  Room,
  RoomMember,
  Media,
  NativePlatformProvider,
} from "../../shared/api/types";
export const roomsApi = (api: ApiClient) => ({
  list: () => api<Room[]>("/rooms"),
  members: (id: string) =>
    api<RoomMember[]>(`/rooms/${encodeURIComponent(id)}/members`),
  previewPlatform: async (
    room: string,
    input: string,
    provider?: NativePlatformProvider,
    collection = false,
    signal?: AbortSignal,
    account?: PlatformImportAccountIntent,
    continuation?: string,
  ) =>
    validatePlatformImportPreview(
      await api(
        `/rooms/${encodeURIComponent(room)}/platform-media/preview`,
        "POST",
        {
          input: platformImportInput(input),
          ...(provider ? { provider } : {}),
          collection,
          ...(collection
            ? {
                collection_version: 2,
                ...(continuation ? { continuation } : {}),
              }
            : {}),
          ...(collection &&
          (platformCollectionProvider(input, provider) === "youtube" ||
            (platformCollectionProvider(input, provider) === "bilibili" &&
              /\/(bangumi|cheese)\/play\/ss[1-9]\d*/.test(input)))
            ? {
                credential_mode: account?.credential_mode ?? "anonymous",
                ...(account?.credential_mode === "own_or_anonymous" &&
                account.account_id
                  ? { account_id: account.account_id }
                  : {}),
              }
            : {}),
        },
        signal,
      ),
    ),
  importPlatformBatch: async (
    room: string,
    selected: readonly PlatformImportBatchItem[],
    signal?: AbortSignal,
  ) => {
    const items = selected.map((item) => ({
      key: item.key,
      provider: item.provider,
      url: item.url,
      part: item.part,
      ...(item.live_version ? { live_version: item.live_version } : {}),
      ...(item.course_version === 1 ? { course_version: 1 as const } : {}),
      ...((item.provider === "bilibili" &&
        (item.url.includes("/bangumi/play/ep") ||
          item.live_version === 1 ||
          item.course_version === 1)) ||
      item.provider === "douyin" ||
      item.provider === "tiktok" ||
      item.provider === "youtube"
        ? {
            credential_mode: item.credential_mode ?? "anonymous",
            ...(item.credential_mode === "own_or_anonymous" && item.account_id
              ? { account_id: item.account_id }
              : {}),
          }
        : {}),
    }));
    return validatePlatformImportBatch(
      await api(
        `/rooms/${encodeURIComponent(room)}/platform-media/batch`,
        "POST",
        { items },
        signal,
      ),
      items,
    );
  },
  importPlatform: (
    room: string,
    url: string,
    part?: number,
    signal?: AbortSignal,
    provider: NativePlatformProvider = "bilibili",
    account?: PlatformImportAccountIntent,
  ) =>
    api<Media>(
      `/rooms/${encodeURIComponent(room)}/platform-media`,
      "POST",
      {
        provider,
        url,
        ...(part === undefined ? {} : { part }),
        ...(provider !== "bilibili" &&
        (/^https:\/\/live\.douyin\.com\//.test(url) ||
          /^https:\/\/m\.tiktok\.com\/share\/live\//.test(url) ||
          /^https:\/\/www\.tiktok\.com\/@[^/]+\/live$/.test(url) ||
          /^https:\/\/(?:www\.|m\.)?youtube\.com\/live\//.test(url))
          ? { live_version: 2 }
          : {}),
        ...(provider === "bilibili" &&
        /^https:\/\/live\.bilibili\.com\//.test(url)
          ? { live_version: 1 }
          : {}),
        ...(provider === "bilibili" && url.includes("/cheese/play/ep")
          ? { course_version: 1 }
          : {}),
        ...(account &&
        ((provider === "bilibili" &&
          (url.includes("/cheese/play/ep") ||
            url.includes("/bangumi/play/ep") ||
            /^https:\/\/live\.bilibili\.com\//.test(url))) ||
          provider === "douyin" ||
          provider === "tiktok" ||
          provider === "youtube")
          ? {
              credential_mode: account.credential_mode,
              ...(account.credential_mode === "own_or_anonymous" &&
              account.account_id
                ? { account_id: account.account_id }
                : {}),
            }
          : {}),
      },
      signal,
    ),
  create: (name: string, requestKey: string) =>
    api<{ id: string }>("/rooms", "POST", { name }, undefined, {
      "Idempotency-Key": requestKey,
    }),
  join: (id: string, token: string) =>
    api("/rooms/" + encodeURIComponent(id) + "/join", "POST", { token }),
});
