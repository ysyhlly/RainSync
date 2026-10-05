#!/usr/bin/env python3
"""Future fixture lifecycle contract. No real process backend is enabled.

The owner, rather than the workload client, keeps every original child/pin.
All backend methods are nonblocking: a tick may start one action or poll it,
but must never wait on Node, SQL, a process, or a caller's stdin.
"""
from dataclasses import dataclass, field
import queue
import re


REAL_LAUNCH_AVAILABLE = False
OLD_RUN_ID = "15e2d8bb-b544-4985-9b72-c69dd5598d81"
TOKEN = re.compile(r"^[a-f0-9]{32}$")
LABEL = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")


class ContractError(RuntimeError):
    """An evidence or protocol contract failed, not an observed success."""


class StartupUnconfirmed(ContractError):
    def __init__(self, message, retained_admissions):
        super().__init__(message)
        self.retained_admissions = tuple(retained_admissions)


def launch_real_fixture(*_args, **_kwargs):
    raise ContractError("real fixture launch disabled pending independent review")


@dataclass(frozen=True)
class Scope:
    run_id: str
    owner_nonce: str
    client_nonce: str
    database_name: str | None
    ports: tuple
    data_directory_identity: tuple
    purpose: str = "postgres_future"

    def __post_init__(self):
        if (self.run_id == OLD_RUN_ID or not TOKEN.fullmatch(self.run_id)
                or not TOKEN.fullmatch(self.owner_nonce)
                or not TOKEN.fullmatch(self.client_nonce)
                or len({self.run_id, self.owner_nonce, self.client_nonce}) != 3
                or self.purpose not in {"postgres_future", "kernel_probe"}
                or (self.purpose == "postgres_future" and (self.database_name != "owned_" + self.run_id or not self.ports))
                or (self.purpose == "kernel_probe" and (self.database_name is not None or self.ports != ()))
                or type(self.ports) is not tuple
                or len(set(self.ports)) != len(self.ports)
                or any(type(p) is not int or not 1024 <= p <= 65535 for p in self.ports)
                or type(self.data_directory_identity) is not tuple
                or len(self.data_directory_identity) != 2
                or any(type(v) is not int or v < 0 for v in self.data_directory_identity)):
            raise ContractError("invalid exclusive new-run scope")


@dataclass(frozen=True)
class Identity:
    pid: int
    start_ticks: str
    executable_sha256: str
    executable: str = "/fake/fixture"

    def __post_init__(self):
        if (type(self.pid) is not int or self.pid <= 1
                or not re.fullmatch(r"[0-9]{1,32}", self.start_ticks)
                or not re.fullmatch(r"[a-f0-9]{64}", self.executable_sha256)
                or type(self.executable) is not str or not self.executable.startswith("/")
                or len(self.executable) > 4096 or any(ord(c) < 32 for c in self.executable)):
            raise ContractError("invalid original process identity")


@dataclass(frozen=True)
class Admission:
    """One admitted lifetime; never recreated from a later numeric PID.

    pin and original_child are opaque objects retained by the owner backend.
    The future launch adapter must return fresh_spawn evidence and the exact
    scope; accepting a caller-supplied PID or imported ownership is forbidden.
    """
    lifetime_id: str
    identity: Identity
    parent_lifetime_id: str | None
    pin: object
    original_child: object | None
    source: str
    run_id: str
    owner_nonce: str


@dataclass(frozen=True)
class Observation:
    lifetime_id: str
    pin: object
    readiness: str  # alive, exited, unknown, invalid, lost
    identity_matches: bool = False
    parent_matches: bool = False
    execution_state: str = "unknown"  # running, stopped, unknown
    closure_proof: str = "none"  # original_waitpid, original_lifetime_absent, none
    original_lifetime_absent: bool = False
    waitpid_status: int | None = None
    original_child: object | None = None


@dataclass(frozen=True)
class Completion:
    token: object
    outcome: str  # succeeded, failed


@dataclass(frozen=True)
class DriverEvent:
    kind: str  # active, success, failed, cancelled, lost


@dataclass(frozen=True)
class Limits:
    workload: float = 240.0
    lease: float = 45.0
    cleanup: float = 30.0
    action: float = 2.0
    report: float = 2.0
    max_lifetimes: int = 128

    def __post_init__(self):
        if (any(type(v) not in (float, int) or not 0 < v <= 3600
                for v in (self.workload, self.lease, self.cleanup, self.action, self.report))
                or type(self.max_lifetimes) is not int or not 1 <= self.max_lifetimes <= 128):
            raise ContractError("invalid bounded owner deadlines")


@dataclass
class LifetimeState:
    admission: Admission
    pause_attempted: bool = False
    suspension_possible: bool = False
    stopped_observed: bool = False
    continuation_sent: bool = False
    continuation_confirmed: bool = False
    exit_observed: bool = False
    closed: bool = False
    actual_waitpid: bool = False
    waitpid_status: int | None = None
    closure_proof: str = "none"
    released: bool = False
    unknown: bool = False
    stop_attempted: bool = False
    force_attempted: bool = False


@dataclass
class Operation:
    operation_id: str
    kind: str
    state: str = "pending"
    phase: str = "queued"
    position: int = 0
    errors: list = field(default_factory=list)


@dataclass
class ControlTicket:
    operation: str
    result: object = None
    error: object = None
    handled: bool = False


class FixtureOwner:
    """Single event-loop owner; backends cannot be replaced after admission.

    Required fake/future backend interface: attest_scope(scope),
    owns_admission(admission), observe(pin,
    identity), begin(action, pin, identity, original_child, deadline),
    poll(token, now), driver_event(now), begin_report(report, deadline).
    begin issues its one mutation synchronously exactly once; the returned
    token can only observe that action. It cannot queue a delayed mutation.
    No method may block. Polling and commands always use the retained pin and
    original child object; the owner never opens a PID or discovers processes.
    """
    def __init__(self, scope, admissions, backend, clock, limits=Limits()):
        if type(scope) is not Scope or type(limits) is not Limits:
            raise ContractError("owner requires a validated fresh scope")
        admissions = tuple(admissions)
        try:
            if backend.attest_scope(scope) is not True:
                raise ContractError("scope already claimed or unreserved")
        except Exception as error:
            raise StartupUnconfirmed("new scope unavailable; no replacement owner", admissions) from error
        self.scope, self.backend, self.clock, self.limits = scope, backend, clock, limits
        self.created_at = clock.now()
        self.workload_deadline = self.created_at + limits.workload
        self.lease_deadline = self.created_at + limits.lease
        self.cleanup_deadline = None
        self.state = "driver_running"
        self.errors, self._causes, self.operations = [], [], {}
        self.primary_error = None
        self.restore_operation = self.stop_operation = self.pause_operation = None
        self._active = self._action = None
        self._next_operation = 0
        self.control_lost = False
        self.report_written = False
        self._report_attempted = False
        self._terminal = False
        self._restore_only = False
        self._control_queue = queue.Queue(maxsize=128)
        self._passive_position = 0
        self._startup_pending = ()
        startup_error = None
        try:
            self._ledger = self._admit(admissions)
        except Exception as error:
            # Construction must not drop already-created child/pin objects.
            # Keep every rejected object as unresolved; only independently
            # admitted exact root ownership may receive bounded cleanup.
            startup_error = error
            self._startup_pending = admissions
            self._ledger = ()
            roots = [a for a in admissions if type(a) is Admission and a.parent_lifetime_id is None]
            if len(roots) == 1:
                try:
                    self._ledger = self._admit((roots[0],))
                except Exception:
                    pass
            self._startup_pending = tuple(a for a in admissions
                                          if not any(a is admitted for admitted in self._ledger))
        self.lifetimes = {a.lifetime_id: LifetimeState(a) for a in self._ledger}
        self.root_id = self._ledger[-1].lifetime_id if self._ledger else None
        self.original_child = self._ledger[-1].original_child if self._ledger else None
        if startup_error is not None:
            self._error("startup", "admission_unconfirmed", startup_error, primary=True)
            self.dispatch("stop_fixture")

    @property
    def ledger(self):
        return self._ledger

    def _admit(self, admissions):
        if not 1 <= len(admissions) <= self.limits.max_lifetimes:
            raise ContractError("bounded original lifetime ledger required")
        ids, pins, identities, roots = set(), set(), set(), []
        by_id = {}
        for a in admissions:
            if (type(a) is not Admission or not LABEL.fullmatch(a.lifetime_id)
                    or type(a.identity) is not Identity or a.source != "fresh_spawn"
                    or a.run_id != self.scope.run_id or a.owner_nonce != self.scope.owner_nonce
                    or a.pin is None or id(a.pin) in pins or a.lifetime_id in ids
                    or (a.identity.pid, a.identity.start_ticks) in identities):
                raise ContractError("imported, duplicate, or foreign lifetime refused")
            if self.backend.owns_admission(a) is not True:
                raise ContractError("admission was not minted by this original spawn owner")
            ids.add(a.lifetime_id)
            pins.add(id(a.pin))
            identities.add((a.identity.pid, a.identity.start_ticks))
            by_id[a.lifetime_id] = a
            if a.parent_lifetime_id is None:
                roots.append(a)
        if len(roots) != 1 or roots[0].original_child is None:
            raise ContractError("exact original root child handle required")
        root = roots[0]
        for a in admissions:
            seen, current = set(), a
            while current is not root:
                if current.lifetime_id in seen or current.parent_lifetime_id not in by_id:
                    raise ContractError("original lifetime parent chain unconfirmed")
                seen.add(current.lifetime_id)
                current = by_id[current.parent_lifetime_id]
            if a is not root and a.original_child is not None:
                raise ContractError("non-root cannot import a child handle")
            o = self.backend.observe(a.pin, a.identity)
            self._validate_observation(a, o)
            if o.readiness != "alive" or not o.identity_matches or not o.parent_matches:
                raise ContractError("original pin admission unavailable")
        # Preserve admission order for children; the root is always last.
        return tuple(a for a in admissions if a is not root) + (root,)

    def _validate_observation(self, a, o):
        if (type(o) is not Observation or o.lifetime_id != a.lifetime_id
                or o.pin is not a.pin or o.readiness not in {"alive", "exited", "unknown", "invalid", "lost"}
                or type(o.identity_matches) is not bool or type(o.parent_matches) is not bool
                or o.execution_state not in {"running", "stopped", "unknown"}
                or o.closure_proof not in {"none", "original_waitpid", "original_lifetime_absent"}
                or type(o.original_lifetime_absent) is not bool
                or (o.waitpid_status is not None and type(o.waitpid_status) is not int)):
            raise ContractError("invalid retained-pin observation")
        if o.closure_proof != "none" and o.readiness != "exited":
            raise ContractError("closure requires positive retained-pin exit")
        if o.closure_proof == "original_waitpid":
            if (a.original_child is None or o.original_child is not a.original_child
                    or o.waitpid_status is None):
                raise ContractError("waitpid requires the original child and actual status")
        elif o.waitpid_status is not None or o.original_child is not None:
            raise ContractError("unproved waitpid or child reference")
        if o.closure_proof == "original_lifetime_absent" and not o.original_lifetime_absent:
            raise ContractError("descendant closure needs original lifetime absence")
        if a.parent_lifetime_id is None and o.closure_proof == "original_lifetime_absent":
            raise ContractError("root closure requires original waitpid")

    def _error(self, stage, code, cause=None, operation=None, primary=False):
        # Never serialize arbitrary backend exception strings or driver input.
        error = {"index": len(self.errors), "stage": stage, "code": code}
        if cause is not None:
            self._causes.append((error["index"], cause))
        self.errors.append(error)
        if operation is not None:
            operation.errors.append(error["index"])
        if primary and self.primary_error is None:
            self.primary_error = error["index"]
        return error

    def _observe(self, state, operation=None, report_errors=True):
        if state.released:
            return None
        a = state.admission
        try:
            o = self.backend.observe(a.pin, a.identity)
            self._validate_observation(a, o)
            if o.readiness in {"invalid", "lost"}:
                raise ContractError("retained pin unavailable")
            if o.readiness == "exited":
                state.exit_observed = True
                state.suspension_possible = False
                if o.closure_proof != "none":
                    state.closed = True
                    state.closure_proof = o.closure_proof
                    state.actual_waitpid = o.closure_proof == "original_waitpid"
                    state.waitpid_status = o.waitpid_status
            return o
        except Exception as error:
            state.unknown = True
            if report_errors:
                self._error(a.lifetime_id, "pin_observation_unconfirmed", error, operation)
            return None

    def _operation(self, kind):
        self._next_operation += 1
        op = Operation(f"operation_{self._next_operation}", kind)
        self.operations[op.operation_id] = op
        return op

    def dispatch(self, operation):
        if operation == "status":
            return self.snapshot()
        if operation not in {"pause_fixture", "restore_fixture", "stop_fixture"}:
            raise ContractError("unsupported fixture operation")
        if self._terminal or self.control_lost:
            if (self._terminal and self.state == "unresolved" and not self.control_lost
                    and operation == "stop_fixture"):
                # A new explicit request retries only pending original pins.
                # Prior RPC tickets/operations remain immutable; no takeover.
                self._terminal = False
                self._restore_only = False
                self.stop_operation = None
                if any(s.suspension_possible for s in self.lifetimes.values()):
                    self.restore_operation = None
                self._report_attempted = self.report_written = False
            elif (self._terminal and self.state == "unresolved" and not self.control_lost
                    and operation == "restore_fixture"):
                self._terminal = False
                self._restore_only = True
                self.restore_operation = None
                self._set_cleanup_deadlines()
            else:
                if operation == "stop_fixture" and self.stop_operation is not None:
                    return self.stop_operation
                if operation == "restore_fixture" and self.restore_operation is not None:
                    return self.restore_operation
                raise ContractError("owner ended or unresolved; no replacement ownership")
        if operation == "pause_fixture":
            if self.stop_operation is not None or self.restore_operation is not None:
                raise ContractError("pause after cleanup refused")
            if self.pause_operation is None:
                self.pause_operation = self._operation(operation)
            return self.pause_operation
        if operation == "restore_fixture":
            if self.restore_operation is None or self.restore_operation.state == "unresolved":
                self.restore_operation = self._operation(operation)
            return self.restore_operation
        if self.stop_operation is None:
            self.stop_operation = self._operation(operation)
            self._restore_only = False
            self._set_cleanup_deadlines()
        if self.restore_operation is None:
            self.restore_operation = self._operation("restore_fixture")
        return self.stop_operation

    def _set_cleanup_deadlines(self):
        start = self.clock.now()
        self.cleanup_deadline = start + self.limits.cleanup
        self.phase_deadlines = {"restore_children": start + self.limits.cleanup * .30,
                                "restore_root": start + self.limits.cleanup * .40,
                                "stop": start + self.limits.cleanup * .60,
                                "force_children": start + self.limits.cleanup * .75,
                                "force_root": start + self.limits.cleanup * .85,
                                "release": start + self.limits.cleanup * .90}

    def post_control(self, operation):
        if operation not in {"status", "pause_fixture", "restore_fixture", "stop_fixture"}:
            raise ContractError("unsupported fixture operation")
        ticket = ControlTicket(operation)
        try:
            self._control_queue.put_nowait(ticket)
        except queue.Full as error:
            raise ContractError("bounded owner control queue full") from error
        return ticket

    def post_control_loss(self, cause):
        try:
            self._control_queue.put_nowait(ControlTicket("control_lost", error=cause))
        except queue.Full:
            # Sticky flag is nonblocking; owner observes it on its next tick.
            self._control_overflow = cause

    def _service_control(self):
        if hasattr(self, "_control_overflow"):
            self.lose_control(self._control_overflow)
            del self._control_overflow
        for _ in range(8):
            try:
                ticket = self._control_queue.get_nowait()
            except queue.Empty:
                break
            if ticket.operation == "control_lost":
                self.lose_control(ticket.error)
            else:
                try:
                    ticket.result = self.dispatch(ticket.operation)
                except Exception as error:
                    ticket.error = error
            ticket.handled = True

    def driver_failed(self, cause=None, kind="failed"):
        if kind not in {"failed", "cancelled", "lost"}:
            raise ContractError("invalid driver failure kind")
        self._error("driver", "driver_" + kind, cause, primary=True)
        self.dispatch("stop_fixture")

    def lose_control(self, cause=None):
        if not self.control_lost:
            self.control_lost = True
            self._error("control", "owner_control_lost", cause, primary=True)
            if self._terminal:
                self.state = "unresolved"
            # Control loss is sticky even if resource cleanup later succeeds.
            if self.stop_operation is None:
                self.control_lost = False
                self.dispatch("stop_fixture")
                self.control_lost = True

    def _start(self, action, state, op):
        now = self.clock.now()
        deadline = now + self.limits.action
        if self.cleanup_deadline is not None:
            deadline = min(deadline, self.cleanup_deadline)
            root = state.admission.lifetime_id == self.root_id
            phase = {"continue": "restore_root" if root else "restore_children",
                     "stop": "stop", "force_stop": "force_root" if root else "force_children",
                     "release": "release"}.get(action)
            if phase is not None:
                deadline = min(deadline, self.phase_deadlines[phase])
        a = state.admission
        if now >= deadline:
            state.unknown = True
            self._error(a.lifetime_id, action + "_phase_timeout", operation=op)
            return False
        if action == "pause":
            state.pause_attempted = state.suspension_possible = True
        elif action == "stop":
            state.stop_attempted = True
        elif action == "force_stop":
            state.force_attempted = True
        try:
            token = self.backend.begin(action, a.pin, a.identity, a.original_child, deadline)
            if token is None:
                raise ContractError("missing bounded operation token")
            self._action = (action, state, op, token, deadline)
            return True
        except Exception as error:
            state.unknown = True
            self._error(a.lifetime_id, action + "_unconfirmed", error, op)
            return False

    def _poll(self):
        action, state, op, token, deadline = self._action
        expired = self.clock.now() >= deadline
        if expired:
            self._error(state.admission.lifetime_id, action + "_timeout", operation=op)
        try:
            result = self.backend.poll(token, self.clock.now())
            if result is not None and (type(result) is not Completion
                    or result.token is not token or result.outcome not in {"succeeded", "failed"}):
                raise ContractError("invalid operation completion")
            if result is None and not expired:
                return False
            if result is None or result.outcome != "succeeded":
                state.unknown = True
                if result is not None:
                    self._error(state.admission.lifetime_id, action + "_failed", operation=op)
            elif action == "release":
                if not state.closed:
                    raise ContractError("release without closure")
                state.released = True
            else:
                o = self._observe(state, op)
                if action == "pause":
                    if o is not None and o.readiness == "alive" and o.execution_state == "stopped":
                        state.stopped_observed = True
                    elif not state.exit_observed:
                        state.unknown = True
                        self._error(state.admission.lifetime_id, "pause_observation_unconfirmed", operation=op)
                elif action == "continue":
                    state.continuation_sent = True
                    if state.exit_observed:
                        pass  # Exit discharges suspension; never claims continuation.
                    elif o is not None and o.readiness == "alive" and o.execution_state == "running":
                        state.continuation_confirmed = True
                        state.suspension_possible = False
                    else:
                        state.unknown = True
                        self._error(state.admission.lifetime_id, "continue_observation_unconfirmed", operation=op)
                elif not state.closed:
                    state.unknown = True
                    self._error(state.admission.lifetime_id, action + "_closure_unconfirmed", operation=op)
        except Exception as error:
            state.unknown = True
            self._error(state.admission.lifetime_id, action + "_unconfirmed", error, op)
        self._action = None
        op.position += 1
        return True

    def _restore_step(self, op):
        op.phase = "continue_children_root_last"
        if (self.cleanup_deadline is not None and self.clock.now() >= self.phase_deadlines["restore_children"]
                and op.position < len(self._ledger) - 1):
            while op.position < len(self._ledger) - 1:
                state = self.lifetimes[self._ledger[op.position].lifetime_id]
                if state.suspension_possible and not state.exit_observed and not state.continuation_confirmed:
                    self._error(state.admission.lifetime_id, "continue_phase_timeout", operation=op)
                    state.unknown = True
                op.position += 1
        if op.position >= len(self._ledger):
            op.state = "unresolved" if any(s.suspension_possible for s in self.lifetimes.values()) else "completed"
            return
        state = self.lifetimes[self._ledger[op.position].lifetime_id]
        # Cached continuation/exit never opens or signals the lifetime again.
        if state.released or state.continuation_confirmed or state.exit_observed or not state.suspension_possible:
            op.position += 1
            return
        o = self._observe(state, op)
        if state.exit_observed:
            op.position += 1
            return
        if o is None or o.readiness != "alive" or not o.identity_matches:
            state.unknown = True
            self._error(state.admission.lifetime_id, "continue_identity_unconfirmed", operation=op)
            op.position += 1
            return
        if not self._start("continue", state, op):
            op.position += 1

    def _pause_step(self, op):
        op.phase = "pause_root_children"
        order = (self._ledger[-1],) + self._ledger[:-1] if self._ledger else ()
        if op.position >= len(order):
            op.state = "completed" if all(s.stopped_observed or s.exit_observed for s in self.lifetimes.values()) else "unresolved"
            return
        state = self.lifetimes[order[op.position].lifetime_id]
        o = self._observe(state, op)
        if state.exit_observed:
            op.position += 1
            return
        if o is None or o.readiness != "alive" or not o.identity_matches or not o.parent_matches:
            state.unknown = True
            self._error(state.admission.lifetime_id, "pause_identity_unconfirmed", operation=op)
            op.position += 1
            return
        # A dispatched pause may have happened even if its acknowledgement fails.
        if not self._start("pause", state, op):
            op.position += 1

    def _stop_step(self, op):
        if op.phase == "queued":
            op.phase, op.position = "stop_exact_root", 0
        if op.phase in {"stop_exact_root", "force_children_root_last", "release_closed"}:
            order = (self._ledger[-1],) if op.phase == "stop_exact_root" and self._ledger else self._ledger
            if (op.phase == "force_children_root_last" and self.clock.now() >= self.phase_deadlines["force_children"]
                    and op.position < len(order) - 1):
                while op.position < len(order) - 1:
                    state = self.lifetimes[order[op.position].lifetime_id]
                    if not state.closed:
                        state.unknown = True
                        self._error(state.admission.lifetime_id, "force_stop_phase_timeout", operation=op)
                    op.position += 1
            if op.position >= len(order):
                if op.phase == "stop_exact_root":
                    op.phase, op.position = "force_children_root_last", 0
                elif op.phase == "force_children_root_last":
                    op.phase, op.position = "release_closed", 0
                else:
                    op.phase, op.position = "report", 0
                return
            state = self.lifetimes[order[op.position].lifetime_id]
            if state.released:
                op.position += 1
                return
            if op.phase == "release_closed" and self.clock.now() >= self.phase_deadlines["release"]:
                self._error("cleanup", "release_phase_timeout", operation=op)
                op.phase, op.position = "report", 0
                return
            o = self._observe(state, op)
            if op.phase == "release_closed":
                if state.closed:
                    if not self._start("release", state, op):
                        op.position += 1
                else:
                    op.position += 1
                return
            if state.closed or state.exit_observed:
                op.position += 1
                return
            # Best effort stop still reaches the original root after child error.
            if o is None or o.readiness != "alive" or not o.identity_matches:
                state.unknown = True
                self._error(state.admission.lifetime_id, "stop_identity_unconfirmed", operation=op)
                op.position += 1
                return
            action = "stop" if op.phase == "stop_exact_root" else "force_stop"
            if not self._start(action, state, op):
                op.position += 1
            return
        self._report_step(op)

    def _report_step(self, op):
        if not self._report_attempted:
            self._report_attempted = True
            deadline = min(self.clock.now() + self.limits.report, self.cleanup_deadline)
            try:
                journal = self.snapshot()
                journal["report_kind"] = "pre_sink_resource_journal"
                journal["final_outcome_available"] = False
                token = self.backend.begin_report(journal, deadline)
                if token is None:
                    raise ContractError("missing report sink token")
                self._report_action = (token, deadline)
            except Exception as error:
                self._error("report", "report_sink_failed", error, op)
                self._finish(op)
            return
        token, deadline = self._report_action
        expired = self.clock.now() >= deadline
        if expired:
            self._error("report", "report_sink_timeout", operation=op)
        try:
            result = self.backend.poll(token, self.clock.now())
            if result is not None and (type(result) is not Completion or result.token is not token
                    or result.outcome not in {"succeeded", "failed"}):
                raise ContractError("invalid report completion")
            if result is None and not expired:
                return
            if result is None or result.outcome != "succeeded":
                if result is not None:
                    self._error("report", "report_sink_failed", operation=op)
            else:
                self.report_written = True
        except Exception as error:
            self._error("report", "report_sink_failed", error, op)
        self._finish(op)

    def _finish(self, op):
        pending = bool(self._startup_pending) or any(not s.released for s in self.lifetimes.values())
        self.state = "unresolved" if pending or self.control_lost or not self.report_written else "cleanup_confirmed"
        op.state = "unresolved" if self.state == "unresolved" else "completed"
        self._terminal = True

    def tick(self):
        self._service_control()
        if self._terminal:
            if self.state == "unresolved" and self._ledger:
                state = self.lifetimes[self._ledger[self._passive_position % len(self._ledger)].lifetime_id]
                self._passive_position += 1
                if not state.released:
                    # Late positive evidence updates the ledger, but does not
                    # issue signals/releases, replace pins, or erase errors.
                    self._observe(state, report_errors=False)
            return
        now = self.clock.now()
        if self.stop_operation is None:
            if now >= min(self.workload_deadline, self.lease_deadline):
                self._error("driver", "workload_timeout" if now >= self.workload_deadline else "driver_lease_lost", primary=True)
                self.dispatch("stop_fixture")
        if self.stop_operation is None:
            try:
                event = self.backend.driver_event(now)
                if event is not None:
                    if type(event) is not DriverEvent or event.kind not in {"active", "success", "failed", "cancelled", "lost"}:
                        raise ContractError("invalid driver event")
                    if event.kind == "active":
                        self.lease_deadline = now + self.limits.lease
                    elif event.kind == "success":
                        self.dispatch("stop_fixture")
                    else:
                        self.driver_failed(kind=event.kind)
            except Exception as error:
                self.driver_failed(error)
        if self.cleanup_deadline is not None and now >= self.cleanup_deadline:
            if self._action is not None:
                self._poll()
            op = self.restore_operation if self._restore_only else self.stop_operation
            self._error("cleanup", "cleanup_total_timeout", operation=op)
            self.state, op.state, self._terminal = "unresolved", "unresolved", True
            return
        if self._action is not None:
            self._poll()
            return
        # A single queue controls every action. Stop shares the same restore and
        # cannot begin a second continuation while the first is pending.
        if (self.pause_operation is not None and self.pause_operation.state == "pending"
                and (self.restore_operation is not None or self.stop_operation is not None)):
            self.pause_operation.state = "interrupted"
        if self.pause_operation is not None and self.pause_operation.state == "pending":
            self.state = "pausing"
            self._pause_step(self.pause_operation)
            return
        if self.restore_operation is not None and self.restore_operation.state == "pending":
            self.state = "restoring"
            self._restore_step(self.restore_operation)
            return
        if self._restore_only:
            self.state, self._terminal = "unresolved", True
            return
        if self.stop_operation is not None:
            self.state = "stopping"
            self._stop_step(self.stop_operation)
        elif self.pause_operation is not None and self.pause_operation.state == "completed":
            self.state = "paused"

    def operation_snapshot(self, op):
        return {"operation_id": op.operation_id, "operation": op.kind,
                "state": op.state, "phase": op.phase, "error_indexes": list(op.errors),
                "observed_bound_satisfied": not op.errors}

    def snapshot(self):
        rows = []
        for a in self._ledger:
            s = self.lifetimes[a.lifetime_id]
            rows.append({"lifetime_id": a.lifetime_id, "root": a.lifetime_id == self.root_id,
                         "identity": {"pid": a.identity.pid, "start_ticks": a.identity.start_ticks,
                                      "executable_sha256": a.identity.executable_sha256},
                         "pause_attempted": s.pause_attempted, "suspension_pending": s.suspension_possible,
                         "stopped_observed": s.stopped_observed,
                         "continuation_sent": s.continuation_sent,
                         "continuation_confirmed": s.continuation_confirmed,
                         "retained_pidfd_exit": s.exit_observed, "closed": s.closed,
                         "actual_waitpid": s.actual_waitpid, "waitpid_status": s.waitpid_status,
                         "closure_proof": s.closure_proof, "released": s.released,
                         "original_lifetime_absent": s.closure_proof == "original_lifetime_absent",
                         "unknown_observation": s.unknown,
                         "stop_attempted": s.stop_attempted, "force_stop_attempted": s.force_attempted})
        return {"version": 1, "run_id": self.scope.run_id, "state": self.state,
                "real_launch_available": False, "actual_runtime_validated": False,
                "accepted": False, "release_ready": False, "database_health_proved": False,
                "control_lost": self.control_lost, "owner_may_exit": self._terminal and self.state == "cleanup_confirmed",
                "original_child_retained": self.original_child is not None or any(
                    type(a) is Admission and a.original_child is not None for a in self._startup_pending),
                "primary_error_index": self.primary_error, "errors": list(self.errors),
                "report_written": self.report_written, "lifetimes": rows,
                "pending_resources": [r["lifetime_id"] for r in rows if not r["released"]] + [
                    f"startup_unadmitted_{i}" for i in range(len(self._startup_pending))],
                "startup_pending_count": len(self._startup_pending),
                "operations": [self.operation_snapshot(op) for op in self.operations.values()]}


if __name__ == "__main__":
    # No CLI can obtain a real backend or import an existing ownership handle.
    raise SystemExit("real fixture launch unavailable; pure fake-backend tests only")
