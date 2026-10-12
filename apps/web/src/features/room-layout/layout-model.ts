/** Personal display geometry only. Never put room, media or account data here. */
export type LayoutBreakpoint = "wide" | "narrow";
export const WIDGET_TYPES = [
  "room-info",
  "player",
  "media-info",
  "chat",
  "queue",
  "members",
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export interface LayoutItem {
  id: string;
  type: WidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutDocument {
  version: 1;
  breakpoint: LayoutBreakpoint;
  items: LayoutItem[];
}

export interface WidgetDefinition {
  type: WidgetType;
  label: string;
  description: string;
  minW: number;
  minH: number;
  defaultW: number;
  defaultH: number;
  removable: boolean;
}

export const GRID_COLUMNS = { wide: 24, narrow: 1 } as const;
export const GRID_GAP_PX = 16;
/** Narrow flow's reference row height. Wide rows scale with the canvas. */
export const GRID_ROW_HEIGHT = 8;
export const GRID_VERTICAL_GAP = 2;
export const MAX_LAYOUT_ROWS = 512;
export const PLAYER_ASPECT_RATIO = 16 / 9;
export const NARROW_BREAKPOINT_PX = 1024;

export const WIDGET_DEFINITIONS: Readonly<
  Record<WidgetType, Readonly<WidgetDefinition>>
> = {
  "room-info": {
    type: "room-info",
    label: "房间信息",
    description: "房间名称、连接状态与常用操作",
    minW: 6,
    minH: 6,
    defaultW: 18,
    defaultH: 6,
    removable: true,
  },
  player: {
    type: "player",
    label: "播放器",
    description: "保持画面比例，播放不中断；此组件不可隐藏",
    minW: 8,
    minH: 24,
    defaultW: 18,
    defaultH: 54,
    removable: false,
  },
  "media-info": {
    type: "media-info",
    label: "影片详情",
    description: "当前影片的标题与播放信息",
    minW: 6,
    minH: 8,
    defaultW: 18,
    defaultH: 8,
    removable: true,
  },
  chat: {
    type: "chat",
    label: "聊天",
    description: "与房间成员交流，隐藏不会删除消息",
    minW: 5,
    minH: 24,
    defaultW: 6,
    defaultH: 62,
    removable: true,
  },
  queue: {
    type: "queue",
    label: "待播",
    description: "查看和管理房间的待播影片",
    minW: 6,
    minH: 14,
    defaultW: 18,
    defaultH: 14,
    removable: true,
  },
  members: {
    type: "members",
    label: "在线成员",
    description: "查看房间内的真实在线成员",
    minW: 4,
    minH: 14,
    defaultW: 6,
    defaultH: 14,
    removable: true,
  },
};

const NARROW_HEIGHTS: Record<WidgetType, { min: number; initial: number }> = {
  "room-info": { min: 6, initial: 8 },
  player: { min: 20, initial: 26 },
  "media-info": { min: 8, initial: 10 },
  chat: { min: 28, initial: 42 },
  queue: { min: 14, initial: 24 },
  members: { min: 14, initial: 20 },
};

export function getWidgetConstraints(
  type: WidgetType,
  breakpoint: LayoutBreakpoint,
) {
  const definition = WIDGET_DEFINITIONS[type];
  return {
    minW: breakpoint === "narrow" ? 1 : definition.minW,
    minH: breakpoint === "narrow" ? NARROW_HEIGHTS[type].min : definition.minH,
    maxW: GRID_COLUMNS[breakpoint],
    maxH: 160,
    defaultW: breakpoint === "narrow" ? 1 : definition.defaultW,
    defaultH:
      breakpoint === "narrow"
        ? NARROW_HEIGHTS[type].initial
        : definition.defaultH,
  };
}

function item(
  type: WidgetType,
  x: number,
  y: number,
  w: number,
  h: number,
): LayoutItem {
  return { id: type, type, x, y, w, h };
}

/**
 * Viewport-independent room for the exact 16:9 frame, in wide grid rows.
 * Row height is calibrated to the default 18-column, 54-row player. With
 * column pitch s >= 17px (1px minimum column + 16px gutter), a w-column
 * picture needs 54 * (w*s - 16) / (18*s - 16) rows. This is at most 3*w
 * for w <= 18 and strictly less than 3*w + 1 for 18 < w <= 24.
 * Use this ceiling in saved geometry so changing canvas width is also safe.
 */
export function getPlayerMinimumHeight(w: number): number {
  return Math.ceil(3 * w + (w > 18 ? 1 : 0));
}

export function createDefaultLayout(
  breakpoint: LayoutBreakpoint = "wide",
): LayoutDocument {
  if (breakpoint === "wide") {
    return {
      version: 1,
      breakpoint,
      items: [
        item("room-info", 0, 0, 18, 6),
        item("player", 0, 8, 18, 54),
        item("media-info", 0, 64, 18, 8),
        item("chat", 18, 0, 6, 62),
        item("queue", 0, 74, 18, 14),
        item("members", 18, 64, 6, 14),
      ],
    };
  }
  let y = 0;
  return {
    version: 1,
    breakpoint,
    items: WIDGET_TYPES.map((type) => {
      const h = getWidgetConstraints(type, breakpoint).defaultH;
      const result = item(type, 0, y, 1, h);
      y += h + GRID_VERTICAL_GAP;
      return result;
    }),
  };
}

/** Copies a strict whitelist, even if a caller supplied extra properties. */
export function cloneLayout(document: LayoutDocument): LayoutDocument {
  return {
    version: 1,
    breakpoint: document.breakpoint,
    items: document.items.map(({ id, type, x, y, w, h }) => ({
      id,
      type,
      x,
      y,
      w,
      h,
    })),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isWidgetType(value: unknown): value is WidgetType {
  return (
    typeof value === "string" && WIDGET_TYPES.some((type) => type === value)
  );
}

/** Touching edges are allowed; column gutters are applied during rendering. */
export function itemsOverlap(a: LayoutItem, b: LayoutItem): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

export function validateLayout(
  input: unknown,
  breakpoint?: LayoutBreakpoint,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (
    !record(input) ||
    input.version !== 1 ||
    (input.breakpoint !== "wide" && input.breakpoint !== "narrow") ||
    !Array.isArray(input.items)
  ) {
    return { valid: false, errors: ["Invalid layout document"] };
  }
  if (breakpoint && input.breakpoint !== breakpoint)
    errors.push("Layout breakpoint does not match");
  if (input.items.length > WIDGET_TYPES.length)
    errors.push("Too many layout items");
  const seen = new Set<WidgetType>();
  const checked: LayoutItem[] = [];
  // Bound validation work on untrusted documents. A valid document has at most six entries.
  for (const candidate of input.items.slice(0, WIDGET_TYPES.length + 1)) {
    if (!record(candidate) || !isWidgetType(candidate.type)) {
      errors.push("Unknown widget type");
      continue;
    }
    const type = candidate.type;
    if (candidate.id !== type) errors.push(`Invalid widget id: ${type}`);
    if (seen.has(type)) errors.push(`Duplicate widget: ${type}`);
    seen.add(type);
    if (
      ![candidate.x, candidate.y, candidate.w, candidate.h].every(
        (value) => typeof value === "number" && Number.isSafeInteger(value),
      )
    ) {
      errors.push(`Invalid geometry: ${type}`);
      continue;
    }
    const entry = candidate as unknown as LayoutItem;
    const limits = getWidgetConstraints(type, input.breakpoint);
    if (
      entry.x < 0 ||
      entry.y < 0 ||
      entry.w < limits.minW ||
      entry.w > limits.maxW ||
      entry.h < limits.minH ||
      entry.h > limits.maxH ||
      entry.x + entry.w > GRID_COLUMNS[input.breakpoint] ||
      entry.y + entry.h > MAX_LAYOUT_ROWS
    ) {
      errors.push(`Widget outside size or canvas limits: ${type}`);
    }
    if (
      type === "player" &&
      input.breakpoint === "wide" &&
      entry.h < getPlayerMinimumHeight(entry.w)
    ) {
      errors.push("The player slot is too short for its fixed aspect ratio");
    }
    for (const previous of checked) {
      if (itemsOverlap(entry, previous))
        errors.push(`Widgets overlap: ${previous.type}, ${type}`);
    }
    checked.push(entry);
  }
  if (!seen.has("player")) errors.push("The player is required");
  return { valid: errors.length === 0, errors };
}

export function isLayoutDocument(input: unknown): input is LayoutDocument {
  return validateLayout(input).valid;
}

function integer(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(
    minimum,
    Math.min(
      maximum,
      typeof value === "number" && Number.isFinite(value)
        ? Math.round(value)
        : fallback,
    ),
  );
}

/** Recover useful v1 geometry without trusting stored identities or arbitrary fields. */
export function normalizeLayout(
  input: unknown,
  breakpoint: LayoutBreakpoint,
): LayoutDocument {
  if (
    !record(input) ||
    input.version !== 1 ||
    input.breakpoint !== breakpoint ||
    !Array.isArray(input.items)
  ) {
    return createDefaultLayout(breakpoint);
  }
  if (isLayoutDocument(input)) return cloneLayout(input);
  const defaults = createDefaultLayout(breakpoint);
  const seen = new Set<WidgetType>();
  const candidates: LayoutItem[] = [];
  for (const value of input.items.slice(0, 64)) {
    if (!record(value) || !isWidgetType(value.type) || seen.has(value.type))
      continue;
    const type = value.type;
    seen.add(type);
    const limits = getWidgetConstraints(type, breakpoint);
    const initial = defaults.items.find((entry) => entry.type === type)!;
    const w = integer(value.w, initial.w, limits.minW, limits.maxW);
    const minH =
      type === "player" && breakpoint === "wide"
        ? Math.max(limits.minH, getPlayerMinimumHeight(w))
        : limits.minH;
    const h = integer(value.h, initial.h, minH, limits.maxH);
    candidates.push(
      item(
        type,
        integer(value.x, initial.x, 0, GRID_COLUMNS[breakpoint] - w),
        integer(value.y, initial.y, 0, MAX_LAYOUT_ROWS - h),
        w,
        h,
      ),
    );
  }
  if (!seen.has("player"))
    candidates.unshift({
      ...defaults.items.find((entry) => entry.type === "player")!,
    });
  const placed: LayoutItem[] = [];
  for (const candidate of candidates) {
    let position: LayoutItem | undefined;
    if (!placed.some((entry) => itemsOverlap(candidate, entry)))
      position = candidate;
    // Search from the requested row first, then the preceding free space. Bounded and deterministic.
    for (
      let offset = 0;
      !position && offset <= MAX_LAYOUT_ROWS - candidate.h;
      offset++
    ) {
      const y = (candidate.y + offset) % (MAX_LAYOUT_ROWS - candidate.h + 1);
      for (let x = 0; x <= GRID_COLUMNS[breakpoint] - candidate.w; x++) {
        const proposed = { ...candidate, x, y };
        if (!placed.some((entry) => itemsOverlap(proposed, entry))) {
          position = proposed;
          break;
        }
      }
    }
    // Six maximum-height full-width cards cannot fit. Prefer a valid recoverable default.
    if (!position) return defaults;
    placed.push(position);
  }
  return { version: 1, breakpoint, items: placed };
}
