import {
  GRID_COLUMNS,
  GRID_GAP_PX,
  GRID_ROW_HEIGHT,
  GRID_VERTICAL_GAP,
  MAX_LAYOUT_ROWS,
  PLAYER_ASPECT_RATIO,
  WIDGET_DEFINITIONS,
  createDefaultLayout,
  getWidgetConstraints,
  getPlayerMinimumHeight,
  isWidgetType,
  itemsOverlap,
  validateLayout,
  type LayoutBreakpoint,
  type LayoutDocument,
  type LayoutItem,
  type WidgetType,
} from "./layout-model";

export { getWidgetConstraints, itemsOverlap } from "./layout-model";

export interface GridMetrics {
  columns: number;
  columnWidth: number;
  rowHeight: number;
  gap: number;
}

/** The default player's outer box is 16:9 at every wide canvas width. */
export function getGridMetrics(
  canvasWidth: number,
  breakpoint: LayoutBreakpoint,
): GridMetrics {
  const columns = GRID_COLUMNS[breakpoint];
  const width =
    Number.isFinite(canvasWidth) && canvasWidth > 0
      ? canvasWidth
      : breakpoint === "wide"
        ? 1200
        : 360;
  const gap = GRID_GAP_PX;
  const columnWidth = Math.max(1, (width - gap * (columns - 1)) / columns);
  const playerWidth = 18 * (columnWidth + gap) - gap;
  return {
    columns,
    columnWidth,
    gap,
    rowHeight:
      breakpoint === "wide"
        ? playerWidth / PLAYER_ASPECT_RATIO / 54
        : GRID_ROW_HEIGHT,
  };
}

/** Rounding only affects the slot; the picture inside retains its exact aspect ratio. */
export function getPlayerHeight(w: number, metrics: GridMetrics): number {
  const width = Math.max(
    1,
    w * (metrics.columnWidth + metrics.gap) - metrics.gap,
  );
  const measured = Math.ceil(
    width / PLAYER_ASPECT_RATIO / metrics.rowHeight - 1e-9,
  );
  return metrics.columns === GRID_COLUMNS.wide
    ? Math.max(measured, getPlayerMinimumHeight(w))
    : measured;
}

function finiteInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isSafeInteger(Math.round(value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function replace(
  document: LayoutDocument,
  replacement: LayoutItem,
): LayoutDocument {
  const previous = document.items.find((entry) => entry.id === replacement.id);
  if (
    !previous ||
    (previous.x === replacement.x &&
      previous.y === replacement.y &&
      previous.w === replacement.w &&
      previous.h === replacement.h)
  )
    return document;
  const next = {
    ...document,
    items: document.items.map((entry) =>
      entry.id === replacement.id ? replacement : entry,
    ),
  };
  return validateLayout(next).valid ? next : document;
}

function ordered(document: LayoutDocument): LayoutItem[] {
  return [...document.items].sort(
    (a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id),
  );
}

function packNarrow(
  document: LayoutDocument,
  entries: LayoutItem[],
): LayoutDocument {
  let y = 0;
  const items = entries.map((entry) => {
    const next = { ...entry, x: 0, y, w: 1 };
    y += entry.h + GRID_VERTICAL_GAP;
    return next;
  });
  const next = { ...document, items };
  return validateLayout(next).valid ? next : document;
}

export function moveWidget(
  document: LayoutDocument,
  id: string,
  x: number,
  y: number,
): LayoutDocument {
  const entry = document.items.find((candidate) => candidate.id === id);
  if (!entry || !finiteInteger(x) || !finiteInteger(y)) return document;
  if (document.breakpoint === "narrow") {
    if (Math.round(y) === entry.y) return document;
    const entries = ordered(document);
    const from = entries.findIndex((candidate) => candidate.id === id);
    const direction = y < entry.y ? -1 : 1;
    let to = from + direction;
    if (to < 0 || to >= entries.length) return document;
    // Even a one-row keyboard change means one adjacent position in flow mode.
    while (
      to + direction >= 0 &&
      to + direction < entries.length &&
      (direction < 0
        ? y <= entries[to + direction].y
        : y >= entries[to + direction].y)
    )
      to += direction;
    entries.splice(from, 1);
    entries.splice(to, 0, entry);
    return packNarrow(document, entries);
  }
  return replace(document, {
    ...entry,
    x: clamp(x, 0, GRID_COLUMNS.wide - entry.w),
    y: clamp(y, 0, MAX_LAYOUT_ROWS - entry.h),
  });
}

export function resizeWidget(
  document: LayoutDocument,
  id: string,
  w: number,
  h: number,
): LayoutDocument {
  const entry = document.items.find((candidate) => candidate.id === id);
  if (!entry || !finiteInteger(w) || !finiteInteger(h)) return document;
  const limits = getWidgetConstraints(entry.type, document.breakpoint);
  const replacement = {
    ...entry,
    w: clamp(
      w,
      limits.minW,
      Math.min(limits.maxW, GRID_COLUMNS[document.breakpoint] - entry.x),
    ),
    h: clamp(h, limits.minH, Math.min(limits.maxH, MAX_LAYOUT_ROWS - entry.y)),
  };
  if (entry.type === "player" && document.breakpoint === "wide") {
    replacement.h = Math.max(
      replacement.h,
      getPlayerMinimumHeight(replacement.w),
    );
  }
  if (entry.w === replacement.w && entry.h === replacement.h) return document;
  if (document.breakpoint === "narrow") {
    return packNarrow(
      document,
      ordered(document).map((candidate) =>
        candidate.id === id ? replacement : candidate,
      ),
    );
  }
  return replace(document, replacement);
}

export function removeWidget(
  document: LayoutDocument,
  id: string,
): LayoutDocument {
  const entry = document.items.find((candidate) => candidate.id === id);
  if (!entry || !WIDGET_DEFINITIONS[entry.type].removable) return document;
  const items = document.items.filter((candidate) => candidate.id !== id);
  return document.breakpoint === "narrow"
    ? packNarrow(document, ordered({ ...document, items }))
    : { ...document, items };
}

export function addWidget(
  document: LayoutDocument,
  type: WidgetType,
): LayoutDocument {
  if (
    !isWidgetType(type) ||
    document.items.some((entry) => entry.type === type)
  )
    return document;
  const entry = createDefaultLayout(document.breakpoint).items.find(
    (candidate) => candidate.type === type,
  )!;
  if (document.breakpoint === "narrow")
    return packNarrow(document, [...ordered(document), entry]);
  if (!document.items.some((candidate) => itemsOverlap(entry, candidate)))
    return { ...document, items: [...document.items, entry] };
  for (let y = 0; y <= MAX_LAYOUT_ROWS - entry.h; y++) {
    for (let x = 0; x <= GRID_COLUMNS.wide - entry.w; x++) {
      const candidate = { ...entry, x, y };
      if (!document.items.some((other) => itemsOverlap(candidate, other)))
        return { ...document, items: [...document.items, candidate] };
    }
  }
  return document;
}
