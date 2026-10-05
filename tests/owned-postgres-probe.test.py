"""Pure modeled events only: no process, pin, thread, directory or file fixture."""

from dataclasses import FrozenInstanceError, replace
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "owned_postgres_pure_model", Path(__file__).resolve().parents[1]
    / "scripts/fixtures/owned-postgres-probe.py")
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)


class Opaque:
    def __eq__(self, other):
        raise AssertionError("opaque originals must only be compared with is")


def process(name="root", parent=None, direct=True):
    identity = m.Identity(100 + len(name), "birth-" + name,
                          () if parent is None else ((parent.identity.pid, parent.identity.start),))
    original = m.Original(name, identity, Opaque(), Opaque() if direct else None, parent, direct)
    capture = m.Capture(original, original.pin, original.popen, identity, identity,
                        "fake-image", "fake-image", ("fake-image",))
    return m.ProcessRecord(original, capture)


def fixture(children=2, paused=True, resources=()):
    root = process()
    records = tuple(process("child" + str(i), root.original, False) for i in range(children)) + (root,)
    records = tuple(replace(r, suspension_possible=paused) for r in records)
    owner, client = Opaque(), Opaque()
    exact = m.ExactCoverage(owner, tuple(r.original for r in records), Opaque())
    pins = tuple(m.ResourceRecord(m.Obligation("pin:" + r.original.name, "pin", r.original.pin))
                 for r in records)
    return m.ProbeState(owner, client, root.original, records, (*pins, *resources), 30, 5, exact_coverage=exact)


def control(state, now, verb="status", key=None):
    sequence = state.sequence + 1
    state, receipt = m.receive(state, now, m.Control(state.client, sequence, verb, key or str(sequence)))
    assert receipt is not None
    return m.step(state, now, receipt)[0]


def running(original):
    return m.Observation(original, original.pin, execution="running", identity=original.identity)


def exited(original, status=0, zombie=False, absent=True):
    wait = m.RawWait(original, original.popen, status) if original.direct else None
    return m.Observation(original, original.pin, pin_exit=True,
                         execution="zombie" if zombie else "unknown", lifetime_absent=absent, wait=wait)


def record(state, original):
    return next(r for r in state.processes if r.original is original)


def close_processes(state, now=0):
    for item in state.processes:
        state = m.step(state, now, exited(item.original))[0]
    # Each fake original pin gets a separate positive close observation.
    for item in state.resources:
        if item.obligation.kind == "pin" and any(item.obligation.original is r.original.pin
                                                 for r in state.processes):
            state = m.step(state, now, m.ResourceObservation(item.obligation,
                                                            item.obligation.original, "closed"))[0]
    return state


def family_context(kind="postmaster_fast_shutdown"):
    state = fixture(0, False)
    original = state.root
    binding = m.ProgramBinding("fake-package", "fake-source", ("fake-image",),
                               ("fake-bootstrap-input",), ("fake-library",),
                               "fake-environment", "fake-configuration", ("fixed-fake-argv",))
    contract = m.FamilyContract(kind, original, binding, Opaque(), Opaque(), Opaque())
    state = replace(state, exact_coverage=None, families=(contract,))
    ready = m.NormalReadiness(contract, original, original.pin, original.popen, binding,
                              original.identity, contract.readiness_path)
    if kind == "postmaster_fast_shutdown":
        state = m.step(state, 0, ready)[0]
    return state, contract, ready


def family_fixture(kind="postmaster_fast_shutdown", result="succeeded", issue=True):
    state, contract, ready = family_context(kind)
    original, binding = state.root, contract.binding
    if kind == "postmaster_fast_shutdown":
        if issue:
            state = control(state, 0, "stop")
            if result is not None:
                state = m.step(state, 0, m.ActionResult(record(state, original).stop_request, result))[0]
    state = close_processes(state)
    receipt = m.FamilyReceipt(contract, original, original.pin, original.popen, binding,
                              record(state, original).wait, contract.normal_path,
                              contract.complete_launch_path,
                              "SIGINT" if kind == "postmaster_fast_shutdown" else "normal_success", ready,
                              requested_action=record(state, original).stop_request,
                              action_result=record(state, original).stop_result)
    return state, contract, receipt


class PureTests(unittest.TestCase):
    def setUp(self):
        # Loading test source is harness work. During each modeled test all
        # filesystem/control/resource constructors are guarded against use.
        self.guards = [patch(target, side_effect=AssertionError("runtime operation forbidden"))
                       for target in ("builtins.open", "os.open", "os.mkdir", "os.remove",
                                      "os.kill", "os.fork", "os.posix_spawn", "os.waitpid",
                                      "os.pidfd_open", "subprocess.Popen", "threading.Thread",
                                      "signal.pidfd_send_signal")]
        for guard in self.guards:
            guard.start()
            self.addCleanup(guard.stop)

    def test_immutable_originals_and_actions_have_no_runtime_authority(self):
        state = control(fixture(1), 0, "restore")
        plan = state.actions[0]
        self.assertIs(plan.original, state.processes[0].original)
        self.assertIs(plan.original.pin, state.processes[0].original.pin)
        self.assertFalse(plan.runtime_authority)
        with self.assertRaises(FrozenInstanceError):
            plan.original.pin = Opaque()
        self.assertNotIn("run_owner", vars(m))
        self.assertNotIn("__main__", vars(m))

    def test_restore_stop_replay_share_the_original_pass(self):
        state = control(fixture(1), 0, "restore", "resume-key")
        original_pass, original_action = state.resume, state.actions[0]
        state = control(state, 1, "stop", "stop-key")
        self.assertIs(state.resume, original_pass)
        self.assertIs(state.resume.attempts[0].plan, original_action)
        self.assertEqual(state.cleanup.deadline, 21)
        count = len(state.actions)
        for verb, key in (("restore", "resume-key"), ("stop", "stop-key")):
            state = control(state, 1, verb, key)
        self.assertEqual(len(state.actions), count)
        self.assertEqual(state.resume.child_deadline, 6)
        self.assertEqual(state.resume.root_deadline, 8)

    def test_32_lifetimes_do_not_promise_32_child_attempts_in_six_seconds(self):
        state = control(fixture(31), 0, "stop")
        for now in (2, 4, 6):
            state = m.step(state, now)[0]
        continues = [p for p in state.actions if p.kind == "continue"]
        self.assertEqual([p.original.name for p in continues], ["child0", "child1", "child2", "root"])
        unissued = state.resume.attempts[3:-1]
        self.assertEqual(len(unissued), 28)
        for attempt in unissued:
            self.assertEqual(attempt.status, "not_issued: child_phase_expired")
            self.assertIsNone(attempt.plan)
            self.assertTrue(record(state, attempt.original).suspension_possible)
        self.assertEqual(continues[-1].deadline, 8)
        self.assertFalse(m.exit_gate(state).may_exit)

    def test_child_errors_preserve_independent_root_window(self):
        state = control(fixture(2), 0, "stop")
        state = m.step(state, 2, m.ActionResult(state.actions[-1], "error"))[0]
        state = m.step(state, 4, m.ActionResult(state.actions[-1], "error"))[0]
        self.assertIs(state.actions[-1].original, state.root)
        self.assertEqual(state.actions[-1].deadline, 6)
        self.assertEqual(state.resume.root_deadline, 8)
        state = m.step(state, 8)[0]
        self.assertEqual(state.actions[-1].kind, "request_SIGINT")
        self.assertEqual(state.cleanup.stop_plan.deadline, 10)

    def test_clock_jump_does_not_invent_root_attempt(self):
        state = control(fixture(31), 0, "stop")
        state = m.step(state, 9)[0]
        root_attempt = state.resume.attempts[-1]
        self.assertEqual(root_attempt.status, "not_issued: root_phase_expired")
        self.assertIsNone(root_attempt.plan)
        self.assertEqual([p.kind for p in state.actions], ["continue", "request_SIGINT"])

    def test_jump_past_stop_window_records_no_request(self):
        state = control(fixture(), 0, "stop")
        state = m.step(state, 25)[0]
        self.assertEqual(state.cleanup.stop_status, "not_issued: root_stop_phase_expired")
        self.assertEqual(len(state.actions), 1)
        self.assertFalse(m.exit_gate(state).may_exit)

    def test_stop_after_unresolved_resume_never_restarts_expired_pass(self):
        state = control(fixture(1), 0, "restore", "resume")
        state = control(state, 4, "status")
        state = m.step(state, 6)[0]
        state = control(state, 8, "status")
        self.assertIsNone(state.cleanup)
        original_pass, count = state.resume, len(state.actions)
        state = control(state, 9, "stop")
        self.assertIs(state.resume, original_pass)
        self.assertEqual(sum(p.kind == "continue" for p in state.actions), count)
        self.assertEqual(state.cleanup.deadline, 29)
        self.assertTrue(record(state, state.root).suspension_possible)

    def test_lease_loss_during_resume_keeps_original_action_deadline(self):
        state = control(fixture(1), 0, "restore")
        state = replace(state, lease_deadline=1)
        original_plan = state.actions[0]
        state = m.step(state, 1)[0]
        self.assertEqual(state.cleanup.deadline, 21)
        self.assertIs(state.resume.attempts[0].plan, original_plan)
        self.assertEqual(original_plan.deadline, 2)
        self.assertEqual(state.resume.root_deadline, 8)

    def test_already_continued_and_closed_objects_are_never_resignalled(self):
        state = fixture(2)
        state = m.step(state, 0, running(state.processes[0].original))[0]
        state = m.step(state, 0, exited(state.processes[1].original))[0]
        state = m.step(state, 0, exited(state.root))[0]
        state = control(state, 0, "restore")
        state = control(state, 0, "stop")
        self.assertEqual(state.actions, ())

    def test_exit_after_continue_discharges_suspension_without_running_claim(self):
        state = control(fixture(1), 0, "restore")
        child = state.processes[0].original
        state = m.step(state, 1, exited(child))[0]
        item = record(state, child)
        self.assertTrue(item.closed)
        self.assertFalse(item.suspension_possible)
        self.assertFalse(item.running_confirmed)
        self.assertEqual(item.closure_method, "original_pin_exit_and_lifetime_absent")
        self.assertIsNone(item.wait)
        self.assertFalse(item.actual_waitpid)

    def test_zombie_is_not_closed_but_exit_discharges_suspension(self):
        item = process()
        item = m.observe(item, exited(item.original, zombie=True))
        self.assertFalse(item.closed)
        self.assertFalse(item.suspension_possible)

    def test_parent_reaped_child_has_no_fabricated_waitpid(self):
        state = fixture(1)
        child = state.processes[0]
        item = m.observe(child, exited(child.original))
        self.assertTrue(item.closed)
        self.assertIsNone(item.wait)
        self.assertFalse(item.actual_waitpid)
        self.assertEqual(item.closure_method, "original_pin_exit_and_lifetime_absent")

    def test_pid_absence_echild_root_exit_and_pin_exit_alone_do_not_close_child(self):
        state = fixture(1)
        child = state.processes[0]
        for event in (m.Observation(child.original, child.original.pin, lifetime_absent=True),
                      m.Observation(child.original, child.original.pin, wait="ECHILD"),
                      exited(state.root), exited(child.original, absent=False)):
            with self.subTest(event=event.execution):
                self.assertFalse(m.observe(child, event).closed)

    def test_direct_root_requires_matched_raw_terminal_wait_and_original_popen(self):
        item = process()
        for wait in (None, "ECHILD", m.RawWait(item.original, Opaque(), 0),
                     m.RawWait(replace(item.original), item.original.popen, 0),
                     m.RawWait(item.original, item.original.popen, False),
                     m.RawWait(item.original, item.original.popen, 127),
                     m.RawWait(item.original, item.original.popen, 65535)):
            with self.subTest(wait_type=type(wait).__name__):
                event = replace(exited(item.original), wait=wait)
                self.assertFalse(m.observe(item, event).closed)
        self.assertTrue(m.observe(item, exited(item.original, 15)).closed)

    def test_bootstrap_and_partial_startup_obligations_remain_independent(self):
        state = fixture(0)
        bootstrap = process("initdb")
        shell = process("bootstrap-shell", bootstrap.original, False)
        failed = m.ProcessRecord(m.Original("failed-popen", m.Identity(201, "unknown", ()), None, None, direct=True))
        obligations = tuple(m.ResourceRecord(m.Obligation(name, kind, Opaque())) for name, kind in
                            (("raw-pin", "raw_pin"), ("wrapped-pin", "pin"),
                             ("partial-popen", "candidate"), ("bootstrap-input", "file")))
        state = replace(state, processes=(*state.processes, bootstrap, shell, failed), resources=obligations)
        state = m.step(state, 0, exited(state.root))[0]
        gate = m.exit_gate(state)
        for name in ("process:initdb", "process:bootstrap-shell", "process:failed-popen",
                     "resource:raw-pin", "resource:wrapped-pin", "resource:partial-popen"):
            self.assertIn(name, gate.pending)
        state = control(state, 0, "stop")
        self.assertFalse(any(p.original is failed.original for p in state.actions))

    def test_late_birth_invalidates_fixed_ledger_and_stays_unadmitted(self):
        state = fixture(0, False)
        newcomer = process("late-child", state.root, False).original
        state = m.step(state, 0, m.Birth(newcomer))[0]
        self.assertFalse(m.coverage_proof(state).passed)
        self.assertIsNone(record(state, newcomer).capture)
        self.assertFalse(any(p.original is newcomer for p in state.actions))
        self.assertEqual(state.errors[0], "new_birth_unadmitted")

    def test_empty_topology_and_process_count_cannot_cover_unseen_births(self):
        state = close_processes(replace(fixture(0, False), exact_coverage=None))
        state = m.step(state, 0, {"process_count": 0, "process_group_empty": True})[0]
        self.assertFalse(m.coverage_proof(state).passed)
        self.assertIn("birth_coverage", m.exit_gate(state).pending)

    def test_both_separate_fake_normal_family_contracts(self):
        for kind in ("initdb_normal_success", "postmaster_fast_shutdown"):
            with self.subTest(kind=kind):
                state, contract, receipt = family_fixture(kind)
                proof = m.family_proof(contract, receipt, record(state, state.root))
                self.assertTrue(proof.passed, proof.reasons)
                self.assertFalse(proof.runtime_authority)
                state = m.step(state, 0, receipt)[0]
                self.assertTrue(m.coverage_proof(state).passed)

    def test_family_rejects_other_legal_capture_images_outside_its_contract(self):
        for kind in ("initdb_normal_success", "postmaster_fast_shutdown"):
            state, contract, receipt = family_fixture(kind)
            root = record(state, state.root)
            for before, after in (("other-image", "other-image"), ("fake-image", "other-image"),
                                  ("other-image", "fake-image")):
                with self.subTest(kind=kind, before=before, after=after):
                    capture = replace(root.capture, image_before=before, image_after=after,
                                      reviewed_images=("fake-image", "other-image"), witnessed_exec=True)
                    self.assertTrue(m.admitted(state.root, capture))
                    proof = m.family_proof(contract, receipt, replace(root, capture=capture))
                    self.assertFalse(proof.passed, proof.reasons)

    def test_family_requires_successful_sigint_result_before_natural_exit_zero(self):
        for result, issue in ((None, False), (None, True), ("error", True), ("unknown", True),
                              ("not_issued", True)):
            with self.subTest(result=result, issue=issue):
                state, contract, receipt = family_fixture(result=result, issue=issue)
                root = record(state, state.root)
                self.assertTrue(root.closed)
                self.assertEqual(root.wait.status, 0)
                self.assertFalse(m.family_proof(contract, receipt, root).passed)

    def test_family_receipt_rejects_assertions_and_copied_originals(self):
        state, contract, receipt = family_fixture()
        variants = (True, {"all_closed": True}, replace(receipt, root=replace(state.root)),
                    replace(receipt, pin=Opaque()), replace(receipt, popen=Opaque()),
                    replace(receipt, contract=replace(contract)), replace(receipt, wait=replace(receipt.wait)))
        for value in variants:
            with self.subTest(value_type=type(value).__name__):
                self.assertFalse(m.family_proof(contract, value, record(state, state.root)).passed)
        for malformed in ((True,), (Opaque(),)):
            trial = m.step(state, 0, replace(receipt, memberships=malformed))[0]
            self.assertFalse(m.coverage_proof(trial).passed)

    def test_family_requires_all_program_bindings_and_reviewed_paths(self):
        state, contract, receipt = family_fixture()
        for field in ("package", "source", "images", "bootstrap_inputs", "dependencies",
                      "environment", "configuration", "argv"):
            with self.subTest(field=field):
                empty = () if isinstance(getattr(contract.binding, field), tuple) else ""
                binding = replace(contract.binding, **{field: empty})
                bad_contract = replace(contract, binding=binding)
                bad_receipt = replace(receipt, contract=bad_contract, binding=binding)
                self.assertFalse(m.family_proof(bad_contract, bad_receipt, record(state, state.root)).passed)
                mismatch = replace(receipt, binding=replace(receipt.binding, **{field: empty}))
                self.assertFalse(m.family_proof(contract, mismatch, record(state, state.root)).passed)
        for field in ("normal_path", "complete_launch_path"):
            self.assertFalse(m.family_proof(contract, replace(receipt, **{field: Opaque()}),
                                            record(state, state.root)).passed)
            assertion_contract = replace(contract, **{field: True})
            assertion_receipt = replace(receipt, contract=assertion_contract, **{field: True})
            self.assertFalse(m.family_proof(assertion_contract, assertion_receipt,
                                            record(state, state.root)).passed)

    def test_family_rejects_failure_forced_kill_and_missing_readiness(self):
        state, contract, receipt = family_fixture()
        for changes in ({"forced": True}, {"error_path": True}, {"uncovered_birth": True},
                        {"action": "SIGKILL"}, {"readiness": None}, {"readiness": True},
                        {"readiness": replace(receipt.readiness, pin=Opaque())}):
            self.assertFalse(m.family_proof(contract, replace(receipt, **changes), record(state, state.root)).passed)
        nonzero = m.RawWait(state.root, state.root.popen, 256)
        bad_root = replace(record(state, state.root), wait=nonzero)
        self.assertFalse(m.family_proof(contract, replace(receipt, wait=nonzero), bad_root).passed)
        self.assertFalse(m.family_proof(contract, receipt, replace(bad_root, pin_exit=False)).passed)

    def test_running_alone_and_copied_or_unbound_ready_do_not_prove_normal_readiness(self):
        state, contract, receipt = family_fixture()
        for ready in (running(state.root), replace(receipt.readiness),
                      replace(receipt.readiness, reviewed_path=Opaque()),
                      replace(receipt.readiness, binding=replace(contract.binding, configuration="wrong")),
                      replace(receipt.readiness, popen=Opaque())):
            root = record(state, state.root)
            self.assertFalse(m.family_proof(contract, replace(receipt, readiness=ready), root).passed)
        root = replace(record(state, state.root), normal_ready=None)
        self.assertFalse(m.family_proof(contract, receipt, root).passed)
        before_ready = fixture(0, False)
        before_contract = replace(contract, root=before_ready.root)
        before_ready = control(replace(before_ready, families=(before_contract,)), 0, "stop")
        late = replace(receipt.readiness, contract=before_contract, root=before_ready.root,
                       pin=before_ready.root.pin, popen=before_ready.root.popen,
                       identity=before_ready.root.identity)
        before_ready = m.step(before_ready, 0, late)[0]
        self.assertIsNone(record(before_ready, before_ready.root).normal_ready)

    def test_normal_family_requires_original_owner_sigint_action_binding(self):
        state, contract, receipt = family_fixture()
        for action in (None, True, "SIGINT", replace(receipt.requested_action),
                       replace(receipt.requested_action, original=replace(state.root)),
                       replace(receipt.requested_action, kind="SIGKILL")):
            self.assertFalse(m.family_proof(contract, replace(receipt, requested_action=action),
                                            record(state, state.root)).passed)

    def test_family_never_clears_individual_unknowns(self):
        state, contract, receipt = family_fixture()
        state = replace(state, resources=tuple(m.ResourceRecord(m.Obligation(k, k, Opaque()))
                                              for k in ("candidate", "pin", "fd", "thread", "job")))
        resources, processes = state.resources, state.processes
        state = m.step(state, 0, receipt)[0]
        self.assertTrue(m.coverage_proof(state).passed)
        self.assertIs(state.resources, resources)
        self.assertIs(state.processes, processes)
        self.assertFalse(m.exit_gate(state).may_exit)
        for item in resources:
            self.assertIn("resource:" + item.obligation.name, m.exit_gate(state).pending)

    def test_family_cannot_cover_outside_lineage_or_erase_known_child_exit(self):
        state, contract, receipt = family_fixture()
        foreign = process("foreign", None, False)
        state = replace(state, processes=(*state.processes, foreign))
        state = m.step(state, 0, receipt)[0]
        self.assertFalse(m.coverage_proof(state).passed)
        child = process("known", state.root, False)
        state = replace(state, processes=(state.processes[0], child))
        self.assertFalse(m.coverage_proof(state).passed)
        self.assertIn("process:known", m.exit_gate(state).pending)
        self.assertIsNone(child.wait)

    def test_action_result_and_disposition_are_independent_in_both_event_orders(self):
        for outcome in ("succeeded", "error", "unknown"):
            for observation_kind in ("running", "exit"):
                for acknowledgment_first in (True, False):
                    with self.subTest(outcome=outcome, observation=observation_kind,
                                      acknowledgment_first=acknowledgment_first):
                        state = control(fixture(1), 0, "restore")
                        plan, original = state.actions[0], state.processes[0].original
                        ack = m.ActionResult(plan, outcome)
                        observation = running(original) if observation_kind == "running" else exited(original)
                        events = (ack, observation) if acknowledgment_first else (observation, ack)
                        for now, event in zip((.1, .2), events):
                            state = m.step(state, now, event)[0]
                            if event is observation and not acknowledgment_first:
                                self.assertEqual(len(state.actions), 1)
                        attempt = state.resume.attempts[0]
                        self.assertIs(attempt.action_result, ack)
                        self.assertEqual(attempt.status, "acknowledged" if outcome == "succeeded"
                                         else "attempted_" + outcome)
                        self.assertEqual(attempt.disposition, "continued" if observation_kind == "running"
                                         else "exited")
                        root_plan = state.actions[-1]
                        self.assertIs(root_plan.original, state.root)
                        state = m.step(state, .3, m.ActionResult(root_plan, "succeeded"))[0]
                        state = m.step(state, .4, running(state.root))[0]
                        state = close_processes(state, .5)
                        state = m.step(state, .5, m.Publication("succeeded"))[0]
                        gate = m.exit_gate(state)
                        self.assertTrue(gate.may_exit, gate.pending)
                        self.assertEqual(gate.exit_code, 0 if outcome == "succeeded" else 1)
                        self.assertIs(state.resume.attempts[0].action_result, ack)

    def test_positive_exit_does_not_invent_an_ack_or_accept_a_late_ack(self):
        state = control(fixture(0), 0, "restore")
        plan = state.actions[0]
        state = close_processes(state, .1)
        state = m.step(state, .1, m.Publication("succeeded"))[0]
        self.assertIn("action:continue:root", m.exit_gate(state).pending)
        self.assertEqual(state.resume.attempts[0].disposition, "exited")
        state = m.step(state, 2, m.ActionResult(plan, "succeeded"))[0]
        self.assertIsNone(state.resume.attempts[0].action_result)
        self.assertEqual(state.resume.attempts[0].status, "attempted_unknown")
        self.assertEqual(m.exit_gate(state).exit_code, 1)

    def test_sigint_result_requires_exact_accepted_event_and_timely_first_result(self):
        state, contract, receipt = family_fixture()
        for result in (True, replace(receipt.action_result),
                       replace(receipt.action_result, plan=replace(receipt.requested_action))):
            self.assertFalse(m.family_proof(contract, replace(receipt, action_result=result),
                                            record(state, state.root)).passed)
        for initial in (None, "error", "unknown"):
            state, contract, receipt = family_fixture(result=initial)
            late = m.ActionResult(receipt.requested_action, "succeeded")
            state = m.step(state, 2 if initial is None else 1, late)[0]
            updated = replace(receipt, action_result=record(state, state.root).stop_result)
            self.assertFalse(m.family_proof(contract, updated, record(state, state.root)).passed)

    def test_receive_freezes_original_key_receipt_under_both_service_orders_and_expiry(self):
        for now in (4.999, 5, 5.001):
            for replay_first in (True, False):
                with self.subTest(now=now, replay_first=replay_first):
                    state = fixture(0, False)
                    state, original = m.receive(state, 1, m.Control(state.client, 1, "status", "K"))
                    state, replay = m.receive(state, 4, m.Control(state.client, 2, "status", "K"))
                    self.assertIs(replay, original)
                    self.assertEqual(replay.control.sequence, 1)
                    self.assertEqual(replay.received_at, 1)
                    self.assertEqual(len(state.receipts), 1)
                    for event in ((replay, original) if replay_first else (original, replay)):
                        state = m.step(state, now, event)[0]
                    self.assertEqual(state.lease_deadline, 6 if now < 5 else 5)
                    self.assertEqual(state.cleanup is not None, now >= 5)

    def test_key_verb_conflict_is_rejected_at_receive_before_service(self):
        for first, second in (("stop", "status"), ("status", "stop")):
            state = fixture(0, False)
            state, original = m.receive(state, 1, m.Control(state.client, 1, first, "K"))
            state, rejected = m.receive(state, 4, m.Control(state.client, 2, second, "K"))
            self.assertIsNone(rejected)
            self.assertIn("key_verb_conflict", state.rejections)
            self.assertEqual(state.sequence, 1)
            self.assertIs(state.receipts[0], original)
            state = m.step(state, 4, original)[0]
            if first == "stop":
                self.assertIsNotNone(state.cleanup)
                self.assertEqual(state.actions[-1].kind, "request_SIGINT")
            else:
                self.assertIsNone(state.cleanup)
                self.assertEqual(state.lease_deadline, 6)

    def test_original_raw_wait_and_pin_exit_can_arrive_in_either_order(self):
        for wait_first in (True, False):
            original = process().original
            state = replace(fixture(0, False), root=original, processes=(m.ProcessRecord(original),))
            wait = m.RawWait(original, original.popen, 0)
            events = (m.Observation(original, original.pin, wait=wait),
                      m.Observation(original, original.pin, pin_exit=True))
            if not wait_first:
                events = tuple(reversed(events))
            state = m.step(state, 0, events[0])[0]
            self.assertFalse(record(state, original).closed)
            if wait_first:
                self.assertIs(record(state, original).wait, wait)
                self.assertTrue(record(state, original).actual_waitpid)
            state = m.step(state, .1, events[1])[0]
            self.assertTrue(record(state, original).closed)
            self.assertIs(record(state, original).wait, wait)

    def test_terminal_raw_wait_alone_blocks_new_ready_membership_and_signal_plans(self):
        state, contract, ready = family_context()
        child = process("after-root-wait", state.root, False)
        state = replace(state, processes=(replace(state.processes[0], normal_ready=None), child))
        wait = m.RawWait(state.root, state.root.popen, 0)
        state = m.step(state, 0, m.Observation(state.root, state.root.pin, wait=wait))[0]
        state = m.step(state, 0, ready)[0]
        self.assertIsNone(record(state, state.root).normal_ready)
        member = m.ManagedMembership(state.owner, contract, child.original, child.capture,
                                     state.root, contract.binding, contract.complete_launch_path)
        state = m.step(state, 0, member)[0]
        self.assertEqual(state.memberships, ())
        state = control(state, 0, "stop")
        self.assertFalse(any(a.original is state.root for a in state.actions))
        self.assertFalse(record(state, state.root).closed)

    def test_old_family_receipt_cannot_cover_a_new_birth_after_its_root_exit(self):
        state, contract, receipt = family_fixture()
        state = m.step(state, 0, receipt)[0]
        child = process("new-managed-looking-child", state.root, False)
        state = m.step(state, 0, m.Birth(child.original))[0]
        pin = m.ResourceRecord(m.Obligation("new-pin", "pin", child.original.pin))
        state = replace(state, resources=(*state.resources, pin))
        member = m.ManagedMembership(state.owner, contract, child.original, child.capture,
                                     state.root, contract.binding, contract.complete_launch_path)
        state = m.step(state, 0, member)[0]
        self.assertEqual(state.memberships, ())
        state = close_processes(state)
        state = m.step(state, 0, m.Publication("succeeded"))[0]
        self.assertTrue(record(state, child.original).closed)
        self.assertFalse(m.coverage_proof(state).passed)
        self.assertIn("birth_coverage", m.exit_gate(state).pending)

    def test_managed_birth_requires_registered_bound_membership_and_keeps_unknown_resources(self):
        state, contract, ready = family_context()
        child = process("managed-birth", state.root, False)
        state = m.step(state, 0, m.Birth(child.original))[0]
        member = m.ManagedMembership(state.owner, contract, child.original, child.capture,
                                     state.root, contract.binding, contract.complete_launch_path)
        state = m.step(state, 0, member)[0]
        self.assertIs(state.memberships[0], member)
        self.assertIsNone(record(state, child.original).capture)
        plan = record(state, state.root).stop_request
        result = m.ActionResult(plan, "succeeded")
        state = m.step(state, .1, result)[0]
        pin = m.ResourceRecord(m.Obligation("new-pin", "pin", child.original.pin))
        state = replace(state, resources=(*state.resources, pin))
        state = close_processes(state, .2)
        root = record(state, state.root)
        receipt = m.FamilyReceipt(contract, state.root, state.root.pin, state.root.popen,
                                  contract.binding, root.wait, contract.normal_path,
                                  contract.complete_launch_path, "SIGINT", ready,
                                  requested_action=plan, action_result=result, memberships=(member,))
        for members in ((), (replace(member),), (True,)):
            trial = m.step(state, .2, replace(receipt, memberships=members))[0]
            self.assertFalse(m.coverage_proof(trial).passed)
        state = m.step(state, .2, receipt)[0]
        self.assertTrue(m.coverage_proof(state).passed)
        unknowns = tuple(m.ResourceRecord(m.Obligation(k, k, Opaque())) for k in ("pin", "thread", "job"))
        state = replace(state, resources=(*state.resources, *unknowns))
        resources = state.resources
        state = m.step(state, .2, m.Publication("succeeded"))[0]
        self.assertIs(state.resources, resources)
        for item in unknowns:
            self.assertIn("resource:" + item.obligation.name, m.exit_gate(state).pending)

    def test_failed_capture_wrong_image_foreign_owner_and_parent_cannot_claim_membership(self):
        state, contract, ready = family_context()
        child = process("candidate", state.root, False)
        state = replace(state, processes=(*state.processes, replace(child, capture=None)))
        member = m.ManagedMembership(state.owner, contract, child.original, child.capture,
                                     state.root, contract.binding, contract.complete_launch_path)
        for candidate in (replace(member, capture=replace(child.capture, io_known=False)),
                          replace(member, capture=replace(child.capture, image_before="other",
                                  image_after="other", reviewed_images=("other",))),
                          replace(member, owner=Opaque()), replace(member, parent=replace(state.root)),
                          replace(member, complete_launch_path=Opaque())):
            trial = m.step(state, 0, candidate)[0]
            self.assertEqual(trial.memberships, ())
        failed = replace(state, processes=(state.processes[0], replace(child,
                                      capture=replace(child.capture, io_known=False))))
        self.assertEqual(m.step(failed, 0, member)[0].memberships, ())
        state = control(failed, 0, "stop")
        plan = record(state, state.root).stop_request
        result = m.ActionResult(plan, "succeeded")
        state = m.step(state, 0, result)[0]
        state = close_processes(state)
        root = record(state, state.root)
        receipt = m.FamilyReceipt(contract, state.root, state.root.pin, state.root.popen,
                                  contract.binding, root.wait, contract.normal_path,
                                  contract.complete_launch_path, "SIGINT", ready,
                                  requested_action=plan, action_result=result)
        state = m.step(state, 0, receipt)[0]
        self.assertTrue(record(state, child.original).closed)
        self.assertFalse(m.coverage_proof(state).passed)

    def test_reused_pid_start_ancestry_unknown_io_and_exec_cannot_admit(self):
        item = process()
        cap = item.capture
        variants = (replace(cap, before=replace(cap.before, pid=999)),
                    replace(cap, after=replace(cap.after, start="reused")),
                    replace(cap, after=replace(cap.after, ancestors=((999, "old"),))),
                    replace(cap, io_known=False), replace(cap, pin=Opaque()),
                    replace(cap, original=replace(item.original)),
                    replace(cap, image_after="new-image", reviewed_images=("fake-image", "new-image")))
        for capture in variants:
            self.assertFalse(m.admitted(item.original, capture))
            state = replace(fixture(0), root=item.original, processes=(replace(item, capture=capture),))
            state = control(state, 0, "stop")
            self.assertEqual(state.actions, ())
        self.assertTrue(m.admitted(item.original, replace(variants[-1], witnessed_exec=True)))

    def test_copied_pin_exit_and_unknown_io_are_not_positive_observations(self):
        item = process()
        for changes in ({"original": replace(item.original)}, {"pin": Opaque()}, {"io_known": False}):
            self.assertIs(m.observe(item, replace(exited(item.original), **changes)), item)

    def test_expiry_before_accept_and_service_at_exact_boundary(self):
        for now, expired in ((4.999, False), (5, True), (5.001, True)):
            with self.subTest(now=now):
                state = control(fixture(0, False), now)
                self.assertEqual(state.cleanup is not None, expired)
                self.assertEqual(state.lease_deadline, 5 if expired else now + 5)
                self.assertEqual(state.receipts[-1].received_at, now)

    def test_receipt_time_is_owner_created_and_delayed_renewal_uses_it_once(self):
        state = fixture(0, False)
        request = m.Control(state.client, 1, "status", "heartbeat")
        state, receipt = m.receive(state, 1, request)
        state = m.step(state, 2, receipt)[0]
        self.assertEqual(receipt.received_at, 1)
        self.assertEqual(state.lease_deadline, 6)
        state = m.step(state, 3, receipt)[0]
        self.assertEqual(state.lease_deadline, 6)
        self.assertIn("replayed_receipt", state.rejections)

    def test_queued_activity_delivered_at_expiry_cannot_revive_lease(self):
        state = fixture(0, False)
        state, receipt = m.receive(state, 4.9, m.Control(state.client, 1, "status", "queued"))
        state = m.step(state, 5, receipt)[0]
        self.assertEqual(state.lease_deadline, 5)
        self.assertEqual(state.errors[0], "driver_lease_lost")
        self.assertIsNotNone(state.cleanup)

    def test_future_stale_foreign_copied_and_sequence_replayed_receipts_rejected(self):
        state = fixture(0, False)
        state, receipt = m.receive(state, 1, m.Control(state.client, 1, "status", "one"))
        variants = (replace(receipt, received_at=3), replace(receipt, owner=Opaque()),
                    replace(receipt), replace(receipt, control=replace(receipt.control, client=Opaque())))
        for value in variants:
            changed = m.step(state, 2, value)[0]
            self.assertEqual(changed.lease_deadline, 5)
            self.assertTrue(changed.rejections)
        stale = m.step(state, 6, receipt)[0]
        self.assertIn("stale_receipt", stale.rejections)
        replayed, value = m.receive(state, 2, receipt.control)
        self.assertIsNone(value)
        self.assertEqual(len(replayed.receipts), 1)

    def test_replayed_status_key_and_internal_ticks_are_not_activity(self):
        state = control(fixture(0, False), 1, key="status-key")
        state = control(state, 2, key="status-key")
        self.assertEqual(state.lease_deadline, 6)
        state = m.step(state, 6)[0]
        self.assertEqual(state.errors[0], "driver_lease_lost")

    def test_workload_expiry_wins_over_fresh_lease_renewal(self):
        state = replace(fixture(0, False), workload_deadline=5, lease_deadline=6)
        state = control(state, 5)
        self.assertEqual(state.errors[0], "workload_expired")
        self.assertEqual(state.lease_deadline, 6)
        self.assertEqual(state.workload_deadline, 5)

    def test_nonfinite_or_backwards_clock_cannot_poison_deadlines(self):
        state = m.step(fixture(), 1)[0]
        for now in (float("nan"), float("inf"), -.5, True):
            with self.assertRaises(ValueError):
                m.step(state, now)
        self.assertEqual(state.now, 1)
        with self.assertRaises(ValueError):
            m.step(replace(state, lease_deadline=True), 1)

    def test_client_loss_node_error_and_publication_failure_need_no_callback(self):
        for event in (None, m.DriverFailure("node_error"), m.Publication("failed")):
            with self.subTest(event=type(event).__name__):
                state = fixture(0, False)
                state = m.step(state, 5 if event is None else 0, event)[0]
                self.assertIsNotNone(state.cleanup)
                self.assertEqual(state.actions[-1].kind, "request_SIGINT")
                self.assertIs(state.actions[-1].original, state.root)
                self.assertFalse(m.exit_gate(state).may_exit)

    def test_primary_and_secondary_failures_are_preserved(self):
        state = m.step(fixture(0, False), 0, m.DriverFailure("node_error"))[0]
        state = m.step(state, 0, m.Publication("failed"))[0]
        state = m.step(state, 0, m.DriverFailure("node_error"))[0]
        self.assertEqual(state.errors, ("node_error", "publication_failed"))

    def test_partial_close_blocked_worker_unknown_start_and_job_stay_pending(self):
        names = (("pin", "partial_close"), ("raw_pin", "unknown"), ("fd", "partial_close"),
                 ("file", "unknown"), ("directory", "partial_close"), ("thread", "blocked"),
                 ("thread", "start_unknown"), ("job", "unsettled"), ("candidate", "unknown"))
        resources = tuple(m.ResourceRecord(m.Obligation(str(i), kind, Opaque()))
                          for i, (kind, outcome) in enumerate(names))
        state = close_processes(fixture(0, False, resources))
        state = m.step(state, 0, m.Publication("failed"))[0]
        for resource, (_, outcome) in zip(resources, names):
            state = m.step(state, 0, m.ResourceObservation(resource.obligation,
                                                         resource.obligation.original, outcome))[0]
        self.assertFalse(m.exit_gate(state).may_exit)
        for resource in resources:
            self.assertIn("resource:" + resource.obligation.name, m.exit_gate(state).pending)

    def test_delivery_only_failure_can_exit_nonzero_only_after_full_gate(self):
        resources = tuple(m.ResourceRecord(m.Obligation(kind, kind, Opaque()))
                          for kind in ("pin", "fd", "file", "directory", "thread", "job", "candidate"))
        state = close_processes(fixture(0, False, resources))
        state = m.step(state, 0, m.Publication("failed"))[0]
        self.assertFalse(m.exit_gate(state).may_exit)
        for resource in resources:
            outcome = {"thread": "joined", "job": "settled", "candidate": "disposed"}.get(
                resource.obligation.kind, "closed")
            state = m.step(state, 0, m.ResourceObservation(resource.obligation,
                                                         resource.obligation.original, outcome))[0]
        gate = m.exit_gate(state)
        self.assertTrue(gate.may_exit, gate.pending)
        self.assertEqual(gate.exit_code, 1)

    def test_copied_resource_and_bare_closed_assertion_do_not_discharge_gate(self):
        resource = m.ResourceRecord(m.Obligation("fd", "fd", Opaque()))
        state = fixture(0, False, (resource,))
        state = m.step(state, 0, m.ResourceObservation(replace(resource.obligation),
                                                     resource.obligation.original, "closed"))[0]
        self.assertFalse(m.resource_closed(state.resources[0]))
        state = replace(state, processes=(replace(state.processes[0], closed=True),))
        self.assertIn("process:root", m.exit_gate(state).pending)

    def test_unknown_resource_kind_is_never_proved_closed(self):
        resource = m.ResourceRecord(m.Obligation("unknown", "other", Opaque()), "unprovable")
        self.assertFalse(m.resource_closed(resource))

    def test_numeric_handles_and_assertion_only_launch_coverage_do_not_authorize(self):
        item = process()
        numeric = replace(item.original, pin=101, popen=201)
        capture = replace(item.capture, original=numeric, pin=101, popen=201)
        self.assertFalse(m.admitted(numeric, capture))
        resource = m.ResourceRecord(m.Obligation("unknown-fd", "fd", 101), "closed")
        self.assertFalse(m.resource_closed(resource))
        state = fixture(0, False)
        state = replace(state, exact_coverage=replace(state.exact_coverage, complete_launch_path=True))
        self.assertFalse(m.coverage_proof(state).passed)

    def test_action_acknowledgment_is_not_running_or_disposal_proof(self):
        state = control(fixture(0), 0, "restore")
        plan = state.actions[-1]
        state = m.step(state, 1, m.ActionResult(plan, "succeeded"))[0]
        self.assertTrue(record(state, state.root).suspension_possible)
        self.assertFalse(record(state, state.root).running_confirmed)
        self.assertFalse(record(state, state.root).closed)
        state = control(state, 1, "stop")
        self.assertEqual(sum(p.kind == "continue" for p in state.actions), 1)

    def test_completion_at_deadline_and_unknown_result_do_not_revive_pass(self):
        state = control(fixture(0), 0, "restore")
        plan = state.actions[-1]
        state = m.step(state, 2, m.ActionResult(plan, "succeeded"))[0]
        self.assertEqual(state.resume.attempts[-1].status, "attempted_unknown")
        state = m.step(state, 3, m.ActionResult(plan, "succeeded"))[0]
        self.assertEqual(state.resume.attempts[-1].status, "attempted_unknown")
        self.assertEqual(len(state.actions), 1)

    def test_positive_gate_after_missed_budget_can_exit_but_cannot_claim_success(self):
        state = control(fixture(0), 0, "stop")
        state = m.step(state, 20)[0]
        state = close_processes(state, 20)
        state = m.step(state, 20, m.Publication("succeeded"))[0]
        gate = m.exit_gate(state)
        self.assertTrue(gate.may_exit, gate.pending)
        self.assertEqual(gate.exit_code, 1)
        self.assertIn("cleanup_deadline_expired", state.errors)

    def test_full_positive_gate_without_failure_returns_model_zero(self):
        state = close_processes(fixture(0, False))
        state = m.step(state, 0, m.Publication("succeeded"))[0]
        gate = m.exit_gate(state)
        self.assertTrue(gate.may_exit)
        self.assertEqual(gate.exit_code, 0)
        self.assertFalse(gate.runtime_authority)
        self.assertTrue(record(state, state.root).actual_waitpid)

    def test_original_root_exit_without_wait_remains_pending_without_resignal(self):
        state = fixture(0)
        state = m.step(state, 0, replace(exited(state.root), wait=None))[0]
        state = control(state, 0, "stop")
        self.assertEqual(state.actions, ())
        self.assertEqual(state.cleanup.stop_status, "exited_closure_pending")
        self.assertIn("original_root_waitpid", m.exit_gate(state).pending)

    def test_omitting_known_pin_close_obligation_cannot_open_gate(self):
        state = close_processes(fixture(0, False))
        state = replace(state, resources=())
        state = m.step(state, 0, m.Publication("succeeded"))[0]
        self.assertIn("original_pin_close:root", m.exit_gate(state).pending)
        self.assertFalse(m.exit_gate(state).may_exit)


if __name__ == "__main__":
    unittest.main()
