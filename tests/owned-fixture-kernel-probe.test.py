"""Static/fake adapter checks. Native spawn/pidfd/signal/waitpid are forbidden."""
import ast
from dataclasses import replace
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / "scripts/fixtures/owned-fixture-kernel-probe.py"
spec = importlib.util.spec_from_file_location("fixed_kernel_probe_test", path)
probe = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = probe
spec.loader.exec_module(probe)


class Clock:
    value = 0.0

    def now(self):
        return self.value

    def advance(self, duration=.05):
        self.value += duration


class FakeKernel:
    def __init__(self):
        self.child = SimpleNamespace(pid=20001, returncode=None)
        self.pending_child = None
        self.pending_pin_fd = None
        self.known_pin = None
        self.known_pin_closed = False
        self.pin = probe.RetainedPin(901)
        self.identity = probe.owned.Identity(20001, "777", "a" * 64, "/fake/python")
        self.ready = "alive"
        self.status = None
        self.signals, self.closed, self.waits = [], [], []
        self.prepared = self.spawned = self.captured = 0
        self.fail = None
        self.defer_signal = False
        self.advance_on_readiness = None

    def prepare_interpreter(self, deadline, clock):
        self.prepared += 1
        if self.fail == "prepare":
            raise OSError("fake setup failure")

    def spawn_fixed(self, phase):
        self.spawned += 1
        self.pending_child = self.child
        if self.fail == "construct":
            raise OSError("fake partial Popen construction")
        return self.child

    def open_pin(self, child):
        if self.fail == "open_allocated":
            self.pending_pin_fd = 902
            raise MemoryError("fake wrapper failed after allocation")
        if self.fail == "open":
            raise OSError("fake pidfd unavailable")
        return self.pin

    def capture(self, child, pin, deadline, clock):
        self.captured += 1
        if self.fail == "capture":
            raise OSError("fake admission failure")
        return self.identity

    def readiness(self, pin):
        if pin is not self.pin:
            raise AssertionError("original fake pin only")
        if self.advance_on_readiness:
            self.advance_on_readiness()
        return self.ready

    def wait_original(self, child):
        if child is not self.child:
            raise AssertionError("original fake Popen only")
        self.waits.append(child)
        return self.status

    def signal_pin(self, pin, action):
        self.signals.append((pin, action))
        if not self.defer_signal:
            self.exit(15 if action == "stop" else 9)

    def close_pin(self, pin):
        self.closed.append(pin)
        self.known_pin_closed = True

    def close_partial_pin(self):
        if self.ready != "exited":
            return False
        self.closed.append(self.pending_pin_fd)
        self.pending_pin_fd = None
        return True

    def exit(self, status=0):
        self.ready, self.status = "exited", status


class FakeThread:
    def __init__(self, **_kwargs):
        self.alive = False

    def start(self):
        self.alive = True

    def is_alive(self):
        return self.alive

    def join(self, timeout):
        self.alive = False


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.native_guards = [patch.object(probe.subprocess, "Popen", side_effect=AssertionError("native spawn forbidden")),
                              patch.object(probe.os, "pidfd_open", side_effect=AssertionError("native pidfd forbidden")),
                              patch.object(probe.os, "waitpid", side_effect=AssertionError("native waitpid forbidden")),
                              patch.object(probe.signal, "pidfd_send_signal", side_effect=AssertionError("native signal forbidden"))]
        for guard in self.native_guards:
            guard.start()
        self.clock, self.kernel = Clock(), FakeKernel()
        self.scope = probe.owned.Scope("1" * 32, "2" * 32, "3" * 32, None, (), (11, 22), purpose="kernel_probe")
        self.backend = probe.KernelBackend(self.scope, "stop", self.kernel, self.clock)

    def tearDown(self):
        for guard in reversed(self.native_guards):
            guard.stop()

    def spawn(self, phase="stop"):
        self.backend.phase = phase
        self.admissions = self.backend.spawn()
        return self.admissions

    def owner(self):
        self.spawn()
        return probe.owned.FixtureOwner(self.scope, self.admissions, self.backend, self.clock,
                                        probe.owned.Limits(workload=8, lease=2, cleanup=6, action=.5, report=.5))

    def test_real_access_and_owner_client_io_need_explicit_flag(self):
        with self.assertRaises(probe.owned.ContractError):
            probe.LinuxKernel()
        with patch.object(probe, "_private_new_root") as root, patch.object(probe, "_attach_client") as attach:
            for phase in probe.PHASES:
                with self.assertRaises(probe.owned.ContractError):
                    probe.run_owner(phase)
                with self.assertRaises(probe.owned.ContractError):
                    probe.run_client(phase, "status_then_stop")
            root.assert_not_called()
            attach.assert_not_called()

    def test_missing_linux_api_is_refused_before_interpreter_read_or_spawn(self):
        kernel = probe.LinuxKernel.__new__(probe.LinuxKernel)
        with patch.object(probe, "hasattr", create=True, side_effect=lambda obj, name: False if name == "pidfd_open" else hasattr(obj, name)), patch("builtins.open") as opened:
            with self.assertRaises(probe.owned.ContractError):
                kernel.prepare_interpreter(1, self.clock)
            opened.assert_not_called()

    def test_natural_and_deadline_runtime_modes_are_deferred_even_with_flag(self):
        with patch.object(probe, "_private_new_root") as root, patch.object(probe, "_attach_client") as attach:
            for phase in ("natural", "deadline"):
                with self.assertRaises(probe.owned.ContractError):
                    probe.run_owner(phase, True)
                with self.assertRaises(probe.owned.ContractError):
                    probe.run_client(phase, "status", True)
            root.assert_not_called()
            attach.assert_not_called()

    def test_probe_has_no_database_ports_or_allocator(self):
        self.assertIsNone(self.scope.database_name)
        self.assertEqual(self.scope.ports, ())
        with self.assertRaises(probe.owned.ContractError):
            probe.owned.Scope("1" * 32, "2" * 32, "3" * 32, "owned_" + "1" * 32,
                              (43001,), (11, 22), purpose="kernel_probe")
        with self.assertRaises(probe.owned.ContractError):
            probe.KernelBackend(replace(self.scope, purpose="postgres_future", database_name="owned_" + "1" * 32,
                                         ports=(43001,)), "stop", self.kernel, self.clock)

    def test_interpreter_preparation_precedes_the_only_spawn(self):
        self.spawn()
        self.assertEqual((self.kernel.prepared, self.kernel.spawned, self.kernel.captured), (1, 1, 1))
        with self.assertRaises(probe.owned.ContractError):
            self.backend.spawn()
        self.assertEqual(self.kernel.spawned, 1)

    def test_original_handles_and_minted_admission_are_retained(self):
        admission, = self.spawn()
        self.assertIs(admission.original_child, self.kernel.child)
        self.assertIs(admission.pin, self.kernel.pin)
        self.assertTrue(self.backend.owns_admission(admission))
        self.assertFalse(self.backend.owns_admission(replace(admission)))
        self.assertTrue(self.backend.attest_scope(self.scope))
        self.assertFalse(self.backend.attest_scope(self.scope))

    def test_actor_observations_do_not_rehash_or_read_executable(self):
        self.spawn()
        for _ in range(20):
            result = self.backend.observe(self.backend.pin, self.backend.identity)
            self.assertEqual(result.readiness, "alive")
        self.assertEqual(self.kernel.captured, 1)
        tree = ast.parse(path.read_text())
        backend_class = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "KernelBackend")
        observe = next(n for n in backend_class.body if isinstance(n, ast.FunctionDef) and n.name == "observe")
        self.assertFalse(any(isinstance(n, ast.Attribute) and n.attr in {"capture", "open", "read", "readlink"}
                             for n in ast.walk(observe)))

    def test_invalid_pin_never_signals_or_reopens(self):
        self.spawn()
        self.kernel.ready = "invalid"
        with self.assertRaises(probe.owned.ContractError):
            self.backend.begin("stop", self.backend.pin, self.backend.identity, self.backend.child, 1)
        self.assertEqual(self.kernel.signals, [])
        self.assertEqual(self.kernel.spawned, 1)

    def test_imported_pin_identity_child_and_arbitrary_actions_are_rejected(self):
        self.spawn()
        args = (self.backend.pin, self.backend.identity, self.backend.child, 1)
        for action in ("pause", "continue", "SIGUSR1", "shell", "spawn"):
            with self.assertRaises(probe.owned.ContractError):
                self.backend.begin(action, *args)
        for index in range(3):
            modified = list(args)
            modified[index] = object()
            with self.assertRaises(probe.owned.ContractError):
                self.backend.begin("stop", *modified)
        self.assertEqual(self.kernel.signals, [])

    def test_monotonic_recheck_prohibits_signal_after_observation_crosses_deadline(self):
        self.spawn()
        self.kernel.advance_on_readiness = lambda: self.clock.advance(2)
        with self.assertRaises(probe.owned.ContractError):
            self.backend.begin("stop", self.backend.pin, self.backend.identity, self.backend.child, 1)
        self.assertEqual(self.kernel.signals, [])

    def test_signal_receipt_is_not_exit_or_waitpid_and_poll_is_observation_only(self):
        self.spawn()
        self.kernel.defer_signal = True
        token = self.backend.begin("stop", self.backend.pin, self.backend.identity, self.backend.child, 1)
        self.assertIsNone(self.backend.poll(token, self.clock.now()))
        self.assertFalse(self.backend.pidfd_exit)
        self.assertIsNone(self.backend.waitpid_status)
        self.kernel.exit(15)
        self.assertEqual(self.backend.poll(token, self.clock.now()).outcome, "succeeded")
        self.assertEqual(len(self.kernel.signals), 1)
        self.assertEqual(len(self.kernel.waits), 1)

    def test_positive_pidfd_exit_without_waitpid_is_not_closure(self):
        self.spawn()
        self.kernel.ready = "exited"
        observation = self.backend.observe(self.backend.pin, self.backend.identity)
        self.assertEqual(observation.readiness, "exited")
        self.assertEqual(observation.closure_proof, "none")
        self.assertIsNone(observation.waitpid_status)
        with self.assertRaises(probe.owned.ContractError):
            self.backend.begin("release", self.backend.pin, self.backend.identity, self.backend.child, 1)
        self.assertEqual(self.kernel.closed, [])

    def test_natural_exit_same_pin_actual_reap_is_cached_without_signal(self):
        self.spawn("natural")
        self.kernel.exit(0)
        one = self.backend.observe(self.backend.pin, self.backend.identity)
        two = self.backend.observe(self.backend.pin, self.backend.identity)
        self.assertEqual(one.waitpid_status, 0)
        self.assertIs(one.original_child, self.kernel.child)
        self.assertEqual(two.closure_proof, "original_waitpid")
        self.assertEqual(len(self.kernel.waits), 1)
        self.assertEqual(self.kernel.signals, [])

    def test_natural_phase_cannot_signal_on_timeout_or_control_loss(self):
        self.spawn("natural")
        for action in ("stop", "force_stop"):
            with self.assertRaises(probe.owned.ContractError):
                self.backend.begin(action, self.backend.pin, self.backend.identity, self.backend.child, 1)
        self.assertEqual(self.kernel.signals, [])

    def test_pre_spawn_failure_does_not_claim_a_child_or_actual_waitpid(self):
        self.kernel.fail = "prepare"
        with self.assertRaises(probe.ProbeStartupFailure) as caught:
            self.backend.spawn()
        self.assertIs(caught.exception.backend, self.backend)
        self.assertEqual(self.kernel.spawned, 0)
        self.assertFalse(self.backend.startup_observation()["pending"])
        self.assertFalse(self.backend.startup_observation()["actual_waitpid"])

    def test_partial_popen_and_pre_pin_errors_retain_the_original_child(self):
        for failure in ("construct", "open", "capture"):
            with self.subTest(failure=failure):
                kernel = FakeKernel()
                kernel.fail = failure
                backend = probe.KernelBackend(self.scope, "stop", kernel, self.clock)
                with self.assertRaises(probe.ProbeStartupFailure) as caught:
                    backend.spawn()
                self.assertIs(backend.child, kernel.child)
                self.assertIs(caught.exception.backend.child, kernel.child)
                self.assertTrue(backend.startup_observation()["pending"])
                self.assertEqual(kernel.signals, [])

    def test_startup_reap_does_not_release_alive_or_invalid_pin(self):
        for ready in ("alive", "invalid", "exited"):
            with self.subTest(ready=ready):
                kernel = FakeKernel()
                kernel.fail = "capture"
                backend = probe.KernelBackend(self.scope, "stop", kernel, self.clock)
                with self.assertRaises(probe.ProbeStartupFailure):
                    backend.spawn()
                kernel.status, kernel.ready = 0, ready
                result = backend.startup_observation()
                self.assertTrue(result["actual_waitpid"])
                self.assertEqual(backend.pin_closed, ready == "exited")
                self.assertEqual(backend.pidfd_exit, ready == "exited")
                self.assertEqual(result["pending"], ready != "exited")

    def test_allocated_pidfd_survives_wrapper_failure_until_exit_and_reap(self):
        self.kernel.fail = "open_allocated"
        with self.assertRaises(probe.ProbeStartupFailure):
            self.backend.spawn()
        self.assertEqual(self.kernel.pending_pin_fd, 902)
        self.assertTrue(self.backend.startup_observation()["pending"])
        self.assertFalse(self.backend.resources_closed())
        self.kernel.exit(0)
        self.assertFalse(self.backend.startup_observation()["pending"])
        self.assertTrue(self.backend.resources_closed())
        self.assertEqual(self.kernel.closed, [902])

    def test_known_pin_before_backend_transfer_remains_an_original_obligation(self):
        self.backend.popen_attempted = self.backend.spawn_attempted = True
        self.backend.child = self.kernel.child
        self.kernel.known_pin = self.kernel.pin
        self.backend.waitpid_status = 0
        self.assertIsNone(self.backend.pin)
        self.assertFalse(self.backend.resources_closed())
        self.assertTrue(self.backend.startup_observation()["pending"])
        self.assertIs(self.backend.pin, self.kernel.pin)
        self.kernel.ready = "exited"
        self.assertFalse(self.backend.startup_observation()["pending"])
        self.assertTrue(self.backend.resources_closed())
        self.assertEqual(self.kernel.closed, [self.kernel.pin])

    def test_release_needs_both_exit_and_reap_and_never_reopens(self):
        self.spawn()
        self.kernel.exit(15)
        self.backend.observe(self.backend.pin, self.backend.identity)
        token = self.backend.begin("release", self.backend.pin, self.backend.identity, self.backend.child, 1)
        self.assertEqual(self.backend.poll(token, 0).outcome, "succeeded")
        self.assertEqual(self.kernel.closed, [self.kernel.pin])
        with self.assertRaises(probe.owned.ContractError):
            self.backend.observe(self.backend.pin, self.backend.identity)
        self.assertEqual(self.kernel.spawned, 1)

    def test_failed_owner_preserves_startup_status_and_denies_unadmitted_stop(self):
        self.kernel.fail = "capture"
        with self.assertRaises(probe.ProbeStartupFailure) as caught:
            self.backend.spawn()
        owner = probe.FailureOwner(self.backend, self.clock, caught.exception)
        status = owner.post_control("status")
        stop = owner.post_control("stop_fixture")
        owner.tick()
        self.assertTrue(status.handled)
        self.assertTrue(status.result["original_child_retained"])
        self.assertTrue(status.result["pending_resources"])
        self.assertIsNotNone(stop.error)
        self.assertEqual(self.kernel.signals, [])

    def test_failed_owner_cleanup_is_original_and_bounded(self):
        self.spawn()
        self.kernel.defer_signal = True
        owner = probe.FailureOwner(self.backend, self.clock, OSError("fake actor fault"))
        owner.tick()
        self.clock.advance(.6)
        owner.tick()
        self.assertEqual([action for _pin, action in self.kernel.signals], ["stop", "force_stop"])
        self.clock.advance(6)
        owner.tick()
        self.assertFalse(owner.snapshot()["owner_may_exit"])
        self.assertTrue(owner.snapshot()["pending_resources"])
        count = len(self.kernel.signals)
        owner.tick()
        self.assertEqual(len(self.kernel.signals), count)

    def test_sticky_and_queued_control_loss_survive_actor_failure(self):
        for queued in (False, True):
            with self.subTest(queued=queued):
                kernel = FakeKernel()
                backend = probe.KernelBackend(self.scope, "stop", kernel, self.clock)
                admissions = backend.spawn()
                previous = probe.owned.FixtureOwner(self.scope, admissions, backend, self.clock)
                if queued:
                    previous.post_control_loss(OSError("fake queued channel failure"))
                else:
                    previous.control_lost = True
                owner = probe.FailureOwner(backend, self.clock, OSError("fake actor fault"), previous)
                kernel.exit(15)
                owner.tick()
                owner.report_written = True
                self.assertTrue(owner.control_lost)
                self.assertFalse(owner.snapshot()["owner_may_exit"])

    def test_fixed_child_source_is_six_seconds_and_has_no_fork_exec_or_network(self):
        tree = ast.parse(probe.FIXED_CHILD_CODE)
        imports = [alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names]
        self.assertEqual(imports, ["os", "time"])
        calls = [node.func.attr for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)]
        self.assertEqual(set(calls), {"monotonic", "sleep", "_exit"})
        self.assertEqual(probe.CHILD_HARD_LIFETIME, 6)
        self.assertEqual(hashlib.sha256(probe.FIXED_CHILD_CODE.encode()).hexdigest(), probe.CHILD_CODE_SHA256)
        source = path.read_text()
        self.assertIn('"-I", "-S", "-u", "-c", FIXED_CHILD_CODE', source)
        self.assertNotIn('os.kill(', source)
        self.assertNotIn('nsenter', source)


class ScopeAndContextTests(unittest.TestCase):
    spawn = AdapterTests.spawn
    owner = AdapterTests.owner
    def setUp(self):
        AdapterTests.setUp(self)
        self.temp = tempfile.TemporaryDirectory(prefix="kernel-probe-fake-")
        self.root = Path(self.temp.name)
        self.directory = probe.rpc.PrivateRunDirectory.create(self.root, "4" * 32, "5" * 32, "6" * 32,
                                                             (), (), None, probe.owned.Scope, purpose="kernel_probe")
        self.backend = probe.KernelBackend(self.directory.scope, "stop", self.kernel, self.clock)
        self.scope = self.directory.scope

    def tearDown(self):
        self.directory.close()
        self.temp.cleanup()
        AdapterTests.tearDown(self)

    def test_networkless_scope_does_not_reserve_ports_and_rejects_pause(self):
        self.assertEqual(self.directory.scope.purpose, "kernel_probe")
        self.assertEqual(self.directory.scope.ports, ())
        request = {"version": 1, "run_id": self.directory.scope.run_id, "owner_nonce": self.directory.scope.owner_nonce,
                   "client_nonce": self.directory.scope.client_nonce, "sequence": 1,
                   "idempotency_key": "a" * 32, "operation": "pause_fixture"}
        with self.assertRaises(probe.rpc.ChannelError):
            probe.rpc.validate_request(request, self.directory.scope)

    def test_common_nonce_claims_refuse_cross_phase_reuse(self):
        common = self.root / "common"
        common.mkdir(mode=0o700)
        with patch.object(probe, "PROBE_ROOT", common):
            probe._claim_common_nonces(("7" * 32, "8" * 32, "9" * 32), "7" * 32)
            with self.assertRaises(FileExistsError):
                probe._claim_common_nonces(("b" * 32, "8" * 32, "c" * 32), "b" * 32)

    def test_locator_is_exclusive_private_and_exactly_typed(self):
        value = {"version": 1, "phase": "stop", "run_id": "4" * 32,
                 "owner_nonce": "5" * 32, "client_nonce": "6" * 32,
                 "directory_identity": self.directory.directory_identity,
                 "data_directory_identity": self.directory.data_identity}
        probe._write_locator(self.root, value)
        self.assertEqual((self.root / "locator.json").stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            probe._write_locator(self.root, value)

    def test_explicit_caller_timeout_does_not_submit_the_stop_leg(self):
        requests = []
        def missing(*_args):
            raise FileNotFoundError()
        client = SimpleNamespace(directory=SimpleNamespace(scope=self.scope, close=lambda: None, read=missing),
                                 submit=lambda request: requests.append(request),
                                 caller_result=lambda *_args: {"outcome": "caller_timeout", "pending": True})
        request = {"version": 1, "run_id": self.scope.run_id, "owner_nonce": self.scope.owner_nonce,
                   "client_nonce": self.scope.client_nonce, "sequence": 1, "idempotency_key": "a" * 32, "operation": "status"}
        with patch.object(probe, "_attach_client", return_value=client), patch.object(probe, "MonotonicClock", return_value=self.clock), patch.object(probe, "_new_client_request", return_value=request), patch("sys.stdout", new=io.StringIO()):
            self.assertEqual(probe.run_client("stop", "status_then_stop", True), 2)
        self.assertEqual([request["operation"] for request in requests], ["status"])

    def test_unavailable_control_client_never_starts_an_owner(self):
        with patch.object(probe, "_attach_client", side_effect=FileNotFoundError()), patch.object(probe, "run_owner") as owner, patch("sys.stdout", new=io.StringIO()) as output:
            self.assertEqual(probe.run_client("stop", "status_then_stop", True), 2)
            self.assertFalse(json.loads(output.getvalue())["replacement_owner_started"])
            owner.assert_not_called()

    def test_new_status_is_fresh_and_pending_stop_reuses_its_exact_key(self):
        client = probe.rpc.FileRPCClient(self.directory)
        one = probe._new_client_request(client, "status")
        two = probe._new_client_request(client, "status")
        stop = probe._new_client_request(client, "stop_fixture")
        retry = probe._new_client_request(client, "stop_fixture")
        self.assertEqual((one["sequence"], two["sequence"], stop["sequence"]), (1, 2, 3))
        self.assertNotEqual(one["idempotency_key"], two["idempotency_key"])
        self.assertEqual(stop, retry)

    def test_completed_stop_receipt_is_read_without_a_live_owner_or_new_status(self):
        client = probe.rpc.FileRPCClient(self.directory)
        stop = probe._new_client_request(client, "stop_fixture")
        value = {"version": 1, "run_id": self.scope.run_id, "owner_nonce": self.scope.owner_nonce,
                 "client_nonce": self.scope.client_nonce, "sequence": stop["sequence"],
                 "idempotency_key": stop["idempotency_key"], "operation": "stop_fixture", "terminal": True,
                 "result": {"state": "completed", "observed_bound_satisfied": True}}
        self.directory.write_new(probe.rpc.FileRPC.reply_name(stop, True), value, probe.rpc.MAX_REPLY_BYTES)
        self.directory.write_new(probe.rpc.FileRPC.request_name(stop), stop, probe.rpc.MAX_REQUEST_BYTES)
        with patch.object(probe, "_attach_client", return_value=client), patch.object(probe, "MonotonicClock", return_value=self.clock), patch.object(probe, "_new_client_request") as allocate, patch("sys.stdout", new=io.StringIO()):
            self.assertEqual(probe.run_client("stop", "status_then_stop", True), 0)
            allocate.assert_not_called()

    def test_owner_actor_has_no_stdout_ready_write_that_can_drop_handles(self):
        tree = ast.parse(path.read_text())
        context = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "ProbeContext")
        self.assertFalse(any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "print"
                             for n in ast.walk(context)))

    def test_constructor_and_thread_start_failures_keep_original_backend(self):
        for failure in ("owner", "worker", "thread"):
            with self.subTest(failure=failure):
                kernel = FakeKernel()
                backend = probe.KernelBackend(self.directory.scope, "stop", kernel, self.clock)
                def owner_factory(*args):
                    if failure == "owner":
                        raise OSError("fake owner constructor")
                    return probe.owned.FixtureOwner(*args)
                def worker_factory(*args):
                    if failure == "worker":
                        raise OSError("fake file worker constructor")
                    return probe.FileWorker(*args)
                class Thread(FakeThread):
                    def start(self):
                        if failure == "thread":
                            raise OSError("fake thread start")
                        super().start()
                context = probe.ProbeContext(self.directory, backend, self.clock, owner_factory, worker_factory, Thread)
                try:
                    context.initialize()
                except OSError as error:
                    context.retain_failure(error)
                self.assertIs(context.backend.child, kernel.child)
                self.assertIs(context.backend.pin, kernel.pin)
                self.assertTrue(context.failed)
                context.owner.tick()
                self.assertEqual(kernel.signals[0], (kernel.pin, "stop"))

    def test_actor_tick_and_final_publication_failures_retain_original_handles(self):
        context = probe.ProbeContext(self.directory, self.backend, self.clock, thread_factory=FakeThread)
        context.initialize()
        with patch.object(context.owner, "tick", side_effect=OSError("fake actor failure")):
            try:
                context.step()
            except OSError as error:
                context.retain_failure(error)
        self.assertTrue(context.failed)
        self.assertIs(context.backend.child, self.kernel.child)
        context.owner.tick()
        self.assertEqual(self.kernel.signals, [(self.kernel.pin, "stop")])

    def test_status_then_live_stop_has_phase_evidence_and_flushes_results(self):
        context = probe.ProbeContext(self.directory, self.backend, self.clock, thread_factory=FakeThread)
        context.initialize()
        base = {"version": 1, "run_id": self.scope.run_id, "owner_nonce": self.scope.owner_nonce,
                "client_nonce": self.scope.client_nonce}
        for sequence, operation in ((1, "status"), (2, "stop_fixture")):
            context.worker.front.submit({**base, "sequence": sequence, "operation": operation,
                                         "idempotency_key": f"{sequence:032x}"})
            context.worker.step()
            context.step()
            context.worker.step()
        result = None
        for _ in range(100):
            context.worker.step()
            result = context.step()
            self.clock.advance()
            if result is not None:
                break
        self.assertEqual(result, 0)
        self.assertTrue(context.verdict["phase_objective_observed"])
        self.assertTrue(context.verdict["bounded_phase_success"])
        self.assertEqual(self.backend.waitpid_status, 15)
        self.assertTrue(context.worker.final_results["kernel-probe-final.json"])
        self.assertTrue(all(record["final_written"] for record in context.worker.front.requests.values()
                            if record["operation"] is not None))

    def test_terminal_publication_failure_exits_nonzero_only_after_all_resources_closed(self):
        context = probe.ProbeContext(self.directory, self.backend, self.clock, thread_factory=FakeThread)
        context.initialize()
        context.owner.dispatch("stop_fixture")
        for _ in range(100):
            context.worker.step()
            context.step()
            self.clock.advance()
            if context.final_queued:
                break
        self.assertTrue(context.final_queued)
        self.assertTrue(self.backend.pin_closed)
        self.clock.advance(1.1)
        self.assertEqual(context.step(), 2)
        self.assertTrue(context.delivery_failed)
        self.assertTrue(context.backend.resources_closed())
        self.assertTrue(context.directory.resource_closure()["all_closed"])
        self.assertTrue(all(record["closed"] for record in context.thread_records))
        self.assertTrue(context.jobs_settled)
        self.assertNotEqual(context.step(), 0)

    def test_unknown_process_pin_or_thread_never_becomes_delivery_failure_exit(self):
        context = probe.ProbeContext(self.directory, self.backend, self.clock, thread_factory=FakeThread)
        context.initialize()
        self.kernel.ready = "invalid"
        context.owner.lose_control(OSError("fake channel loss"))
        for _ in range(100):
            context.worker.step()
            self.assertIsNone(context.step())
            self.clock.advance()
        self.assertFalse(context.backend.resources_closed())
        self.assertFalse(context.directory.closed)

    def test_known_unknown_directory_or_thread_preserves_current_control_channel(self):
        context = probe.ProbeContext(self.directory, self.backend, self.clock, thread_factory=FakeThread)
        context.initialize()
        self.kernel.exit(15)
        self.backend.observe(self.backend.pin, self.backend.identity)
        self.backend.begin("release", self.backend.pin, self.backend.identity, self.backend.child, 1)
        self.directory.transient_close_unknown = True
        self.assertFalse(context.resource_exit_gate())
        self.assertFalse(context.worker.stop_event.is_set())
        self.assertFalse(self.directory.data_closed)
        self.assertFalse(self.directory.run_closed)
        self.directory.transient_close_unknown = False
        context.thread_records.append({"thread": FakeThread(), "start_confirmed": False, "closed": False})
        self.assertFalse(context.resource_exit_gate())
        self.assertFalse(context.worker.stop_event.is_set())
        self.assertFalse(self.directory.closed)

    def test_directory_close_keeps_successful_fd_and_unknown_fd_separate(self):
        original = os.close
        failed_fd = self.directory.fd
        calls = []
        def closing(fd):
            calls.append(fd)
            if fd == failed_fd:
                raise OSError("fake uncertain run-fd close")
            return original(fd)
        with patch.object(probe.rpc.os, "close", side_effect=closing):
            with self.assertRaises(OSError):
                self.directory.close()
            self.directory.close()
        self.assertTrue(self.directory.data_closed)
        self.assertTrue(self.directory.run_close_unknown)
        self.assertFalse(self.directory.resource_closure()["all_closed"])
        self.assertEqual(calls.count(self.directory.data_fd), 1)
        self.assertEqual(calls.count(failed_fd), 1)
        original(failed_fd)  # Test's injected failure proved it did not close.

    def test_known_directory_handles_close_after_pre_popen_locator_failure(self):
        phase = self.root / "phase"
        phase.mkdir(mode=0o700)
        with patch.object(probe, "_private_new_root", return_value=phase), patch.object(probe, "_claim_common_nonces"), patch.object(probe.rpc.PrivateRunDirectory, "create", return_value=self.directory), patch.object(probe, "_write_locator", side_effect=OSError("fake locator sink")), patch.object(probe, "LinuxKernel") as kernel:
            self.assertEqual(probe.run_owner("stop", True), 1)
            kernel.assert_not_called()
        self.assertTrue(self.directory.resource_closure()["all_closed"])

    def test_stop_without_an_earlier_live_status_is_not_phase_success(self):
        self.spawn()
        self.backend.begin("stop", self.backend.pin, self.backend.identity, self.backend.child, 1)
        self.backend.observe(self.backend.pin, self.backend.identity)
        ticket = SimpleNamespace(handled=True, error=None)
        front = SimpleNamespace(request_evidence=(probe.RequestEvidence(1, "stop_fixture", True, False, False),))
        owner = SimpleNamespace(errors=[], snapshot=lambda: {"pending_resources": []})
        self.assertFalse(probe.phase_verdict("stop", owner, self.backend, front)["bounded_phase_success"])

    def test_child_closure_without_required_rpc_stop_is_not_phase_success(self):
        owner = self.owner()
        self.kernel.exit(0)
        self.backend.observe(self.backend.pin, self.backend.identity)
        verdict = probe.phase_verdict("stop", owner, self.backend, SimpleNamespace(requests={}))
        self.assertFalse(verdict["phase_objective_observed"])
        self.assertFalse(verdict["bounded_phase_success"])

    def test_file_front_is_independent_of_actor_and_reports_startup_failure(self):
        self.kernel.fail = "capture"
        with self.assertRaises(probe.ProbeStartupFailure) as caught:
            self.backend.spawn()
        owner = probe.FailureOwner(self.backend, self.clock, caught.exception)
        worker = probe.FileWorker(self.directory, owner, self.backend)
        request = {"version": 1, "run_id": self.directory.scope.run_id, "owner_nonce": self.directory.scope.owner_nonce,
                   "client_nonce": self.directory.scope.client_nonce, "sequence": 1,
                   "idempotency_key": "a" * 32, "operation": "status"}
        worker.front.submit(request)
        worker.step()
        owner.tick()
        worker.step()
        reply = worker.front.read_reply(request)
        self.assertEqual(reply["result"]["state"], "retained_failure")
        self.assertTrue(reply["result"]["pending_resources"])
        self.assertEqual(self.kernel.signals, [])


if __name__ == "__main__":
    unittest.main()
