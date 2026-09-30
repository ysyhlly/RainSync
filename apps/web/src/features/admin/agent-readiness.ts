import type { Agent } from "../../shared/api/types";

export function agentConnectionLabel(agent: Agent): string {
  if (agent.revoked) return "已撤销";
  if (agent.connected === true) return "在线";
  if (agent.connected === false) return "离线";
  return agent.last_seen ? "已配对记录" : "等待首次连接";
}

export function agentReadinessLabel(agent: Agent): string {
  if (agent.revoked) return "设备凭据已失效，无法继续读取片源";
  const missing =
    agent.unversioned_count != null && agent.unversioned_count > 0
      ? `（${agent.unversioned_count} 部影片缺少版本）`
      : "";
  switch (agent.source_version_status) {
    case "upgrade_required":
      return `请升级 NAS Agent 并重新扫描，现有索引缺少文件版本${missing}`;
    case "rescan_required":
      return `文件版本索引待补全，请重新扫描${missing}`;
    case "empty":
      return "尚无可用影片索引，请连接设备并扫描";
    case "ready":
      return `文件版本索引已就绪${agent.indexed_count != null ? `（${agent.indexed_count} 部影片）` : ""}`;
    default:
      return "文件版本索引状态未知，请升级服务端和 NAS Agent 后重新扫描";
  }
}

export function agentDrainLabel(agent: Agent): string {
  if (agent.revoked) return "";
  if (agent.drain_receipts === true) return "支持资源释放确认";
  if (agent.connected && agent.drain_receipts === false)
    return "请升级 NAS Agent：当前版本不能确认房间关闭时的资源释放";
  return "资源释放确认能力尚未确认";
}
