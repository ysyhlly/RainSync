import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export async function controlEpochs({
  socket,
  command,
  state,
  room,
  admin,
  friend,
  sql,
  sqlProcess,
  env,
}) {
  const current = {
    ...command,
    command_id: randomUUID(),
    control_epoch: socket.controlEpoch,
    expected_revision: state.revision,
    media_generation: state.media_generation,
    type: "PLAY",
    payload: undefined,
  };
  async function rejected(body, code) {
    socket.ws.send(JSON.stringify(body));
    const message = await socket.wait(
      (v) => v.type === "ERROR" && v.command_id === body.command_id,
    );
    assert.equal(message.error.code, code);
    assert.equal(message.state.revision, state.revision);
    assert.ok(message.control_epoch.id);
    assert.ok(message.control_epoch.expires_at_ms <= Date.now() + 86400000);
    return message;
  }
  await rejected(
    { ...current, control_epoch: undefined },
    "CONTROL_EPOCH_REQUIRED",
  );
  await rejected(
    { ...current, control_epoch: randomUUID() },
    "CONTROL_EPOCH_EXPIRED",
  );
  const friendId = (await friend.request("/auth/me")).id;
  const wrongUser = sql(
    `SELECT id FROM control_epochs WHERE user_id='${friendId}' LIMIT 1`,
  );
  await rejected(
    { ...current, control_epoch: wrongUser },
    "CONTROL_EPOCH_EXPIRED",
  );
  const otherRoom = await admin.request("/rooms", "POST", {
    name: "epoch scope fixture",
  });
  const otherEpoch = randomUUID();
  sql(
    `INSERT INTO control_epochs(id,user_id,room_id) SELECT '${otherEpoch}',user_id,'${otherRoom.id}' FROM control_epochs WHERE id='${socket.controlEpoch}'`,
  );
  await rejected(
    { ...current, control_epoch: otherEpoch },
    "CONTROL_EPOCH_EXPIRED",
  );
  // Even a known successful command cannot bypass expiry via cached results.
  sql(
    `UPDATE control_epochs SET expires_at=now()-interval '1 second' WHERE id='${command.control_epoch}'`,
  );
  await rejected(command, "CONTROL_EPOCH_EXPIRED");
  sql(
    `UPDATE command_results SET created_at=now()-interval '25 hours' WHERE command_id='${command.command_id}'`,
  );
  const oldId = randomUUID();
  sql(
    `INSERT INTO command_results(room_id,command_id,user_id,state,request_payload,created_at) SELECT room_id,'${oldId}',user_id,state,request_payload,now()-interval '49 hours' FROM command_results WHERE command_id='${command.command_id}'`,
  );
  const cleanup = resolve(
    env.CARGO_TARGET_DIR ?? "target",
    "debug",
    "examples",
    `cleanup_control_history${process.platform === "win32" ? ".exe" : ""}`,
  );
  assert.ok(
    existsSync(cleanup),
    "Build cleanup_control_history before this test: cargo build --locked -p persistence --example cleanup_control_history",
  );
  execFileSync(cleanup, [], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  assert.equal(
    sql(
      `SELECT count(*) FROM command_results WHERE command_id='${command.command_id}'`,
    ),
    "1",
    "25h results survive the independent 48h window",
  );
  assert.equal(
    sql(`SELECT count(*) FROM command_results WHERE command_id='${oldId}'`),
    "0",
  );
  assert.equal(
    sql(
      `SELECT count(*) FROM control_epochs WHERE id='${command.control_epoch}'`,
    ),
    "0",
  );
  sql(`DELETE FROM command_results WHERE command_id='${command.command_id}'`);
  await rejected(command, "CONTROL_EPOCH_EXPIRED");

  // Expire a valid command while its replay/commit authorization waits for the snapshot.
  // The direct final-commit expiry race is also covered by room-membership-gates.
  const lock = sqlProcess(undefined, { interactive: true });
  const locked = new Promise((resolve, reject) => {
    lock.stdout.on("data", (data) => {
      if (data.toString().includes("epoch-lock-ready")) resolve();
    });
    lock.once("error", reject);
    lock.once("exit", (code) => {
      if (code) reject(new Error("epoch lock failed"));
    });
  });
  const waiting = {
    ...current,
    command_id: randomUUID(),
    control_epoch: socket.controlEpoch,
  };
  try {
    lock.stdin.write(
      `BEGIN; SELECT room_id FROM room_snapshots WHERE room_id='${room.id}' FOR UPDATE; SELECT 'epoch-lock-ready';\n`,
    );
    await locked;
    socket.ws.send(JSON.stringify(waiting));
    let blocked = "0";
    for (let i = 0; i < 30 && blocked === "0"; i++) {
      blocked = sql(
        "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND (query LIKE 'SELECT state FROM room_snapshots%FOR UPDATE%' OR query LIKE 'SELECT room_id FROM room_snapshots%FOR SHARE%')",
      );
      if (blocked === "0")
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.notEqual(blocked, "0");
    sql(
      `UPDATE control_epochs SET expires_at=now()-interval '1 second' WHERE id='${waiting.control_epoch}'`,
    );
  } finally {
    const released = new Promise((resolve) => lock.once("exit", resolve));
    lock.stdin.end("COMMIT;\n");
    await released;
  }
  const expired = await socket.wait(
    (v) => v.type === "ERROR" && v.command_id === waiting.command_id,
  );
  assert.equal(expired.error.code, "CONTROL_EPOCH_EXPIRED");
  assert.equal(expired.state.revision, state.revision);
  socket.ws.send(
    JSON.stringify({
      ...current,
      command_id: randomUUID(),
      control_epoch: socket.controlEpoch,
    }),
  );
  const resumed = await socket.wait((v) => v.type === "ACK");
  assert.equal(resumed.state.revision, state.revision + 1);
  console.log(
    "PASS: control epochs bind users, expire before replay and after lock waits, renew without old-command execution; 48h result retention",
  );
}
