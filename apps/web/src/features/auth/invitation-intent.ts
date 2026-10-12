import { shallowRef } from "vue";
const pending = shallowRef<{ room_id: string; token: string } | null>(null);
/** Keep invite capabilities in memory while moving through signup; never put them in a redirect query. */
export function rememberInvitation(value: { room_id: string; token: string }) {
  pending.value = value;
}
export function pendingInvitation(room: unknown) {
  return pending.value?.room_id === room ? pending.value : null;
}
export function clearInvitation() {
  pending.value = null;
}
