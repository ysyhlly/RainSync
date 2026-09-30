import type { Room, RoomLifecycle } from "../../shared/api/types";

export const lifecycleLabels: Record<RoomLifecycle, string> = {
  active: "开放中",
  closing: "正在关闭",
  closed: "已关闭",
  archived: "已归档",
};
export type RoomFilter = RoomLifecycle | "all";
export function filterRooms(rooms: Room[], filter: RoomFilter): Room[] {
  return filter === "all"
    ? rooms
    : rooms.filter((room) => (room.lifecycle ?? "active") === filter);
}
