export type NativeMediaFailure = Readonly<{ code: number }>;
export type NativeDriverOptions = {
  element: HTMLVideoElement;
  source: string;
  current: () => boolean;
  /** Live media retains its existing error policy without a src-attribute gate. */
  requireSource?: boolean;
  attached: () => void;
  error: (failure: NativeMediaFailure) => void;
};

/** Own native source assignment and its exact error listener, not the shared
 * video's lifetime, autoplay, synchronization, grant or fallback decisions. */
export function createNativeDriver(options: NativeDriverOptions) {
  const {
    element,
    source,
    current: ownsAttachment,
    requireSource = true,
    attached,
    error,
  } = options;
  let disposed = false,
    started = false;
  let activeSource: { listener: () => void } | undefined;
  const current = () => !disposed && ownsAttachment();
  function setSource(url: string, load: boolean) {
    if (
      !current() ||
      (activeSource && element.onerror !== activeSource.listener)
    )
      return false;
    const binding = {
      listener: () => {
        if (
          !current() ||
          activeSource !== binding ||
          element.onerror !== binding.listener ||
          (requireSource && !element.getAttribute("src")) ||
          !element.error ||
          element.error.code === 1
        )
          return;
        error(Object.freeze({ code: element.error.code }));
      },
    };
    activeSource = binding;
    element.onerror = binding.listener;
    element.src = url;
    const ownsSource = () =>
      current() &&
      activeSource === binding &&
      element.onerror === binding.listener;
    if (!ownsSource()) return false;
    if (load) element.load();
    if (!ownsSource()) return false;
    attached();
    return true;
  }
  return {
    attach(load = false) {
      if (started || !current()) return false;
      started = true;
      return setSource(source, load);
    },
    reload(url: string) {
      return started && setSource(url, true);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      const old = activeSource;
      activeSource = undefined;
      if (old && element.onerror === old.listener) element.onerror = null;
    },
  };
}
export type NativeDriver = ReturnType<typeof createNativeDriver>;
