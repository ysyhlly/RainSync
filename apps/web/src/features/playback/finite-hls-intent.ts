import type {
  PlaybackCapabilities,
  PlaybackRequest,
} from "../../../../../packages/protocol";

export function validateFiniteHlsChoice(
  mode: string,
  scope: {
    advanced?: unknown;
    ladder?: unknown;
    distributed?: unknown;
    continuation?: unknown;
  },
): void {
  if (mode !== "finite_hls") return;
  if (scope.advanced || scope.ladder || scope.distributed || scope.continuation)
    throw Error(
      "有限 HLS 时间线转码不能同时使用高级处理、多档、分布式产物或回退；请关闭这些选项后重新加载",
    );
}
export function finiteHlsRequestParameters(
  mode: string,
  kind: string | undefined,
  capabilities: PlaybackCapabilities,
): Pick<PlaybackRequest, "mode" | "finite_hls_version"> {
  if (mode !== "finite_hls") return { mode };
  if (kind !== "http")
    throw Error("有限 HLS 时间线转码仅适用于已登记的 HTTP 片源");
  if (!capabilities.native_hls && !capabilities.mse_h264_aac)
    throw Error("当前浏览器不支持此有限 HLS 转码输出");
  return { mode: "transcode", finite_hls_version: 1 };
}
