import type {
  PlaybackPlan,
  UpstreamMeasuredOutput,
} from "../../../../../packages/protocol";
import { upstreamOutputUrl, validateUpstreamOutput } from "./upstream-output";

/** One optional, bounded observation on an already granted upstream session. */
export function observeUpstreamOutput(options: {
  plan: PlaybackPlan;
  origin: string;
  current: () => boolean;
  facts: (value: UpstreamMeasuredOutput) => void;
  fetcher?: typeof fetch;
}) {
  const controller = new AbortController();
  let active = true;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stop = () => {
    active = false;
    controller.abort();
    void reader?.cancel().catch(() => {});
    clearTimeout(timer);
  };
  const until = performance.now() + 30_000;
  const wallUntil = Date.now() + 30_000;
  const timer = setTimeout(stop, 30_000);
  const current = () =>
    active &&
    !controller.signal.aborted &&
    options.current() &&
    performance.now() < until &&
    Date.now() < wallUntil;
  const done = (async () => {
    try {
      const url = upstreamOutputUrl(options.plan, options.origin);
      if (!url || !current()) return;
      const response = await (options.fetcher ?? fetch)(url, {
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      reader = response.body?.getReader();
      if (
        !current() ||
        response.status !== 200 ||
        response.redirected ||
        (response.url && response.url !== url) ||
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? "",
        ) ||
        !reader
      )
        return;
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 32768))
        return;
      const bytes = new Uint8Array(32768);
      let used = 0;
      for (;;) {
        const next = await reader.read();
        if (!current()) return;
        if (next.done) break;
        if (used + next.value.byteLength > bytes.length) return;
        bytes.set(next.value, used);
        used += next.value.byteLength;
      }
      const facts = validateUpstreamOutput(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, used),
          ),
        ),
        options.plan,
      );
      if (facts && current()) options.facts(facts);
    } catch {
      // Missing observation never becomes measured facts, a new grant or a
      // playback failure. There is no automatic retry or SID negotiation.
    } finally {
      stop();
    }
  })();
  return { stop, done };
}
