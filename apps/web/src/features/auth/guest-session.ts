import type { Identity } from "../../shared/api/types";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function guestRoomPath(
  identity: Pick<Identity, "guest" | "guest_room_id"> | null | undefined,
): string | undefined {
  return identity?.guest === true && uuid.test(identity.guest_room_id ?? "")
    ? `/rooms/${identity.guest_room_id}`
    : undefined;
}
/** Only parse invite data locally; never visit or forward arbitrary pasted URLs. */
export function parseGuestInvitation(input: string, origin: string) {
  if (!input.trim() || input.length > 16384)
    throw Error("请粘贴完整的房间邀请 JSON 或本站房间邀请链接。");
  let room: unknown, token: unknown;
  try {
    if (input.trim().startsWith("{")) {
      const data = JSON.parse(input);
      room = data.room_id;
      token = data.token;
    } else {
      const url = new URL(input.trim(), origin);
      const match = /^\/rooms\/([0-9a-f-]+)\/?$/i.exec(url.pathname);
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        !match ||
        url.searchParams.getAll("invite").length > 1 ||
        url.searchParams.getAll("token").length > 1
      )
        throw Error();
      room = match[1];
      token = url.searchParams.get("invite") ?? url.searchParams.get("token");
    }
  } catch {
    throw Error("房间邀请格式无效，请粘贴完整邀请或本站邀请链接。");
  }
  if (
    typeof room !== "string" ||
    !uuid.test(room) ||
    typeof token !== "string" ||
    !/^[0-9a-f]{64}$/i.test(token.trim())
  )
    throw Error("房间邀请必须包含有效房间 ID 和邀请 token。");
  return { room_id: room.toLowerCase(), token: token.trim() };
}
