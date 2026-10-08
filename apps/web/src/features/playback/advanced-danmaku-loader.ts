import type { PlatformDanmakuCue } from "./platform-text";
/** One owned worker per finite snapshot, stopped on success, failure, timeout,
 * disable, media replacement and scope disposal. No untrusted code is eval'd. */
export async function compileDanmakuCues(
  cues: PlatformDanmakuCue[],
  signal: AbortSignal,
): Promise<PlatformDanmakuCue[]> {
  const programs = cues.filter((c) => c.program);
  if (!programs.length) return cues;
  if (signal.aborted) throw signal.reason;
  let worker: Worker | undefined;
  try {
    worker = new Worker(
      new URL("./advanced-danmaku-worker.ts", import.meta.url),
      { type: "module" },
    );
    const results = await new Promise<
      { scene?: PlatformDanmakuCue["scene"]; error?: string }[]
    >((resolve, reject) => {
      const complete = (action: () => void) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        action();
      };
      const aborted = () => complete(() => reject(signal.reason));
      const timer = setTimeout(
        () => complete(() => reject(new Error("advanced_danmaku_timeout"))),
        1500,
      );
      signal.addEventListener("abort", aborted, { once: true });
      worker!.onerror = () =>
        complete(() => reject(new Error("advanced_danmaku_worker_failed")));
      worker!.onmessage = (event) =>
        complete(() => {
          if (
            !Array.isArray(event.data) ||
            event.data.length !== programs.length
          )
            reject(new Error("advanced_danmaku_result_invalid"));
          else resolve(event.data);
        });
      worker!.postMessage(programs.map((c) => c.program));
    });
    let index = 0;
    return cues.map((c) =>
      c.program
        ? {
            ...c,
            scene: results[index]?.scene,
            program_error: results[index++]?.error,
          }
        : c,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    return cues.map((c) =>
      c.program
        ? { ...c, program_error: "高级弹幕加载失败，可重新开启弹幕重试" }
        : c,
    );
  } finally {
    worker?.terminate();
  }
}
