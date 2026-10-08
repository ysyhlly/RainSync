import { StaleIdentity } from "../../shared/api/client";

/** One provider's request lifecycle. Status validation and publishing stay local. */
export function createAccountRequestSlot<Status>(options: {
  epoch: () => number;
  cached: (force: boolean) => Status | undefined;
  read: (signal: AbortSignal) => Promise<Status>;
  accept: (value: Status) => Status;
  timeoutMs: number;
  busyMessage: string;
}) {
  let serial = 0,
    controller = new AbortController(),
    pending: Promise<Status> | undefined,
    mutation: Promise<unknown> | undefined;

  function retire() {
    ++serial;
    controller.abort();
    controller = new AbortController();
    pending = mutation = undefined;
  }

  function refresh(force = false): Promise<Status> {
    if (mutation) {
      const epoch = options.epoch();
      return mutation
        .catch(() => undefined)
        .then(() => {
          if (epoch !== options.epoch()) throw new StaleIdentity();
          return refresh(force);
        });
    }
    if (pending) return pending;
    const cached = options.cached(force);
    if (!force && cached) return Promise.resolve(cached);
    const epoch = options.epoch(),
      generation = serial,
      signal = controller.signal;
    const request = options
      .read(signal)
      .then((value) => {
        if (
          epoch !== options.epoch() ||
          generation !== serial ||
          signal.aborted
        )
          throw new StaleIdentity();
        return options.accept(value);
      })
      .finally(() => {
        if (pending === request) pending = undefined;
      });
    pending = request;
    return request;
  }

  function mutate<Result>(
    action: (signal: AbortSignal) => Promise<Result>,
    publish: (value: Result) => Result,
    external?: AbortSignal,
    validate?: () => void,
  ): Promise<Result> {
    if (mutation) return Promise.reject(Error(options.busyMessage));
    try {
      validate?.();
    } catch (error) {
      return Promise.reject(error);
    }
    retire();
    const epoch = options.epoch(),
      generation = serial,
      signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(options.timeoutMs),
        ...(external ? [external] : []),
      ]);
    const request = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return action(signal);
      })
      .then((value) => {
        if (
          epoch !== options.epoch() ||
          generation !== serial ||
          signal.aborted
        )
          throw new StaleIdentity();
        return publish(value);
      })
      .finally(() => {
        if (mutation === request) mutation = undefined;
      });
    mutation = request;
    return request;
  }

  return { refresh, mutate, retire };
}
