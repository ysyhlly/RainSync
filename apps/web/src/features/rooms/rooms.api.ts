import type { ApiClient } from "../../shared/api/client";
import type { Room, RoomMember } from "../../shared/api/types";
export const roomsApi = (api: ApiClient) => ({
  list: () => api<Room[]>("/rooms"),
  members: (id: string) =>
    api<RoomMember[]>(`/rooms/${encodeURIComponent(id)}/members`),
  create: (name: string) => api<{ id: string }>("/rooms", "POST", { name }),
  join: (id: string, token: string) =>
    api("/rooms/" + encodeURIComponent(id) + "/join", "POST", { token }),
});
