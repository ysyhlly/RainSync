#!/usr/bin/env python3
"""Unexecuted, separately reviewed no-network Linux test-child probe.

Only the explicit future execution flag can start the fixed child. There is no
PG adapter and no caller command/PID/path/signal option. Import is inert.
"""
import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import secrets
import select
import signal
import subprocess
import sys
import threading
import time


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


owned = _load("owned_kernel_probe_owner", "owned-fixture-owner.py")
rpc = _load("owned_kernel_probe_rpc", "owned-fixture-rpc.py")
PHASES = ("natural", "stop", "deadline")
RUNTIME_PHASES = ("stop",)  # Natural/deadline runtime proposals are deferred.
CHILD_HARD_LIFETIME = 6.0
FIXED_CHILD_CODE = """import os,time
deadline=time.monotonic()+6.0
while time.monotonic()<deadline:
    time.sleep(min(0.02,max(0.0,deadline-time.monotonic())))
os._exit(0)
"""
CHILD_CODE_SHA256 = hashlib.sha256(FIXED_CHILD_CODE.encode()).hexdigest()
PROBE_ROOT = Path(__file__).resolve().parents[2] / ".owned-fixture-kernel-probes"
_RUNTIME_CAPABILITY = object()


class MonotonicClock:
    def now(self):
        return time.monotonic()


@dataclass(frozen=True)
class RetainedPin:
    fd: int


class ProbeStartupFailure(owned.ContractError):
    def __init__(self, backend):
        super().__init__("probe startup failed; original child/pin retained")
        self.backend = backend


class LinuxKernel:
    """Known original direct-child syscalls only; no process enumeration."""
    def __init__(self, capability=None):
        if capability is not _RUNTIME_CAPABILITY:
            raise owned.ContractError("kernel probe execution requires the reviewed runtime flag")
        self.owner_pid = os.getpid()
        self.pending_pin_fd = None
        self.known_pin = None
        self.known_pin_closed = False
        self.pin_close_unknown = False
        self.open_files = {}
        self.file_close_unknown = False

    @contextmanager
    def _owned_file(self, path, mode="rb"):
        handle = open(path, mode)
        self.open_files[id(handle)] = handle
        try:
            yield handle
        finally:
            try:
                handle.close()
            except BaseException:
                self.file_close_unknown = True
                raise
            else:
                del self.open_files[id(handle)]

    def prepare_interpreter(self, deadline, clock):
        # File hashing precedes Popen: blocked setup cannot strand a new child.
        if not all((hasattr(os, "pidfd_open"), hasattr(signal, "pidfd_send_signal"),
                    hasattr(select, "poll"), hasattr(os, "WNOHANG"))):
            raise owned.ContractError("required Linux child/pidfd APIs unavailable before spawn")
        executable = str(Path(sys.executable).resolve(strict=True))
        digest = hashlib.sha256()
        with self._owned_file(executable) as source:
            before = os.fstat(source.fileno())
            total = 0
            while True:
                if clock.now() >= deadline:
                    raise owned.ContractError("interpreter setup observation deadline")
                block = source.read(65536)
                if not block:
                    break
                total += len(block)
                if total > 64 * 1024 * 1024:
                    raise owned.ContractError("bounded interpreter image exceeded")
                digest.update(block)
            after = os.fstat(source.fileno())
        version = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        if version(before) != version(after) or clock.now() >= deadline:
            raise owned.ContractError("interpreter changed during setup")
        self.interpreter = executable
        self.interpreter_digest = digest.hexdigest()
        self.interpreter_version = version(after)

    def spawn_fixed(self, phase):
        if phase not in PHASES:
            raise owned.ContractError("unknown fixed child phase")
        # Retain even a partially initialized Popen when construction raises.
        self.pending_child = subprocess.Popen.__new__(subprocess.Popen)
        subprocess.Popen.__init__(self.pending_child,
                                 [self.interpreter, "-I", "-S", "-u", "-c", FIXED_CHILD_CODE],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, close_fds=True,
                                 env={"LC_ALL": "C", "PATH": "/usr/bin:/bin"})
        return self.pending_child

    def open_pin(self, child):
        self.pending_pin_fd = os.pidfd_open(child.pid, 0)
        self.known_pin = RetainedPin(self.pending_pin_fd)
        self.pending_pin_fd = None
        return self.known_pin

    def readiness(self, pin):
        poller = select.poll()
        poller.register(pin.fd, select.POLLIN)
        events = poller.poll(0)
        if not events:
            return "alive"
        if len(events) != 1 or events[0][0] != pin.fd or events[0][1] & select.POLLNVAL:
            return "invalid"
        return "exited" if events[0][1] & select.POLLIN else "invalid"

    def _stat(self, child):
        with self._owned_file(f"/proc/{child.pid}/stat") as source:
            raw = source.read(8193)
        if len(raw) > 8192:
            raise owned.ContractError("bounded original-child stat exceeded")
        fields = raw.rsplit(b")", 1)[1].split()
        return int(fields[1]), fields[19].decode("ascii"), fields[0].decode("ascii")

    def capture(self, child, pin, deadline, clock):
        if clock.now() >= deadline or self.readiness(pin) != "alive":
            raise owned.ContractError("original-child admission unavailable")
        before = self._stat(child)
        if before[0] != self.owner_pid:
            raise owned.ContractError("original direct-child parent changed")
        path = f"/proc/{child.pid}/exe"
        executable = os.readlink(path)
        with self._owned_file(path) as source:
            inode = os.fstat(source.fileno())
        with self._owned_file(path) as current:
            current_inode = os.fstat(current.fileno())
        after = self._stat(child)
        if (clock.now() >= deadline or self.readiness(pin) != "alive"
                or before[:2] != after[:2] or before[0] != self.owner_pid
                or executable != os.readlink(path)
                or executable != self.interpreter
                or (inode.st_dev, inode.st_ino, inode.st_size, inode.st_mtime_ns, inode.st_ctime_ns) != self.interpreter_version
                or (inode.st_dev, inode.st_ino) != (current_inode.st_dev, current_inode.st_ino)):
            raise owned.ContractError("original lifetime changed during capture")
        return owned.Identity(child.pid, before[1], self.interpreter_digest, executable)

    def wait_original(self, child):
        # Genuine direct-child waitpid; this is never a Popen-close inference.
        pid, status = os.waitpid(child.pid, os.WNOHANG)
        if pid == 0:
            return None
        if pid != child.pid:
            raise owned.ContractError("unexpected original-child waitpid result")
        child.returncode = os.waitstatus_to_exitcode(status)
        return status

    def signal_pin(self, pin, action):
        if action not in {"stop", "force_stop"}:
            raise owned.ContractError("probe cannot pause or accept arbitrary signals")
        signal.pidfd_send_signal(pin.fd, signal.SIGTERM if action == "stop" else signal.SIGKILL, None, 0)

    def close_pin(self, pin):
        if self.pin_close_unknown:
            raise owned.ContractError("unknown original fd close is never retried")
        try:
            os.close(pin.fd)
        except BaseException:
            self.pin_close_unknown = True
            raise
        self.known_pin_closed = True

    def close_partial_pin(self):
        if self.pending_pin_fd is None:
            return True
        if self.pin_close_unknown:
            return False
        poller = select.poll()
        poller.register(self.pending_pin_fd, select.POLLIN)
        events = poller.poll(0)
        if len(events) != 1 or events[0][0] != self.pending_pin_fd or not events[0][1] & select.POLLIN or events[0][1] & select.POLLNVAL:
            return False
        try:
            os.close(self.pending_pin_fd)
        except BaseException:
            self.pin_close_unknown = True
            raise
        self.pending_pin_fd = None
        return True


class KernelBackend:
    def __init__(self, scope, phase, kernel, clock):
        if scope.purpose != "kernel_probe" or scope.ports != () or scope.database_name is not None or phase not in PHASES:
            raise owned.ContractError("only a fresh networkless test scope is allowed")
        self.scope, self.phase, self.kernel, self.clock = scope, phase, kernel, clock
        self.child = self.pin = self.admission = self.identity = None
        self.spawn_attempted = self.popen_attempted = self.claimed = self.pin_closed = False
        self.pidfd_exit = False
        self.waitpid_status = None
        self.startup_error = None
        self.actions, self.tokens = [], {}
        self.report_queue = queue.Queue(maxsize=4)
        self.report_results = {}
        self._next_report = 0
        self.blocked_driver_started = False
        self.last_readiness = "unknown"

    def spawn(self):
        if self.spawn_attempted:
            raise owned.ContractError("second child or replacement spawn refused")
        self.spawn_attempted = True
        try:
            self.kernel.prepare_interpreter(self.clock.now() + .5, self.clock)
            self.popen_attempted = True
            self.child = self.kernel.spawn_fixed(self.phase)
            self.pin = self.kernel.open_pin(self.child)
            self.identity = self.kernel.capture(self.child, self.pin, self.clock.now() + .5, self.clock)
            self.admission = owned.Admission("root", self.identity, None, self.pin, self.child,
                                             "fresh_spawn", self.scope.run_id, self.scope.owner_nonce)
            return (self.admission,)
        except BaseException as error:
            if self.child is None:
                self.child = getattr(self.kernel, "pending_child", None)
            if self.pin is None:
                self.pin = getattr(self.kernel, "known_pin", None)
            self.startup_error = error
            raise ProbeStartupFailure(self) from error

    def attest_scope(self, scope):
        if scope != self.scope or self.claimed or self.admission is None:
            return False
        self.claimed = True
        return True

    def owns_admission(self, admission):
        return admission is self.admission

    def _observe_exit(self):
        if self.pin_closed:
            return
        ready = self.kernel.readiness(self.pin)
        self.last_readiness = ready
        if ready not in {"alive", "exited"}:
            raise owned.ContractError("invalid original pidfd readiness")
        if ready == "exited":
            self.pidfd_exit = True
            if self.waitpid_status is None:
                self.waitpid_status = self.kernel.wait_original(self.child)

    def observe(self, pin, identity):
        if pin is not self.pin or identity is not self.identity or self.pin_closed:
            raise owned.ContractError("imported or released original pin refused")
        self._observe_exit()
        if self.pidfd_exit:
            closed = self.waitpid_status is not None
            return owned.Observation("root", pin, "exited", closure_proof="original_waitpid" if closed else "none",
                                     waitpid_status=self.waitpid_status,
                                     original_child=self.child if closed else None)
        # Immutable admission capture happened before the actor. This fixed
        # isolated child has no exec/imported command/input path. Its retained
        # kernel object plus original Popen is the post-admission lifetime
        # authority; never block cleanup by re-reading executable files.
        return owned.Observation("root", pin, "alive", identity_matches=True,
                                 parent_matches=True, execution_state="running")

    def begin(self, action, pin, identity, original_child, deadline):
        if action not in {"stop", "force_stop", "release"} or pin is not self.pin or identity is not self.identity or original_child is not self.child:
            raise owned.ContractError("non-fixed or imported probe command refused")
        if self.phase == "natural" and action != "release":
            raise owned.ContractError("natural observation phase cannot signal")
        if self.clock.now() >= deadline:
            raise owned.ContractError("expired probe action refused")
        if action == "release":
            if not self.pidfd_exit or self.waitpid_status is None or self.pin_closed:
                raise owned.ContractError("probe release needs actual pidfd exit and waitpid")
            self.kernel.close_pin(pin)
            self.pin_closed = True
        else:
            observation = self.observe(pin, identity)
            if observation.readiness != "alive" or not observation.identity_matches:
                raise owned.ContractError("exact original probe identity unavailable")
            if self.clock.now() >= deadline:
                raise owned.ContractError("probe deadline expired before fixed signal")
            # Immediate one-time syscall. Token polling never queues a signal.
            self.kernel.signal_pin(pin, action)
        token = object()
        self.tokens[token] = action
        self.actions.append({"action": action, "issued_at": self.clock.now(), "deadline": deadline})
        return token

    def poll(self, token, now):
        if token in self.report_results:
            return owned.Completion(token, self.report_results[token])
        if token not in self.tokens:
            return None
        action = self.tokens[token]
        if action == "release":
            return owned.Completion(token, "succeeded")
        self._observe_exit()
        if not self.pidfd_exit or self.waitpid_status is None:
            return None
        return owned.Completion(token, "succeeded")

    def driver_event(self, now):
        if self.phase == "deadline":
            return None  # The separate fixed driver thread is deliberately blocked.
        if not self.pin_closed:
            self._observe_exit()
        return owned.DriverEvent("success" if self.waitpid_status is not None else "active")

    def begin_report(self, report, deadline):
        self._next_report += 1
        token = object()
        self.report_queue.put_nowait((token, self._next_report, report, deadline))
        return token

    def startup_observation(self):
        """No signalling/adoption when first capture/pidfd admission failed."""
        if self.pin is None and getattr(self.kernel, "known_pin", None) is not None:
            self.pin = self.kernel.known_pin  # Same original holder, not imported.
        if self.child is None:
            return {"child_handle_received": False, "spawn_attempted": self.spawn_attempted,
                    "pending": self.popen_attempted, "actual_waitpid": False}
        if getattr(self.child, "pid", None) is None:
            return {"child_handle_received": True, "spawn_attempted": True, "pending": True, "actual_waitpid": False}
        if self.waitpid_status is None:
            self.waitpid_status = self.kernel.wait_original(self.child)
        if self.waitpid_status is not None and self.pin is not None and not self.pin_closed:
            if self.kernel.readiness(self.pin) == "exited":
                self.pidfd_exit = True
                self.kernel.close_pin(self.pin)
                self.pin_closed = True
        if self.waitpid_status is not None and self.pin is None and getattr(self.kernel, "pending_pin_fd", None) is not None:
            if self.kernel.close_partial_pin():
                self.pidfd_exit = self.pin_closed = True
        return {"child_handle_received": True, "pending": self.waitpid_status is None or (self.pin is not None and not self.pin_closed)
                or getattr(self.kernel, "pending_pin_fd", None) is not None,
                "actual_waitpid": self.waitpid_status is not None, "waitpid_status": self.waitpid_status,
                "admitted": False, "accepted": False}

    def evidence(self):
        return {"phase": self.phase, "fixed_child_code_sha256": CHILD_CODE_SHA256,
                "child_hard_lifetime_seconds": CHILD_HARD_LIFETIME, "spawn_attempt_count": int(self.spawn_attempted),
                "popen_attempt_count": int(self.popen_attempted),
                "child_handle_received": self.child is not None,
                "original_popen_retained": self.child is not None, "retained_pidfd_exit": self.pidfd_exit,
                "actual_waitpid": self.waitpid_status is not None, "waitpid_status": self.waitpid_status,
                "pin_closed": self.pin_closed, "actions": list(self.actions),
                "blocked_driver_started": self.blocked_driver_started,
                "post_admission_identity_basis": "retained_pidfd_original_popen_fixed_no_exec_child",
                "partial_pidfd_pending": getattr(self.kernel, "pending_pin_fd", None) is not None,
                "database_started": False, "network_used": False, "accepted": False, "release_ready": False}

    def resources_closed(self):
        child_closed = not self.popen_attempted or (self.child is not None and self.waitpid_status is not None)
        pin_closed = (self.pin is None or self.pin_closed) and getattr(self.kernel, "pending_pin_fd", None) is None
        if self.pin is None and getattr(self.kernel, "known_pin", None) is not None:
            pin_closed = getattr(self.kernel, "known_pin_closed", False) is True
        files_closed = not getattr(self.kernel, "open_files", {}) and not getattr(self.kernel, "file_close_unknown", False)
        return child_closed and pin_closed and files_closed and not getattr(self.kernel, "pin_close_unknown", False)


class ProbeOwner(owned.FixtureOwner):
    def dispatch(self, operation):
        if operation == "status":
            for state in self.lifetimes.values():
                self._observe(state)
            result = self.snapshot()
            result["kernel_probe_status"] = {"root_current_alive": not self.backend.pin_closed and self.backend.last_readiness == "alive",
                                             "observed_at_monotonic": self.clock.now(),
                                             "evidence_kind": "retained_pin_or_cached_closed_lifetime"}
            return result
        return super().dispatch(operation)


@dataclass(frozen=True)
class RequestEvidence:
    sequence: int
    operation: str
    handled: bool
    failed: bool
    live_status: bool


class FileWorker:
    """Separate future filesystem thread; never runs in the owner actor tick."""
    def __init__(self, directory, owner, backend):
        self.directory, self.owner, self.backend = directory, owner, backend
        self.front = rpc.FileRPC(directory, owner)
        self.front.request_evidence = ()
        self.stop_event = threading.Event()
        self.final_event = threading.Event()
        self.failure = None
        self.final_snapshot = queue.Queue(maxsize=2)
        self.final_results = {}
        self.ready_written = False

    def step(self):
        if not self.ready_written:
            self.directory.write_new("kernel-probe-ready.json", {"version": 1, "run_id": self.directory.scope.run_id,
                                     "phase": self.backend.phase, "probe_ready": isinstance(self.owner, ProbeOwner),
                                     "retained_failure": isinstance(self.owner, FailureOwner)}, rpc.MAX_REQUEST_BYTES)
            self.ready_written = True
        self.front.poll()
        # Publish one immutable memory snapshot. Actor never iterates this
        # worker's mutable file-request ledger or holds a lock across I/O.
        self.front.request_evidence = tuple(
            RequestEvidence(record["request"]["sequence"], record["request"]["operation"],
                            record["ticket"].handled, record["ticket"].error is not None,
                            bool((record.get("status") or {}).get("kernel_probe_status", {}).get("root_current_alive")))
            for record in self.front.requests.values())
        try:
            token, index, report, deadline = self.backend.report_queue.get_nowait()
        except queue.Empty:
            pass
        else:
            try:
                self.directory.write_new(f"resource-journal-{index:06d}.json", report, rpc.MAX_REPLY_BYTES)
                self.backend.report_results[token] = "succeeded"
            except Exception:
                self.backend.report_results[token] = "failed"
        try:
            final_name, snapshot = self.final_snapshot.get_nowait()
        except queue.Empty:
            return
        # Terminal RPC results must be flushed before the original owner exits.
        if any(not record["ticket"].handled or (record["operation"] is not None and not record["final_written"])
               for record in self.front.requests.values()):
            self.final_snapshot.put_nowait((final_name, snapshot))
            return
        try:
            if final_name not in {"kernel-probe-final.json", "kernel-probe-runtime-failed.json"}:
                raise owned.ContractError("unrecognized fixed final report")
            self.directory.write_new(final_name, snapshot, rpc.MAX_REPLY_BYTES)
            self.final_results[final_name] = True
            self.final_event.set()
        except Exception as error:
            self.failure = error
            self.owner.post_control_loss(error)

    def run(self):
        while not self.stop_event.is_set():
            try:
                self.step()
            except Exception as error:
                self.failure = error
                self.owner.post_control_loss(error)
                return
            self.stop_event.wait(.02)


class FailureOwner:
    """Same outer owner/backend, preserving ownership after component failure.

    This is not a new spawn, namespace, imported receipt, or scope claim. Only
    already minted original pins may receive this phase's fixed cleanup.
    Unadmitted startup objects get observation/reap only and remain inspectable.
    """
    def __init__(self, backend, clock, cause, previous=None):
        self.backend, self.clock, self.scope, self.previous = backend, clock, backend.scope, previous
        self.deadline = clock.now() + 6
        self.force_at = clock.now() + .5
        self.queue = queue.Queue(maxsize=128)
        self.causes = [cause]
        self.errors = [{"index": 0, "stage": "outer_owner", "code": "probe_runtime_failed"}]
        self.control_lost = bool(getattr(previous, "control_lost", False))
        self.operation = owned.Operation("failure_cleanup", "stop_fixture")
        self.stop_attempted = self.force_attempted = False
        self.pending = True
        self.report_written = False
        self.report_token = None
        if previous is not None:
            for op in getattr(previous, "operations", {}).values():
                if op.state == "pending":
                    op.state = "unresolved"

    def _error(self, code, cause=None):
        if any(error["code"] == code for error in self.errors):
            return
        self.errors.append({"index": len(self.errors), "stage": "outer_owner", "code": code})
        if cause is not None:
            self.causes.append(cause)

    def post_control(self, operation):
        ticket = owned.ControlTicket(operation)
        self.queue.put_nowait(ticket)
        return ticket

    def post_control_loss(self, cause):
        self.control_lost = True
        self._error("failure_control_lost", cause)

    def dispatch(self, operation):
        if operation == "status":
            return self.snapshot()
        if operation == "stop_fixture" and self.backend.admission is not None and self.backend.phase != "natural":
            return self.operation
        raise owned.ContractError("retained unadmitted/natural owner cannot signal")

    def operation_snapshot(self, operation):
        return {"operation_id": operation.operation_id, "operation": operation.kind,
                "state": operation.state, "phase": "retained_failure_cleanup",
                "error_indexes": list(range(len(self.errors))), "observed_bound_satisfied": False}

    def _service(self, control_queue, reject=False):
        for _ in range(8):
            try:
                ticket = control_queue.get_nowait()
            except queue.Empty:
                return
            try:
                if ticket.operation == "control_lost":
                    self.post_control_loss(ticket.error)
                elif reject:
                    raise owned.ContractError("original actor failed before request dispatch")
                else:
                    ticket.result = self.dispatch(ticket.operation)
            except Exception as error:
                ticket.error = error
            ticket.handled = True

    def tick(self):
        self._service(self.queue)
        if self.previous is not None and hasattr(self.previous, "_control_queue"):
            self._service(self.previous._control_queue, reject=True)
        if self.previous is not None and hasattr(self.previous, "_control_overflow"):
            self.post_control_loss(self.previous._control_overflow)
            del self.previous._control_overflow
        now = self.clock.now()
        if now >= self.deadline:
            self._error("failure_cleanup_deadline")
        try:
            state = self.backend.startup_observation()
            self.pending = state["pending"]
            if self.pending and now < self.deadline and self.backend.admission is not None and self.backend.phase != "natural":
                if not self.stop_attempted:
                    self.stop_attempted = True
                    if not any(a["action"] == "stop" for a in self.backend.actions):
                        self.backend.begin("stop", self.backend.pin, self.backend.identity, self.backend.child,
                                           min(self.deadline, now + .5))
                elif now >= self.force_at and not self.force_attempted:
                    self.force_attempted = True
                    if not any(a["action"] == "force_stop" for a in self.backend.actions):
                        self.backend.begin("force_stop", self.backend.pin, self.backend.identity, self.backend.child,
                                           min(self.deadline, now + .5))
        except Exception as error:
            self.pending = True
            self._error("failure_owned_observation_unconfirmed", error)
        if not self.pending:
            self.operation.state = "completed"
            if self.report_token is None:
                try:
                    self.report_token = self.backend.begin_report(self.snapshot(), min(self.deadline, now + .5))
                except Exception as error:
                    self._error("failure_report_enqueue_failed", error)
            elif self.report_token in self.backend.report_results:
                self.report_written = self.backend.report_results[self.report_token] == "succeeded"
                if not self.report_written:
                    self._error("failure_report_sink_failed")
        elif now >= self.deadline:
            self.operation.state = "unresolved"

    def snapshot(self):
        prior_errors = []
        if self.previous is not None:
            prior_errors = list(getattr(self.previous, "errors", []))
        return {"version": 1, "run_id": self.scope.run_id, "state": "retained_failure",
                "owner_may_exit": not self.pending and self.report_written and not self.control_lost,
                "pending_resources": ["original_child_or_pin"] if self.pending else [],
                "errors": list(self.errors), "prior_errors": prior_errors,
                "original_child_retained": self.backend.child is not None,
                "control_lost": self.control_lost, "report_written": self.report_written,
                "accepted": False, "release_ready": False, "actual_runtime_validated": False}


class ProbeContext:
    """One foreground holder; every post-spawn exception stays inside it."""
    def __init__(self, directory, backend, clock, owner_factory=ProbeOwner,
                 worker_factory=FileWorker, thread_factory=threading.Thread):
        self.directory, self.backend, self.clock = directory, backend, clock
        self.owner_factory, self.worker_factory, self.thread_factory = owner_factory, worker_factory, thread_factory
        self.owner = self.worker = self.file_thread = None
        self.final_name = "kernel-probe-final.json"
        self.final_queued = False
        self.final_deadline = None
        self.failed = False
        self.verdict = None
        self.thread_records = []
        self.delivery_failed = False
        self.jobs_settled = False

    def _start_file_thread(self, name):
        thread = self.thread_factory(target=self.worker.run, name=name, daemon=True)
        self.file_thread = thread
        record = {"thread": thread, "start_confirmed": False, "closed": False}
        self.thread_records.append(record)
        thread.start()
        record["start_confirmed"] = True

    def initialize(self):
        admissions = self.backend.spawn()
        limits = owned.Limits(workload=8, lease=2, cleanup=6, action=.5, report=.5)
        self.owner = self.owner_factory(self.directory.scope, admissions, self.backend, self.clock, limits)
        if self.owner.snapshot().get("startup_pending_count", 0):
            raise owned.ContractError("actor admission retained unadmitted startup objects")
        self.worker = self.worker_factory(self.directory, self.owner, self.backend)
        self._start_file_thread("fixed-probe-files")

    def retain_failure(self, cause):
        self.owner = FailureOwner(self.backend, self.clock, cause, self.owner)
        self.failed = True
        self.final_name = "kernel-probe-runtime-failed.json"
        self.final_queued = False
        self.final_deadline = None
        try:
            if self.worker is None:
                self.worker = self.worker_factory(self.directory, self.owner, self.backend)
            else:
                self.worker.owner = self.owner
                self.worker.front.owner = self.owner
                if self.worker.front.channel_lost or self.worker.failure is not None:
                    self.owner.post_control_loss(self.worker.failure)
            if self.file_thread is None or not self.file_thread.is_alive():
                self._start_file_thread("retained-probe-files")
        except BaseException as error:
            self.owner.post_control_loss(error)

    def _close_threads(self):
        if self.worker is not None:
            self.worker.stop_event.set()
        all_closed = True
        for record in self.thread_records:
            if record["closed"]:
                continue
            thread = record["thread"]
            if not record["start_confirmed"] and getattr(thread, "ident", None) is None:
                all_closed = False  # A failed/partial start has no join proof.
                continue
            try:
                thread.join(.2)
                if not thread.is_alive():
                    record["closed"] = True
                else:
                    all_closed = False
            except BaseException:
                all_closed = False
        return all_closed and all(record["closed"] for record in self.thread_records)

    def _settle_jobs(self):
        # Only after every producer/FS thread has positively closed. Queued
        # delivery work is marked failed, never successful or still executing.
        while True:
            try:
                token, _index, _report, _deadline = self.backend.report_queue.get_nowait()
            except queue.Empty:
                break
            self.backend.report_results[token] = "failed"
        if self.worker is not None:
            while True:
                try:
                    name, _snapshot = self.worker.final_snapshot.get_nowait()
                except queue.Empty:
                    break
                self.worker.final_results[name] = False
        self.jobs_settled = True

    def resource_exit_gate(self):
        if not self.backend.resources_closed():
            return False
        closure = self.directory.resource_closure()
        if closure["run_fd_unknown"] or closure["data_fd_unknown"] or closure["transient_fd_unknown"]:
            return False
        if any(not record["start_confirmed"] and getattr(record["thread"], "ident", None) is None
               for record in self.thread_records if not record["closed"]):
            return False
        if not self._close_threads():
            return False
        self._settle_jobs()
        try:
            self.directory.close()
        except BaseException:
            return False
        return self.directory.resource_closure()["all_closed"] and self.jobs_settled

    def step(self):
        self.owner.tick()
        snapshot = self.owner.snapshot()
        if snapshot["owner_may_exit"] and not self.final_queued:
            self.verdict = phase_verdict(self.backend.phase, self.owner, self.backend, self.worker.front)
            final = {"owner": snapshot, "kernel_probe": self.backend.evidence(), "phase_verdict": self.verdict,
                     "retained_runtime_failure": self.failed, "accepted": False, "release_ready": False}
            self.worker.final_snapshot.put_nowait((self.final_name, final))
            self.final_queued = True
            self.final_deadline = self.clock.now() + 1
        acknowledged = self.worker is not None and self.worker.final_results.get(self.final_name) is True
        if self.final_queued and not acknowledged and self.clock.now() >= self.final_deadline and not self.owner.control_lost:
            self.delivery_failed = True
            self.owner.post_control_loss(owned.ContractError("terminal publication deadline"))
        if acknowledged and self.owner.snapshot()["owner_may_exit"]:
            if self.resource_exit_gate():
                return 0 if not self.failed and self.verdict["bounded_phase_success"] else 1
            self.owner.post_control_loss(owned.ContractError("owned resource closure unknown"))
            return None
        ended_attempt = bool(getattr(self.owner, "_terminal", False)) or (self.failed and self.clock.now() >= self.owner.deadline)
        waiting_for_publication = self.final_queued and self.clock.now() < self.final_deadline and not self.delivery_failed
        if ended_attempt and not waiting_for_publication and self.backend.resources_closed():
            self.delivery_failed = True
            if self.resource_exit_gate():
                # Resource closure and delivery failure are distinct. This
                # nonzero exit never claims a bounded experiment success.
                return 1 if self.failed else 2
        return None

    def run(self):
        try:
            self.initialize()
        except BaseException as error:
            self.retain_failure(error)
        while True:
            try:
                result = self.step()
                if result is not None:
                    return result
            except BaseException as error:
                if not self.failed:
                    self.retain_failure(error)
                else:
                    self.owner.post_control_loss(error)
            time.sleep(.02)


def phase_verdict(phase, owner, backend, front):
    status = backend.waitpid_status
    actions = [item["action"] for item in backend.actions if item["action"] != "release"]
    requests = tuple(getattr(front, "request_evidence", ()))
    status_sequences = [record.sequence for record in requests
                        if record.operation == "status" and record.handled and not record.failed and record.live_status]
    status_seen = bool(status_sequences)
    stop_seen = any(record.operation == "stop_fixture" and record.handled and not record.failed for record in requests)
    natural = status is not None and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
    signalled = status is not None and os.WIFSIGNALED(status) and os.WTERMSIG(status) in {signal.SIGTERM, signal.SIGKILL}
    expired = any(e["code"] in {"driver_lease_lost", "workload_timeout"} for e in getattr(owner, "errors", []))
    if phase == "natural":
        objective = natural and not actions and status_seen
    elif phase == "stop":
        ordered_status = any(record.operation == "stop_fixture" and any(sequence < record.sequence for sequence in status_sequences)
                             for record in requests)
        objective = status_seen and ordered_status and stop_seen and signalled and "stop" in actions
    else:
        objective = backend.blocked_driver_started and expired and not stop_seen and signalled and "stop" in actions
    return {"phase_objective_observed": objective, "status_request_admitted": status_seen,
            "bounded_phase_success": objective and not getattr(owner, "errors", []) and not owner.snapshot()["pending_resources"],
            "rpc_stop_admitted": stop_seen, "natural_exit_observed": natural,
            "signalled_exit_observed": signalled, "automatic_deadline_observed": expired,
            "cross_exec_runtime_validated": False, "accepted": False, "release_ready": False}


def _phase_path(phase):
    if phase not in PHASES:
        raise owned.ContractError("unknown fixed probe phase")
    return PROBE_ROOT / phase


def _private_new_root(phase):
    if "15e2d8bb" in str(PROBE_ROOT):
        raise owned.ContractError("sealed old scope overlap")
    if not PROBE_ROOT.exists():
        PROBE_ROOT.mkdir(mode=0o700)
    rpc.PrivateRunDirectory._private_directory(os.lstat(PROBE_ROOT))
    path = _phase_path(phase)
    path.mkdir(mode=0o700)  # Existing phase is never deleted, reused or imported.
    return path


def _claim_common_nonces(tokens, run_id, tracker=None):
    fd = os.open(PROBE_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        rpc.PrivateRunDirectory._private_directory(os.fstat(fd))
        for nonce in tokens:
            claim = os.open("nonce-" + nonce + ".claim", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            try:
                raw = json.dumps({"version": 1, "run_id": run_id}).encode()
                if os.write(claim, raw) != len(raw):
                    raise rpc.ChannelError("partial common nonce claim")
                os.fsync(claim)
            finally:
                tracker._close_transient(claim) if tracker is not None else os.close(claim)
        os.fsync(fd)
    finally:
        tracker._close_transient(fd) if tracker is not None else os.close(fd)


def _write_locator(path, value, tracker=None):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = "incoming-" + secrets.token_hex(16) + ".tmp"
    file_fd = None
    try:
        rpc.PrivateRunDirectory._private_directory(os.fstat(fd))
        file_fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        raw = json.dumps(value, sort_keys=True).encode()
        if len(raw) > rpc.MAX_REQUEST_BYTES or os.write(file_fd, raw) != len(raw):
            raise rpc.ChannelError("partial or oversized fixed locator")
        os.fsync(file_fd)
        os.link(temporary, "locator.json", src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
        os.unlink(temporary, dir_fd=fd)
        os.fsync(fd)
    finally:
        if file_fd is not None:
            tracker._close_transient(file_fd) if tracker is not None else os.close(file_fd)
        try:
            os.unlink(temporary, dir_fd=fd)
        except FileNotFoundError:
            pass
        tracker._close_transient(fd) if tracker is not None else os.close(fd)


def run_owner(phase, execute_reviewed=False):
    if execute_reviewed is not True or phase not in RUNTIME_PHASES:
        raise owned.ContractError("only the separately reviewed stop probe may execute")
    path = _private_new_root(phase)
    run_id, owner_nonce, client_nonce = (secrets.token_hex(16) for _ in range(3))
    directory = rpc.PrivateRunDirectory.create(path, run_id, owner_nonce, client_nonce, (), (), None,
                                               owned.Scope, purpose="kernel_probe")
    locator = {"version": 1, "phase": phase, "run_id": run_id, "owner_nonce": owner_nonce,
               "client_nonce": client_nonce, "directory_identity": directory.directory_identity,
               "data_directory_identity": directory.data_identity}
    try:
        _claim_common_nonces((run_id, owner_nonce, client_nonce), run_id, directory)
        _write_locator(path, locator, directory)
        clock = MonotonicClock()
        backend = KernelBackend(directory.scope, phase, LinuxKernel(_RUNTIME_CAPABILITY), clock)
        context = ProbeContext(directory, backend, clock)
    except BaseException as cause:
        directory.setup_failure = cause  # No Popen attempt; preserve exact handles.
        try:
            directory.close()
        except BaseException as close_error:
            directory.setup_close_failure = close_error
        if directory.resource_closure()["all_closed"]:
            return 1
        while True:
            time.sleep(.02)  # Unknown setup fd is retained, never relabeled delivery.
    # Context is created before its only spawn. All construction/thread/tick/
    # publication failures after that point preserve this same backend holder.
    return context.run()


def _attach_client(phase):
    path = _phase_path(phase)
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        rpc.PrivateRunDirectory._private_directory(os.fstat(fd))
        locator_fd = os.open("locator.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            st = os.fstat(locator_fd)
            rpc.PrivateRunDirectory._private_file(st)
            raw = os.read(locator_fd, rpc.MAX_REQUEST_BYTES + 1)
            if len(raw) > rpc.MAX_REQUEST_BYTES:
                raise rpc.ChannelError("bounded private locator exceeded")
            value = rpc._strict_json(raw)
        finally:
            os.close(locator_fd)
    finally:
        os.close(fd)
    fields = {"version", "phase", "run_id", "owner_nonce", "client_nonce", "directory_identity", "data_directory_identity"}
    if type(value) is not dict or set(value) != fields or type(value["version"]) is not int or value["version"] != 1 or value["phase"] != phase:
        raise rpc.ChannelError("stale or foreign fixed-phase locator")
    scope = owned.Scope(value["run_id"], value["owner_nonce"], value["client_nonce"], None, (),
                        tuple(value["data_directory_identity"]), purpose="kernel_probe")
    directory = rpc.PrivateRunDirectory.attach_control(path / ("owned-" + scope.run_id), scope,
                                                        tuple(value["directory_identity"]))
    return rpc.FileRPCClient(directory)


def _new_client_request(client, operation):
    directory, scope = client.directory, client.directory.scope
    if operation == "stop_fixture":
        try:
            original, _inode, _digest = directory.read("client-stop-request.json", rpc.MAX_REQUEST_BYTES)
            rpc.validate_request(original, scope)
            if original["operation"] != "stop_fixture":
                raise rpc.ChannelError("conflicting fixed stop receipt")
            return original
        except FileNotFoundError:
            pass
    for sequence in range(1, rpc.MAX_REQUESTS + 1):
        try:
            directory.write_new(f"client-sequence-{sequence:06d}.json", {"version": 1, "run_id": scope.run_id}, rpc.MAX_REQUEST_BYTES)
            break
        except FileExistsError:
            continue
    else:
        raise rpc.ChannelError("bounded client sequence slots exhausted")
    request = {"version": 1, "run_id": scope.run_id, "owner_nonce": scope.owner_nonce,
               "client_nonce": scope.client_nonce, "sequence": sequence,
               "idempotency_key": secrets.token_hex(16), "operation": operation}
    if operation == "stop_fixture":
        try:
            directory.write_new("client-stop-request.json", request, rpc.MAX_REQUEST_BYTES)
        except FileExistsError:
            original, _inode, _digest = directory.read("client-stop-request.json", rpc.MAX_REQUEST_BYTES)
            rpc.validate_request(original, scope)
            if original["operation"] != "stop_fixture":
                raise rpc.ChannelError("conflicting fixed stop receipt")
            return original
    return request


def run_client(phase, action, execute_reviewed=False):
    if execute_reviewed is not True or phase not in RUNTIME_PHASES:
        raise owned.ContractError("probe client I/O requires the separately reviewed stop flag")
    if action not in {"status", "status_then_stop"} or (action == "status_then_stop" and phase != "stop"):
        raise owned.ContractError("client supports only status or status/stop")
    clock = MonotonicClock()
    total_deadline = clock.now() + 4
    try:
        client = _attach_client(phase)
    except Exception:
        print(json.dumps({"outcome": "control_unavailable", "pending": True, "replacement_owner_started": False}))
        return 2
    try:
        original_stop = None
        if action == "status_then_stop":
            try:
                original_stop, _inode, _digest = client.directory.read("client-stop-request.json", rpc.MAX_REQUEST_BYTES)
                rpc.validate_request(original_stop, client.directory.scope)
                if original_stop["operation"] != "stop_fixture":
                    raise rpc.ChannelError("conflicting fixed stop receipt")
            except FileNotFoundError:
                pass
        operations = ("stop_fixture",) if original_stop is not None else (("status", "stop_fixture") if action == "status_then_stop" else ("status",))
        for operation in operations:
            if clock.now() >= total_deadline:
                print(json.dumps({"outcome": "caller_timeout", "pending": True, "replacement_owner_started": False}))
                return 2
            request = original_stop if original_stop is not None else _new_client_request(client, operation)
            try:
                client.submit(request)
            except FileExistsError:
                pass  # Original immutable request; no new owner/operation.
            while clock.now() < total_deadline:
                result = client.caller_result(request, total_deadline, clock)
                if result is not None:
                    print(json.dumps(result, sort_keys=True))
                    if result.get("outcome") == "caller_timeout":
                        return 2
                    if operation == "stop_fixture" and (result.get("result", {}).get("state") != "completed"
                                                        or result.get("result", {}).get("observed_bound_satisfied") is not True):
                        return 2
                    break
                time.sleep(.02)
            else:
                print(json.dumps({"outcome": "caller_timeout", "pending": True, "replacement_owner_started": False}))
                return 2
        return 0
    finally:
        client.directory.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("role", choices=("owner", "client"))
    parser.add_argument("--phase", choices=RUNTIME_PHASES, required=True)
    parser.add_argument("--action", choices=("status", "status_then_stop"), default="status")
    parser.add_argument("--execute-reviewed-probe", action="store_true")
    args = parser.parse_args(argv)
    return run_owner(args.phase, args.execute_reviewed_probe) if args.role == "owner" else run_client(args.phase, args.action, args.execute_reviewed_probe)


if __name__ == "__main__":
    raise SystemExit(main())
