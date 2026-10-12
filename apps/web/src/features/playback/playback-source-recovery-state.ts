/** The synchronous facts shared by generated waits and same-source recovery.
 * Scope decisions, request polling, deadlines and media effects stay in runtime.
 * Abort dispatch is synchronous: the distinct transition orders are deliberate. */
export function createPlaybackSourceRecoveryState() {
  let wait: AbortController | undefined;
  let failed = false;
  let end: number | undefined;
  let recovering = false;

  return {
    get pending() {
      return !!wait;
    },
    get failed() {
      return failed;
    },
    get end() {
      return end;
    },
    get recovering() {
      return recovering;
    },
    beginWait() {
      const controller = new AbortController();
      wait = controller;
      return controller;
    },
    finishWait(controller: AbortController) {
      if (wait === controller) wait = undefined;
    },
    failWait() {
      failed = true;
    },
    completeAt(value: number) {
      end = value;
    },
    beginRecovery() {
      recovering = true;
    },
    endRecovery() {
      recovering = false;
    },
    retireSource() {
      wait?.abort();
      wait = undefined;
      failed = false;
      end = undefined;
      recovering = false;
    },
    restartSourceRecovery() {
      wait?.abort();
      wait = undefined;
      failed = false;
      end = undefined;
      recovering = true;
    },
    resetSeek() {
      failed = false;
      end = undefined;
      recovering = false;
      wait?.abort();
      wait = undefined;
    },
    invalidateClock() {
      wait?.abort();
      wait = undefined;
      failed = false;
    },
  };
}
