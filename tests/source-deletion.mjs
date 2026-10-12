// Real isolated PostgreSQL/Server/Vue/Chromium. No application route mocks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { createServer as netServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer as viteServer } from "vite";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";
import { safeFailure } from "./fixtures/safe-failure.mjs";
import { withTerminationSignal } from "../deploy/owned-process.mjs";

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 1 && args[0] === "--backend-only"),
);
const backendOnly = args[0] === "--backend-only";
const report = {
  schema_version: 1,
  selection: backendOnly ? "backend-only" : "full",
  result: "running",
  backend: "running",
  browser: backendOnly ? "not_run" : "pending",
  started_at: new Date().toISOString(),
  failures: [],
};
let owned;
const save = async () => {
  if (owned)
    await writeFile(
      resolve(owned.root, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
};
const runServer = (name, run, options) =>
  backendOnly
    ? withTerminationSignal((signal) =>
        isolatedServer(name, run, { ...options, signal }),
      )
    : isolatedServer(name, run, options);

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
async function prepareLocal(f, client, room, media) {
  const socket = new WebSocket(
    f.origin.replace("http:", "ws:") + "/api/v1/ws",
    {
      headers: { Origin: f.env.PUBLIC_ORIGIN, Cookie: client.cookie },
    },
  );
  const frames = [];
  socket.on("message", (bytes) => frames.push(JSON.parse(bytes)));
  socket.on("error", () => {});
  try {
    await new Promise((done, reject) => {
      socket.once("open", done);
      socket.once("error", reject);
    });
    async function next(predicate) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const i = frames.findIndex(predicate);
        if (i >= 0) return frames.splice(i, 1)[0];
        await new Promise((done) => setTimeout(done, 20));
      }
      throw Error("owned room command timed out");
    }
    socket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
    const snapshot = await next((frame) => frame.type === "SNAPSHOT");
    const command = {
      protocol_version: 1,
      room_id: room.id,
      command_id: randomUUID(),
      control_epoch: snapshot.control_epoch.id,
      expected_revision: snapshot.state.revision,
      media_generation: snapshot.state.media_generation,
      type: "CHANGE_MEDIA",
      payload: { media_id: media },
    };
    socket.send(JSON.stringify(command));
    const ack = await next((frame) => frame.command_id === command.command_id);
    assert.equal(ack.type, "ACK");
    const playback = await client.request("/playback-sessions", "POST", {
      room_id: room.id,
      media_generation: ack.state.media_generation,
      position_ms: 0,
      audio_index: null,
      mode: "auto",
      idempotency_key: randomUUID(),
      capabilities: {
        progressive_h264_aac: true,
        native_hls: false,
        mse_h264_aac: true,
      },
    });
    return playback.session_id;
  } finally {
    socket.terminate();
  }
}
// Establish deletion commit before the scan's next guarded publication step.
// Awaiting the DELETE response before releasing the provider would deadlock:
// the provider holds a source FOR SHARE lock for its complete response.
async function deleteDuringHeldScan(f, admin, source) {
  const scan = admin.raw(`/sources/${source.id}/test`, { method: "POST" });
  // Preserve both deferred outcomes until their assertion and final settlement.
  scan.catch(() => {});
  let deletion, barrier, barrierMarker, timer;
  let barrierReleased = false,
    primaryFailed = false,
    primaryError;
  const evidence = { checks: [] };
  report.scan_deletion_order = evidence;
  async function releaseBarrier() {
    if (!barrier || barrierReleased) return;
    barrierReleased = true;
    if (!barrier.stdin.destroyed && !barrier.stdin.writableEnded)
      barrier.stdin.end("COMMIT;\n\\q\n");
    await barrier.done;
    assert.equal(barrier.exitCode, 0);
    assert.equal(barrier.signalCode, null);
    assert.equal(verifyPidAbsent(barrier.pid), true);
    await f.waitForSql(
      `SELECT count(*) FROM pg_stat_activity WHERE application_name=${quote(barrierMarker)}`,
      "0",
      2000,
    );
    evidence.release = {
      pid: barrier.pid,
      exit_code: 0,
      signal: null,
      observed_close: true,
      pid_absent: true,
      postgres_connection_absent: true,
    };
  }
  try {
    try {
      await Promise.race([
        reached,
        new Promise((_done, reject) => {
          timer = setTimeout(
            () => reject(Error("owned scan did not reach provider")),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    evidence.checks.push("provider response held");
    deletion = admin.request(`/sources/${source.id}`, "DELETE");
    deletion.catch(() => {});
    const deadline = Date.now() + 2000;
    let writer;
    while (Date.now() < deadline) {
      f.abortSignal?.throwIfAborted();
      const rows = JSON.parse(
        f.sql(
          "SELECT COALESCE(json_agg(json_build_object('pid',w.pid,'blocker',b.pid)),'[]'::json) FROM pg_stat_activity w CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) x(pid) JOIN pg_stat_activity b ON b.pid=x.pid WHERE w.datname=current_database() AND w.query='SELECT kind,library_id FROM sources WHERE id=$1 FOR UPDATE' AND w.wait_event_type='Lock' AND b.state='idle in transaction' AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=w.pid AND l.relation='sources'::regclass AND l.mode='RowShareLock' AND l.granted) AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=b.pid AND l.relation='sources'::regclass AND l.mode='RowShareLock' AND l.granted)",
        ),
      );
      if (rows.length === 1) {
        writer = rows[0];
        break;
      }
      await delay(20);
    }
    assert.ok(writer, "exact DELETE writer waits on the held provider guard");
    evidence.writer = {
      pid: writer.pid,
      provider_backend_pid: writer.blocker,
      relation_lock_owned: true,
    };
    evidence.checks.push("exact DELETE writer waits on provider guard");
    // The admitted writer can upgrade its existing relation lock before this
    // EXCLUSIVE waiter; the next scan's fresh RowShareLock queues behind it.
    barrierMarker = `source_delete_barrier_${randomUUID().replaceAll("-", "")}`;
    barrier = f.sqlProcess(undefined, { interactive: true });
    barrier.stdout.resume();
    barrier.stdin.write(
      `SET application_name=${quote(barrierMarker)}; BEGIN; SET LOCAL statement_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='10s'; LOCK TABLE sources IN EXCLUSIVE MODE;\n`,
    );
    await f.waitForSql(
      `SELECT count(*) FROM pg_stat_activity WHERE application_name=${quote(barrierMarker)}`,
      "1",
      2000,
    );
    const barrierPid = Number(
      f.sql(
        `SELECT pid FROM pg_stat_activity WHERE application_name=${quote(barrierMarker)}`,
      ),
    );
    assert.ok(Number.isSafeInteger(barrierPid) && barrierPid > 0);
    evidence.barrier_backend_pid = barrierPid;
    await f.waitForSql(
      `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${barrierPid} AND relation='sources'::regclass AND mode='ExclusiveLock' AND NOT granted)`,
      "t",
      2000,
    );
    evidence.checks.push("exact table barrier queued before provider release");
    releaseScan();
    await f.waitForSql(
      `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${barrierPid} AND relation='sources'::regclass AND mode='ExclusiveLock' AND granted)`,
      "t",
      2000,
    );
    await deletion;
    assert.equal(
      f.sql(`SELECT count(*) FROM sources WHERE id=${quote(source.id)}`),
      "0",
    );
    assert.equal(
      f.sql(
        `SELECT count(*) FROM media_items WHERE source_id=${quote(source.id)} OR resource='late-item'`,
      ),
      "0",
    );
    const nextGuard =
      "SELECT kind,config_encrypted FROM sources WHERE id=$1 AND deleted_at IS NULL FOR SHARE";
    await f.waitForSql(
      `SELECT count(*) FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.datname=current_database() AND a.query=${quote(nextGuard)} AND l.relation='sources'::regclass AND l.mode='RowShareLock' AND NOT l.granted AND ${barrierPid}=ANY(pg_blocking_pids(a.pid))`,
      "1",
      2000,
    );
    evidence.checks.push(
      "DELETE committed with zero items while exact next scan guard waits",
    );
    await releaseBarrier();
    const response = await scan;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "SOURCE_SCAN_FAILED");
    assert.equal(
      f.sql(
        `SELECT count(*) FROM media_items WHERE source_id=${quote(source.id)} OR resource='late-item'`,
      ),
      "0",
    );
    evidence.response = { status: 409, error_code: "SOURCE_SCAN_FAILED" };
    evidence.checks.push(
      "deleted source scan fails without publishing any item",
    );
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
    throw error;
  } finally {
    releaseScan?.();
    try {
      await releaseBarrier();
    } catch (error) {
      if (primaryFailed)
        throw new AggregateError(
          [primaryError, error],
          "scan deletion and barrier cleanup failed",
        );
      throw error;
    } finally {
      await Promise.allSettled([scan, deletion].filter(Boolean));
    }
  }
}
const listener = netServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const origin = `http://127.0.0.1:${port}`;
let releaseScan;
let scanReached;
const reached = new Promise((done) => (scanReached = done));
const upstream = httpServer(async (_request, response) => {
  scanReached();
  await new Promise((done) => (releaseScan = done));
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify({
      Items: [{ Id: "late-item", Name: "late scan result" }],
      TotalRecordCount: 1,
    }),
  );
});
await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
const upstreamPort = upstream.address().port;
let primaryFailed = false;
const cleanupErrors = [];
try {
  await runServer(
    "source-deletion",
    async (f) => {
      report.server_pid = f.serverPid;
      await save();
      const admin = f.client();
      const me = await admin.login();
      const mediaRoot = resolve(f.root, "owned-media");
      await mkdir(mediaRoot);
      const file = resolve(mediaRoot, "deletion-fixture.mp4");
      execFileSync("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=10",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-y",
        file,
      ]);
      const digest = () =>
        readFile(file).then((bytes) =>
          createHash("sha256").update(bytes).digest("hex"),
        );
      const original = await digest();
      const source = await admin.request("/sources", "POST", {
        name: "owned indexed source",
        kind: "local",
        config: { root: mediaRoot },
      });
      assert.equal(
        (await admin.request(`/sources/${source.id}/test`, "POST")).count,
        1,
      );
      const media = (await admin.request("/media"))[0];
      assert.ok(media);
      const path = `/sources/${source.id}`;
      await f.client().request(path, "DELETE", undefined, 401);
      await admin.request(path, "DELETE", undefined, 403, {
        "x-csrf-token": "",
      });
      await admin.request("/users", "POST", {
        username: "delete.viewer",
        password: f.password,
      });
      const viewer = f.client();
      await viewer.login("delete.viewer");
      await viewer.request(path, "DELETE", undefined, 403);

      const room = await admin.request("/rooms", "POST", {
        name: "deletion history",
      });
      const playlist = randomUUID();
      f.sql(
        `INSERT INTO playlist_items(id,room_id,media_id,sort_order) VALUES(${quote(playlist)},${quote(room.id)},${quote(media.id)},0)`,
      );
      const session = await prepareLocal(f, admin, room, media.id);
      const blocked = await admin.request(path, "DELETE", undefined, 409);
      assert.equal(blocked.error.code, "SOURCE_IN_USE");
      assert.match(blocked.error.message, /请先停止/);
      assert.equal(
        f.sql(`SELECT available FROM media_items WHERE id=${quote(media.id)}`),
        "t",
      );
      await admin.request(`/playback-sessions/${session}`, "DELETE");
      await admin.request(path, "DELETE");
      await admin.request(path, "DELETE");
      assert.equal(
        f.sql(`SELECT count(*) FROM sources WHERE id=${quote(source.id)}`),
        "0",
      );
      assert.equal(
        f.sql(
          `SELECT count(*) FROM source_scans WHERE source_id=${quote(source.id)}`,
        ),
        "0",
      );
      assert.equal(
        f.sql(
          `SELECT NOT available AND source_id IS NULL FROM media_items WHERE id=${quote(media.id)}`,
        ),
        "t",
      );
      assert.equal(
        f.sql(
          `SELECT count(*) FROM playlist_items WHERE id=${quote(playlist)} AND media_id=${quote(media.id)}`,
        ),
        "1",
      );
      assert.equal(
        f.sql(
          `SELECT stopped FROM playback_sessions WHERE id=${quote(session)}`,
        ),
        "t",
      );
      assert.equal(
        (await admin.request("/media")).some((row) => row.id === media.id),
        false,
      );
      assert.equal(await digest(), original);
      assert.equal(
        (await admin.request(path + "/test", "POST", undefined, 404)).error
          .code,
        "SOURCE_NOT_FOUND",
      );

      for (const kind of ["http", "jellyfin", "emby"]) {
        const row = await admin.request("/sources", "POST", {
          name: `empty ${kind}`,
          kind,
          config: {
            url: "https://fixture.example/video.mp4",
            user_id: "fixture",
            token: "fixture",
          },
        });
        await admin.request(`/sources/${row.id}`, "DELETE");
      }
      const rollback = await admin.request("/sources", "POST", {
        name: "rollback",
        kind: "http",
        config: { url: "https://fixture.example/rollback.mp4" },
      });
      const rollbackMedia = randomUUID();
      f.sql(`INSERT INTO media_items(id,source_id,title,resource) VALUES(${quote(rollbackMedia)},${quote(rollback.id)},'rollback','owned');
      CREATE FUNCTION test_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id=${quote(rollback.id)} THEN RAISE EXCEPTION 'owned deletion failure'; END IF; RETURN OLD; END $$;
      CREATE TRIGGER test_delete_failure BEFORE DELETE ON sources FOR EACH ROW EXECUTE FUNCTION test_delete_failure()`);
      await admin.request(`/sources/${rollback.id}`, "DELETE", undefined, 500);
      assert.equal(
        f.sql(
          `SELECT available AND source_id=${quote(rollback.id)} FROM media_items WHERE id=${quote(rollbackMedia)}`,
        ),
        "t",
      );
      f.sql(
        "DROP TRIGGER test_delete_failure ON sources; DROP FUNCTION test_delete_failure()",
      );
      await admin.request(`/sources/${rollback.id}`, "DELETE");

      const late = await admin.request("/sources", "POST", {
        name: "delayed scan",
        kind: "jellyfin",
        config: {
          url: `http://127.0.0.1:${upstream.address().port}`,
          user_id: "fixture",
          token: "fixture",
        },
      });
      await deleteDuringHeldScan(f, admin, late);

      const privateSource = await admin.request("/sources", "POST", {
        name: "private scope",
        kind: "http",
        config: { url: "https://fixture.example/private.mp4" },
      });
      const library = randomUUID();
      f.sql(`INSERT INTO private_libraries(id,name,owner_id,visibility) VALUES(${quote(library)},'owned private library',${quote(me.id)},'private');
      UPDATE sources SET library_id=${quote(library)} WHERE id=${quote(privateSource.id)}`);
      assert.equal(
        (
          await admin.request(
            `/sources/${privateSource.id}`,
            "DELETE",
            undefined,
            409,
          )
        ).error.code,
        "SOURCE_MANAGED_ELSEWHERE",
      );
      assert.equal(
        f.sql(
          `SELECT library_id FROM sources WHERE id=${quote(privateSource.id)}`,
        ),
        library,
      );

      report.backend = "passed";
      if (backendOnly) return;
      report.browser = "running";
      process.env.RAINSYNC_SERVER_PROXY_URL = f.origin;
      const dev = await viteServer({
        root: process.env.RAINSYNC_TEST_WEB_DIST ?? resolve("apps/web"),
        configFile: process.env.RAINSYNC_TEST_WEB_DIST
          ? false
          : resolve("apps/web/vite.config.ts"),
        server: {
          host: "127.0.0.1",
          port,
          strictPort: true,
          proxy: { "/api/v1": { target: f.origin, ws: true } },
        },
        logLevel: "warn",
      });
      let browser;
      try {
        await dev.listen();
        browser = await chromium.launch({
          headless: true,
          ...(process.env.RAINSYNC_CHROMIUM_EXECUTABLE
            ? { executablePath: process.env.RAINSYNC_CHROMIUM_EXECUTABLE }
            : {}),
        });
        const page = await browser.newPage();
        const errors = [];
        let deletes = 0;
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (
            request.method() === "DELETE" &&
            /\/api\/v1\/sources\//.test(request.url())
          )
            ++deletes;
        });
        await page.goto(origin + "/login");
        await page.getByLabel("登录账号", { exact: true }).fill("admin");
        await page.getByLabel("密码", { exact: true }).fill(f.password);
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await expect(
          page.getByRole("heading", { name: "放映室", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("link", { name: "片源管理", exact: true })
          .filter({ visible: true })
          .click();
        await page
          .getByRole("button", { name: "添加片源", exact: true })
          .click();
        await page
          .getByLabel("名称", { exact: true })
          .fill("browser deletion source");
        await page.getByLabel("容器内路径", { exact: true }).fill(mediaRoot);
        await page
          .getByRole("button", { name: "保存片源", exact: true })
          .click();
        const row = page
          .locator("article.admin-row")
          .filter({ hasText: "browser deletion source" });
        await expect(row).toBeVisible();
        await row
          .getByRole("button", { name: "检测并扫描", exact: true })
          .click();
        await expect(row).toContainText("本次扫描发现 1 部影片");
        const button = row.getByRole("button", {
          name: "删除片源 browser deletion source",
          exact: true,
        });
        await button.click();
        const dialog = page.getByRole("dialog", {
          name: "删除片源",
          exact: true,
        });
        await expect(dialog).toContainText("不会删除原始媒体文件");
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(row).toBeVisible();
        assert.equal(deletes, 0);
        const browserSource = (await admin.request("/sources")).find(
          (source) => source.name === "browser deletion source",
        );
        const browserMedia = f.sql(
          `SELECT id FROM media_items WHERE source_id=${quote(browserSource.id)} AND available`,
        );
        const browserSession = await prepareLocal(f, admin, room, browserMedia);
        await button.click();
        await dialog
          .getByRole("button", { name: "确认删除片源", exact: true })
          .click();
        await expect(dialog.getByRole("alert")).toContainText(
          "请先停止相关播放后再删除",
        );
        await expect(row).toBeAttached();
        assert.equal(deletes, 1);
        await admin.request(`/playback-sessions/${browserSession}`, "DELETE");
        await dialog
          .getByRole("button", { name: "确认删除片源", exact: true })
          .click();
        await expect(dialog).toBeHidden();
        await expect(row).toHaveCount(0);
        assert.equal(deletes, 2);
        await page.reload();
        await expect(
          page.getByRole("heading", { name: "片源管理", exact: true }),
        ).toBeVisible();
        await expect(row).toHaveCount(0);
        await expect(
          page
            .locator("article.admin-row")
            .filter({ hasText: "private scope" }),
        ).toContainText("请在所属媒体库中管理");
        assert.equal(await digest(), original);
        await page.setViewportSize({ width: 390, height: 844 });
        await admin.request("/sources", "POST", {
          name: "mobile deletion source",
          kind: "local",
          config: { root: mediaRoot },
        });
        await page.reload();
        const mobileRow = page
          .locator("article.admin-row")
          .filter({ hasText: "mobile deletion source" });
        await mobileRow
          .getByRole("button", {
            name: "删除片源 mobile deletion source",
            exact: true,
          })
          .click();
        await expect(
          dialog.getByRole("button", { name: "确认删除片源", exact: true }),
        ).toBeInViewport();
        await dialog
          .getByRole("button", { name: "确认删除片源", exact: true })
          .click();
        await expect(mobileRow).toHaveCount(0);
        assert.equal(deletes, 3);
        assert.equal(await digest(), original);
        assert.deepEqual(errors, []);
        console.log(
          "PASS: real API and Vue deletion, cancel, reload, admin/CSRF gates, active playback conflict, history/file preservation, atomic rollback, delayed scan fencing, private scope preserved",
        );
      } finally {
        await browser?.close();
        await dev.close();
      }
      report.browser = "passed";
    },
    {
      env: { PUBLIC_ORIGIN: origin },
      beforeStart: async (fixture) => {
        owned = fixture;
        report.fixture_id = fixture.id;
        report.server_origin = fixture.origin;
        report.postgres = fixture.postgresDiagnostics();
        await save();
      },
      ...(process.env.RAINSYNC_TEST_SERVER_BINARY
        ? { binary: process.env.RAINSYNC_TEST_SERVER_BINARY }
        : {}),
    },
  );
} catch (error) {
  primaryFailed = true;
  report.failures.push(safeFailure(error) ?? "verification_failed");
} finally {
  releaseScan?.();
  upstream.closeAllConnections();
  for (const step of [
    async () => {
      await new Promise((done, reject) =>
        upstream.close((error) => (error ? reject(error) : done())),
      );
      report.upstream_port_closed = await verifyClosedPort(upstreamPort);
      assert.equal(report.upstream_port_closed, true);
    },
    async () => {
      if (owned) report.cleanup = await owned.verifyStopped();
    },
  ]) {
    try {
      await step();
    } catch (error) {
      cleanupErrors.push(error);
      report.failures.push("cleanup_failed");
    }
  }
}
report.result = primaryFailed || cleanupErrors.length ? "failed" : "passed";
report.finished_at = new Date().toISOString();
try {
  await save();
} catch (error) {
  cleanupErrors.push(error);
}
if (primaryFailed || cleanupErrors.length) {
  // Assertion details, command output and browser call logs remain private.
  console.error("source_deletion_verification_failed");
  process.exitCode = 1;
} else if (backendOnly) {
  console.log(
    "PASS: source-deletion backend assertions; browser not run (--backend-only)",
  );
}
