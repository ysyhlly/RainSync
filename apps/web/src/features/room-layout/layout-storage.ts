import {
  createDefaultLayout,
  validateLayout,
  type LayoutBreakpoint,
  type LayoutDocument,
} from "./layout-model";

/** Only layout geometry belongs here. Never persist room or session data. */
export const ROOM_LAYOUT_STORAGE_PREFIX = "rainsync:room-layout:v1:";
export const MAX_LAYOUT_STORAGE_BYTES = 16 * 1024;

export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type LayoutLoadStatus =
  | "default"
  | "saved"
  | "memory-only"
  | "unavailable"
  | "corrupt"
  | "unsupported-version";

export interface LayoutLoadResult {
  layout: LayoutDocument;
  status: LayoutLoadStatus;
  error: string | null;
}

export type LayoutSaveResult =
  { ok: true; persisted: boolean } | { ok: false; error: string };

export function roomLayoutStorageKey(
  userId: string | null | undefined,
  breakpoint: LayoutBreakpoint,
): string | null {
  // An unauthenticated room must never inherit another visitor's profile.
  if (typeof userId !== "string" || userId.length === 0) return null;
  return `${ROOM_LAYOUT_STORAGE_PREFIX}${encodeURIComponent(userId)}:${breakpoint}`;
}

function browserStorage(storage?: LayoutStorage | null): LayoutStorage | null {
  if (storage !== undefined) return storage;
  return typeof window === "undefined" ? null : window.localStorage;
}

function exceedsSizeLimit(raw: string): boolean {
  // Bound work before parsing or UTF-8 encoding untrusted stored data.
  return (
    raw.length > MAX_LAYOUT_STORAGE_BYTES ||
    new TextEncoder().encode(raw).byteLength > MAX_LAYOUT_STORAGE_BYTES
  );
}

function hasUnsupportedVersion(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "number" &&
    value.version !== 1
  );
}

/** Rebuild the schema explicitly so extra properties can never reach storage. */
export function copyLayoutGeometry(layout: LayoutDocument): LayoutDocument {
  return {
    version: 1,
    breakpoint: layout.breakpoint,
    items: layout.items.map(({ id, type, x, y, w, h }) => ({
      id,
      type,
      x,
      y,
      w,
      h,
    })),
  };
}

export function loadRoomLayout(
  userId: string | null | undefined,
  breakpoint: LayoutBreakpoint,
  storage?: LayoutStorage | null,
): LayoutLoadResult {
  const fallback = (
    status: LayoutLoadStatus,
    error: string | null = null,
  ): LayoutLoadResult => ({
    layout: createDefaultLayout(breakpoint),
    status,
    error,
  });
  const key = roomLayoutStorageKey(userId, breakpoint);
  if (!key) return fallback("memory-only");

  let raw: string | null;
  try {
    const target = browserStorage(storage);
    if (!target)
      return fallback(
        "unavailable",
        "无法读取浏览器布局存储，当前使用默认布局",
      );
    raw = target.getItem(key);
  } catch {
    return fallback("unavailable", "无法读取浏览器布局存储，当前使用默认布局");
  }
  if (raw === null) return fallback("default");
  if (exceedsSizeLimit(raw)) {
    return fallback("corrupt", "已保存的布局超过大小限制，当前使用默认布局");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fallback("corrupt", "已保存的布局无法读取，当前使用默认布局");
  }
  if (hasUnsupportedVersion(value)) {
    return fallback(
      "unsupported-version",
      "已保存的布局版本暂不支持。若要替换，请先恢复默认布局，再完成编辑",
    );
  }
  if (!validateLayout(value, breakpoint).valid) {
    return fallback("corrupt", "已保存的布局无效，当前使用默认布局");
  }
  return {
    layout: copyLayoutGeometry(value as LayoutDocument),
    status: "saved",
    error: null,
  };
}

export function saveRoomLayout(
  userId: string | null | undefined,
  layout: LayoutDocument,
  storage?: LayoutStorage | null,
  options: { replaceUnsupportedVersion?: boolean } = {},
): LayoutSaveResult {
  if (!validateLayout(layout).valid) {
    return { ok: false, error: "布局无效，未保存。请调整布局后重试" };
  }
  // Project a known schema even if a caller accidentally supplies extra fields.
  const raw = JSON.stringify(copyLayoutGeometry(layout));
  if (exceedsSizeLimit(raw)) {
    return { ok: false, error: "布局超过本地存储大小限制，未保存" };
  }
  const key = roomLayoutStorageKey(userId, layout.breakpoint);
  if (!key) return { ok: true, persisted: false };

  try {
    const target = browserStorage(storage);
    if (!target) {
      return {
        ok: false,
        error: "浏览器布局存储不可用。更改仍保留在编辑中，请重试或取消",
      };
    }
    // A newer tab may have written a future schema since this controller loaded.
    // Never silently downgrade it, even when this tab started with no saved data.
    if (!options.replaceUnsupportedVersion) {
      const previous = target.getItem(key);
      if (previous !== null && !exceedsSizeLimit(previous)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(previous);
        } catch {
          // An explicit save may replace corrupt data; reads never delete it.
        }
        if (hasUnsupportedVersion(parsed)) {
          return {
            ok: false,
            error:
              "已保存的布局版本暂不支持。若要替换，请先恢复默认布局，再完成编辑",
          };
        }
      }
    }
    target.setItem(key, raw);
    return { ok: true, persisted: true };
  } catch {
    return {
      ok: false,
      error:
        "布局保存失败，可能是浏览器存储已满或被禁用。更改仍保留在编辑中，请重试或取消",
    };
  }
}
