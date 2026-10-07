import { onBeforeUnmount, onMounted, ref } from "vue";
import type { ApiClient } from "../../shared/api/client";
export interface RegistrationPolicy {
  registration_mode: "closed" | "invite_only" | "open";
  guests_enabled: boolean;
}
export function checkedRegistrationPolicy(
  value: RegistrationPolicy,
): RegistrationPolicy {
  if (
    !value ||
    !["closed", "invite_only", "open"].includes(value.registration_mode) ||
    typeof value.guests_enabled !== "boolean"
  )
    throw new Error("注册入口配置暂时不可用");
  return value;
}
/** Unknown or failed policy never grants self-registration or guest entry. */
export function useRegistrationPolicy(session: { api: ApiClient }) {
  const policy = ref<RegistrationPolicy>(),
    loading = ref(true),
    error = ref("");
  let alive = true,
    serial = 0,
    controller: AbortController | undefined;
  async function reload() {
    const request = ++serial;
    controller?.abort();
    controller = new AbortController();
    loading.value = true;
    error.value = "";
    try {
      const value = checkedRegistrationPolicy(
        await session.api<RegistrationPolicy>(
          "/auth/registration-policy",
          "GET",
          undefined,
          controller.signal,
        ),
      );
      if (alive && request === serial) policy.value = value;
    } catch {
      if (alive && request === serial) {
        policy.value = undefined;
        error.value =
          "暂时无法读取注册与访客入口状态，请重试。已有账号仍可登录。";
      }
    } finally {
      if (alive && request === serial) loading.value = false;
    }
  }
  onMounted(reload);
  onBeforeUnmount(() => {
    alive = false;
    ++serial;
    controller?.abort();
  });
  return { policy, loading, error, reload };
}
