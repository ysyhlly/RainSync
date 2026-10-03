// Owned, local-only prerequisite runner. No HTTP, Server/Worker integration,
// persistent authorization or production capture budget is implemented here.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  STATIC_HLS_LIMITS,
  inspectStaticHlsStructure,
  inspectStaticHlsTimeline,
  staticMediaPlaylist,
} from "./static-hls-timeline.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const deny = (reason) => {
  throw new Error(`unsupported_static_hls_timeline:${reason}`);
};
export async function runBoundedOwned(
  command,
  args,
  {
    timeout = STATIC_HLS_LIMITS.decodeMilliseconds,
    outputBytes = STATIC_HLS_LIMITS.decoderOutputBytes,
    limited = true,
  } = {},
) {
  if (process.platform !== "linux") deny("owned_runner_linux_required");
  if (!(timeout > 0 && timeout <= STATIC_HLS_LIMITS.decodeMilliseconds))
    deny("decoder_deadline");
  const executable = limited ? "prlimit" : command;
  const argv = limited
    ? [
        `--as=${STATIC_HLS_LIMITS.decoderAddressSpaceBytes}`,
        "--cpu=35",
        "--",
        command,
        ...args,
      ]
    : args;
  const child = spawn(executable, argv, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" },
  });
  const began = performance.now(),
    stdout = [],
    stderr = [];
  let bytes = 0,
    errorBytes = 0,
    failure;
  const kill = (reason) => {
    failure ??= reason;
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") failure = "decoder_kill_failed";
      }
    }
  };
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > outputBytes) kill("decoder_output_bound");
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    errorBytes += chunk.length;
    if (errorBytes > 65536) kill("decoder_error_output_bound");
    else stderr.push(chunk);
  });
  const timer = setTimeout(() => kill("decoder_deadline"), timeout);
  const result = await new Promise((done) => {
    child.on("error", (error) => {
      failure ??= `decoder_spawn_${error.code ?? "failed"}`;
    });
    // close follows process exit AND closed stdio, so timeout never returns an
    // unresolved process that can continue consuming bytes or memory.
    child.on("close", (code, signal) => done({ code, signal }));
  });
  clearTimeout(timer);
  if (!Number.isInteger(child.pid) || child.pid <= 0)
    deny(`${failure ?? "decoder_spawn_failed"}:never_started`);
  let reaped = false;
  try {
    process.kill(-child.pid, 0);
  } catch (error) {
    reaped = error.code === "ESRCH";
  }
  if (!reaped) deny("decoder_group_not_reaped");
  const out = Buffer.concat(stdout),
    err = Buffer.concat(stderr);
  if (failure) deny(failure);
  if (result.code !== 0 || err.length !== 0) deny("decoder_failed");
  return {
    stdout: out,
    execution: {
      command,
      args,
      command_sha256: digest(JSON.stringify([executable, ...argv])),
      pid: child.pid,
      exit_code: result.code,
      signal: result.signal,
      elapsed_ms: performance.now() - began,
      stdout_bytes: bytes,
      stdout_sha256: digest(out),
      address_space_bytes: limited
        ? STATIC_HLS_LIMITS.decoderAddressSpaceBytes
        : null,
      process_group_reaped: reaped,
    },
  };
}
async function boundedRead(path, maximum) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum)
      deny("local_file_bound");
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(65536),
        { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximum || total > before.size) deny("local_file_changed");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (
      total !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      deny("local_file_changed");
    return Buffer.concat(chunks);
  } finally {
    await file.close();
  }
}
function localName(name) {
  if (name !== basename(name) || !/^[a-zA-Z0-9_-]+\.(m4s|mp4)$/.test(name))
    deny("owned_local_reference_required");
  return name;
}
export async function scanOwnedStaticHls(directory) {
  const began = performance.now(),
    manifestPath = resolve(directory, "index.m3u8");
  const manifestBytes = await boundedRead(
    manifestPath,
    STATIC_HLS_LIMITS.manifestBytes,
  );
  const manifest = new TextDecoder("utf-8", { fatal: true }).decode(
    manifestBytes,
  );
  const playlist = staticMediaPlaylist(manifest),
    names = [
      localName(playlist.map),
      ...playlist.segments.map(({ uri }) => localName(uri)),
    ];
  let total = manifestBytes.length;
  const files = [];
  for (const name of names) {
    const bytes = await boundedRead(
      resolve(directory, name),
      Math.min(
        files.length === 0
          ? STATIC_HLS_LIMITS.initBytes
          : STATIC_HLS_LIMITS.resourceBytes,
        STATIC_HLS_LIMITS.totalBytes - total,
      ),
    );
    total += bytes.length;
    if (total > STATIC_HLS_LIMITS.totalBytes) deny("total_bytes_bound");
    files.push(bytes);
  }
  const input = { manifest, init: files[0], segments: files.slice(1) };
  inspectStaticHlsStructure(input); // Structural limits before starting decode.
  const args = [
    "-v",
    "error",
    "-threads",
    "1",
    "-max_alloc",
    "134217728",
    "-protocol_whitelist",
    "file",
    "-err_detect",
    "explode",
    "-show_packets",
    "-show_frames",
    "-show_streams",
    "-show_entries",
    "stream=index,id,codec_name,codec_type,time_base,has_b_frames,width,height,sample_rate,channels:frame=stream_index,media_type,pts,best_effort_timestamp,duration,pkt_duration,nb_samples,width,height:packet=stream_index,pts,dts,duration:packet_side_data=side_data_type,skip_samples,discard_padding",
    "-of",
    "json",
    manifestPath,
  ];
  const decoded = await runBoundedOwned("ffprobe", args, {
    timeout: STATIC_HLS_LIMITS.decodeMilliseconds - (performance.now() - began),
  });
  const probe = JSON.parse(decoded.stdout);
  // Decoder opened local paths. Hash-check every file again before accepting
  // its observations, including the final unplayed segment and original text.
  const paths = [
      manifestPath,
      ...names.map((name) => resolve(directory, name)),
    ],
    original = [manifestBytes, ...files];
  for (let index = 0; index < paths.length; index++) {
    const current = await boundedRead(
      paths[index],
      STATIC_HLS_LIMITS.resourceBytes,
    );
    if (digest(current) !== digest(original[index])) deny("local_file_changed");
  }
  if (performance.now() - began > STATIC_HLS_LIMITS.decodeMilliseconds)
    deny("capture_deadline");
  const proof = inspectStaticHlsTimeline({ ...input, probe });
  if (performance.now() - began > STATIC_HLS_LIMITS.decodeMilliseconds)
    deny("capture_deadline");
  return {
    proof,
    input,
    probe,
    execution: decoded.execution,
    actual_bytes: total,
    elapsed_ms: performance.now() - began,
  };
}
