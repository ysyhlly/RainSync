import { expect, it } from "vitest";
import {
  filterRooms,
  lifecycleLabels,
} from "../apps/web/src/features/rooms/room-lifecycle";
import type { Room } from "../apps/web/src/shared/api/types";

it("filters every lifecycle without mutating selected rooms or hiding legacy active rooms", () => {
  const rooms: Room[] = [
    { id: "legacy", name: "Legacy", owner_id: "a" },
    ...(["active", "closing", "closed", "archived"] as const).map(
      (lifecycle) => ({
        id: lifecycle,
        name: lifecycle,
        owner_id: "a",
        lifecycle,
      }),
    ),
  ];
  const selected = rooms[4];
  expect(filterRooms(rooms, "active").map((room) => room.id)).toEqual([
    "legacy",
    "active",
  ]);
  expect(filterRooms(rooms, "archived")).toEqual([selected]);
  expect(filterRooms(rooms, "closed").map((room) => room.id)).toEqual([
    "closed",
  ]);
  expect(filterRooms(rooms, "closing").map((room) => room.id)).toEqual([
    "closing",
  ]);
  expect(filterRooms(rooms, "all")).toBe(rooms);
  expect(selected.lifecycle).toBe("archived");
  expect(lifecycleLabels.archived).toBe("已归档");
});
