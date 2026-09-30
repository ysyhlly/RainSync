import { computed, reactive, ref, watch } from "vue";
import { defineStore } from "pinia";
import { useSession } from "../auth/session.store";
import type { Source } from "../../shared/api/types";

export const useSourceScans = defineStore("source-scans", () => {
  const session = useSession();
  const running = ref(false),
    batch = ref(false),
    error = ref("");
  const results = reactive<
    Record<
      string,
      { name: string; busy: boolean; message: string; failed: boolean }
    >
  >({});
  const busy = computed(
    () => running.value || Object.values(results).some((r) => r.busy),
  );
  watch(
    () => session.epoch,
    () => {
      for (const key of Object.keys(results)) delete results[key];
      error.value = "";
      batch.value = false;
    },
  );
  const labels: Record<string, string> = {
    offline: "NAS 设备离线，请连接后重试",
    unsupported: "请更新 NAS Agent 后再手动扫描",
    upgrade_required: "请升级 NAS Agent 并重新扫描，现有索引缺少文件版本",
    busy: "设备正在扫描，请稍后重试",
    disconnected: "扫描期间设备断开，结果未确认",
    timeout: "扫描尚未确认完成，请稍后刷新媒体库",
    failed: "NAS 扫描失败，请检查设备目录",
  };
  async function scan(source: Source) {
    if (results[source.id]?.busy) return;
    const epoch = session.epoch;
    results[source.id] = {
      name: source.name,
      busy: true,
      message: "扫描中…",
      failed: false,
    };
    try {
      const value = await session.api<{ status?: string; count: number }>(
        source.kind === "agent"
          ? `/agents/${source.id}/scan`
          : `/sources/${source.id}/test`,
        "POST",
        undefined,
        AbortSignal.timeout(125000),
      );
      if (epoch !== session.epoch) return;
      const failed = !!value.status && value.status !== "complete";
      results[source.id] = {
        name: source.name,
        busy: false,
        failed,
        message: failed
          ? (labels[value.status!] ?? "扫描未完成")
          : `本次扫描发现 ${value.count} 部影片`,
      };
    } catch (failure) {
      if (epoch === session.epoch)
        results[source.id] = {
          name: source.name,
          busy: false,
          failed: true,
          message: failure instanceof Error ? failure.message : String(failure),
        };
    }
  }
  async function scanAll() {
    if (busy.value) return;
    running.value = true;
    batch.value = true;
    error.value = "";
    const epoch = session.epoch;
    try {
      const [sources, agents] = await Promise.all([
        session.api<Source[]>("/sources"),
        session.api<{ id: string; name: string; revoked: boolean }[]>(
          "/agents",
        ),
      ]);
      if (epoch !== session.epoch) return;
      const queue = [
        ...sources.filter((s) => s.kind !== "agent"),
        ...agents
          .filter((a) => !a.revoked)
          .map((a) => ({ id: a.id, name: a.name, kind: "agent" })),
      ];
      for (const key of Object.keys(results)) delete results[key];
      if (!queue.length) error.value = "暂无可扫描的片源或 NAS 设备";
      for (const source of queue)
        results[source.id] = {
          name: source.name,
          busy: false,
          failed: false,
          message: "等待扫描",
        };
      // At most three upstream scans; one failed source never cancels the others.
      await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, async () => {
          while (queue.length && epoch === session.epoch)
            await scan(queue.shift()!);
        }),
      );
    } catch (failure) {
      if (epoch === session.epoch)
        error.value =
          failure instanceof Error ? failure.message : String(failure);
    } finally {
      running.value = false;
    }
  }
  return { busy, running, batch, results, error, scan, scanAll };
});
