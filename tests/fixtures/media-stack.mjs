import { reapOwnedChildren } from "../../deploy/owned-process.mjs";
import { isolatedServer, delay } from "./server.mjs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function port() {
  const server = createServer(); await new Promise(r => server.listen(0, "127.0.0.1", r));
  const value = server.address().port; await new Promise(r => server.close(r)); return value;
}
export async function isolatedMediaStack(name, run, options = {}) {
  return isolatedServer(name, async f => {
    const children = new Set(), streams = [];
    let worker, agent, agentPair, launch = 0;
    const workerPort = await port(); f.workerOrigin = `http://127.0.0.1:${workerPort}`;
    const start = (binary, env, args = []) => {
      f.abortSignal?.throwIfAborted();
      const log = createWriteStream(resolve(f.root, `child-${++launch}.log`)); streams.push(log);
      const child = spawn(binary, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      children.add(child); child.failure = null;
      child.once("error", e => child.failure = e);
      child.done = new Promise(r => child.once("close", code => { children.delete(child); r(code); }));
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false }); return child;
    };
    const stop = async child => {
      if (!child) return null;
      if (child.exitCode === null && child.signalCode === null) child.kill();
      const code = await child.done;
      return { pid: child.pid ?? null, observed_close: true, exit_code: code, signal: child.signalCode };
    };
    f.startWorker = async (extra = {}) => {
      if (worker?.exitCode === null) throw Error("Worker already owned and running");
      worker = start(resolve(f.target, `rainsync-media-worker${process.platform === "win32" ? ".exe" : ""}`), { ...f.env, WORKER_BIND: `127.0.0.1:${workerPort}`, PUBLIC_ORIGIN: f.workerOrigin, ...extra });
      f.workerPid = worker.pid;
      for (let i=0; i<100; i++) {
        f.abortSignal?.throwIfAborted();
        if (worker.failure || worker.exitCode !== null) throw Error("Fixture Worker failed; inspect child log");
        try { if ((await fetch(f.workerOrigin + "/health")).ok) return; } catch {}
        await delay(100);
      }
      throw Error("Fixture Worker timeout");
    };
    f.stopWorker = async () => { const outcome = await stop(worker); worker = undefined; return outcome; };
    f.startAgent = async ({ mediaRoot = f.root } = {}) => {
      const admin = f.client(); await admin.login();
      const created = agentPair ??= await admin.request("/agents", "POST", { name: "owned preview agent" });
      agent = start(resolve(f.target, `rainsync-nas-agent${process.platform === "win32" ? ".exe" : ""}`), { ...f.env, SERVER_URL: f.origin, AGENT_DATA_ORIGIN: f.workerOrigin, PAIR_CODE: created.pair_code, MEDIA_ROOT: mediaRoot, AGENT_CREDENTIAL_FILE: resolve(f.root, "agent-token") });
      f.agentPid = agent.pid;
      return { agentId: created.id };
    };
    f.stopAgent = async () => { const outcome = await stop(agent); agent = undefined; return outcome; };
    f.makeClip = async (name, { blackSeconds = 0, pictureSeconds = 1, width = 640, height = 360, color = "red", rotate = 0 } = {}) => {
      const file = resolve(f.root, name);
      const filter = blackSeconds ? `color=black:s=${width}x${height}:r=25:d=${blackSeconds}[a];color=${color}:s=${width}x${height}:r=25:d=${pictureSeconds}[b];[a][b]concat=n=2:v=1:a=0` : `color=${color}:s=${width}x${height}:r=25:d=${pictureSeconds}`;
      const child = start("ffmpeg", f.env, ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", filter, "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", ...(rotate ? ["-metadata:s:v:0", `rotate=${rotate}`] : []), file]);
      const timeout = setTimeout(() => child.kill(), 15000);
      try { if (await child.done !== 0) throw Error("Fixture clip generation failed"); } finally { clearTimeout(timeout); }
      return file;
    };
    let previewClient;
    f.waitForPreview = async (mediaId, expectedStatus = "ready", timeout = 45000) => {
      if (!previewClient) { previewClient = f.client(); await previewClient.login(); }
      const client = previewClient;
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const result = await client.request(`/media/previews?ids=${mediaId}`);
        const cover = result.items[0]?.cover;
        if (cover?.status === expectedStatus) return cover;
        if (cover?.status === "unavailable" && expectedStatus !== "unavailable") throw Error("Preview unavailable");
        await delay(100);
      }
      throw Error(`Preview did not become ${expectedStatus}`);
    };
    try { await writeFile(resolve(f.root, "ownership.json"), JSON.stringify({ fixture: f.id, container: f.container, workerPort })); await run(f); }
    finally {
      try { await reapOwnedChildren([...children].map(child => ({ child, closed: child.done }))); }
      finally { for (const stream of streams) await new Promise(r => stream.end(r)); }
    }
  }, options);
}
