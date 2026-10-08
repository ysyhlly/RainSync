import { onScopeDispose, watch, type Ref } from "vue";
/** Success feedback expires; failures remain until explicitly handled. */
export function useTransientMessage(message: Ref<string>, timeoutMs = 5000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  watch(
    message,
    (value) => {
      clear();
      if (value)
        timer = setTimeout(() => {
          message.value = "";
        }, timeoutMs);
    },
    { flush: "sync", immediate: true },
  );
  onScopeDispose(clear);
  return {
    dismiss: () => {
      clear();
      message.value = "";
    },
  };
}
