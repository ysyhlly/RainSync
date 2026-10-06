type CreateRoom = (name: string, requestKey: string) => Promise<{ id: string }>;
type Attempt = { user: string; name: string; key: string };

function requestKey() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The pending key survives uncertain network failures and page reloads in the
// same browser tab. Different accounts and edited names use different keys.
export function createRoomSubmission(
  create: CreateRoom,
  identity: () => string | null | undefined,
  storage: () => Storage = () => sessionStorage,
) {
  let pending: Attempt | undefined;
  const storageKey = (user: string) => `rainsync:room-creation:${user}`;
  function saved(user: string, name: string): Attempt | undefined {
    try {
      const value = JSON.parse(storage().getItem(storageKey(user)) ?? "null");
      if (
        value?.user === user &&
        value.name === name &&
        typeof value.key === "string" &&
        /^[0-9a-f-]{36}$/i.test(value.key)
      )
        return value;
    } catch {
      // Private browsing and disabled storage retain the in-memory attempt.
    }
  }
  return async (name: string) => {
    const user = identity();
    if (!user) throw Error("请先登录再创建房间");
    if (pending?.user !== user || pending.name !== name)
      pending = saved(user, name) ?? { user, name, key: requestKey() };
    const attempt = pending;
    try {
      storage().setItem(storageKey(user), JSON.stringify(attempt));
    } catch {
      // A storage failure does not prevent a safe retry in this page.
    }
    const result = await create(name, attempt.key);
    if (identity() !== user) throw Error("登录身份已变化，请重新操作");
    if (pending === attempt) pending = undefined;
    try {
      // An older request finishing must not discard a newer pending attempt.
      if (storage().getItem(storageKey(user)) === JSON.stringify(attempt))
        storage().removeItem(storageKey(user));
    } catch {
      // The confirmed result can still be used when storage is unavailable.
    }
    return result;
  };
}
