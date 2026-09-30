import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const definitions = {
  jellyfin: {
    image:
      "jellyfin/jellyfin@sha256:59417f441213e236a9f907d4e71a13472042409d85f9e9310dbdd87ee33d7bd4",
    version: "10.11.0",
    prefix: "",
  },
  emby: {
    image:
      "emby/embyserver@sha256:3aafff933d3f28d23ed0bc201022abe71c0aa80deb17177566c726b9bbc686c6",
    version: "4.10.0.40",
    prefix: "/emby",
  },
};
const ffmpegRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
  ".runtime/tooling/windows-ffmpeg/ffmpeg-9.0.2-1f9837cfbc4b44fab9db3ad46b57f1b6",
);
const defaultBin = resolve(
  ffmpegRoot,
  "unpacked/ffmpeg-9.0.2-essentials_build/bin",
);
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const delay = (ms, signal) =>
  new Promise((done, reject) => {
    signal?.throwIfAborted();
    const stop = () => {
      clearTimeout(timer);
      reject(new Error("Upstream fixture interrupted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      done();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });

/**
 * An owned, disposable upstream. Credentials stay in this closure; metadata,
 * HTTP clients and addRainSyncSource are available only until the callback ends.
 * This helper proves setup, not actual player or encoder lifecycle correctness.
 * Checkpoint: the previous 20s/admin setup was exercised on both pinned products.
 * Optional 90s/frame-clock/nonadmin/revokeClient extensions are syntax-checked
 * only until the real fixed-version matrix is explicitly executed.
 */
export async function isolatedUpstreamReal(kind, run, options = {}) {
  const definition = definitions[kind];
  assert.ok(definition, "Supported fixture kind: jellyfin or emby");
  assert.equal(typeof run, "function");
  const durationSeconds = options.durationSeconds ?? 20;
  assert.ok(
    Number.isInteger(durationSeconds) &&
      durationSeconds >= 20 &&
      durationSeconds <= 120,
    "Owned fixture duration must be an integer between 20 and 120 seconds",
  );
  const id = randomUUID();
  const root = resolve(options.artifactRoot ?? ".runtime/upstream-real", id);
  const container = `rainsync-upstream-${kind}-${id}`;
  const network = `rainsync-upstream-net-${id}`;
  const reportPath = resolve(root, "report.json");
  const activityPath = resolve(
    options.activityPath ?? resolve(root, "activity.jsonl"),
  );
  const bin = resolve(options.ffmpegBin ?? defaultBin);
  const control = new AbortController();
  const interrupt = () => control.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const secrets = new Set();
  const report = {
    result: "running",
    scope: "Real upstream setup only; no actual playback compatibility claim",
    id,
    kind,
    root,
    image: definition.image,
    limits: { cpus: 1, memory_bytes: 1610612736, pids: 256 },
    started_at: new Date().toISOString(),
    source_sha256: await digest(new URL(import.meta.url)),
    checks: [],
    failures: [],
    cleanup: { container: false, network: false, volumes: [] },
  };
  await mkdir(root, { recursive: true });
  await mkdir(dirname(activityPath), { recursive: true });
  const save = () =>
    writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  const activity = async (event, argv, extra = {}) =>
    appendFile(
      activityPath,
      JSON.stringify({
        event,
        utc: new Date().toISOString(),
        kind: "upstream_real_setup",
        fixture_id: id,
        argv,
        jobs: null,
        concurrent_runs: options.concurrentRuns ?? null,
        ...extra,
      }) + "\n",
    );
  const redact = (value) => {
    let text = String(value);
    for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
    return text;
  };
  async function command(binary, args, { timeout = 30000, signal } = {}) {
    await activity("start", [binary, ...args]);
    try {
      const result = await execute(binary, args, {
        windowsHide: true,
        timeout,
        signal,
        maxBuffer: 4 * 1024 * 1024,
      });
      await activity("end", [binary, ...args], { exitcode: 0 });
      return result.stdout.trim();
    } catch (error) {
      const failure = {
        argv: [binary, ...args],
        exit_code: typeof error.code === "number" ? error.code : null,
        stdout: redact(error.stdout ?? ""),
        stderr: redact(error.stderr ?? ""),
      };
      (report.command_failures ??= []).push(failure);
      await activity("end", [binary, ...args], {
        exitcode: typeof error.code === "number" ? error.code : null,
        failed: true,
      });
      throw new Error(
        `${binary} fixture command failed (${error.code ?? "unknown"}); inspect owned evidence`,
      );
    }
  }
  const docker = (...args) => command("docker", args);
  const inspect = async (type, name, format) => {
    assert.match(name, /^[A-Za-z0-9_.-]+$/);
    const names = await docker(
      type,
      "ls",
      ...(type === "container" ? ["-a"] : []),
      "--filter",
      `name=^${type === "container" ? "/" : ""}${name}$`,
      "--format",
      type === "container" ? "{{.Names}}" : "{{.Name}}",
    );
    if (!names) return null;
    assert.equal(names, name, "Only the owned Docker object matches");
    return docker(type, "inspect", name, "--format", format);
  };
  let containerId;
  let networkId;
  let volumeNames = [];
  let callbackResult;
  let originalError;
  let open = true;
  const checkOpen = () => {
    assert.ok(open, "Upstream fixture callback has ended");
    control.signal.throwIfAborted();
  };
  try {
    await save();
    const image = JSON.parse(
      await docker(
        "image",
        "inspect",
        definition.image,
        "--format",
        "{{json .}}",
      ),
    );
    // The immutable registry manifest digest and the local image configuration
    // ID identify different artifacts. Check the manifest through RepoDigests.
    assert.ok(image.RepoDigests?.includes(definition.image));
    assert.match(image.Id, /^sha256:[0-9a-f]{64}$/);
    report.image_id = image.Id;
    report.repo_digests = image.RepoDigests;
    if (options.ffmpegBin !== undefined)
      assert.ok(
        isAbsolute(options.ffmpegBin),
        "Use an explicit absolute local toolchain directory",
      );
    const original =
      options.ffmpegBin === undefined
        ? JSON.parse(
            await readFile(
              resolve(ffmpegRoot, "native-validation-report.json"),
              "utf8",
            ),
          )
        : null;
    report.ffmpeg = [];
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const path = resolve(
        bin,
        `${tool}${process.platform === "win32" ? ".exe" : ""}`,
      );
      const sha256 = await digest(path);
      if (original)
        assert.ok(JSON.stringify(original).toLowerCase().includes(sha256));
      const version = (await command(path, ["-version"])).split(/\r?\n/)[0];
      assert.ok(version.startsWith(`${tool} version `));
      if (original) assert.ok(version.includes("9.0.2"));
      report.ffmpeg.push({ tool, path, sha256, version });
    }
    if (original) report.archive_sha256 = original.download.expected_sha256;
    report.toolchain_provenance = original
      ? "verified fixed Windows archive"
      : "explicit existing local executables; version and SHA-256 recorded; no archive claim";
    const media = resolve(root, "media");
    const config = resolve(root, "config");
    const cache = resolve(root, "cache");
    for (const path of [media, config, cache])
      await mkdir(path, { recursive: true });
    const clock = (seconds) =>
      `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")},000`;
    const cues = [];
    for (let start = 1; start + 7 < durationSeconds; start += 10)
      cues.push(
        `${cues.length + 1}\n${clock(start)} --> ${clock(start + 7)}\nRainSync isolated subtitle ${start}s\n`,
      );
    const srt = cues.join("\n");
    await writeFile(resolve(media, "rainsync-h264.en.srt"), srt);
    const embeddedSubtitle = resolve(root, "embedded.srt");
    await writeFile(embeddedSubtitle, srt);
    const common = [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-filter_threads",
      "1",
      "-filter_complex_threads",
      "1",
    ];
    // Loss-tolerant visual time code in the source itself: sixteen little-endian
    // cells encode the original 10fps frame index, independently of room state,
    // request parameters or the downstream player's reported currentTime.
    const frameClock = ["drawbox=x=0:y=0:w=128:h=12:color=black:t=fill"];
    for (let bit = 0; bit < 16; bit++)
      frameClock.push(
        `drawbox=x=${bit * 8}:y=0:w=8:h=12:color=white:t=fill:enable='mod(floor(t*10/${2 ** bit}),2)'`,
      );
    report.frame_clock = {
      fps: 10,
      bits: 16,
      bit_order: "little_endian",
      x: 0,
      y: 0,
      cell_width: 8,
      cell_height: 12,
    };
    const h264 = resolve(media, "rainsync-h264.mp4");
    const hevc = resolve(media, "rainsync-hevc.mkv");
    const ffmpeg = report.ffmpeg.find((value) => value.tool === "ffmpeg").path;
    const ffprobe = report.ffmpeg.find(
      (value) => value.tool === "ffprobe",
    ).path;
    await command(
      ffmpeg,
      [
        ...common,
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=10",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t",
        String(durationSeconds),
        "-vf",
        frameClock.join(","),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "libx264",
        "-threads:v",
        "2",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-threads:a",
        "2",
        "-b:a",
        "64k",
        "-movflags",
        "+faststart",
        h264,
      ],
      { timeout: 60000, signal: control.signal },
    );
    await command(
      ffmpeg,
      [
        ...common,
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=10",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:sample_rate=48000",
        "-i",
        embeddedSubtitle,
        "-t",
        String(durationSeconds),
        "-vf",
        frameClock.join(","),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-map",
        "2:a:0",
        "-map",
        "3:s:0",
        "-c:v",
        "libx265",
        "-threads:v",
        "2",
        "-preset",
        "ultrafast",
        "-x265-params",
        "pools=1:frame-threads=1:wpp=0:log-level=error",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-threads:a",
        "2",
        "-b:a",
        "64k",
        "-c:s",
        "srt",
        "-metadata:s:a:0",
        "language=eng",
        "-metadata:s:a:1",
        "language=jpn",
        "-metadata:s:s:0",
        "language=eng",
        "-disposition:a:0",
        "default",
        "-disposition:a:1",
        "0",
        hevc,
      ],
      { timeout: 60000, signal: control.signal },
    );
    report.samples = [];
    for (const [path, codec, audios, subtitles] of [
      [h264, "h264", 1, 0],
      [hevc, "hevc", 2, 1],
    ]) {
      const info = JSON.parse(
        await command(ffprobe, [
          "-v",
          "error",
          "-show_format",
          "-show_streams",
          "-of",
          "json",
          path,
        ]),
      );
      assert.equal(
        info.streams.find((stream) => stream.codec_type === "video").codec_name,
        codec,
      );
      assert.equal(
        info.streams.filter((stream) => stream.codec_type === "audio").length,
        audios,
      );
      assert.equal(
        info.streams.filter((stream) => stream.codec_type === "subtitle")
          .length,
        subtitles,
      );
      assert.ok(
        Number(info.format.duration) >= durationSeconds - 0.1 &&
          Number(info.format.duration) <= durationSeconds + 1,
      );
      report.samples.push({
        path,
        sha256: await digest(path),
        codec,
        audio_streams: audios,
        embedded_subtitles: subtitles,
        duration_seconds: Number(info.format.duration),
      });
    }
    report.subtitle_sha256 = await digest(
      resolve(media, "rainsync-h264.en.srt"),
    );
    // A restrictive host umask must not hide these owned synthetic samples from
    // Emby's non-root container user. Never widen the credential/config paths.
    await chmod(media, 0o755);
    for (const path of [h264, hevc, resolve(media, "rainsync-h264.en.srt")])
      await chmod(path, 0o644);
    networkId = await docker(
      "network",
      "create",
      "--label",
      `rainsync.fixture=${id}`,
      network,
    );
    containerId = await docker(
      "run",
      "--detach",
      "--name",
      container,
      "--label",
      `rainsync.fixture=${id}`,
      "--network",
      network,
      "--cpus",
      "1",
      "--memory",
      "1536m",
      "--memory-swap",
      "1536m",
      "--pids-limit",
      "256",
      "--publish",
      "127.0.0.1::8096",
      "--mount",
      `type=bind,source=${config},target=/config`,
      "--mount",
      `type=bind,source=${cache},target=/cache`,
      "--mount",
      `type=bind,source=${media},target=/media,readonly`,
      definition.image,
    );
    const mounts = JSON.parse(
      await docker(
        "container",
        "inspect",
        container,
        "--format",
        "{{json .Mounts}}",
      ),
    );
    volumeNames = mounts
      .filter((mount) => mount.Type === "volume")
      .map((mount) => mount.Name);
    const published = await docker("port", container, "8096/tcp");
    assert.match(published, /^127\.0\.0\.1:\d+$/);
    const port = Number(published.split(":")[1]);
    const origin = `http://127.0.0.1:${port}`;
    const base = origin + definition.prefix;
    report.container = {
      name: container,
      id: containerId,
      network,
      network_id: networkId,
      port,
      origin,
    };
    const host = JSON.parse(
      await docker(
        "container",
        "inspect",
        container,
        "--format",
        "{{json .HostConfig}}",
      ),
    );
    assert.equal(host.NanoCpus, 1000000000);
    assert.equal(host.Memory, report.limits.memory_bytes);
    assert.equal(host.PidsLimit, 256);
    const username = `fixture-${id}`;
    const password = randomBytes(24).toString("hex");
    secrets.add(username);
    secrets.add(password);
    function makeClient(
      deviceId = `fixture-${randomUUID()}`,
      token = "",
      userId = null,
    ) {
      assert.match(deviceId, /^[a-zA-Z0-9-]{1,128}$/);
      const headers = () => ({
        "Content-Type": "application/json",
        Authorization: `MediaBrowser Client="RainSync Verification", Device="Owned Fixture", DeviceId="${deviceId}", Version="0.1.0"${token ? `, Token="${token}"` : ""}`,
      });
      const raw = async (
        path,
        { method = "GET", body, timeout = 10000 } = {},
      ) => {
        checkOpen();
        assert.ok(path.startsWith("/") && !path.startsWith("//"));
        try {
          return await fetch(base + path, {
            method,
            signal: AbortSignal.any([
              control.signal,
              AbortSignal.timeout(timeout),
            ]),
            headers: headers(),
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: "error",
          });
        } catch {
          throw new Error(`Upstream ${method} ${path.split("?")[0]} failed`);
        }
      };
      const api = async (path, method = "GET", body, expected = [200, 204]) => {
        const response = await raw(path, { method, body });
        assert.ok(
          expected.includes(response.status),
          `Upstream ${method} ${path.split("?")[0]} status=${response.status}`,
        );
        const text = await response.text();
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(
            `Upstream ${method} ${path.split("?")[0]} invalid JSON`,
          );
        }
      };
      return { deviceId, userId, raw, api };
    }
    const anonymous = makeClient();
    let info;
    const publicReadyStarted = Date.now();
    const publicReadyDeadline = publicReadyStarted + 60000;
    while (Date.now() < publicReadyDeadline) {
      try {
        const response = await anonymous.raw("/System/Info/Public", {
          timeout: Math.max(
            1,
            Math.min(2000, publicReadyDeadline - Date.now()),
          ),
        });
        if (response.status === 200) {
          const candidate = await response.json();
          if (typeof candidate?.Version === "string" && candidate.Version) {
            info = candidate;
            break;
          }
        } else await response.arrayBuffer();
      } catch {
        // Startup may return 200 with a loading message before public info.
      }
      await delay(500, control.signal);
    }
    assert.ok(info, "Upstream public information became available");
    assert.equal(info.Version, definition.version);
    report.public_ready_wait_seconds = (Date.now() - publicReadyStarted) / 1000;
    report.actual_version = info.Version;
    report.server_id = info.Id;
    report.checks.push("actual immutable image and public version");
    await anonymous.api("/Startup/Configuration", "POST", {
      ServerName: `RainSync owned ${id}`,
      UICulture: "en-US",
      MetadataCountryCode: "US",
      PreferredMetadataLanguage: "en",
    });
    if (kind === "jellyfin") {
      // v10.11 initializes its first user in this GET; POST assumes it exists.
      await anonymous.api("/Startup/User");
    }
    await anonymous.api("/Startup/User", "POST", {
      Name: username,
      Password: password,
    });
    await anonymous.api("/Startup/RemoteAccess", "POST", {
      EnableRemoteAccess: true,
      EnableAutomaticPortMapping: false,
    });
    await anonymous.api("/Startup/Complete", "POST");
    const clients = new Map();
    let admin;
    async function client(options) {
      checkOpen();
      const deviceId =
        typeof options === "string" ? options : options?.deviceId;
      const restricted =
        typeof options === "object" && options?.restricted === true;
      let accountName = username;
      let accountPassword = password;
      if (restricted) {
        assert.ok(
          admin,
          "The fixture admin must exist before creating an owned viewer",
        );
        accountName = `viewer-${randomUUID()}`;
        accountPassword = randomBytes(24).toString("hex");
        secrets.add(accountName);
        secrets.add(accountPassword);
        const created = await admin.api("/Users/New", "POST", {
          Name: accountName,
        });
        assert.ok(created?.Id, "The upstream created a real owned viewer");
        const userPath = `/Users/${encodeURIComponent(created.Id)}`;
        await admin.api(
          kind === "jellyfin"
            ? `/Users/Password?userId=${encodeURIComponent(created.Id)}`
            : `${userPath}/Password`,
          "POST",
          { CurrentPw: "", NewPw: accountPassword, ResetPassword: false },
        );
        const current = await admin.api(userPath);
        await admin.api(`${userPath}/Policy`, "POST", {
          ...current.Policy,
          IsAdministrator: false,
          IsDisabled: false,
          EnableAllFolders: true,
          EnableAllDevices: true,
          EnableMediaPlayback: true,
          EnableAudioPlaybackTranscoding: true,
          EnableVideoPlaybackTranscoding: true,
          EnablePlaybackRemuxing: true,
          EnableRemoteAccess: true,
        });
        const checked = await admin.api(userPath);
        assert.equal(checked.Policy.IsAdministrator, false);
        assert.equal(checked.Policy.EnableMediaPlayback, true);
      }
      const unauthenticated = makeClient(deviceId);
      const auth = await unauthenticated.api(
        "/Users/AuthenticateByName",
        "POST",
        { Username: accountName, Pw: accountPassword },
      );
      assert.ok(auth.AccessToken && auth.User?.Id);
      secrets.add(auth.AccessToken);
      const authenticated = makeClient(
        unauthenticated.deviceId,
        auth.AccessToken,
        auth.User.Id,
      );
      clients.set(authenticated, {
        token: auth.AccessToken,
        userId: auth.User.Id,
        restricted,
      });
      return authenticated;
    }
    admin = await client();
    assert.equal((await admin.api("/System/Info")).Version, definition.version);
    const libraryName = `RainSync fixtures ${id}`;
    const libraries =
      kind === "emby"
        ? (await admin.api("/Library/VirtualFolders/Query")).Items
        : await admin.api("/Library/VirtualFolders");
    assert.ok(!libraries.some((library) => library.Name === libraryName));
    await admin.api(
      `/Library/VirtualFolders?name=${encodeURIComponent(libraryName)}&collectionType=homevideos&refreshLibrary=true`,
      "POST",
      {
        LibraryOptions: {
          PathInfos: [{ Path: "/media" }],
          EnableRealtimeMonitor: false,
          EnableInternetProviders: false,
          SaveLocalMetadata: false,
        },
      },
    );
    await admin.api("/Library/Refresh", "POST");
    const itemPath = (start = 0, limit = 10) =>
      `/Users/${admin.userId}/Items?Recursive=true&IncludeItemTypes=Video,Movie&Fields=MediaSources&SortBy=SortName&SortOrder=Ascending&StartIndex=${start}&Limit=${limit}&EnableTotalRecordCount=true`;
    let listing;
    for (let i = 0; i < 120; i++) {
      listing = await admin.api(itemPath());
      if (
        listing.TotalRecordCount === 2 &&
        listing.Items?.length === 2 &&
        listing.Items.every((item) => item.MediaSources?.length)
      )
        break;
      await delay(500, control.signal);
    }
    assert.equal(listing.TotalRecordCount, 2);
    assert.equal(listing.Items.length, 2);
    assert.ok(
      listing.Items.every((item) => item.MediaSources?.length),
      "Real metadata/probe completed",
    );
    const first = await admin.api(itemPath(0, 1));
    const second = await admin.api(itemPath(1, 1));
    const tail = await admin.api(itemPath(2, 1));
    report.pagination = [first, second, tail].map((page, start) => ({
      start_index: start,
      limit: 1,
      total_record_count: page.TotalRecordCount,
      item_ids: page.Items.map((item) => item.Id),
    }));
    await save();
    for (const page of [first, second]) assert.equal(page.TotalRecordCount, 2);
    // Fixed Emby 4.10 returns zero total for an empty beyond-end page;
    // its two nonempty pages must still report the complete library count.
    assert.equal(tail.TotalRecordCount, kind === "emby" ? 0 : 2);
    assert.equal(first.Items.length, 1);
    assert.equal(second.Items.length, 1);
    assert.equal(tail.Items.length, 0);
    assert.notEqual(first.Items[0].Id, second.Items[0].Id);
    assert.deepEqual(
      [first.Items[0].Id, second.Items[0].Id].sort(),
      listing.Items.map((item) => item.Id).sort(),
    );
    report.checks.push("two real items and complete Limit=1 pagination");
    const denied = await anonymous.raw(itemPath());
    assert.ok(
      [401, 403].includes(denied.status),
      "Unauthenticated library listing denied",
    );
    await denied.arrayBuffer();
    report.anonymous_status = denied.status;
    report.checks.push("authenticated metadata and unauthenticated denial");
    report.items = listing.Items.map((item) => ({
      id: item.Id,
      name: item.Name,
      video_codec: item.MediaSources[0].MediaStreams?.find(
        (stream) => stream.Type === "Video",
      )?.Codec,
    }));
    await save();
    callbackResult = await run({
      id,
      root,
      kind,
      base,
      origin,
      signal: control.signal,
      metadata: { ...report, failures: [], cleanup: undefined },
      admin,
      anonymous,
      client,
      revokeClient: async (upstreamClient) => {
        checkOpen();
        const scope = clients.get(upstreamClient);
        assert.ok(
          scope?.restricted,
          "Only this fixture's owned nonadmin viewers can be revoked",
        );
        const userPath = `/Users/${encodeURIComponent(scope.userId)}`;
        const current = await admin.api(userPath);
        await admin.api(`${userPath}/Policy`, "POST", {
          ...current.Policy,
          EnableMediaPlayback: false,
        });
        const checked = await admin.api(userPath);
        assert.equal(
          checked.Policy.EnableMediaPlayback,
          false,
          "Real upstream policy is revoked",
        );
        return { user_id: scope.userId, enable_media_playback: false };
      },
      items: listing.Items,
      addRainSyncSource: async (rainsyncClient, upstreamClient = admin) => {
        checkOpen();
        const scope = clients.get(upstreamClient);
        assert.ok(
          scope,
          "Only this fixture's authenticated clients can create sources",
        );
        return rainsyncClient.request("/sources", "POST", {
          name: `Owned ${kind} ${id}`,
          kind,
          config: { url: base, token: scope.token, user_id: scope.userId },
        });
      },
    });
    report.result = "passed";
  } catch (error) {
    originalError = error;
    report.result = "failed";
    report.failures.push(redact(error.stack ?? error));
  } finally {
    open = false;
    control.abort();
    const cleanup = async (name, action) => {
      try {
        await action();
      } catch (error) {
        report.result = "failed";
        report.failures.push(redact(`${name}: ${error.message}`));
      }
    };
    await cleanup("owned container", async () => {
      const currentId = await inspect("container", container, "{{.Id}}");
      if (currentId) {
        const owner = await docker(
          "container",
          "inspect",
          container,
          "--format",
          '{{index .Config.Labels "rainsync.fixture"}}',
        );
        assert.equal(owner, id);
        if (containerId) assert.equal(currentId, containerId);
        const mounts = JSON.parse(
          await docker(
            "container",
            "inspect",
            container,
            "--format",
            "{{json .Mounts}}",
          ),
        );
        volumeNames = [
          ...new Set([
            ...volumeNames,
            ...mounts
              .filter((mount) => mount.Type === "volume")
              .map((mount) => mount.Name),
          ]),
        ];
        const state = JSON.parse(
          await docker(
            "container",
            "inspect",
            container,
            "--format",
            "{{json .State}}",
          ),
        );
        report.final_container_state = {
          running: state.Running,
          oom_killed: state.OOMKilled,
          exit_code: state.ExitCode,
        };
        const logs = await command("docker", ["logs", container]).catch(
          () => "Logs unavailable",
        );
        await writeFile(resolve(root, "upstream.log"), redact(logs));
        await docker("rm", "-f", "-v", container);
      }
      assert.equal(await inspect("container", container, "{{.Id}}"), null);
      report.cleanup.container = true;
      for (const volume of volumeNames) {
        assert.match(volume, /^[A-Za-z0-9_.-]+$/);
        if (await inspect("volume", volume, "{{.Name}}"))
          await docker("volume", "rm", volume);
        assert.equal(await inspect("volume", volume, "{{.Name}}"), null);
        report.cleanup.volumes.push({ name: volume, absent: true });
      }
    });
    await cleanup("owned network", async () => {
      const currentId = await inspect("network", network, "{{.Id}}");
      if (currentId) {
        const owner = await docker(
          "network",
          "inspect",
          network,
          "--format",
          '{{index .Labels "rainsync.fixture"}}',
        );
        assert.equal(owner, id);
        if (networkId) assert.equal(currentId, networkId);
        await docker("network", "rm", network);
      }
      assert.equal(await inspect("network", network, "{{.Id}}"), null);
      report.cleanup.network = true;
    });
    await cleanup("source integrity", async () => {
      assert.equal(
        await digest(new URL(import.meta.url)),
        report.source_sha256,
      );
      report.source_unchanged = true;
      for (const tool of report.ffmpeg ?? [])
        assert.equal(
          await digest(tool.path),
          tool.sha256,
          "The recorded toolchain did not change during the fixture",
        );
      report.toolchain_unchanged = true;
    });
    if (report.final_container_state?.oom_killed) {
      report.result = "failed";
      report.failures.push("Owned upstream container was OOM killed");
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    report.finished_at = new Date().toISOString();
    await save();
  }
  if (report.result !== "passed") {
    throw new Error(`Owned ${kind} fixture failed; evidence ${reportPath}`, {
      cause: originalError
        ? new Error(redact(originalError.message))
        : undefined,
    });
  }
  return { reportPath, metadata: report, result: callbackResult };
}
