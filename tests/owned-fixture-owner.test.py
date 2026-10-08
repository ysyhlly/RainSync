"""Future fixture owner negatives; every process, pidfd and clock is fake."""
from dataclasses import FrozenInstanceError, replace
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))
from owned_fixture_fake import Backend, Clock, drive, make_owner, owned, paused, scope


class OwnerTests(unittest.TestCase):
    def test_real_launch_is_explicitly_disabled(self):
        self.assertFalse(owned.REAL_LAUNCH_AVAILABLE)
        with self.assertRaisesRegex(owned.ContractError, "disabled"):
            owned.launch_real_fixture()

    def test_immutable_admitted_lifetimes_retain_original_child_and_pins(self):
        owner, backend, _clock = make_owner()
        self.assertIs(owner.original_child, backend.original_child)
        self.assertEqual(owner.ledger, tuple(backend.admissions))
        with self.assertRaises(FrozenInstanceError):
            owner.ledger[0].identity.pid = 999
        with self.assertRaises(FrozenInstanceError):
            owner.ledger[0].pin = object()

    def test_no_replacement_owner_can_claim_the_scope(self):
        owner, backend, clock = make_owner()
        with self.assertRaises(owned.StartupUnconfirmed) as caught:
            owned.FixtureOwner(owner.scope, owner.ledger, backend, clock)
        self.assertEqual(caught.exception.retained_admissions, owner.ledger)
        self.assertEqual(backend.calls, [])

    def test_attestation_exception_retains_every_startup_handle(self):
        clock, current_scope = Clock(), scope()
        backend = Backend(current_scope, clock)
        def failed(_scope):
            raise RuntimeError("fake credential")
        backend.attest_scope = failed
        with self.assertRaises(owned.StartupUnconfirmed) as caught:
            owned.FixtureOwner(current_scope, backend.admissions, backend, clock)
        self.assertEqual(caught.exception.retained_admissions, tuple(backend.admissions))
        self.assertIsNotNone(caught.exception.__cause__)

    def test_bad_descendant_admission_keeps_root_cleanup_and_unknown_objects(self):
        for change in ({"source": "imported"}, {"run_id": "f" * 32}, {"owner_nonce": "e" * 32},
                       {"parent_lifetime_id": "foreign"}, {"original_child": object()}):
            with self.subTest(change=tuple(change)):
                clock, current_scope = Clock(), scope()
                backend = Backend(current_scope, clock)
                admissions = [replace(backend.admissions[0], **change), *backend.admissions[1:]]
                owner = owned.FixtureOwner(current_scope, admissions, backend, clock)
                drive(owner, clock, lambda: owner._terminal)
                self.assertEqual(owner.state, "unresolved")
                self.assertGreater(owner.snapshot()["startup_pending_count"], 0)
                self.assertEqual(owner.snapshot()["startup_pending_count"], len(admissions) - 1)
                self.assertTrue(any(name.startswith("startup_unadmitted_") for name in owner.snapshot()["pending_resources"]))
                self.assertIn(("root", "stop"), [(name, action) for name, action, _d in backend.calls])
                self.assertFalse(owner.snapshot()["owner_may_exit"])

    def test_copied_identical_admission_has_no_minted_ownership(self):
        clock, current_scope = Clock(), scope()
        backend = Backend(current_scope, clock)
        imported = [replace(a) for a in backend.admissions]
        owner = owned.FixtureOwner(current_scope, imported, backend, clock)
        drive(owner, clock, lambda: owner._terminal)
        self.assertEqual(owner.state, "unresolved")
        self.assertEqual(owner.ledger, ())
        self.assertEqual(backend.calls, [])

    def test_missing_root_identity_retains_pending_startup_without_signals(self):
        clock, current_scope = Clock(), scope()
        backend = Backend(current_scope, clock)
        backend.rows["root"]["identity_matches"] = False
        owner = owned.FixtureOwner(current_scope, backend.admissions, backend, clock)
        drive(owner, clock, lambda: owner._terminal)
        self.assertEqual(owner.state, "unresolved")
        self.assertEqual(backend.calls, [])
        self.assertEqual(owner._startup_pending, tuple(backend.admissions))
        self.assertEqual(owner.snapshot()["pending_resources"],
                         ["startup_unadmitted_0", "startup_unadmitted_1", "startup_unadmitted_2"])
        self.assertTrue(owner.snapshot()["original_child_retained"])

    def test_pause_order_is_root_then_children(self):
        owner, backend, clock = make_owner()
        op = paused(owner, backend, clock)
        self.assertEqual(op.state, "completed")
        self.assertEqual([(n, a) for n, a, _d in backend.calls],
                         [("root", "pause"), ("child_0", "pause"), ("child_1", "pause")])

    def test_restore_is_shared_sequential_and_root_last(self):
        owner, backend, clock = make_owner()
        paused(owner, backend, clock)
        backend.calls.clear()
        op = owner.dispatch("restore_fixture")
        self.assertIs(op, owner.dispatch("restore_fixture"))
        drive(owner, clock, lambda: op.state != "pending")
        self.assertEqual(op.state, "completed")
        self.assertEqual([(n, a) for n, a, _d in backend.calls],
                         [("child_0", "continue"), ("child_1", "continue"), ("root", "continue")])
        self.assertIs(op, owner.dispatch("restore_fixture"))
        for _ in range(10):
            owner.tick()
        self.assertEqual(len(backend.calls), 3)
        self.assertEqual(backend.attempted_reopens, 0)

    def test_child_continue_error_does_not_skip_other_children_or_root_stop(self):
        owner, backend, clock = make_owner()
        paused(owner, backend, clock)
        backend.calls.clear()
        backend.plans[("child_0", "continue")] = {"raise": True}
        owner.dispatch("stop_fixture")
        drive(owner, clock, lambda: owner._terminal)
        actions = [(n, a) for n, a, _d in backend.calls]
        self.assertEqual(actions[:4], [("child_0", "continue"), ("child_1", "continue"),
                                      ("root", "continue"), ("root", "stop")])
        self.assertTrue(any(e["code"] == "continue_unconfirmed" for e in owner.errors))

    def test_stop_during_pause_cancels_unstarted_pause_actions(self):
        owner, backend, clock = make_owner()
        backend.plans[("root", "pause")] = {"delay": .5}
        pause = owner.dispatch("pause_fixture")
        owner.tick()
        owner.dispatch("stop_fixture")
        drive(owner, clock, lambda: owner._terminal)
        self.assertEqual(pause.state, "interrupted")
        self.assertEqual([n for n, a, _d in backend.calls if a == "pause"], ["root"])
        self.assertIn(("root", "continue"), [(n, a) for n, a, _d in backend.calls])

    def test_stop_shares_restore_in_flight_and_never_overlaps_it(self):
        owner, backend, clock = make_owner()
        paused(owner, backend, clock)
        backend.calls.clear()
        backend.plans[("child_0", "continue")] = {"delay": .5}
        restore = owner.dispatch("restore_fixture")
        owner.tick()
        stop = owner.dispatch("stop_fixture")
        self.assertIs(restore, owner.restore_operation)
        self.assertIs(stop, owner.dispatch("stop_fixture"))
        for _ in range(5):
            owner.tick()
            clock.advance()
        self.assertEqual([(n, a) for n, a, _d in backend.calls], [("child_0", "continue")])
        drive(owner, clock, lambda: owner._terminal)

    def test_continue_then_natural_exit_is_not_fabricated_continuation(self):
        owner, backend, clock = make_owner()
        paused(owner, backend, clock)
        backend.plans[("child_0", "continue")] = {"exit": True, "closed": False}
        restore = owner.dispatch("restore_fixture")
        drive(owner, clock, lambda: restore.state != "pending")
        row = owner.lifetimes["child_0"]
        self.assertTrue(row.continuation_sent)
        self.assertFalse(row.continuation_confirmed)
        self.assertTrue(row.exit_observed)
        self.assertFalse(row.suspension_possible)
        self.assertFalse(row.closed)
        self.assertFalse(row.actual_waitpid)
        owner.dispatch("stop_fixture")
        drive(owner, clock, lambda: owner._terminal)
        self.assertEqual(sum(n == "child_0" and a == "continue" for n, a, _d in backend.calls), 1)
        self.assertEqual(sum(n == "child_0" and a == "force_stop" for n, a, _d in backend.calls), 0)

    def test_exit_before_restore_never_reopens_or_signals_completed_lifetime(self):
        owner, backend, clock = make_owner()
        paused(owner, backend, clock)
        backend.exited("child_0")
        backend.calls.clear()
        restore = owner.dispatch("restore_fixture")
        drive(owner, clock, lambda: restore.state != "pending")
        self.assertFalse(any(n == "child_0" for n, _a, _d in backend.calls))
        self.assertFalse(owner.lifetimes["child_0"].continuation_sent)

    def test_pid_reuse_blocks_signal_and_never_imports_replacement(self):
        owner, backend, clock = make_owner()
        paused(owner, backend, clock)
        backend.rows["child_0"]["identity_matches"] = False
        backend.calls.clear()
        backend.cascade = False
        owner.dispatch("stop_fixture")
        drive(owner, clock, lambda: owner._terminal)
        self.assertFalse(any(n == "child_0" for n, _a, _d in backend.calls))
        self.assertIn("child_0", owner.snapshot()["pending_resources"])
        self.assertTrue(owner.lifetimes["root"].actual_waitpid)
        self.assertFalse(owner.snapshot()["owner_may_exit"])

    def test_parent_death_never_creates_replacement_admission(self):
        owner, backend, clock = make_owner()
        paused(owner, backend, clock)
        backend.rows["child_0"]["parent_matches"] = False
        restore = owner.dispatch("restore_fixture")
        drive(owner, clock, lambda: restore.state != "pending")
        self.assertTrue(owner.lifetimes["child_0"].continuation_confirmed)
        self.assertEqual(len(owner.ledger), 3)
        self.assertEqual(backend.attempted_reopens, 0)

    def test_invalid_readiness_and_lost_pin_stay_pending_after_root_waitpid(self):
        for readiness in ("invalid", "lost", "unknown"):
            with self.subTest(readiness=readiness):
                owner, backend, clock = make_owner()
                backend.rows["child_0"]["readiness"] = readiness
                backend.cascade = False
                owner.dispatch("stop_fixture")
                drive(owner, clock, lambda: owner._terminal)
                self.assertIn("child_0", owner.snapshot()["pending_resources"])
                self.assertEqual(owner.state, "unresolved")
                self.assertTrue(owner.lifetimes["root"].released)

    def test_descendant_exit_without_original_lifetime_absence_is_not_closed(self):
        owner, backend, clock = make_owner()
        backend.cascade = False
        backend.exited("child_0", closed=False)
        backend.rows["child_0"]["closure_proof"] = "original_lifetime_absent"
        owner.dispatch("stop_fixture")
        drive(owner, clock, lambda: owner._terminal)
        self.assertFalse(owner.lifetimes["child_0"].closed)
        self.assertFalse(owner.lifetimes["child_0"].released)

    def test_descendant_cannot_claim_actual_waitpid_or_root_handle(self):
        owner, backend, clock = make_owner()
        backend.cascade = False
        backend.exited("child_0", closed=False)
        backend.rows["child_0"].update(closure_proof="original_waitpid", waitpid_status=0,
                                       original_child=backend.original_child)
        owner.dispatch("stop_fixture")
        drive(owner, clock, lambda: owner._terminal)
        self.assertFalse(owner.lifetimes["child_0"].actual_waitpid)

    def test_root_exit_without_original_waitpid_is_not_release(self):
        owner, backend, clock = make_owner(children=0)
        backend.exited("root", closed=False)
        owner.dispatch("stop_fixture")
        drive(owner, clock, lambda: owner._terminal)
        self.assertEqual(owner.state, "unresolved")
        self.assertFalse(owner.lifetimes["root"].released)
        self.assertFalse(owner.lifetimes["root"].actual_waitpid)
        self.assertEqual(backend.calls, [])

    def test_driver_blocking_cannot_block_owner_lease_cleanup(self):
        limits = owned.Limits(workload=50, lease=1, cleanup=10, action=.5, report=.5)
        owner, backend, clock = make_owner(limits=limits)
        paused(owner, backend, clock)
        backend.driver = "blocking"
        drive(owner, clock, lambda: owner._terminal)
        self.assertLess(clock.now(), 12)
        self.assertEqual(owner.errors[owner.primary_error]["code"], "driver_lease_lost")
        self.assertTrue(owner.lifetimes["root"].actual_waitpid)

    def test_driver_crash_and_cancel_keep_primary_and_secondary_sink_errors(self):
        for kind in ("crash", "cancelled", "lost"):
            with self.subTest(kind=kind):
                owner, backend, clock = make_owner()
                paused(owner, backend, clock)
                backend.driver = kind
                backend.plans[("child_0", "continue")] = {"raise": True}
                backend.plans[("report", "report")] = {"raise": True}
                drive(owner, clock, lambda: owner._terminal)
                codes = [error["code"] for error in owner.errors]
                self.assertTrue(codes[owner.primary_error].startswith("driver_"))
                self.assertIn("continue_unconfirmed", codes)
                self.assertIn("report_sink_failed", codes)
                self.assertNotIn("private-value", json.dumps(owner.snapshot()))
                self.assertNotIn("do-not-serialize", json.dumps(owner.snapshot()))

    def test_fixed_workload_deadline_is_not_extended_by_heartbeats(self):
        limits = owned.Limits(workload=1, lease=45, cleanup=10, action=.5, report=.5)
        owner, backend, clock = make_owner(limits=limits)
        drive(owner, clock, lambda: owner._terminal)
        self.assertEqual(owner.errors[owner.primary_error]["code"], "workload_timeout")
        self.assertEqual(owner.workload_deadline, 1)

    def test_heartbeat_observed_after_lease_expiry_cannot_revive_the_lease(self):
        limits = owned.Limits(workload=50, lease=1, cleanup=10, action=.5, report=.5)
        owner, backend, clock = make_owner(limits=limits)
        clock.advance(1.01)
        owner.tick()
        self.assertIsNotNone(owner.stop_operation)
        self.assertEqual(owner.errors[owner.primary_error]["code"], "driver_lease_lost")
        self.assertEqual(owner.lease_deadline, 1)

    def test_many_child_timeouts_preserve_root_restore_and_stop_budgets(self):
        owner, backend, clock = make_owner(children=127)
        for state in owner.lifetimes.values():
            state.suspension_possible = state.pause_attempted = True
            backend.rows[state.admission.lifetime_id]["execution_state"] = "stopped"
            if state.admission.lifetime_id != "root":
                backend.plans[(state.admission.lifetime_id, "continue")] = {"outcome": "pending", "mutate": False}
        owner.dispatch("stop_fixture")
        drive(owner, clock, lambda: owner._terminal)
        actions = [(n, a) for n, a, _d in backend.calls]
        self.assertIn(("root", "continue"), actions)
        self.assertIn(("root", "stop"), actions)
        self.assertLess(clock.now(), 31)

    def test_every_process_phase_timeout_preserves_unknown_evidence(self):
        for phase in ("pause", "continue", "stop", "force_stop", "release"):
            with self.subTest(phase=phase):
                owner, backend, clock = make_owner(children=0)
                if phase != "pause":
                    paused(owner, backend, clock)
                backend.plans[("root", phase)] = {"outcome": "pending", "mutate": False}
                if phase == "force_stop":
                    backend.plans[("root", "stop")] = {"outcome": "failed", "mutate": False}
                if phase == "pause":
                    op = owner.dispatch("pause_fixture")
                    drive(owner, clock, lambda: op.state != "pending")
                    self.assertTrue(owner.lifetimes["root"].suspension_possible)
                    owner.dispatch("stop_fixture")
                else:
                    owner.dispatch("stop_fixture")
                drive(owner, clock, lambda: owner._terminal)
                self.assertTrue(any(e["code"] == phase + "_timeout" for e in owner.errors))
                if phase in {"force_stop", "release"}:
                    self.assertEqual(owner.state, "unresolved")

    def test_report_timeout_is_not_success(self):
        owner, backend, clock = make_owner()
        backend.plans[("report", "report")] = {"outcome": "pending"}
        owner.dispatch("stop_fixture")
        drive(owner, clock, lambda: owner._terminal)
        self.assertFalse(owner.report_written)
        self.assertEqual(owner.state, "unresolved")
        self.assertIn("report_sink_timeout", [e["code"] for e in owner.errors])

    def test_late_report_success_preserves_sink_timeout_and_positive_write(self):
        owner, backend, clock = make_owner()
        backend.plans[("report", "report")] = {"delay": 2}
        stop = owner.dispatch("stop_fixture")
        drive(owner, clock, lambda: owner._report_attempted)
        clock.advance(2.1)
        owner.tick()
        self.assertTrue(owner.report_written)
        self.assertIn("report_sink_timeout", [e["code"] for e in owner.errors])
        self.assertFalse(owner.operation_snapshot(stop)["observed_bound_satisfied"])

    def test_total_cleanup_timeout_never_issues_expired_actions(self):
        owner, backend, clock = make_owner()
        owner.dispatch("stop_fixture")
        clock.advance(31)
        owner.tick()
        self.assertEqual(owner.state, "unresolved")
        self.assertEqual(backend.calls, [])
        self.assertIn("cleanup_total_timeout", [e["code"] for e in owner.errors])

    def test_phase_clock_jump_never_issues_expired_root_action(self):
        owner, backend, clock = make_owner(children=0)
        paused(owner, backend, clock)
        owner.dispatch("stop_fixture")
        clock.advance(13)
        owner.tick()
        self.assertFalse(any(a == "continue" for _n, a, _d in backend.calls))
        drive(owner, clock, lambda: owner._terminal)
        self.assertIn("continue_phase_timeout", [e["code"] for e in owner.errors])

    def test_late_successful_completion_keeps_the_expired_action_bound(self):
        owner, backend, clock = make_owner(children=0)
        paused(owner, backend, clock)
        backend.plans[("root", "continue")] = {"delay": 2}
        restore = owner.dispatch("restore_fixture")
        owner.tick()
        clock.advance(2.1)
        owner.tick()
        drive(owner, clock, lambda: restore.state != "pending")
        self.assertTrue(owner.lifetimes["root"].continuation_confirmed)
        self.assertIn("continue_timeout", [e["code"] for e in owner.errors])
        self.assertFalse(owner.operation_snapshot(restore)["observed_bound_satisfied"])

    def test_control_loss_is_sticky_despite_successful_cleanup(self):
        owner, backend, clock = make_owner()
        owner.lose_control(RuntimeError("fake lost original exec channel"))
        drive(owner, clock, lambda: owner._terminal)
        self.assertEqual(owner.state, "unresolved")
        self.assertTrue(owner.control_lost)
        self.assertEqual(owner.snapshot()["pending_resources"], [])
        self.assertFalse(owner.snapshot()["owner_may_exit"])

    def test_control_loss_after_success_does_not_rewrite_closure_receipt(self):
        owner, backend, clock = make_owner()
        stop = owner.dispatch("stop_fixture")
        drive(owner, clock, lambda: owner._terminal)
        self.assertEqual(stop.state, "completed")
        owner.lose_control(RuntimeError("fake late control disappearance"))
        self.assertEqual(owner.state, "unresolved")
        self.assertEqual(stop.state, "completed")
        self.assertFalse(owner.snapshot()["owner_may_exit"])
        self.assertEqual(owner.snapshot()["pending_resources"], [])

    def test_late_exit_is_passively_observed_without_signals_or_release(self):
        owner, backend, clock = make_owner(children=0)
        backend.plans[("root", "stop")] = {"outcome": "pending", "mutate": False}
        backend.plans[("root", "force_stop")] = {"outcome": "pending", "mutate": False}
        owner.dispatch("stop_fixture")
        drive(owner, clock, lambda: owner._terminal)
        actions = list(backend.calls)
        errors = list(owner.errors)
        backend.exited("root")
        owner.tick()
        self.assertTrue(owner.lifetimes["root"].closed)
        self.assertFalse(owner.lifetimes["root"].released)
        self.assertEqual(backend.calls, actions)
        self.assertEqual(owner.errors, errors)
        self.assertFalse(owner.snapshot()["owner_may_exit"])

    def test_explicit_stop_retry_keeps_old_result_and_skips_completed_objects(self):
        owner, backend, clock = make_owner()
        backend.cascade = False
        backend.rows["child_0"]["identity_matches"] = False
        old_stop = owner.dispatch("stop_fixture")
        drive(owner, clock, lambda: owner._terminal)
        self.assertEqual(old_stop.state, "unresolved")
        backend.rows["child_0"]["identity_matches"] = True
        backend.calls.clear()
        new_stop = owner.dispatch("stop_fixture")
        self.assertIsNot(old_stop, new_stop)
        drive(owner, clock, lambda: owner._terminal)
        self.assertEqual(old_stop.state, "unresolved")
        self.assertEqual(new_stop.state, "completed")
        self.assertFalse(any(n == "root" for n, _a, _d in backend.calls))

    def test_explicit_restore_retry_uses_only_unresolved_original_pins(self):
        owner, backend, clock = make_owner()
        paused(owner, backend, clock)
        backend.rows["child_0"]["identity_matches"] = False
        old_restore = owner.dispatch("restore_fixture")
        drive(owner, clock, lambda: old_restore.state != "pending")
        self.assertEqual(old_restore.state, "unresolved")
        backend.rows["child_0"]["identity_matches"] = True
        backend.calls.clear()
        new_restore = owner.dispatch("restore_fixture")
        self.assertIsNot(old_restore, new_restore)
        self.assertIs(new_restore, owner.dispatch("restore_fixture"))
        drive(owner, clock, lambda: new_restore.state != "pending")
        self.assertEqual(old_restore.state, "unresolved")
        self.assertEqual(new_restore.state, "completed")
        self.assertEqual([(n, a) for n, a, _d in backend.calls], [("child_0", "continue")])

    def test_report_truth_separates_fake_evidence_and_runtime_readiness(self):
        owner, backend, clock = make_owner()
        owner.dispatch("stop_fixture")
        drive(owner, clock, lambda: owner._terminal)
        report = owner.snapshot()
        self.assertEqual(owner.state, "cleanup_confirmed")
        for field in ("real_launch_available", "actual_runtime_validated", "accepted", "release_ready", "database_health_proved"):
            self.assertIs(report[field], False)
        for row in report["lifetimes"]:
            self.assertFalse(row["continuation_confirmed"])
            self.assertTrue(row["released"])
            self.assertEqual(row["actual_waitpid"], row["root"])
        self.assertEqual(backend.reports[0]["report_kind"], "pre_sink_resource_journal")
        self.assertFalse(backend.reports[0]["final_outcome_available"])


if __name__ == "__main__":
    unittest.main()
