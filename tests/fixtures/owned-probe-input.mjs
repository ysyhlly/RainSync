import { readlinkSync, statSync } from "node:fs";

// Linux production probes receive the Server's retained descriptor, not the
// pathname. Match only that parent process's handle and the expected live file.
export function isOwnedProbeInput(input, target, serverPid = process.ppid) {
  if (!Number.isSafeInteger(serverPid) || serverPid <= 0 || typeof input !== "string")
    return false;
  const prefix = `/proc/${serverPid}/fd/`;
  if (!input.startsWith(prefix) || !/^\d+$/.test(input.slice(prefix.length)))
    return false;
  try {
    if (readlinkSync(input) !== target) return false;
    const held = statSync(input, { bigint: true });
    const current = statSync(target, { bigint: true });
    return held.isFile() && current.isFile() &&
      held.dev === current.dev && held.ino === current.ino;
  } catch {
    return false;
  }
}
