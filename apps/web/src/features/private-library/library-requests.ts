/** Own one replaceable read; a late response cannot change another identity. */
export function createLibraryRead(
  identity: () => number,
  active: () => boolean,
) {
  let version = 0;
  let controller: AbortController | undefined;
  function cancel() {
    ++version;
    controller?.abort();
    controller = undefined;
  }
  return {
    get version() {
      return version;
    },
    get signal() {
      return controller?.signal;
    },
    cancel,
    begin() {
      cancel();
      const mine = version,
        epoch = identity();
      const owned = new AbortController();
      controller = owned;
      return {
        signal: owned.signal,
        current: () =>
          active() &&
          version === mine &&
          identity() === epoch &&
          !owned.signal.aborted,
      };
    },
  };
}
