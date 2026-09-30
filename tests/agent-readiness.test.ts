import { expect, it } from "vitest";
import {
  agentConnectionLabel,
  agentReadinessLabel,
  agentDrainLabel,
} from "../apps/web/src/features/admin/agent-readiness";
import type { Agent } from "../apps/web/src/shared/api/types";

const agent: Agent = {
  id: "agent",
  name: "NAS",
  revoked: false,
  last_seen: "2026-09-29T00:00:00Z",
};

it("does not infer live connection or versioned readiness from old server fields", () => {
  expect(agentConnectionLabel(agent)).toBe("已配对记录");
  expect(agentConnectionLabel({ ...agent, last_seen: null })).toBe(
    "等待首次连接",
  );
  expect(agentReadinessLabel(agent)).toContain("状态未知");
});

it("keeps connected, indexed and revoked states independent", () => {
  const ready: Agent = {
    ...agent,
    connected: false,
    source_version_status: "ready",
    indexed_count: 12,
  };
  expect(agentConnectionLabel(ready)).toBe("离线");
  expect(agentReadinessLabel(ready)).toBe("文件版本索引已就绪（12 部影片）");
  expect(agentConnectionLabel({ ...ready, connected: true })).toBe("在线");
  expect(agentConnectionLabel({ ...ready, revoked: true })).toBe("已撤销");
  expect(agentReadinessLabel({ ...ready, revoked: true })).toContain(
    "凭据已失效",
  );
});

it("gives actionable upgrade and rescan guidance without claiming an empty index is ready", () => {
  expect(
    agentReadinessLabel({ ...agent, source_version_status: "empty" }),
  ).toBe("尚无可用影片索引，请连接设备并扫描");
  expect(
    agentReadinessLabel({
      ...agent,
      source_version_status: "upgrade_required",
      unversioned_count: 3,
    }),
  ).toBe(
    "请升级 NAS Agent 并重新扫描，现有索引缺少文件版本（3 部影片缺少版本）",
  );
  expect(
    agentReadinessLabel({
      ...agent,
      source_version_status: "rescan_required",
      unversioned_count: 2,
    }),
  ).toBe("文件版本索引待补全，请重新扫描（2 部影片缺少版本）");
});

it("distinguishes legacy, unknown and positive resource drain capability", () => {
  const base = { id: "agent", name: "NAS", revoked: false, last_seen: null };
  expect(agentDrainLabel(base)).toContain("尚未确认");
  expect(
    agentDrainLabel({ ...base, connected: true, drain_receipts: false }),
  ).toContain("请升级");
  expect(
    agentDrainLabel({ ...base, connected: true, drain_receipts: true }),
  ).toBe("支持资源释放确认");
  expect(
    agentDrainLabel({ ...base, revoked: true, drain_receipts: false }),
  ).toBe("");
});
