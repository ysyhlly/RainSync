// Shared controller runtime. Adapters are explicit trusted local modules, never
// shell strings downloaded from a report. No network policy is changed here.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import {
  digestJson,
  verifyCandidate,
  verifySamples,
} from "./release-evidence.mjs";

export const systemClock = {
  now: () => performance.now(),
  sleep: (ms, signal) => sleep(Math.max(0, ms), undefined, { signal }),
};
const normalizedField = (key) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase();
const secretKey =
  /(?:password|passwd|cookie|authorization|csrf|credential|secret|(?:^|_)token|api_?key|signed_?url|(?:^|_)(?:source_)?encryption_key(?:_|$)|(?:^|_)source_key(?:_|$)|(?:^|_)(?:database|db|postgres(?:ql)?)_(?:url|uri|dsn)(?:_|$)|(?:^|_)dsn(?:_|$)|(?:^|_)connection_string(?:_|$))/i;
const secretAssignment =
  /\b(?:password|passwd|token|secret|cookie|csrf|api[_-]?key|(?:source[_-]?)?encryption[_-]?key|source[_-]?key|(?:database|db|postgres(?:ql)?)[_-]?(?:url|uri|dsn)|dsn|connection[_-]?string)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const isSafeDigest = (key, value) =>
  /(?:^|_)sha256$/.test(key) &&
  typeof value === "string" &&
  /^[a-f0-9]{64}$/i.test(value);
export function redactEvidence(value, secrets = []) {
  const cleanString = (text) => {
    for (const secret of secrets) {
      assert.ok(
        typeof secret === "string" && secret.length >= 4,
        "redaction value too short",
      );
      text = text.split(secret).join("[REDACTED]");
    }
    return text
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[REDACTED-AUTH]")
      .replace(secretAssignment, "[REDACTED-SECRET]")
      .replace(/(?:https?|wss?|postgres(?:ql)?):\/\/[^\s<>"']+/gi, (raw) => {
        try {
          const url = new URL(raw);
          url.username = "";
          url.password = "";
          url.search = "";
          url.hash = "";
          return url.toString();
        } catch {
          return "[REDACTED-URL]";
        }
      });
  };
  if (typeof value === "string") return cleanString(value);
  if (value instanceof Error)
    return {
      name: value.name,
      message: cleanString(value.message),
      stack: cleanString(value.stack ?? ""),
    };
  if (Array.isArray(value))
    return value.map((item) => redactEvidence(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretKey.test(normalizedField(key)) &&
        !isSafeDigest(normalizedField(key), item)
          ? "[REDACTED]"
          : redactEvidence(item, secrets),
      ]),
    );
  if (typeof value === "number")
    assert.ok(Number.isFinite(value), "nonfinite evidence");
  return value;
}

export async function createJournal(directory, { secrets = [] } = {}) {
  directory = resolve(directory);
  await mkdir(directory, { mode: 0o700 }); // exclusive: never overwrite a prior run
  let sequence = 0,
    chain = "0".repeat(64),
    pending = Promise.resolve();
  const artifacts = [];
  const write = async (name, value) => {
    assert.match(
      name,
      /^[a-z][a-z0-9_-]*\.json$/,
      "artifact names must be local JSON basenames",
    );
    const bytes =
      JSON.stringify(redactEvidence(value, secrets), null, 2) + "\n";
    assert.ok(
      Buffer.byteLength(bytes) <= 16 * 1024 * 1024,
      "artifact exceeds 16 MiB; use journal records",
    );
    await writeFile(resolve(directory, name), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    artifacts.push({
      path: name,
      bytes: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  };
  return {
    directory,
    write,
    record(kind, value) {
      pending = pending.then(async () => {
        const body = redactEvidence(
          { sequence: ++sequence, previous_sha256: chain, kind, value },
          secrets,
        );
        chain = digestJson(body);
        const line = JSON.stringify({ ...body, sha256: chain }) + "\n";
        assert.ok(
          Buffer.byteLength(line) <= 1024 * 1024,
          "journal record exceeds 1 MiB",
        );
        await appendFile(resolve(directory, "observations.jsonl"), line, {
          mode: 0o600,
        });
      });
      return pending;
    },
    async finish(report) {
      await pending;
      await write(
        report.result === "passed" || report.result === "dry-run"
          ? "report.json"
          : "failed-report.json",
        report,
      );
      await write("artifacts.json", {
        schema_version: 1,
        files: [...artifacts],
        journal: {
          path: "observations.jsonl",
          records: sequence,
          final_sha256: chain,
        },
        redaction:
          "structured secret fields, authorization strings, URL credentials/query/fragment and explicit secret values; review before sharing",
      });
    },
  };
}

export async function boundedCall(
  adapter,
  method,
  input,
  { signal, timeout_ms = 30000 } = {},
) {
  signal?.throwIfAborted();
  assert.equal(
    typeof adapter[method],
    "function",
    `adapter.${method} is required`,
  );
  const local = new AbortController();
  const abort = () => local.abort(signal.reason ?? Error("run interrupted"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => local.abort(Error(`adapter.${method} timed out`)),
    timeout_ms,
  );
  let rejectAbort;
  const cancelled = new Promise((_, reject) => {
    rejectAbort = () => reject(local.signal.reason);
    if (local.signal.aborted) rejectAbort();
    else local.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        local.signal.throwIfAborted();
        return adapter[method](input, { signal: local.signal });
      }),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    local.signal.removeEventListener("abort", rejectAbort);
    signal?.removeEventListener("abort", abort);
  }
}

export async function loadAdapter(path, config) {
  const adapter_source_sha256 = createHash("sha256")
    .update(await readFile(resolve(path)))
    .digest("hex");
  const module = await import(pathToFileURL(resolve(path)).href);
  assert.equal(
    typeof module.createAdapter,
    "function",
    "adapter must export createAdapter(config)",
  );
  const adapter = await module.createAdapter(config);
  assert.equal(adapter.schema_version, 1, "unsupported adapter contract");
  assert.ok(
    ["real", "synthetic"].includes(adapter.mode),
    "adapter must declare real or synthetic observations",
  );
  assert.ok(
    typeof adapter.id === "string" && adapter.id,
    "adapter identity required",
  );
  adapter.source_sha256 = adapter_source_sha256;
  return adapter;
}

export async function bindRun({
  candidate_path,
  samples_path,
  environment,
  command,
  adapter,
  scope,
}) {
  assert.ok(
    ["formal", "smoke", "synthetic"].includes(scope),
    "invalid run scope",
  );
  assert.ok(
    environment?.schema_version === 1 &&
      environment.hardware &&
      environment.tools,
    "captured OS/browser/hardware environment required",
  );
  assert.ok(
    Array.isArray(command) && command.length,
    "execution command required",
  );
  assert.ok(
    scope !== "formal" || adapter.mode === "real",
    "synthetic adapter cannot produce formal evidence",
  );
  const { candidate, source } = await verifyCandidate(candidate_path);
  if (scope === "formal")
    assert.equal(
      fileURLToPath(import.meta.url),
      resolve(source, "scripts/acceptance-runtime.mjs"),
      "formal runner must execute the frozen candidate source",
    );
  const samples = await verifySamples(samples_path);
  assert.equal(
    candidate.status,
    "built",
    "runner requires a built frozen candidate",
  );
  assert.match(
    candidate.production_manifest_sha256 ?? "",
    /^[a-f0-9]{64}$/,
    "production manifest required",
  );
  if (scope === "formal") {
    assert.match(
      candidate.git?.head ?? "",
      /^[a-f0-9]{40,64}$/,
      "candidate commit required",
    );
    for (const field of ["working_diff_sha256", "staged_diff_sha256"])
      assert.match(
        candidate.git?.[field] ?? "",
        /^[a-f0-9]{64}$/,
        "candidate uncommitted diff digests required",
      );
    assert.match(
      adapter.source_sha256 ?? "",
      /^[a-f0-9]{64}$/,
      "adapter implementation digest required",
    );
  }
  const baseline = digestJson(candidate);
  const check = async () => {
    const verified = await verifyCandidate(candidate_path);
    assert.equal(
      digestJson(verified.candidate),
      baseline,
      "candidate descriptor changed during run",
    );
    assert.equal(
      digestJson(await verifySamples(samples_path)),
      digestJson(samples),
      "sample inventory changed during run",
    );
    return true;
  };
  const binding = {
    source_sha256: candidate.source_manifest_sha256,
    production_sha256: candidate.production_manifest_sha256,
    image_id: candidate.image.id,
    binary_sha256: candidate.image.binary_sha256,
    environment_sha256: digestJson(environment),
    samples_sha256: digestJson(samples),
  };
  return {
    check,
    binding,
    metadata: {
      schema_version: 1,
      run_id: randomUUID(),
      started_at: new Date().toISOString(),
      scope,
      command,
      environment,
      adapter: {
        id: adapter.id,
        mode: adapter.mode,
        source_sha256: adapter.source_sha256 ?? null,
      },
      git: candidate.git ?? null,
      lockfiles: candidate.source_manifest.filter((entry) =>
        ["Cargo.lock", "package-lock.json"].includes(entry.path),
      ),
      samples: samples.files.map(({ path, bytes, sha256, authorization }) => ({
        path,
        bytes,
        sha256,
        authorization,
      })),
      binding,
    },
  };
}

export function assertArtifactIdentity(observed, binding) {
  assert.equal(
    observed?.image_id,
    binding.image_id,
    "running image changed or unobserved",
  );
  assert.deepEqual(
    observed?.binary_sha256,
    binding.binary_sha256,
    "running binary identity changed or unobserved",
  );
  assert.equal(
    observed?.source_sha256,
    binding.source_sha256,
    "running source identity changed or unobserved",
  );
  assert.ok(
    typeof observed.observation_id === "string" && observed.observation_id,
    "artifact observation provenance required",
  );
}

export function installInterrupts() {
  const controller = new AbortController();
  const handlers = ["SIGINT", "SIGTERM"].map((name) => {
    const handler = () => controller.abort(Error(`interrupted by ${name}`));
    process.on(name, handler);
    return [name, handler];
  });
  return {
    signal: controller.signal,
    remove: () =>
      handlers.forEach(([name, handler]) =>
        process.removeListener(name, handler),
      ),
  };
}

export async function readRunCLI(argv, kind) {
  const options = new Map();
  for (const argument of argv) {
    if (argument === "--dry-run") {
      assert.ok(!options.has("dry-run"));
      options.set("dry-run", true);
      continue;
    }
    const match = /^--(config|adapter|output)=(.+)$/.exec(argument);
    assert.ok(
      match && !options.has(match[1]),
      "use --config=<json> --adapter=<module> --output=<new-directory> [--dry-run]",
    );
    options.set(match[1], match[2]);
  }
  assert.ok(
    options.has("config") && options.has("output"),
    "config and new output directory required",
  );
  const config = JSON.parse(
    await readFile(resolve(options.get("config")), "utf8"),
  );
  assert.equal(config.kind, kind, "wrong runner config kind");
  config.command = [process.execPath, ...process.argv.slice(1)];
  const dry_run = options.get("dry-run") === true;
  assert.ok(
    dry_run || options.has("adapter"),
    "real execution requires an explicit trusted adapter module",
  );
  return {
    config,
    dry_run,
    output: resolve(options.get("output")),
    adapter_path: options.get("adapter"),
  };
}

// One CLI failure envelope even when adapter loading/preflight fails before the
// run journal exists. Never overwrite a pre-existing run directory.
export async function acceptanceCLI(
  kind,
  runner,
  argv = process.argv.slice(2),
) {
  const interrupts = installInterrupts();
  let options;
  try {
    options = await readRunCLI(argv, kind);
    const adapter = options.dry_run
      ? undefined
      : await loadAdapter(options.adapter_path, options.config);
    const report = await runner({
      ...options,
      adapter,
      signal: interrupts.signal,
    });
    console.log(`${kind} ${report.result}: ${options.output}`);
    if (!["passed", "dry-run"].includes(report.result)) process.exitCode = 1;
  } catch (error) {
    if (options) {
      try {
        const journal = await createJournal(options.output, {
          secrets: options.config.redaction_values ?? [],
        });
        await journal.record("preflight-failure", error);
        await journal.finish({
          schema_version: 1,
          result: "failed",
          scope: options.dry_run ? "dry-run" : options.config.scope,
          accepted: false,
          release_ready: false,
          command: options.config.command,
          failure: error,
          cleanup_confirmed: false,
          stage: "preflight",
        });
      } catch (recordingError) {
        if (recordingError.code !== "EEXIST")
          console.error(
            `Could not save preflight evidence: ${redactEvidence(recordingError).message}`,
          );
      }
    }
    console.error(
      redactEvidence(error, options?.config.redaction_values ?? []).message,
    );
    process.exitCode = 1;
  } finally {
    interrupts.remove();
  }
}
