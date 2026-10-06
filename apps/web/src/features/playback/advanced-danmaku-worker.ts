import { compileBas } from "./bas-danmaku";
import { compileScript } from "./script-danmaku";
import { MAX_PROGRAM_BYTES } from "./advanced-danmaku";
self.onmessage = (event: MessageEvent) => {
  const input = event.data;
  if (!Array.isArray(input) || input.length > 32) return;
  self.postMessage(
    input.map((item) => {
      try {
        if (
          !item ||
          typeof item.source !== "string" ||
          new TextEncoder().encode(item.source).length > MAX_PROGRAM_BYTES
        )
          throw new Error();
        const scene =
          item.language === "bas"
            ? compileBas(item.source)
            : item.language === "script"
              ? compileScript(item.source)
              : undefined;
        if (!scene) throw new Error();
        return { scene };
      } catch {
        return { error: "此条高级弹幕包含暂不支持的语法或超出运行上限" };
      }
    }),
  );
};
