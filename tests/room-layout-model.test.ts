import { describe, expect, it } from "vitest";
import {
  GRID_COLUMNS,
  MAX_LAYOUT_ROWS,
  PLAYER_ASPECT_RATIO,
  WIDGET_TYPES,
  cloneLayout,
  createDefaultLayout,
  getWidgetConstraints,
  getPlayerMinimumHeight,
  isLayoutDocument,
  normalizeLayout,
  validateLayout,
  type LayoutDocument,
} from "../apps/web/src/features/room-layout/layout-model";
import {
  addWidget,
  getGridMetrics,
  getPlayerHeight,
  itemsOverlap,
  moveWidget,
  removeWidget,
  resizeWidget,
} from "../apps/web/src/features/room-layout/layout-geometry";

const get = (document: LayoutDocument, id: string) =>
  document.items.find((item) => item.id === id)!;
const playerOnly = (): LayoutDocument => ({
  ...createDefaultLayout(),
  items: [get(createDefaultLayout(), "player")],
});
const assertValid = (document: LayoutDocument) =>
  expect(validateLayout(document)).toEqual({ valid: true, errors: [] });

function freeze(document: LayoutDocument): LayoutDocument {
  document.items.forEach(Object.freeze);
  Object.freeze(document.items);
  return Object.freeze(document);
}

describe("room layout model", () => {
  it.each(["wide", "narrow"] as const)(
    "creates fresh, valid %s defaults with all six real widget types",
    (breakpoint) => {
      const document = createDefaultLayout(breakpoint);
      assertValid(document);
      expect(document.items.map((item) => item.type)).toEqual(WIDGET_TYPES);
      expect(new Set(document.items.map((item) => item.id)).size).toBe(6);
      document.items[0].y = 100;
      expect(createDefaultLayout(breakpoint).items[0].y).toBe(0);
    },
  );

  it("keeps the approved wide composition: player left, chat right, queue and members below", () => {
    const document = createDefaultLayout();
    const player = get(document, "player");
    const chat = get(document, "chat");
    const queue = get(document, "queue");
    const members = get(document, "members");
    expect(player.x).toBe(0);
    expect(player.w).toBeGreaterThan(chat.w);
    expect(chat.x).toBe(player.w);
    expect(queue.y).toBeGreaterThan(player.y + player.h);
    expect(queue.w).toBe(player.w);
    expect(members.h).toBe(14);
    expect(members.x).toBe(chat.x);
    expect(members.y).toBeGreaterThan(chat.y + chat.h);
  });

  it("clones only geometry, with no room, session or media payload", () => {
    const document = createDefaultLayout() as LayoutDocument & {
      token: string;
    };
    document.token = "do-not-copy";
    Object.assign(document.items[0], { media: { title: "do-not-copy" } });
    const copied = cloneLayout(document);
    expect(copied).not.toHaveProperty("token");
    expect(copied.items[0]).not.toHaveProperty("media");
    expect(copied.items[0]).not.toBe(document.items[0]);
    expect(copied.items).not.toBe(document.items);
  });

  it.each([
    null,
    undefined,
    [],
    1,
    "layout",
    {},
    { version: 2 },
    { version: 1, breakpoint: "other", items: [] },
  ])("safely rejects unknown document input %j", (value) => {
    expect(validateLayout(value).valid).toBe(false);
    expect(isLayoutDocument(value)).toBe(false);
    expect(normalizeLayout(value, "wide")).toEqual(createDefaultLayout());
  });

  it("rejects mismatched breakpoints, missing player, duplicate ids and unknown types", () => {
    expect(validateLayout(createDefaultLayout(), "narrow").valid).toBe(false);
    expect(validateLayout({ ...createDefaultLayout(), items: [] }).valid).toBe(
      false,
    );
    const duplicate = createDefaultLayout();
    duplicate.items.push({ ...duplicate.items[0] });
    expect(validateLayout(duplicate).valid).toBe(false);
    const unknown = cloneLayout(createDefaultLayout());
    Object.assign(unknown.items[0], {
      type: "custom-script",
      id: "custom-script",
    });
    expect(validateLayout(unknown).valid).toBe(false);
    const noncanonical = cloneLayout(createDefaultLayout());
    noncanonical.items[0].id = "untrusted-id";
    expect(validateLayout(noncanonical).valid).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe/non-grid geometry %s",
    (value) => {
      const document = createDefaultLayout();
      document.items[0].x = value;
      expect(validateLayout(document).valid).toBe(false);
    },
  );

  it("rejects every boundary/minimum-size violation", () => {
    for (const patch of [
      { x: -1 },
      { y: -1 },
      { w: 2 },
      { h: 1 },
      { w: 25 },
      { h: 161 },
      { y: MAX_LAYOUT_ROWS },
    ]) {
      const document = playerOnly();
      Object.assign(document.items[0], patch);
      expect(validateLayout(document).valid).toBe(false);
    }
    const narrow = createDefaultLayout("narrow");
    narrow.items[0].w = 2;
    expect(validateLayout(narrow).valid).toBe(false);
  });

  it("allows touching rectangle edges but rejects actual overlap", () => {
    const left = get(createDefaultLayout(), "player");
    const right = { ...left, x: left.x + left.w };
    expect(itemsOverlap(left, right)).toBe(false);
    expect(itemsOverlap(left, { ...right, x: right.x - 1 })).toBe(true);
    expect(itemsOverlap(left, { ...left, y: left.y + left.h })).toBe(false);
    const document = createDefaultLayout();
    document.items[3].x = 17;
    expect(validateLayout(document).valid).toBe(false);
  });

  it("normalizes corrupt supported documents deterministically and strips arbitrary data", () => {
    const corrupt = {
      version: 1,
      breakpoint: "wide",
      token: "ignored",
      items: [
        {
          id: "wrong",
          type: "chat",
          x: -99,
          y: 0,
          w: 0,
          h: NaN,
          messages: ["ignored"],
        },
        { id: "duplicate", type: "chat", x: 8, y: 0, w: 6, h: 30 },
        { id: "bad", type: "script", x: 0, y: 0, w: 24, h: 99 },
        { type: "members", x: Infinity, y: -3, w: 500, h: 500 },
      ],
    };
    const result = normalizeLayout(corrupt, "wide");
    assertValid(result);
    expect(result).toEqual(normalizeLayout(corrupt, "wide"));
    expect(result.items.map((item) => item.type)).toEqual([
      "player",
      "chat",
      "members",
    ]);
    expect(JSON.stringify(result)).not.toContain("ignored");
    expect(result.items.every((item) => item.id === item.type)).toBe(true);
    expect(normalizeLayout(result, "wide")).toEqual(result);
  });

  it("rejects undersized persisted player slots despite otherwise valid v1 geometry", () => {
    for (const [w, h] of [
      [18, 24],
      [24, 24],
      [24, 72],
      [12, 35],
    ]) {
      const document = playerOnly();
      Object.assign(document.items[0], { w, h });
      expect(validateLayout(document).valid).toBe(false);
      expect(isLayoutDocument(document)).toBe(false);
    }
    for (const [w, h] of [
      [8, 24],
      [12, 36],
      [18, 54],
      [24, 73],
    ]) {
      const document = playerOnly();
      Object.assign(document.items[0], { w, h });
      assertValid(document);
    }
  });

  it("moves a neighbour below a repaired18-column player instead of accepting visual overlap", () => {
    const document = playerOnly();
    get(document, "player").h = 24;
    document.items.push({
      id: "queue",
      type: "queue",
      x: 0,
      y: 32,
      w: 12,
      h: 14,
    });
    expect(validateLayout(document).valid).toBe(false);
    const result = normalizeLayout(document, "wide");
    expect(get(result, "player")).toMatchObject({ y: 8, w: 18, h: 54 });
    expect(get(result, "queue").y).toBe(62);
    expect(result).toEqual(normalizeLayout(document, "wide"));
    assertValid(result);
  });

  it("keeps narrow flow height independent of wide occupancy rules", () => {
    const document = createDefaultLayout("narrow");
    get(document, "player").h = 20;
    assertValid(document);
    expect(normalizeLayout(document, "narrow")).toEqual(document);
  });

  it("repairs player occupancy before repairing collisions and lower canvas bounds", () => {
    const document = createDefaultLayout();
    Object.assign(get(document, "player"), { w: 24, h: 24 });
    const repaired = normalizeLayout(document, "wide");
    assertValid(repaired);
    expect(get(repaired, "player")).toMatchObject({ w: 24, h: 73 });
    expect(repaired.items).toHaveLength(6);
    const bottom = playerOnly();
    Object.assign(bottom.items[0], { w: 24, h: 24, y: MAX_LAYOUT_ROWS - 24 });
    const bounded = normalizeLayout(bottom, "wide");
    expect(get(bounded, "player")).toMatchObject({
      h: 73,
      y: MAX_LAYOUT_ROWS - 73,
    });
    assertValid(bounded);
  });

  it("preserves valid custom positions and intentional wide whitespace on normalization", () => {
    const document = playerOnly();
    document.items[0].y = 150;
    expect(normalizeLayout(document, "wide")).toEqual(document);
    expect(normalizeLayout(document, "wide")).not.toBe(document);
  });

  it("falls back safely when six corrupt full-canvas cards cannot all be recovered", () => {
    const oversized = {
      version: 1,
      breakpoint: "wide",
      items: WIDGET_TYPES.map((type) => ({
        id: type,
        type,
        x: 0,
        y: 0,
        w: 24,
        h: 160,
      })),
    };
    expect(normalizeLayout(oversized, "wide")).toEqual(createDefaultLayout());
  });
});

describe("room layout geometry", () => {
  it("moves immutably, preserving every unrelated wide item and whitespace", () => {
    const document = freeze(createDefaultLayout());
    const result = moveWidget(document, "queue", 2, 130);
    assertValid(result);
    expect(result).not.toBe(document);
    expect(get(result, "queue")).toMatchObject({ x: 2, y: 130 });
    for (const item of document.items.filter((item) => item.type !== "queue"))
      expect(get(result, item.id)).toBe(item);
    expect(get(document, "queue").y).toBe(74);
  });

  it("rejects collisions/no-ops without mutating the source", () => {
    const document = freeze(createDefaultLayout());
    expect(moveWidget(document, "queue", 0, 8)).toBe(document);
    expect(resizeWidget(document, "player", 24, 100)).toBe(document);
    expect(moveWidget(document, "player", 0, 8)).toBe(document);
    expect(resizeWidget(document, "player", 18, 54)).toBe(document);
    expect(moveWidget(document, "missing", 0, 0)).toBe(document);
  });

  it("clamps wide positions to canvas bounds and integer grid units", () => {
    const document = freeze(playerOnly());
    const top = moveWidget(document, "player", -20, -10);
    expect(get(top, "player")).toMatchObject({ x: 0, y: 0 });
    const bottom = moveWidget(document, "player", 200, 99999);
    expect(get(bottom, "player")).toMatchObject({
      x: 6,
      y: MAX_LAYOUT_ROWS - 54,
    });
    expect(
      get(moveWidget(document, "player", 2.3, 20.7), "player"),
    ).toMatchObject({ x: 2, y: 21 });
    assertValid(bottom);
  });

  it("clamps resized items to minimum sizes and remaining canvas space", () => {
    const document = playerOnly();
    const smaller = resizeWidget(document, "player", 0, 0);
    expect(get(smaller, "player")).toMatchObject({ w: 8, h: 24 });
    const atEdge = moveWidget(smaller, "player", 16, MAX_LAYOUT_ROWS - 24);
    expect(resizeWidget(atEdge, "player", 999, 999)).toBe(atEdge);
    assertValid(smaller);
  });

  it.each([NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "ignores unsafe operation coordinates %s",
    (value) => {
      const document = freeze(createDefaultLayout());
      expect(moveWidget(document, "queue", value, 100)).toBe(document);
      expect(moveWidget(document, "queue", 0, value)).toBe(document);
      expect(resizeWidget(document, "queue", value, 20)).toBe(document);
      expect(resizeWidget(document, "queue", 12, value)).toBe(document);
    },
  );

  it("clamps manual player resizing to safe occupancy and rejects overflowing growth", () => {
    const original = playerOnly();
    const result = resizeWidget(original, "player", 24, 24);
    expect(get(result, "player")).toMatchObject({ w: 24, h: 73 });
    assertValid(result);
    const bottom = moveWidget(original, "player", 0, MAX_LAYOUT_ROWS - 54);
    expect(resizeWidget(bottom, "player", 24, 24)).toBe(bottom);
  });

  it("hides and restores each optional singleton without deleting or mutating data", () => {
    const original = freeze(createDefaultLayout());
    expect(removeWidget(original, "player")).toBe(original);
    expect(addWidget(original, "player")).toBe(original);
    expect(removeWidget(original, "missing")).toBe(original);
    for (const type of WIDGET_TYPES.filter((type) => type !== "player")) {
      const hidden = removeWidget(original, type);
      expect(hidden.items).toHaveLength(5);
      expect(hidden.items.some((item) => item.type === type)).toBe(false);
      const restored = addWidget(hidden, type);
      assertValid(restored);
      expect(get(restored, type)).toEqual(get(original, type));
      expect(addWidget(restored, type)).toBe(restored);
    }
  });

  it("finds the same free cell when a restored widget's default slot is occupied", () => {
    let document = removeWidget(createDefaultLayout(), "queue");
    document = moveWidget(document, "media-info", 0, 74);
    const result = addWidget(document, "queue");
    expect(result).toEqual(addWidget(document, "queue"));
    assertValid(result);
    expect(get(result, "media-info")).toBe(get(document, "media-info"));
    expect(get(result, "queue").y).not.toBe(74);
  });

  it("gets identical wide outcomes independent of intermediate rejected pointer paths", () => {
    const original = createDefaultLayout();
    const rejected = moveWidget(original, "queue", 0, 9);
    const result = moveWidget(rejected, "queue", 1, 110);
    expect(result).toEqual(moveWidget(original, "queue", 1, 110));
  });

  it("uses narrow y±1 as adjacent reordering while keeping a valid single column", () => {
    const original = freeze(createDefaultLayout("narrow"));
    const player = get(original, "player");
    const upward = moveWidget(original, "player", 0, player.y - 1);
    expect(upward.items.map((item) => item.type).slice(0, 3)).toEqual([
      "player",
      "room-info",
      "media-info",
    ]);
    expect(moveWidget(upward, "player", 0, -1)).toBe(upward);
    const downward = moveWidget(upward, "player", 0, 1);
    expect(downward).toEqual(original);
    assertValid(upward);
    expect(upward.items.every((item) => item.x === 0 && item.w === 1)).toBe(
      true,
    );
  });

  it("supports long narrow reorders and bounds at both ends", () => {
    const original = createDefaultLayout("narrow");
    const bottom = moveWidget(original, "player", 0, 99999);
    expect(bottom.items.at(-1)?.type).toBe("player");
    expect(moveWidget(bottom, "player", 0, 99999)).toBe(bottom);
    const top = moveWidget(bottom, "player", 0, -999);
    expect(top.items[0].type).toBe("player");
    assertValid(top);
  });

  it("repacks narrow resize and hide/add without altering wide defaults", () => {
    const narrow = createDefaultLayout("narrow");
    const resized = resizeWidget(narrow, "chat", 400, 80);
    assertValid(resized);
    expect(get(resized, "chat").w).toBe(1);
    expect(get(resized, "queue").y).toBeGreaterThan(get(narrow, "queue").y);
    const hidden = removeWidget(resized, "media-info");
    const added = addWidget(hidden, "media-info");
    expect(added.items.at(-1)?.type).toBe("media-info");
    assertValid(added);
    expect(createDefaultLayout().items[0]).toMatchObject({ w: 18, h: 6 });
  });

  it.each([1024, 1280, 1440, 1920, 2560])(
    "keeps a16:9 default player at canvas width %s without quantizing the picture",
    (width) => {
      const metrics = getGridMetrics(width, "wide");
      const player = get(createDefaultLayout(), "player");
      const pixelWidth =
        player.w * (metrics.columnWidth + metrics.gap) - metrics.gap;
      expect(pixelWidth / (player.h * metrics.rowHeight)).toBeCloseTo(
        PLAYER_ASPECT_RATIO,
        10,
      );
      expect(getPlayerHeight(player.w, metrics)).toBe(player.h);
      const smallWidth = 12 * (metrics.columnWidth + metrics.gap) - metrics.gap;
      const slotHeight = getPlayerHeight(12, metrics) * metrics.rowHeight;
      expect(slotHeight).toBeGreaterThanOrEqual(
        smallWidth / PLAYER_ASPECT_RATIO,
      );
      expect(slotHeight - smallWidth / PLAYER_ASPECT_RATIO).toBeLessThan(
        metrics.rowHeight,
      );
    },
  );

  it("does not grow the default player by a row due to fractional browser widths", () => {
    for (let width = 1024; width < 3000; width += 0.37) {
      expect(getPlayerHeight(18, getGridMetrics(width, "wide"))).toBe(54);
    }
  });

  it("preserves the visible narrow order when stored array order differs", () => {
    const document = createDefaultLayout("narrow");
    document.items.reverse();
    const result = removeWidget(document, "members");
    expect(result.items.map((item) => item.type)).toEqual(
      WIDGET_TYPES.filter((type) => type !== "members"),
    );
    assertValid(result);
  });

  it("reserves enough player height for every permitted width across canvas resizing", () => {
    for (const canvasWidth of [
      1, 320, 599, 960, 1024, 1280.3, 1440, 2560, 10000, 1000000,
    ]) {
      const metrics = getGridMetrics(canvasWidth, "wide");
      for (let w = 8; w <= 24; w++) {
        const pixelWidth =
          w * (metrics.columnWidth + metrics.gap) - metrics.gap;
        const minimumRows = getPlayerMinimumHeight(w);
        expect(minimumRows * metrics.rowHeight).toBeGreaterThanOrEqual(
          pixelWidth / PLAYER_ASPECT_RATIO - 1e-7,
        );
        expect(getPlayerHeight(w, metrics)).toBeGreaterThanOrEqual(minimumRows);
        const document = playerOnly();
        Object.assign(document.items[0], { w, h: minimumRows });
        assertValid(document);
      }
    }
  });

  it("provides safe pre-measurement metrics and per-breakpoint minimum widths", () => {
    for (const width of [0, NaN, Infinity, -20]) {
      expect(getGridMetrics(width, "wide").rowHeight).toBeGreaterThan(0);
      expect(getGridMetrics(width, "narrow").columns).toBe(1);
    }
    expect(getWidgetConstraints("chat", "narrow").minW).toBe(1);
    expect(getWidgetConstraints("chat", "wide").minW).toBeGreaterThan(1);
  });

  it("keeps bounds, singleton and non-overlap invariants through500 deterministic edits", () => {
    let seed = 17;
    const random = (max: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % max;
    };
    for (const breakpoint of ["wide", "narrow"] as const) {
      let document = createDefaultLayout(breakpoint);
      for (let i = 0; i < 500; i++) {
        const type = WIDGET_TYPES[random(WIDGET_TYPES.length)];
        switch (random(4)) {
          case 0:
            document = moveWidget(
              document,
              type,
              random(GRID_COLUMNS[breakpoint] + 10) - 5,
              random(600) - 20,
            );
            break;
          case 1:
            document = resizeWidget(document, type, random(30), random(180));
            break;
          case 2:
            document = removeWidget(document, type);
            break;
          case 3:
            document = addWidget(document, type);
            break;
        }
        assertValid(document);
      }
    }
  });
});
