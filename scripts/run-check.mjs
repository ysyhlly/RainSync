import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";

const [name, seconds, command, ...args] = process.argv.slice(2);
if (!process.env.RAINSYNC_ARTIFACT_DIR || !/^[\w-]+$/.test(name ?? "") || !command || !(Number(seconds) > 0)) {
  throw new Error("Usage: RAINSYNC_ARTIFACT_DIR=... node scripts/run-check.mjs NAME TIMEOUT_SECONDS COMMAND [ARGS...]");
}
const logs = resolve(process.env.RAINSYNC_ARTIFACT_DIR, "logs");
await mkdir(logs, { recursive: true });
const logPath = resolve(logs, `${name}.log`);
const output = createWriteStream(logPath);
const started = new Date();
const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let timedOut = false;
child.stdout.pipe(output, { end: false });
child.stderr.pipe(output, { end: false });
const timer = setTimeout(() => {
  timedOut = true;
  if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else child.kill("SIGKILL");
}, Number(seconds) * 1000);
const code = await new Promise((resolveCode) => {
  child.once("error", (error) => { output.write(`${error}\n`); resolveCode(127); });
  child.once("close", (code) => resolveCode(code ?? 1));
});
clearTimeout(timer);
await new Promise((done) => output.end(done));
const result = { name, started: started.toISOString(), finished: new Date().toISOString(), command, args, exitCode: timedOut ? 124 : code, timedOut, logPath };
await writeFile(resolve(logs, `${name}.json`), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
process.exitCode = result.exitCode;
