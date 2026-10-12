#!/usr/bin/python3
"""Test-only transparent argv/stdio wrapper; normal execution calls real /usr/bin tool."""
import hashlib, json, os, pathlib, signal, subprocess, sys, time, uuid
name = pathlib.Path(sys.argv[0]).name
if name not in ("ffmpeg", "ffprobe"):
    raise RuntimeError("unexpected_wrapper_name")
real = "/usr/bin/" + name
root = pathlib.Path(os.environ["RAINSYNC_FINISH_PROCESS_RECEIPTS"])
root.mkdir(parents=True, exist_ok=True)
invocation = str(uuid.uuid4())
record = {"invocation": invocation, "tool": name, "real_binary": real,
          "wrapper_pid": os.getpid(), "parent_pid": os.getppid(),
          "argv_sha256": hashlib.sha256(json.dumps(sys.argv[1:]).encode()).hexdigest(),
          "started_at_ns": str(time.time_ns()), "child_pid": None,
          "spawn_observed": False, "close_observed": False,
          "exit_code": None, "signal": None, "pid_absent": None,
          "received_signals": [], "spawn_error": False, "observer_error": False,
          "child_executable": None, "child_executable_sha256": None,
          "child_parent_pid": None, "child_start_ticks": None,
          "observer_error_phase": None, "observer_error_type": None,
          "observer_error_errno": None}
# Only UUIDs extracted from owned output paths are saved, never complete argv.
record["output_bindings"] = []
published = pathlib.Path(os.environ["RAINSYNC_COMPUTE_OUTPUT_ROOT"])
for value in sys.argv[1:]:
    try:
        parts = pathlib.Path(value).relative_to(published).parts
        if len(parts) == 3:
            job, generation = str(uuid.UUID(parts[0])), str(uuid.UUID(parts[1]))
            record["output_bindings"].append({"job_id": job, "output_generation": generation})
    except (ValueError, TypeError):
        pass
path = root / (invocation + ".json")
def save():
    temporary = path.with_suffix(".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(record, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
child = None
pending_signals = []
def received(signum, frame):
    record["received_signals"].append(signum)
    if child is None:
        pending_signals.append(signum)
    elif child.poll() is None:
        child.send_signal(signum)
for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(sig, received)
save()
phase = "spawn"
try:
    # Inherit the actual stdin/stdout/stderr: byte output remains unchanged.
    # Keep the same process group so existing Rust tree ownership also covers child.
    child = subprocess.Popen([real, *sys.argv[1:]], stdin=sys.stdin,
                             stdout=sys.stdout, stderr=sys.stderr)
    record.update(child_pid=child.pid, spawn_observed=True)
    proc = pathlib.Path("/proc") / str(child.pid)
    # Pin the actual child's executable before slow receipt fsync. This reduces
    # the exit race; failure to open remains a failed observation, never a guess.
    phase = "open_child_executable"
    with open(proc / "exe", "rb") as executable:
        phase = "read_child_stat"
        fields = (proc / "stat").read_text().rsplit(") ", 1)[1].split()
        record["child_parent_pid"] = int(fields[1])
        record["child_start_ticks"] = fields[19]
        phase = "read_child_executable_link"
        record["child_executable"] = os.readlink("/proc/self/fd/" + str(executable.fileno()))
        phase = "hash_child_executable"
        record["child_executable_sha256"] = hashlib.file_digest(executable, "sha256").hexdigest()
    phase = "validate_child_identity"
    assert record["child_parent_pid"] == os.getpid(), "real_child_parent_mismatch"
    assert record["child_executable"] == os.path.realpath(real), "real_child_executable_mismatch"
    phase = "save_child_identity"
    save()
    for sig in pending_signals:
        if child.poll() is None:
            child.send_signal(sig)
    phase = "wait_child"
    status = child.wait()  # waitpid observes and reaps this exact real child.
    record.update(close_observed=True, closed_at_ns=str(time.time_ns()),
                  exit_code=status if status >= 0 else None,
                  signal=-status if status < 0 else None)
    phase = "verify_child_absence"
    try:
        os.kill(child.pid, 0)
        record["pid_absent"] = False
    except ProcessLookupError:
        record["pid_absent"] = True
    phase = "save_child_close"
    save()
except BaseException as error:
    record["spawn_error"] = child is None
    record["observer_error"] = True
    record["observer_error_phase"] = phase
    record["observer_error_type"] = type(error).__name__
    record["observer_error_errno"] = error.errno if isinstance(error, OSError) else None
    # Losing /proc evidence is a failed observation; still reap the real child.
    if child is not None:
        if child.poll() is None:
            child.send_signal(signal.SIGTERM)
        cleanup_status = child.wait()
        record.update(close_observed=True, closed_at_ns=str(time.time_ns()),
                      exit_code=cleanup_status if cleanup_status >= 0 else None,
                      signal=-cleanup_status if cleanup_status < 0 else None)
        try:
            os.kill(child.pid, 0)
            record["pid_absent"] = False
        except ProcessLookupError:
            record["pid_absent"] = True
    save()
    raise
# Exit using the actual tool outcome. Signal exits remain signal exits.
if status < 0:
    sig = -status
    signal.signal(sig, signal.SIG_DFL)
    os.kill(os.getpid(), sig)
    raise RuntimeError("signal_exit_not_delivered")
sys.exit(status)
