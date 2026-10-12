"""Memory-only wrapper observations; no media child, signal, socket, or DB is real."""
import builtins
from contextlib import ExitStack
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import unittest
from unittest.mock import patch
import uuid


WRAPPER = Path(__file__).parent / "fixtures" / "compute-finish-real-media-wrapper.py"
WRAPPER_BYTES = WRAPPER.read_bytes()
WRAPPER_PID, CHILD_PID, EXECUTABLE_FD = 12001, 12002, 303
INVOCATION = uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
ROOT = Path("/owned/receipts")
RECEIPT = ROOT / (str(INVOCATION) + ".json")
TEMPORARY = RECEIPT.with_suffix(".tmp")
EXECUTABLE_BYTES = b"owned memory-only executable descriptor bytes"


class Executable(io.BytesIO):
    def fileno(self):
        return EXECUTABLE_FD


class ReceiptStream(io.StringIO):
    def __init__(self, observation, fd):
        super().__init__()
        self.observation, self.fd = observation, fd

    def fileno(self):
        return self.fd

    def close(self):
        if not self.closed:
            self.observation.pending = self.getvalue()
        super().close()


class Observation:
    """Strict fake syscall journal, executing the unchanged wrapper source."""
    def __init__(self, *, exit_at="identity_save", failure_at=None):
        self.exit_at, self.failure_at = exit_at, failure_at
        self.events, self.snapshots, self.receipt_fds = [], [], set()
        self.executable = Executable(EXECUTABLE_BYTES)
        self.pid, self.returncode, self.reaped = CHILD_PID, None, False
        self.pending, self.spawned, self.waits = None, False, 0
        number = errno.ENOENT if failure_at == "open" else errno.EIO
        self.failure = OSError(number, "SECRET exception text", "SECRET/path")
        self.argv = ["/owned/ffprobe", "/owned/published/"
                     "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/"
                     "cccccccc-cccc-4ccc-8ccc-cccccccccccc/index.m3u8",
                     "SECRET_argument"]

    def spawn(self, args, **kwargs):
        assert not self.spawned, "Only the owned fake child may be spawned"
        assert args == ["/usr/bin/ffprobe", *self.argv[1:]]
        assert kwargs == {"stdin": sys.stdin, "stdout": sys.stdout, "stderr": sys.stderr}
        self.spawned = True
        self.events.append("spawn")
        return self

    def poll(self):
        self.events.append("poll")
        return self.returncode

    def send_signal(self, _signal):
        raise AssertionError("These cases must not signal even a fake child")

    def wait(self):
        self.events.append("wait")
        self.waits += 1
        assert self.returncode == 0, "The fake child must already have exited naturally"
        self.reaped = True
        return self.returncode

    def mkdir(self, path, **kwargs):
        assert path == ROOT and kwargs == {"parents": True, "exist_ok": True}

    def open_receipt(self, path, flags, mode):
        assert path == TEMPORARY
        assert flags == os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        assert mode == 0o600
        fd = 400 + len(self.receipt_fds)
        self.receipt_fds.add(fd)
        self.events.append("open_receipt")
        return fd

    def fdopen(self, fd, mode):
        assert fd in self.receipt_fds and mode == "w"
        return ReceiptStream(self, fd)

    def fsync(self, fd):
        assert fd in self.receipt_fds
        self.events.append("fsync")
        if self.spawned and self.exit_at == "identity_save":
            self.returncode = 0

    def replace(self, source, destination):
        assert source == TEMPORARY and destination == RECEIPT
        self.snapshots.append(json.loads(self.pending))

    def open_executable(self, path, mode):
        assert path == Path(f"/proc/{CHILD_PID}/exe") and mode == "rb", (
            "Only the actual child exe may be opened; no real-path fallback")
        assert self.spawned and "open_executable" not in self.events
        self.events.append("open_executable")
        if self.failure_at == "open":
            self.returncode = 0
            raise self.failure
        if self.exit_at == "open":
            self.returncode = 0
        return self.executable

    def read_stat(self, path):
        assert path == Path(f"/proc/{CHILD_PID}/stat") and not self.reaped
        self.events.append("read_stat")
        # The unreaped fake zombie retains stat after exit, but never an exe reopen.
        fields = ["Z" if self.returncode == 0 else "R", str(WRAPPER_PID)]
        fields += ["0"] * 17 + ["12345"]
        return f"{CHILD_PID} (ffprobe) " + " ".join(fields)

    def readlink(self, path):
        assert path == f"/proc/self/fd/{EXECUTABLE_FD}"
        assert not self.executable.closed
        self.events.append("read_pinned_link")
        return "/usr/bin/ffprobe"

    def digest(self, stream, algorithm):
        assert stream is self.executable and not stream.closed
        assert algorithm == "sha256"
        self.events.append("hash_pinned_executable")
        if self.failure_at == "hash":
            self.returncode = 0
            raise self.failure
        return self.real_digest(stream, algorithm)

    def kill(self, pid, signum):
        assert pid == CHILD_PID and signum == 0 and self.reaped
        self.events.append("verify_absence")
        raise ProcessLookupError(errno.ESRCH, "owned fake child reaped")

    def open_source(self, path):
        assert path == self.argv[0]
        return io.BytesIO(WRAPPER_BYTES)

    def run(self):
        self.real_digest = hashlib.file_digest
        with ExitStack() as stack:
            for owner, name, replacement in [
                (sys, "argv", self.argv),
                (subprocess, "Popen", self.spawn),
                (Path, "mkdir", lambda path, **kwargs: self.mkdir(path, **kwargs)),
                (Path, "read_text", lambda path: self.read_stat(path)),
                (builtins, "open", self.open_executable),
                (io, "open_code", self.open_source),
                (os, "open", self.open_receipt),
                (os, "fdopen", self.fdopen),
                (os, "fsync", self.fsync),
                (os, "replace", self.replace),
                (os, "readlink", self.readlink),
                (os, "kill", self.kill),
                (os, "getpid", lambda: WRAPPER_PID),
                (os, "getppid", lambda: 12000),
                (os.path, "realpath", lambda path: str(path)),
                (signal, "signal", lambda *_args: None),
                (uuid, "uuid4", lambda: INVOCATION),
                (hashlib, "file_digest", self.digest),
            ]:
                stack.enter_context(patch.object(owner, name, replacement))
            stack.enter_context(patch.dict(os.environ, {
                "RAINSYNC_FINISH_PROCESS_RECEIPTS": str(ROOT),
                "RAINSYNC_COMPUTE_OUTPUT_ROOT": "/owned/published",
            }, clear=True))
            # runpy sets argv[0] to its path; serve unchanged source from memory
            # under the installed tool name, without a real copy or symlink.
            runpy.run_path(self.argv[0], run_name="__main__")


class WrapperObservationTests(unittest.TestCase):
    def assert_reaped(self, observation):
        receipt = observation.snapshots[-1]
        self.assertEqual(observation.waits, 1)
        self.assertTrue(observation.reaped)
        self.assertTrue(receipt["spawn_observed"])
        self.assertFalse(receipt["spawn_error"])
        self.assertTrue(receipt["close_observed"])
        self.assertEqual(receipt["child_pid"], CHILD_PID)
        self.assertEqual(receipt["exit_code"], 0)
        self.assertIsNone(receipt["signal"])
        self.assertEqual(receipt["received_signals"], [])
        self.assertTrue(receipt["pid_absent"])
        self.assertNotIn("SECRET", json.dumps(observation.snapshots))
        return receipt

    def test_identity_is_pinned_and_hashed_before_post_spawn_receipt_fsync(self):
        observation = Observation(exit_at="identity_save")
        with self.assertRaises(SystemExit) as result:
            observation.run()
        self.assertEqual(result.exception.code, 0)
        events = observation.events[observation.events.index("spawn") + 1:]
        self.assertLess(events.index("open_executable"), events.index("fsync"))
        self.assertLess(events.index("hash_pinned_executable"), events.index("fsync"))
        self.assertLess(events.index("fsync"), events.index("wait"))
        receipt = self.assert_reaped(observation)
        self.assertFalse(receipt["observer_error"])
        self.assertEqual(receipt["child_parent_pid"], WRAPPER_PID)
        self.assertEqual(receipt["child_start_ticks"], "12345")
        self.assertEqual(receipt["child_executable"], "/usr/bin/ffprobe")
        self.assertEqual(receipt["child_executable_sha256"],
                         hashlib.sha256(EXECUTABLE_BYTES).hexdigest())

    def test_exit_after_acquisition_does_not_reopen_exe_or_replace_its_hash(self):
        observation = Observation(exit_at="open")
        with self.assertRaises(SystemExit) as result:
            observation.run()
        self.assertEqual(result.exception.code, 0)
        receipt = self.assert_reaped(observation)
        self.assertFalse(receipt["observer_error"])
        self.assertEqual(receipt["child_executable_sha256"],
                         hashlib.sha256(EXECUTABLE_BYTES).hexdigest())
        self.assertEqual(observation.events.count("open_executable"), 1)

    def test_open_enoent_is_still_failed_reaped_and_sanitized(self):
        observation = Observation(failure_at="open")
        with self.assertRaises(OSError) as result:
            observation.run()
        self.assertIs(result.exception, observation.failure)
        receipt = self.assert_reaped(observation)
        self.assertTrue(receipt["observer_error"])
        self.assertEqual(receipt["observer_error_phase"], "open_child_executable")
        self.assertEqual(receipt["observer_error_type"], "FileNotFoundError")
        self.assertEqual(receipt["observer_error_errno"], errno.ENOENT)
        self.assertIsNone(receipt["child_executable_sha256"])
        self.assertNotIn("hash_pinned_executable", observation.events)

    def test_hash_failure_preserves_original_phase_and_errno_after_cleanup(self):
        observation = Observation(failure_at="hash")
        with self.assertRaises(OSError) as result:
            observation.run()
        self.assertIs(result.exception, observation.failure)
        receipt = self.assert_reaped(observation)
        self.assertTrue(receipt["observer_error"])
        self.assertEqual(receipt["observer_error_phase"], "hash_child_executable")
        self.assertEqual(receipt["observer_error_type"], "OSError")
        self.assertEqual(receipt["observer_error_errno"], errno.EIO)
        self.assertIsNone(receipt["child_executable_sha256"])


if __name__ == "__main__":
    unittest.main()
