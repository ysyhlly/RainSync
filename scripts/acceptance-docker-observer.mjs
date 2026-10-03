// Read-only Docker observer for explicitly identified disposable containers.
// Does not create containers, change network policy, inject faults or run Agent
// control connections. Every observation rechecks ownership and pinned images.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const execute = promisify(execFile);

export async function createDockerObserver({
  run_id,
  containers,
  binding,
  docker_socket = "unix:///var/run/docker.sock",
}) {
  assert.ok(run_id && Array.isArray(containers) && containers.length > 0);
  assert.equal(
    docker_socket,
    "unix:///var/run/docker.sock",
    "reference observer only supports the explicit local Docker socket",
  );
  const roles = new Set();
  for (const item of containers) {
    assert.match(
      item.id,
      /^[a-f0-9]{64}$/,
      "full immutable container ID required; names may be reused",
    );
    assert.match(item.role, /^[a-z][a-z0-9-]*$/);
    assert.ok(!roles.has(item.role));
    roles.add(item.role);
    assert.ok(
      typeof item.cache_path === "string" &&
        /^\/[a-zA-Z0-9/_-]+$/.test(item.cache_path) &&
        !item.cache_path.split("/").includes(".."),
      "explicit safe cache directory required",
    );
    assert.ok(
      Number.isSafeInteger(item.cache_quota_bytes) &&
        item.cache_quota_bytes > 0,
    );
  }
  const docker = async (args, signal) => {
    const env = { ...process.env };
    for (const key of [
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "DOCKER_TLS",
      "DOCKER_TLS_VERIFY",
      "DOCKER_CERT_PATH",
    ])
      delete env[key];
    const { stdout } = await execute(
      "docker",
      ["--host=" + docker_socket, ...args],
      { env, signal, timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8" },
    );
    return stdout.trim();
  };
  const inspect = async (item, signal) => {
    const [info] = JSON.parse(
      await docker(["inspect", "--type=container", item.id], signal),
    );
    assert.equal(info.Id, item.id);
    assert.equal(
      info.Config.Labels?.["org.rainsync.acceptance-run"],
      run_id,
      "container is not owned by this acceptance run",
    );
    assert.equal(
      info.HostConfig.NetworkMode === "host",
      false,
      "host-network container is not isolated",
    );
    assert.equal(info.State.Running, true, "owned container is not running");
    assert.equal(info.Image, binding.image_id, "owned service image changed");
    return info;
  };
  return {
    async artifactIdentity(_input, { signal } = {}) {
      const observed = {};
      const provenance = [];
      for (const item of containers) {
        const info = await inspect(item, signal);
        const [image] = JSON.parse(
          await docker(["image", "inspect", info.Image], signal),
        );
        assert.equal(
          image.Config.Labels?.["org.rainsync.full-source-manifest"],
          binding.source_sha256,
          "image source label mismatch",
        );
        assert.equal(
          image.Config.Labels?.["org.rainsync.source-manifest"],
          binding.production_sha256,
          "image production label mismatch",
        );
        for (const name of Object.keys(binding.binary_sha256)) {
          assert.match(name, /^rainsync-(server|media-worker|nas-agent)$/);
          const text = await docker(
            ["exec", item.id, "sha256sum", "/usr/local/bin/" + name],
            signal,
          );
          const digest = text.split(/\s/)[0];
          assert.equal(
            digest,
            binding.binary_sha256[name],
            `running ${name} differs from frozen candidate`,
          );
          observed[name] = digest;
        }
        provenance.push({
          container_id: item.id,
          image_id: info.Image,
          started_at: info.State.StartedAt,
          role: item.role,
        });
      }
      return {
        observation_id: randomUUID(),
        image_id: binding.image_id,
        source_sha256: binding.source_sha256,
        binary_sha256: observed,
        containers: provenance,
      };
    },
    async sampleResources({ phase }, { signal } = {}) {
      return Promise.all(
        containers.map(async (item) => {
          const info = await inspect(item, signal);
          // Fixed program with positional path input; never execute report/config
          // content as shell code. pid 1 RSS/FD are service-process measurements;
          // sockets/processes are container-wide, including observer overhead.
          const script =
            "set -eu; awk '/^VmRSS:/ { print $2 * 1024 }' /proc/1/status; find /proc/1/fd -mindepth 1 -maxdepth 1 | wc -l; cat /proc/net/tcp /proc/net/tcp6 | awk 'NR > 1 && $1 !~ /sl/ { n++ } END { print n+0 }'; find /proc -maxdepth 1 -type d -name \"[0-9]*\" | wc -l; du -sb -- \"$1\" | cut -f1";
          const result = (
            await docker(
              [
                "exec",
                item.id,
                "sh",
                "-c",
                script,
                "observer",
                item.cache_path,
              ],
              signal,
            )
          )
            .split(/\s+/)
            .map(Number);
          assert.ok(
            result.length === 5 &&
              result.every(
                (value) => Number.isSafeInteger(value) && value >= 0,
              ),
            "invalid resource observation",
          );
          const [
            rss_bytes,
            fd_count,
            socket_count,
            process_count,
            cache_bytes,
          ] = result;
          return {
            entity: item.id,
            role: item.role,
            instance_id: `${item.id}:${info.State.StartedAt}`,
            phase: phase.id,
            observation_id: randomUUID(),
            rss_bytes,
            fd_count,
            socket_count,
            process_count,
            cache_bytes,
            cache_quota_bytes: item.cache_quota_bytes,
            scope:
              "PID 1 RSS/FD; container TCP sockets/processes; directory bytes; observer adds temporary processes",
          };
        }),
      );
    },
  };
}
