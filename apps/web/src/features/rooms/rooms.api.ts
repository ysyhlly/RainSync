import type { ApiClient } from "../../shared/api/client";
import type { Room } from "../../shared/api/types";
export const roomsApi = (api: ApiClient) => ({
  list: () => api<Room[]>("/rooms"),
  create: (name: string) => api<{ id: string }>("/rooms", "POST", { name }),
  join: (id: string, token: string) =>
    api("/rooms/" + encodeURIComponent(id) + "/join", "POST", { token }),
});
