import { compileBas } from "./bas-danmaku";
import { compileScript, ScriptParserUnavailable } from "./script-danmaku";
import { MAX_PROGRAM_BYTES } from "./advanced-danmaku";
self.onmessage = async (event: MessageEvent) => {
  const input = event.data;
  if (!Array.isArray(input) || input.length > 32) return;
  self.postMessage(
    await Promise.all(
      input.map(async (item) => {
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
                ? await compileScript(item.source)
                : undefined;
          if (!scene) throw new Error();
          return { scene };
        } catch (failure) {
          return {
            error:
              failure instanceof ScriptParserUnavailable
                ? "高级弹幕解析器加载失败，请检查网络后重新开启弹幕。"
                : "此条高级弹幕包含暂不支持的语法或超出运行上限",
          };
        }
      }),
    ),
  );
};
