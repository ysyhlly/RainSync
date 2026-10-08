import assert from "node:assert/strict";

// Configuration can contain credentials and is written by the product's own
// UID. Keep it off the host tree; never chmod/chown it to make host rm succeed.
export function ownedUpstreamStorage(kind, id) {
  assert.ok(["jellyfin", "emby"].includes(kind));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return ["config", "cache"].map((directory) => ({
    name: `rainsync-upstream-${kind}-${id}-${directory}`,
    target: `/${directory}`,
    owner: id,
  }));
}

export async function createOwnedUpstreamVolume(docker, volume, onCreateAttempt = () => {}) {
  // Refuse to adopt even a correctly named pre-existing volume.
  const names = await docker("volume", "ls", "--filter", `name=^${volume.name}$`, "--format", "{{.Name}}");
  assert.equal(names, "", "Fresh fixture volume must not already exist");
  // Register cleanup ownership before the command: Docker may create the
  // volume even if its response or activity-log write fails.
  onCreateAttempt(volume);
  const name = await docker("volume", "create", "--label", `rainsync.fixture=${volume.owner}`, volume.name);
  assert.equal(name, volume.name);
}

export async function verifyOwnedUpstreamVolume(docker, volume) {
  const details = JSON.parse(await docker("volume", "inspect", volume.name, "--format", "{{json .}}"));
  assert.equal(details.Name, volume.name, "Exact owned volume name");
  assert.equal(details.Labels?.["rainsync.fixture"], volume.owner, "Exact fixture owner label");
}

export async function removeOwnedUpstreamVolume(docker, volume) {
  await verifyOwnedUpstreamVolume(docker, volume);
  await docker("volume", "rm", volume.name);
}
