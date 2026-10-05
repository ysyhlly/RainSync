import { validNativeLiveBinding } from "../playback/native-live";
import type { NativePlatformProvider } from "../../shared/api/types";
import type { Media } from "../../shared/api/types";
import type { NativePlatformCredentialMode } from "../../../../../packages/protocol";
import type {
  PlatformAccountStatus,
  ShortPlatformAccountStatus,
  YoutubePlatformAccountStatus,
} from "../account/platform-account.api";

export interface PlatformImportAccountIntent {
  credential_mode: NativePlatformCredentialMode;
  account_id?: string;
}
/** Imports never borrow the room owner's or another provider's credentials. */
export function platformImportAccountIntent(
  provider: NativePlatformProvider,
  mode: NativePlatformCredentialMode,
  status?:
    | PlatformAccountStatus
    | ShortPlatformAccountStatus
    | YoutubePlatformAccountStatus,
  isEpisode = false,
): PlatformImportAccountIntent | undefined {
  if (provider === "bilibili" && !isEpisode) return;
  return {
    credential_mode: mode,
    ...(mode === "own_or_anonymous" &&
    status?.provider === provider &&
    status.state === "connected" &&
    status.id
      ? { account_id: status.id }
      : {}),
  };
}

export const platformProviderLabels: Record<NativePlatformProvider, string> = {
  bilibili: "Bilibili",
  douyin: "抖音",
  tiktok: "TikTok",
  youtube: "YouTube",
};
export const platformProviderOptions = Object.entries(
  platformProviderLabels,
).map(([value, label]) => ({ value: value as NativePlatformProvider, label }));
export const platformVideoPlaceholders: Record<NativePlatformProvider, string> =
  {
    bilibili:
      "https://www.bilibili.com/video/BV…、/bangumi/play/ep…、/cheese/play/ep… 或 live.bilibili.com/…",
    douyin: "https://www.douyin.com/video/… 或 https://live.douyin.com/…",
    tiktok: "https://www.tiktok.com/@用户名/video/… 或 /@用户名/live",
    youtube: "https://www.youtube.com/watch?v=… 或 /live/视频编号",
  };

export function recognizedPlatformProvider(
  input: string,
): NativePlatformProvider | undefined {
  try {
    const host = new URL(input.trim()).hostname;
    if (
      [
        "bilibili.com",
        "www.bilibili.com",
        "m.bilibili.com",
        "live.bilibili.com",
      ].includes(host)
    )
      return "bilibili";
    if (["douyin.com", "www.douyin.com", "live.douyin.com"].includes(host))
      return "douyin";
    if (["tiktok.com", "www.tiktok.com", "m.tiktok.com"].includes(host))
      return "tiktok";
    if (
      ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(
        host,
      )
    )
      return "youtube";
  } catch {
    // Recognition never admits a URL; the selected parser does that below.
  }
}

/** Reject unsafe raw spellings before URL normalization can hide them. */
function fullPlatformUrl(input: string): URL {
  const raw = input.trim();
  if (
    raw.length > 2048 ||
    /[\s\\#\u0000-\u001f\u007f]/.test(raw) ||
    !/^https:\/\/[A-Za-z0-9.-]+\//.test(raw) ||
    /\/(?:\.|\.\.)(?:\/|\?|$)/.test(raw)
  )
    throw Error("请输入完整的 HTTPS 视频链接，不支持短链接或播放列表");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw Error("请输入完整的视频链接");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    /%/.test(url.pathname)
  )
    throw Error("视频链接格式无效，不支持短链接、账号信息或自定义端口");
  return url;
}

/** Only ordinary Bilibili BV/av videos retain the existing part contract. */
export function ordinaryBilibiliLink(input: string): {
  url: string;
  part?: number;
} {
  const url = fullPlatformUrl(input);
  if (
    !["www.bilibili.com", "bilibili.com"].includes(url.hostname) ||
    !/^\/video\/(?:BV[1-9A-HJ-NP-Za-km-z]{10}|av[1-9]\d*)\/?$/.test(
      url.pathname,
    )
  )
    throw Error(
      "仅支持普通 Bilibili BV/av 视频，不支持番剧、课程、直播或短链接",
    );
  const parts = url.searchParams.getAll("p");
  const raw = parts[0];
  if (
    parts.length > 1 ||
    (raw !== undefined && (!/^[1-9]\d*$/.test(raw) || Number(raw) > 10000))
  )
    throw Error("分 P 编号无效");
  return {
    url: `https://www.bilibili.com${url.pathname.replace(/\/$/, "")}`,
    ...(raw ? { part: Number(raw) } : {}),
  };
}

/** PGC episode links have no UGC part/query or season-selector fallback. */
export function bilibiliEpisodeLink(input: string): { url: string; part: 1 } {
  const url = fullPlatformUrl(input);
  const id = /^\/bangumi\/play\/ep([1-9]\d*)\/?$/.exec(url.pathname)?.[1];
  if (
    !["www.bilibili.com", "bilibili.com", "m.bilibili.com"].includes(
      url.hostname,
    ) ||
    url.search ||
    !id ||
    BigInt(id) > 9223372036854775807n
  )
    throw Error(
      "仅支持完整的 Bilibili ep 单集链接，不支持整季、预览、DRM 或课程",
    );
  return { url: `https://www.bilibili.com/bangumi/play/ep${id}`, part: 1 };
}
/** Course episode identity is distinct from UGC and PGC and has no season crawl. */
export function bilibiliCourseLink(input: string): {
  url: string;
  part: 1;
  course_version: 1;
} {
  const url = fullPlatformUrl(input);
  const id = /^\/cheese\/play\/ep([1-9]\d*)\/?$/.exec(url.pathname)?.[1];
  if (
    !["www.bilibili.com", "bilibili.com", "m.bilibili.com"].includes(
      url.hostname,
    ) ||
    input.trim().includes("?") ||
    url.search ||
    !id ||
    BigInt(id) > 9223372036854775807n
  )
    throw Error("仅支持完整的 Bilibili 课程单集链接，不支持整季、预览或 DRM");
  return {
    url: `https://www.bilibili.com/cheese/play/ep${id}`,
    part: 1,
    course_version: 1,
  };
}
export function platformEpisodeLabel(item: {
  provider: NativePlatformProvider;
  url: string;
  part: number;
  live_version?: 1 | 2;
  course_version?: 1;
}): string {
  if (item.live_version) return " · 直播场次";
  if (item.course_version === 1)
    return ` · 课程单集 ${/ep([1-9]\d*)$/.exec(item.url)?.[1] ?? ""}`;
  const ep =
    item.provider === "bilibili"
      ? /\/bangumi\/play\/ep([1-9]\d*)$/.exec(item.url)?.[1]
      : undefined;
  return ep ? ` · 单集 ep${ep}` : item.part > 1 ? ` · P${item.part}` : "";
}
export function bilibiliLiveLink(input: string): {
  url: string;
  part: 1;
  live_version: 1;
} {
  const url = fullPlatformUrl(input);
  const room = /^\/(?:blanc\/)?([1-9]\d{0,18})\/?$/.exec(url.pathname)?.[1];
  if (
    url.hostname !== "live.bilibili.com" ||
    input.trim().includes("?") ||
    url.search ||
    !room ||
    BigInt(room) > 9223372036854775807n
  )
    throw Error(
      "请输入完整的 Bilibili 直播间链接，不支持查询参数或其他直播入口",
    );
  return { url: `https://live.bilibili.com/${room}`, part: 1, live_version: 1 };
}
export function otherPlatformLiveLink(
  input: string,
  provider: NativePlatformProvider,
): { url: string; part: 1; live_version: 2 } | undefined {
  const url = fullPlatformUrl(input);
  if (url.search) return;
  const path = url.pathname.replace(/\/$/, "");
  const decimal = (value: string | undefined) =>
    !!value &&
    /^[1-9]\d{0,19}$/.test(value) &&
    BigInt(value) <= 18446744073709551615n;
  if (
    provider === "youtube" &&
    ["www.youtube.com", "youtube.com", "m.youtube.com"].includes(url.hostname)
  ) {
    const id = /^\/live\/([A-Za-z0-9_-]{11})$/.exec(path)?.[1];
    if (id)
      return {
        url: `https://www.youtube.com/live/${id}`,
        part: 1,
        live_version: 2,
      };
  }
  if (provider === "douyin" && url.hostname === "live.douyin.com") {
    const id = /^\/([1-9]\d{0,19})$/.exec(path)?.[1];
    if (decimal(id))
      return { url: `https://live.douyin.com/${id}`, part: 1, live_version: 2 };
  }
  if (provider === "tiktok") {
    const id =
      url.hostname === "m.tiktok.com"
        ? /^\/share\/live\/([1-9]\d{0,19})$/.exec(path)?.[1]
        : undefined;
    if (decimal(id))
      return {
        url: `https://m.tiktok.com/share/live/${id}`,
        part: 1,
        live_version: 2,
      };
    const handle =
      url.hostname === "www.tiktok.com"
        ? /^\/@([A-Za-z0-9_.]{1,24})\/live$/.exec(path)?.[1]
        : undefined;
    if (handle && ![".", ".."].includes(handle))
      return {
        url: `https://www.tiktok.com/@${handle}/live`,
        part: 1,
        live_version: 2,
      };
  }
}
/** Version 1 remains legacy; episodes and broadcasts have closed identities. */
export function validNativePlatformMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (p.version === 1)
    return (
      Object.hasOwn(platformProviderLabels, p.provider as string) &&
      Object.keys(p).sort().join(",") === "content_id,part,provider,version" &&
      typeof p.content_id === "string" &&
      Number.isInteger(p.part) &&
      (p.part as number) >= 1 &&
      (p.part as number) <= 10000 &&
      (p.provider !== "bilibili" ||
        /^(?:BV[1-9A-HJ-NP-Za-km-z]{10}|av[1-9]\d{0,18})$/.test(p.content_id))
    );
  if (p.version === 3) {
    if (
      p.provider !== "bilibili" ||
      p.part !== 1 ||
      Object.keys(p).sort().join(",") !==
        "content_id,part,provider,resource,version" ||
      !p.resource ||
      typeof p.resource !== "object" ||
      Array.isArray(p.resource)
    )
      return false;
    const r = p.resource as Record<string, unknown>;
    return (
      Object.keys(r).sort().join(",") === "broadcast_id,kind,room_id,uid" &&
      r.kind === "bilibili_live" &&
      [r.room_id, r.uid].every(
        (v) =>
          typeof v === "string" &&
          /^[1-9]\d{0,18}$/.test(v) &&
          BigInt(v) <= 9223372036854775807n,
      ) &&
      validNativeLiveBinding({
        version: 1,
        broadcast_id: r.broadcast_id,
        sync_mode: "live_edge_control",
      }) &&
      (r.broadcast_id as string).startsWith(`${r.room_id}:${r.uid}:`) &&
      p.content_id === `live:${r.room_id}:${r.broadcast_id}`
    );
  }
  if (p.version === 5) {
    if (
      !["youtube", "douyin", "tiktok"].includes(p.provider as string) ||
      p.part !== 1 ||
      Object.keys(p).sort().join(",") !==
        "content_id,part,provider,resource,version" ||
      !p.resource ||
      typeof p.resource !== "object" ||
      Array.isArray(p.resource)
    )
      return false;
    const r = p.resource as Record<string, unknown>;
    if (
      Object.keys(r).sort().join(",") !==
        "broadcast_id,broadcaster_id,canonical_url,kind,provider,resource_id,started_at" ||
      r.kind !== "other_live" ||
      r.provider !== p.provider ||
      typeof r.broadcast_id !== "string" ||
      !/^[0-9a-f]{64}$/.test(r.broadcast_id) ||
      typeof r.canonical_url !== "string" ||
      !Number.isInteger(r.started_at) ||
      (r.started_at as number) < 946684800 ||
      (r.started_at as number) > 4102444800 ||
      p.content_id !== `live:${p.provider}:${r.broadcast_id}`
    )
      return false;
    const decimal = (v: unknown) =>
      typeof v === "string" &&
      /^[1-9]\d{0,19}$/.test(v) &&
      BigInt(v) <= 18446744073709551615n;
    if (p.provider === "youtube") {
      if (
        typeof r.resource_id !== "string" ||
        !/^[A-Za-z0-9_-]{11}$/.test(r.resource_id) ||
        typeof r.broadcaster_id !== "string" ||
        !/^UC[A-Za-z0-9_-]{22}$/.test(r.broadcaster_id)
      )
        return false;
    } else if (!decimal(r.resource_id) || !decimal(r.broadcaster_id))
      return false;
    try {
      const parsed = otherPlatformLiveLink(
        r.canonical_url,
        p.provider as NativePlatformProvider,
      );
      if (!parsed || parsed.url !== r.canonical_url) return false;
      if (
        p.provider === "youtube" &&
        !r.canonical_url.endsWith(`/${r.resource_id}`)
      )
        return false;
      if (
        p.provider === "tiktok" &&
        r.canonical_url.startsWith("https://m.tiktok.com/") &&
        !r.canonical_url.endsWith(`/${r.resource_id}`)
      )
        return false;
      return true;
    } catch {
      return false;
    }
  }
  if (p.version === 4) {
    if (
      p.provider !== "bilibili" ||
      p.part !== 1 ||
      Object.keys(p).sort().join(",") !==
        "content_id,part,provider,resource,version" ||
      !p.resource ||
      typeof p.resource !== "object" ||
      Array.isArray(p.resource)
    )
      return false;
    const r = p.resource as Record<string, unknown>;
    return (
      Object.keys(r).sort().join(",") === "aid,cid,ep_id,kind,season_id" &&
      r.kind === "bilibili_course" &&
      [r.ep_id, r.aid, r.cid, r.season_id].every(
        (v) =>
          typeof v === "string" &&
          /^[1-9]\d{0,18}$/.test(v) &&
          BigInt(v) <= 9223372036854775807n,
      ) &&
      p.content_id === `course:ep${r.ep_id}`
    );
  }
  if (
    p.version !== 2 ||
    p.provider !== "bilibili" ||
    p.part !== 1 ||
    Object.keys(p).sort().join(",") !==
      "content_id,part,provider,resource,version" ||
    !p.resource ||
    typeof p.resource !== "object" ||
    Array.isArray(p.resource)
  )
    return false;
  const r = p.resource as Record<string, unknown>;
  return (
    Object.keys(r).sort().join(",") === "cid,ep_id,kind,season_id" &&
    r.kind === "bilibili_pgc" &&
    [r.ep_id, r.cid, r.season_id].every(
      (v) =>
        typeof v === "string" &&
        /^[1-9]\d{0,18}$/.test(v) &&
        BigInt(v) <= 9223372036854775807n,
    ) &&
    p.content_id === `ep${r.ep_id}`
  );
}

function shortVideoLink(url: URL, provider: "douyin" | "tiktok"): string {
  const hosts =
    provider === "douyin"
      ? ["douyin.com", "www.douyin.com"]
      : ["tiktok.com", "www.tiktok.com"];
  const match = (
    provider === "douyin"
      ? /^\/video\/([1-9]\d{0,19})\/?$/
      : /^\/@([A-Za-z0-9._]{1,24})\/video\/([1-9]\d{0,19})\/?$/
  ).exec(url.pathname);
  const id = match?.[provider === "douyin" ? 1 : 2];
  if (
    !hosts.includes(url.hostname) ||
    url.search ||
    !id ||
    BigInt(id) > 18446744073709551615n
  )
    throw Error(
      `请输入完整的${platformProviderLabels[provider]}视频链接，不支持短链接、直播、查询参数或其他内容`,
    );
  return `https://www.${provider}.com${url.pathname.replace(/\/$/, "")}`;
}

function youtubeLink(url: URL): string {
  let id: string | null;
  if (url.hostname === "youtu.be") {
    id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
  } else if (
    ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)
  ) {
    id =
      url.pathname === "/watch"
        ? url.searchParams.getAll("v").length === 1
          ? url.searchParams.get("v")
          : null
        : (/^\/shorts\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] ??
          null);
  } else id = null;
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id))
    throw Error("请输入完整的 YouTube watch、youtu.be 或 Shorts 视频链接");
  const keys = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (
      keys.has(key) ||
      (key === "v"
        ? url.hostname === "youtu.be" || url.pathname !== "/watch"
        : key === "t"
          ? !/^[0-9hms]{1,32}$/.test(value)
          : !["si", "feature"].includes(key) ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    )
      throw Error("YouTube 视频链接包含不支持的参数，不支持播放列表或直播入口");
    keys.add(key);
  }
  return `https://www.youtube.com/watch?v=${id}`;
}

export function ordinaryPlatformLink(
  input: string,
  provider?: NativePlatformProvider,
): {
  provider: NativePlatformProvider;
  url: string;
  part?: number;
  live_version?: 1 | 2;
  course_version?: 1;
} {
  const selected = provider ?? recognizedPlatformProvider(input);
  if (!selected || !Object.hasOwn(platformProviderLabels, selected))
    throw Error("仅支持 Bilibili、抖音、TikTok 和 YouTube 的完整视频链接");
  if (selected !== "bilibili" && /[^\x21-\x7e]|%/.test(input.trim()))
    throw Error("视频链接格式无效，请使用完整的规范视频链接");
  const rawQuery = input.trim().split("?")[1];
  if (
    selected !== "bilibili" &&
    rawQuery !== undefined &&
    (selected !== "youtube" ||
      !rawQuery ||
      rawQuery.split("&").some((pair) => !pair || !pair.includes("=")))
  )
    throw Error("视频链接包含不支持的查询参数，请使用完整的规范视频链接");
  const url = fullPlatformUrl(input);
  if (recognizedPlatformProvider(input) !== selected)
    throw Error(
      `请使用${platformProviderLabels[selected]}的视频链接，或更改所选平台`,
    );
  if (selected !== "bilibili") {
    const live = otherPlatformLiveLink(input, selected);
    if (live) return { provider: selected, ...live };
  }
  if (selected === "bilibili")
    return {
      provider: selected,
      ...(url.hostname === "live.bilibili.com"
        ? bilibiliLiveLink(input)
        : url.pathname.startsWith("/cheese/")
          ? bilibiliCourseLink(input)
          : url.pathname.startsWith("/bangumi/")
            ? bilibiliEpisodeLink(input)
            : ordinaryBilibiliLink(input)),
    };
  return {
    provider: selected,
    url:
      selected === "youtube" ? youtubeLink(url) : shortVideoLink(url, selected),
  };
}

export const platformImportLimit = 20;
export const platformImportInputBytes = 16 * 1024;
export interface PlatformImportScope {
  room: string | undefined;
  epoch: number;
  allowed: boolean;
}
/** Both request supersession and exact room/login scope fence publication. */
export function createPlatformImportFence(scope: () => PlatformImportScope) {
  let serial = 0,
    controller = new AbortController();
  return {
    retire() {
      ++serial;
      controller.abort();
      controller = new AbortController();
    },
    begin() {
      controller.abort();
      controller = new AbortController();
      const current = scope();
      return {
        serial: ++serial,
        room: current.room,
        epoch: current.epoch,
        signal: controller.signal,
      };
    },
    current(token: {
      serial: number;
      room: string | undefined;
      epoch: number;
      signal: AbortSignal;
    }) {
      const current = scope();
      return (
        !token.signal.aborted &&
        token.serial === serial &&
        current.allowed &&
        current.room === token.room &&
        current.epoch === token.epoch
      );
    },
  };
}
export interface PlatformImportFailure {
  code: string;
  retryable: boolean;
  attempted?: boolean;
}
export interface PlatformImportPreviewItem {
  key: string;
  provider: NativePlatformProvider;
  url: string;
  part: number;
  title: string | null;
  live_version?: 1 | 2;
  course_version?: 1;
}
export interface PlatformImportPreview {
  items: PlatformImportPreviewItem[];
  failures: { index: number; error: PlatformImportFailure }[];
  truncated: boolean;
  limit: number;
  next?: string | null;
  omitted?: number;
}
export interface PlatformImportBatchItem extends Omit<
  PlatformImportPreviewItem,
  "title"
> {
  credential_mode?: NativePlatformCredentialMode;
  account_id?: string;
}
export interface PlatformImportOutcome {
  key: string;
  media?: Media;
  error?: PlatformImportFailure;
}
export interface PlatformImportBatchResult {
  outcomes: PlatformImportOutcome[];
  stopped: string | null;
}
const importMessages: Record<string, string> = {
  platform_collection_unsupported:
    "此类内容暂不支持合集或播放列表展开，请使用明确的合集、播放列表或单独视频链接",
  native_other_live_provider_unavailable:
    "服务管理员尚未启用此平台的独立直播适配器，YouTube 还需要可信解析器配置",
  native_other_live_user_handoff_required:
    "平台要求自己的登录或官方网页验证，请完成后重新预览；不会自动生成签名或绕过验证",
  platform_collection_changed: "合集内容或访问权限已变化，请重新预览后选择",
  platform_collection_user_handoff_required:
    "平台要求自己的会话或网页验证，请在官方平台处理后重试；服务端不会生成签名或绕过验证",
  platform_collection_invalid:
    "播放列表链接无效；YouTube 仅支持 PL 编号或完整 /playlist?list=PL… 链接",
  platform_collection_provider_unavailable:
    "服务管理员尚未启用 YouTube 播放列表解析或自己的会话支持",
  platform_collection_restricted:
    "此播放列表未明确公开或不在支持范围内，不支持私有、付费或权限受限的列表",
  platform_collection_items_unavailable:
    "已省略预览范围内已知的直播、年龄限制或非公开视频；导入时会逐条检查可用性",
  platform_collection_cleanup_failed:
    "解析进程未能确认安全退出，请联系服务管理员检查后再试",
  platform_import_cancelled: "预览已取消，可以重新预览",
  platform_import_invalid: "链接无效或内容暂不支持，请使用普通视频或官方短链接",
  platform_import_limit: "一次最多预览和导入 20 条，粘贴内容不得超过 16 KiB",
  platform_import_unavailable:
    "平台短链接或合集暂不可用，可稍后重试或改用完整视频链接",
  platform_import_platform_restricted:
    "平台限制了此合集的公开访问，请改用单独视频链接",
  platform_import_deadline:
    "本次批量导入已超时，已成功的条目会保留，可重试剩余条目",
  platform_account_changed: "自己的对应平台会话已变化，请刷新后重新确认导入",
};
export function platformImportFailureMessage(
  failure: PlatformImportFailure,
): string {
  return importMessages[failure.code] ?? "此条目导入失败，可重新预览或重试";
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("导入响应不完整，请重新预览");
  return value as Record<string, any>;
}
function failure(value: unknown): PlatformImportFailure {
  const v = object(value);
  if (
    typeof v.code !== "string" ||
    !/^[a-z_]{1,100}$/.test(v.code) ||
    typeof v.retryable !== "boolean" ||
    (v.attempted !== undefined && typeof v.attempted !== "boolean")
  )
    throw Error("导入响应不完整，请重新预览");
  return {
    code: v.code,
    retryable: v.retryable,
    ...(v.attempted === undefined ? {} : { attempted: v.attempted }),
  };
}
/** Local bounds only. All discovery still uses the server's closed transport. */
export function platformImportInput(input: string): string {
  const value = input.trim();
  if (
    !value ||
    new TextEncoder().encode(value).length > platformImportInputBytes ||
    value.includes("\0")
  )
    throw Error(importMessages.platform_import_limit);
  const links = value.match(/https:\/\/[^\s，。；、（）<>"']+/g);
  if (
    (links?.length ?? value.split(/\r?\n/).filter((s) => s.trim()).length) >
    platformImportLimit
  )
    throw Error(importMessages.platform_import_limit);
  return value;
}
/** Mirror the server's bounded single-candidate share extraction for account
 * intent only. This does not admit or fetch the collection URL itself. */
export function platformCollectionProvider(
  input: string,
  selected?: NativePlatformProvider,
): NativePlatformProvider | undefined {
  const value = platformImportInput(input);
  const links = value.match(/https:\/\/[^\s，。；、（）<>"']+/g);
  const candidates = links
    ? links.map((link) => link.replace(/[.,;)\]]+$/, ""))
    : value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
  if (candidates.length !== 1) throw Error("一次只能展开一个合集或播放列表");
  const candidate = candidates[0];
  if (new TextEncoder().encode(candidate).length > 2048)
    throw Error(importMessages.platform_import_limit);
  // Discovery recognizes the same official collection/share host families as
  // the server; ordinaryPlatformLink still applies its stricter video grammar.
  if (candidate.startsWith("course:ep")) return "bilibili";
  try {
    const host = new URL(candidate).hostname;
    if (["m.bilibili.com", "space.bilibili.com", "b23.tv"].includes(host))
      return "bilibili";
    if (host === "v.douyin.com") return "douyin";
    if (["vm.tiktok.com", "vt.tiktok.com"].includes(host)) return "tiktok";
  } catch {
    // A bounded bare identity retains only its explicitly selected fallback.
  }
  return recognizedPlatformProvider(candidate) ?? selected;
}
export function validatePlatformImportPreview(
  value: unknown,
): PlatformImportPreview {
  const v = object(value);
  if (
    !Array.isArray(v.items) ||
    v.items.length > platformImportLimit ||
    !Array.isArray(v.failures) ||
    v.failures.length > platformImportLimit ||
    typeof v.truncated !== "boolean" ||
    v.limit !== platformImportLimit
  )
    throw Error("导入响应不完整，请重新预览");
  if (
    v.next !== undefined &&
    v.next !== null &&
    (typeof v.next !== "string" ||
      v.next.length < 1 ||
      v.next.length > 16384 ||
      !/^[A-Za-z0-9_.-]+$/.test(v.next))
  )
    throw Error("合集翻页凭据无效，请重新预览");
  if (
    v.omitted !== undefined &&
    (!Number.isInteger(v.omitted) || v.omitted < 0 || v.omitted > 2000)
  )
    throw Error("合集预览不完整，请重新预览");
  const seen = new Set<string>();
  const items = v.items.map((raw: unknown) => {
    const item = object(raw);
    if (
      typeof item.key !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.key) ||
      seen.has(item.key) ||
      !Object.hasOwn(platformProviderLabels, item.provider) ||
      typeof item.url !== "string" ||
      !Number.isInteger(item.part) ||
      item.part < 1 ||
      item.part > 10000 ||
      (item.title !== null &&
        (typeof item.title !== "string" ||
          [...item.title].length > 200 ||
          /[\u0000-\u001f\u007f\u2028\u2029]/.test(item.title)))
    )
      throw Error("导入响应不完整，请重新预览");
    const parsed = ordinaryPlatformLink(item.url, item.provider);
    if (
      (item.provider !== "bilibili" && parsed.url !== item.url) ||
      (parsed.part ?? 1) !== item.part ||
      parsed.live_version !== item.live_version ||
      parsed.course_version !== item.course_version
    )
      throw Error("预览中的视频身份不一致，请重新预览");
    seen.add(item.key);
    return {
      key: item.key,
      provider: item.provider,
      url: item.url,
      part: item.part,
      title: item.title,
      ...(parsed.live_version ? { live_version: parsed.live_version } : {}),
      ...(parsed.course_version ? { course_version: 1 as const } : {}),
    } as PlatformImportPreviewItem;
  });
  return {
    items,
    failures: v.failures.map((raw: unknown) => {
      const f = object(raw);
      if (
        !Number.isInteger(f.index) ||
        f.index < 0 ||
        f.index >= platformImportLimit
      )
        throw Error("导入响应不完整，请重新预览");
      return { index: f.index, error: failure(f.error) };
    }),
    truncated: v.truncated,
    limit: v.limit,
    ...(v.next === undefined ? {} : { next: v.next }),
    ...(v.omitted === undefined ? {} : { omitted: v.omitted }),
  };
}
export function selectedPlatformImportItems(
  preview: PlatformImportPreview,
  keys: readonly string[],
  mode: NativePlatformCredentialMode,
  statuses: Partial<Record<"douyin" | "tiktok", ShortPlatformAccountStatus>> & {
    youtube?: YoutubePlatformAccountStatus;
    bilibili?: PlatformAccountStatus;
  } = {},
): PlatformImportBatchItem[] {
  if (
    !keys.length ||
    keys.length > platformImportLimit ||
    new Set(keys).size !== keys.length
  )
    throw Error("请选择要导入的视频");
  return keys.map((key) => {
    const item = preview.items.find((v) => v.key === key);
    if (!item) throw Error("所选视频不在当前预览中，请重新预览");
    const account = platformImportAccountIntent(
      item.provider,
      mode,
      item.provider === "bilibili" ||
        item.provider === "douyin" ||
        item.provider === "tiktok" ||
        item.provider === "youtube"
        ? statuses[item.provider]
        : undefined,
      item.provider === "bilibili" &&
        (item.url.includes("/bangumi/play/ep") ||
          item.live_version === 1 ||
          item.course_version === 1),
    );
    return {
      key: item.key,
      provider: item.provider,
      url: item.url,
      part: item.part,
      ...(item.live_version ? { live_version: item.live_version } : {}),
      ...(item.course_version ? { course_version: item.course_version } : {}),
      ...account,
    };
  });
}
export function validatePlatformImportBatch(
  value: unknown,
  selected: readonly PlatformImportBatchItem[],
): PlatformImportBatchResult {
  const v = object(value);
  if (
    !Array.isArray(v.outcomes) ||
    v.outcomes.length !== selected.length ||
    (v.stopped !== null &&
      (typeof v.stopped !== "string" || !/^[a-z_]{1,100}$/.test(v.stopped)))
  )
    throw Error("批量导入响应不完整，可安全重试所选条目");
  const seen = new Set<string>();
  const outcomes = v.outcomes.map((raw: unknown) => {
    const o = object(raw),
      item = selected.find((item) => item.key === o.key);
    if (!item || seen.has(o.key) || Boolean(o.media) === Boolean(o.error))
      throw Error("批量导入响应不完整，可安全重试所选条目");
    seen.add(o.key);
    if (o.error) return { key: o.key, error: failure(o.error) };
    const media = object(o.media),
      platform = object(media.platform);
    const canonical = new URL(item.url);
    const identity =
      item.provider === "youtube"
        ? canonical.searchParams.get("v")
        : canonical.pathname.replace(/\/$/, "").split("/").at(-1);
    const isEpisode =
      item.provider === "bilibili" &&
      canonical.pathname.startsWith("/bangumi/play/ep");
    const isLive = item.live_version === 1;
    const isOtherLive = item.live_version === 2;
    const isCourse = item.course_version === 1;
    const sameIdentity = isLive
      ? platform.version === 3 &&
        platform.resource?.kind === "bilibili_live" &&
        platform.resource.room_id === identity &&
        media.duration_ms === null
      : isOtherLive
        ? platform.version === 5 &&
          platform.resource?.kind === "other_live" &&
          (platform.resource.canonical_url === item.url ||
            (item.provider === "tiktok" &&
              /^https:\/\/www\.tiktok\.com\/@[A-Za-z0-9_.]{1,24}\/live$/.test(
                item.url,
              ) &&
              platform.resource.canonical_url ===
                `https://m.tiktok.com/share/live/${platform.resource.resource_id}`)) &&
          media.duration_ms === null
        : isCourse
          ? platform.version === 4 &&
            platform.resource?.kind === "bilibili_course" &&
            platform.resource.ep_id === identity?.slice(2)
          : isEpisode
            ? platform.version === 2 &&
              platform.resource?.ep_id === identity?.slice(2)
            : platform.version === 1 &&
              (item.provider === "bilibili" && identity?.startsWith("av")
                ? /^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(platform.content_id)
                : platform.content_id === identity);
    if (
      typeof media.id !== "string" ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(media.id) ||
      media.kind !== "native_platform" ||
      typeof media.title !== "string" ||
      [...media.title].length > 200 ||
      !validNativePlatformMetadata(platform) ||
      platform.provider !== item.provider ||
      platform.part !== item.part ||
      typeof platform.content_id !== "string" ||
      !sameIdentity ||
      /[\u0000-\u001f\u007f\u2028\u2029]/.test(media.title)
    )
      throw Error("批量导入中的视频身份不一致，请重新预览");
    return { key: o.key, media: media as Media };
  });
  return { outcomes, stopped: v.stopped };
}
