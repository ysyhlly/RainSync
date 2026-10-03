"""Pure, constructor-free PostgreSQL probe contract model.

All times and observations are supplied data. Opaque references are compared
by identity, never opened, inspected, called or turned into numeric authority.
ActionPlan is a description, not an executable command. Even passing proofs
are fake contract results: this module cannot authorize any runtime operation.
"""

from dataclasses import dataclass, replace
from math import isfinite


def _opaque(value):
    return value is not None and type(value) not in (bool, int, float, str, bytes, tuple, list, dict, set)


@dataclass(frozen=True)
class Identity:
    pid: int
    start: str
    ancestors: tuple


def _identity_shape(value):
    return (type(value) is Identity and type(value.pid) is int and value.pid > 0
            and type(value.start) is str and bool(value.start)
            and type(value.ancestors) is tuple
            and all(type(a) is tuple and len(a) == 2 and type(a[0]) is int and a[0] > 0
                    and type(a[1]) is str and bool(a[1]) for a in value.ancestors))


@dataclass(frozen=True, eq=False)
class Original:
    name: str
    identity: Identity
    pin: object
    popen: object = None
    parent: object = None
    direct: bool = False


@dataclass(frozen=True)
class Capture:
    original: Original
    pin: object
    popen: object
    before: Identity
    after: Identity
    image_before: str
    image_after: str
    reviewed_images: tuple
    witnessed_exec: bool = False
    io_known: bool = True


def admitted(original, capture):
    """Evaluate fake original-object bindings; mint no admission token."""
    return (type(capture) is Capture and capture.original is original
            and _opaque(original.pin) and capture.pin is original.pin
            and capture.popen is original.popen
            and type(original.direct) is bool
            and (not original.direct or _opaque(original.popen))
            and all(_identity_shape(i) for i in (original.identity, capture.before, capture.after))
            and capture.before == original.identity == capture.after
            and capture.io_known is True
            and type(capture.image_before) is str and bool(capture.image_before)
            and type(capture.image_after) is str and bool(capture.image_after)
            and type(capture.reviewed_images) is tuple
            and all(type(i) is str and bool(i) for i in capture.reviewed_images)
            and capture.image_before in capture.reviewed_images
            and capture.image_after in capture.reviewed_images
            and (capture.image_before == capture.image_after
                 or capture.witnessed_exec is True))


@dataclass(frozen=True, eq=False)
class RawWait:
    original: Original
    popen: object
    status: int


def matched_wait(original, wait):
    # POSIX raw stopped/continued statuses are not terminal wait observations.
    return (type(wait) is RawWait and original.direct
            and _opaque(original.popen) and wait.original is original
            and wait.popen is original.popen and type(wait.status) is int
            and 0 <= wait.status <= 65535
            and (wait.status & 127) != 127)


@dataclass(frozen=True)
class Observation:
    original: Original
    pin: object
    pin_exit: bool = False
    execution: str = "unknown"
    identity: object = None
    lifetime_absent: bool = False
    wait: object = None
    io_known: bool = True


@dataclass(frozen=True)
class ProcessRecord:
    original: Original
    capture: object = None
    suspension_possible: bool = True
    pin_exit: bool = False
    running_confirmed: bool = False
    closed: bool = False
    closure_method: str = "none"
    wait: object = None
    normal_ready: object = None
    stop_request: object = None
    stop_result: object = None

    @property
    def actual_waitpid(self):
        return matched_wait(self.original, self.wait)


def observe(record, event):
    original = record.original
    if (type(event) is not Observation or event.original is not original
            or not _opaque(original.pin) or event.pin is not original.pin
            or event.io_known is not True):
        return record
    exited = record.pin_exit or event.pin_exit is True
    running = (event.execution == "running" and not exited
               and _identity_shape(event.identity)
               and event.identity == original.identity)
    closed, method, wait = record.closed, record.closure_method, record.wait
    if matched_wait(original, event.wait):
        wait = event.wait
    if exited and event.execution != "zombie":
        if matched_wait(original, wait):
            closed, method = True, "original_waitpid"
        elif not original.direct and event.lifetime_absent is True:
            closed, method = True, "original_pin_exit_and_lifetime_absent"
    return replace(record, pin_exit=exited, closed=closed,
                   closure_method=method, wait=wait,
                   running_confirmed=record.running_confirmed or running,
                   suspension_possible=record.suspension_possible and not (exited or running))


@dataclass(frozen=True, eq=False)
class Obligation:
    name: str
    kind: str
    original: object


@dataclass(frozen=True)
class ResourceRecord:
    obligation: Obligation
    outcome: str = "unknown"


@dataclass(frozen=True)
class ResourceObservation:
    obligation: Obligation
    original: object
    outcome: str


def resource_closed(record):
    required = {"pin": "closed", "raw_pin": "closed", "fd": "closed",
                "file": "closed", "directory": "closed", "candidate": "disposed",
                "thread": "joined", "job": "settled"}
    return (_opaque(record.obligation.original) and type(record.obligation.kind) is str
            and record.obligation.kind in required and record.outcome == required[record.obligation.kind])


@dataclass(frozen=True)
class ProgramBinding:
    package: str
    source: str
    images: tuple
    bootstrap_inputs: tuple
    dependencies: tuple
    environment: str
    configuration: str
    argv: tuple


def complete_binding(binding):
    if type(binding) is not ProgramBinding:
        return False
    scalar = (binding.package, binding.source, binding.environment, binding.configuration)
    collections = (binding.images, binding.bootstrap_inputs, binding.dependencies, binding.argv)
    return (all(type(x) is str and bool(x) for x in scalar)
            and all(type(xs) is tuple and bool(xs)
                    and all(type(x) is str and bool(x) for x in xs) for xs in collections))


@dataclass(frozen=True, eq=False)
class FamilyContract:
    kind: str
    root: Original
    binding: ProgramBinding
    normal_path: object
    complete_launch_path: object
    readiness_path: object = None


@dataclass(frozen=True, eq=False)
class NormalReadiness:
    contract: FamilyContract
    root: Original
    pin: object
    popen: object
    binding: ProgramBinding
    identity: Identity
    reviewed_path: object


def bound_readiness(contract, ready, original):
    return (type(ready) is NormalReadiness and ready.contract is contract
            and ready.root is original and ready.pin is original.pin
            and ready.popen is original.popen and complete_binding(contract.binding)
            and ready.binding == contract.binding and _identity_shape(ready.identity)
            and ready.identity == original.identity and _opaque(contract.readiness_path)
            and ready.reviewed_path is contract.readiness_path)


@dataclass(frozen=True, eq=False)
class ManagedMembership:
    owner: object
    contract: FamilyContract
    original: Original
    capture: Capture
    parent: Original
    binding: ProgramBinding
    complete_launch_path: object


@dataclass(frozen=True)
class FamilyReceipt:
    contract: FamilyContract
    root: Original
    pin: object
    popen: object
    binding: ProgramBinding
    wait: RawWait
    normal_path: object
    complete_launch_path: object
    action: str
    readiness: object = None
    error_path: bool = False
    forced: bool = False
    uncovered_birth: bool = False
    requested_action: object = None
    action_result: object = None
    memberships: tuple = ()


@dataclass(frozen=True)
class ModeledProof:
    passed: bool
    method: str
    reasons: tuple

    @property
    def runtime_authority(self):
        return False


def family_proof(contract, receipt, root_record):
    """Check a supplied fake normal-family contract without changing a ledger."""
    reasons = []
    if type(contract) is not FamilyContract or type(receipt) is not FamilyReceipt:
        return ModeledProof(False, "fake_managed_family", ("structured_receipt_required",))
    original = contract.root
    if (receipt.contract is not contract or receipt.root is not original
            or root_record.original is not original or receipt.pin is not original.pin
            or receipt.popen is not original.popen):
        reasons.append("original_binding_mismatch")
    if not admitted(original, root_record.capture):
        reasons.append("root_admission_unproved")
    if (not root_record.pin_exit or not root_record.closed
            or not matched_wait(original, root_record.wait)
            or receipt.wait is not root_record.wait or root_record.wait.status != 0):
        reasons.append("positive_original_exit_zero_required")
    if not complete_binding(contract.binding) or receipt.binding != contract.binding:
        reasons.append("program_binding_incomplete_or_mismatched")
    elif (not admitted(original, root_record.capture)
          or root_record.capture.image_before not in contract.binding.images
          or root_record.capture.image_after not in contract.binding.images):
        reasons.append("observed_root_image_outside_contract")
    if (not _opaque(contract.normal_path) or not _opaque(contract.complete_launch_path)
            or receipt.normal_path is not contract.normal_path
            or receipt.complete_launch_path is not contract.complete_launch_path):
        reasons.append("reviewed_normal_coverage_required")
    if (receipt.error_path is not False or receipt.forced is not False
            or receipt.uncovered_birth is not False):
        reasons.append("abnormal_path_not_covered")
    if contract.kind == "initdb_normal_success":
        if receipt.action != "normal_success":
            reasons.append("initdb_success_path_required")
    elif contract.kind == "postmaster_fast_shutdown":
        ready = receipt.readiness
        if (receipt.action != "SIGINT" or root_record.normal_ready is not ready
                or not bound_readiness(contract, ready, original)):
            reasons.append("bound_normal_readiness_and_sigint_required")
        action = receipt.requested_action
        if (type(action) is not ActionPlan or root_record.stop_request is not action
                or action.kind != "request_SIGINT" or action.original is not original):
            reasons.append("original_owner_sigint_request_required")
        result = receipt.action_result
        if (type(result) is not ActionResult or root_record.stop_result is not result
                or result.plan is not action or result.outcome != "succeeded"):
            reasons.append("successful_original_sigint_result_required")
    else:
        reasons.append("unknown_contract")
    return ModeledProof(not reasons, "fake_managed_family", tuple(reasons))


@dataclass(frozen=True)
class ExactCoverage:
    owner: object
    originals: tuple
    complete_launch_path: object


@dataclass(frozen=True, eq=False)
class ActionPlan:
    kind: str
    original: Original
    issued_at: float
    deadline: float

    @property
    def runtime_authority(self):
        return False


@dataclass(frozen=True)
class Attempt:
    original: Original
    status: str = "pending"
    plan: object = None
    action_result: object = None
    disposition: str = "unresolved"


@dataclass(frozen=True)
class ResumePass:
    started_at: float
    child_deadline: float
    root_deadline: float
    attempts: tuple


@dataclass(frozen=True)
class Cleanup:
    started_at: float
    deadline: float
    stop_status: str = "pending"
    stop_plan: object = None


@dataclass(frozen=True)
class Control:
    client: object
    sequence: int
    verb: str
    key: str


@dataclass(frozen=True, eq=False)
class OwnerReceipt:
    owner: object
    control: Control
    received_at: float


@dataclass(frozen=True)
class ActionResult:
    plan: ActionPlan
    outcome: str


@dataclass(frozen=True)
class Birth:
    original: Original


@dataclass(frozen=True)
class DriverFailure:
    code: str


@dataclass(frozen=True)
class Publication:
    outcome: str


@dataclass(frozen=True)
class ProbeState:
    owner: object
    client: object
    root: Original
    processes: tuple
    resources: tuple
    workload_deadline: float
    lease_deadline: float
    now: float = 0.0
    lease: float = 5.0
    resume: object = None
    cleanup: object = None
    receipts: tuple = ()
    consumed: tuple = ()
    sequence: int = 0
    actions: tuple = ()
    errors: tuple = ()
    rejections: tuple = ()
    births: tuple = ()
    exact_coverage: object = None
    families: tuple = ()
    family_receipts: tuple = ()
    memberships: tuple = ()
    publication: str = "pending"


def _record(state, original):
    return next(r for r in state.processes if r.original is original)


def _resume(state):
    if state.resume is not None:
        return state
    children = tuple(r.original for r in state.processes if r.original.parent is state.root)
    attempts = tuple(Attempt(o) for o in (*children, state.root))
    return replace(state, resume=ResumePass(state.now, state.now + 6, state.now + 8, attempts))


def _cleanup(state, code):
    errors = state.errors if code == "stop_requested" or code in state.errors else (*state.errors, code)
    if state.cleanup is not None:
        return replace(state, errors=errors)
    return _resume(replace(state, errors=errors, cleanup=Cleanup(state.now, state.now + 20)))


def _clock(state, now):
    if type(now) not in (float, int) or not isfinite(now) or now < state.now:
        raise ValueError("finite monotonic modeled time required")
    if (not all(type(t) in (int, float) and isfinite(t)
                for t in (state.now, state.workload_deadline, state.lease_deadline, state.lease))
            or not 0 < state.lease <= 5):
        raise ValueError("finite absolute deadlines and a lease of at most five seconds required")
    state = replace(state, now=now)
    if state.cleanup is None:
        workload_expired, lease_expired = now >= state.workload_deadline, now >= state.lease_deadline
        if workload_expired:
            state = _cleanup(state, "workload_expired")
        if lease_expired:
            state = _cleanup(state, "driver_lease_lost")
    elif now >= state.cleanup.deadline and "cleanup_deadline_expired" not in state.errors:
        state = replace(state, errors=(*state.errors, "cleanup_deadline_expired"))
    return state


def receive(state, now, control):
    """Expiry first; create receipt time only when this owner accepts sequence."""
    state = _clock(state, now)
    if (type(control) is not Control or control.client is not state.client
            or type(control.sequence) is not int or control.sequence <= state.sequence
            or control.verb not in ("status", "restore", "stop")
            or type(control.key) is not str or not control.key):
        return replace(state, rejections=(*state.rejections, "invalid_or_replayed_control")), None
    original = next((r for r in state.receipts if r.control.key == control.key), None)
    if original is not None:
        if original.control.verb != control.verb:
            return replace(state, rejections=(*state.rejections, "key_verb_conflict")), None
        # Reserve the new transport sequence without minting new activity.
        return replace(state, sequence=control.sequence), original
    receipt = OwnerReceipt(state.owner, control, state.now)
    return replace(state, sequence=control.sequence, receipts=(*state.receipts, receipt)), receipt


def _service(state, receipt):
    reason = None
    if type(receipt) is not OwnerReceipt:
        reason = "structured_owner_receipt_required"
    elif receipt.owner is not state.owner or receipt.control.client is not state.client:
        reason = "foreign_receipt"
    elif (type(receipt.received_at) not in (int, float) or not isfinite(receipt.received_at)
          or receipt.received_at > state.now):
        reason = "future_receipt"
    elif not any(r is receipt for r in state.receipts):
        reason = "unregistered_receipt"
    elif any(r is receipt for r in state.consumed):
        reason = "replayed_receipt"
    elif state.now >= receipt.received_at + state.lease:
        reason = "stale_receipt"
    if reason:
        return replace(state, rejections=(*state.rejections, reason))
    state = replace(state, consumed=(*state.consumed, receipt))
    verb = receipt.control.verb
    if verb == "stop":
        return _cleanup(state, "stop_requested")
    if state.cleanup is not None:
        return replace(state, rejections=(*state.rejections, "expiry_or_cleanup_before_control"))
    # Delayed service cannot renew from service time or extend workload.
    state = replace(state, lease_deadline=max(state.lease_deadline, receipt.received_at + state.lease))
    return _resume(state) if verb == "restore" else state


def _action_result(state, event):
    if type(event.plan) is not ActionPlan or event.outcome not in ("succeeded", "error", "unknown"):
        return replace(state, rejections=(*state.rejections, "unknown_action_result"))
    status = "acknowledged" if event.outcome == "succeeded" else "attempted_" + event.outcome
    if state.resume is not None:
        attempts = tuple(replace(a, status=status, action_result=event)
                         if a.plan is event.plan and a.status == "inflight"
                         and state.now < a.plan.deadline else a for a in state.resume.attempts)
        if any(a is not b for a, b in zip(attempts, state.resume.attempts)):
            state = replace(state, resume=replace(state.resume, attempts=attempts))
    if (state.cleanup is not None and state.cleanup.stop_plan is event.plan
            and state.cleanup.stop_status == "inflight" and state.now < event.plan.deadline):
        state = replace(state, cleanup=replace(state.cleanup, stop_status=status),
                        processes=tuple(replace(r, stop_result=event) if r.original is state.root
                                        else r for r in state.processes))
    return state


def _plan_resume(state):
    if state.resume is None:
        return state
    attempts = list(state.resume.attempts)
    for index, attempt in enumerate(attempts):
        record = _record(state, attempt.original)
        disposition = ("exited" if record.pin_exit else "waited_exit" if record.actual_waitpid
                       else "continued" if record.running_confirmed
                       else "not_suspended" if not record.suspension_possible else "unresolved")
        if disposition != attempt.disposition:
            attempts[index] = replace(attempt, disposition=disposition)
    for index, attempt in enumerate(attempts):
        record = _record(state, attempt.original)
        root = attempt.original is state.root
        deadline = state.resume.root_deadline if root else state.resume.child_deadline
        if attempt.status not in ("pending", "inflight"):
            continue
        if attempt.status == "inflight":
            if state.now < attempt.plan.deadline:
                break
            attempts[index] = replace(attempt, status="attempted_unknown")
        elif record.pin_exit or record.actual_waitpid or not record.suspension_possible:
            attempts[index] = replace(attempt, status="not_needed")
        elif state.now >= deadline:
            phase = "root" if root else "child"
            attempts[index] = replace(attempt, status="not_issued: " + phase + "_phase_expired")
        elif not admitted(attempt.original, record.capture):
            attempts[index] = replace(attempt, status="not_issued: unadmitted")
        elif not root and index >= 31:
            attempts[index] = replace(attempt, status="not_issued: lifetime_limit_exceeded")
        else:
            plan = ActionPlan("continue", attempt.original, state.now, min(state.now + 2, deadline))
            attempts[index] = replace(attempt, status="inflight", plan=plan)
            state = replace(state, actions=(*state.actions, plan))
            break
    if all(a is b for a, b in zip(attempts, state.resume.attempts)):
        return state
    return replace(state, resume=replace(state.resume, attempts=tuple(attempts)))


def _plan_stop(state):
    cleanup = state.cleanup
    if cleanup is None or cleanup.stop_status != "pending":
        return state
    if any(a.status in ("pending", "inflight") for a in state.resume.attempts):
        return state
    root = _record(state, state.root)
    if root.closed:
        status = "already_closed"
    elif root.pin_exit or root.actual_waitpid:
        status = "exited_closure_pending"
    elif state.now >= cleanup.started_at + 12:
        status = "not_issued: root_stop_phase_expired"
    elif not admitted(state.root, root.capture):
        status = "not_issued: unadmitted"
    else:
        plan = ActionPlan("request_SIGINT", state.root, state.now,
                          min(state.now + 2, cleanup.started_at + 12))
        return replace(state, actions=(*state.actions, plan),
                       processes=tuple(replace(r, stop_request=plan) if r.original is state.root
                                       else r for r in state.processes),
                       cleanup=replace(cleanup, stop_status="inflight", stop_plan=plan))
    return replace(state, cleanup=replace(cleanup, stop_status=status))


def step(state, now, event=None):
    """Apply one fake event and return state plus newly described actions."""
    before = len(state.actions)
    state = _clock(state, now)
    if type(event) is OwnerReceipt:
        state = _service(state, event)
    elif type(event) is Observation:
        state = replace(state, processes=tuple(observe(r, event) for r in state.processes))
    elif type(event) is NormalReadiness:
        if any(c is event.contract for c in state.families):
            state = replace(state, processes=tuple(
                replace(r, normal_ready=event) if r.original is event.root and r.normal_ready is None
                and r.stop_request is None and not r.pin_exit and not r.actual_waitpid
                and admitted(r.original, r.capture)
                and bound_readiness(event.contract, event, r.original) else r for r in state.processes))
    elif type(event) is ActionResult:
        state = _action_result(state, event)
    elif type(event) is DriverFailure:
        state = _cleanup(state, event.code)
    elif type(event) is Publication:
        if event.outcome in ("succeeded", "failed"):
            state = replace(state, publication=event.outcome)
            if event.outcome == "failed":
                state = _cleanup(state, "publication_failed")
    elif type(event) is ResourceObservation:
        resources = tuple(replace(r, outcome=event.outcome)
                          if r.obligation is event.obligation and event.original is r.obligation.original
                          and not resource_closed(r) else r for r in state.resources)
        state = replace(state, resources=resources)
    elif type(event) is Birth:
        if not any(r.original is event.original for r in state.processes):
            state = replace(state, processes=(*state.processes, ProcessRecord(event.original)),
                            births=(*state.births, event.original))
            state = _cleanup(state, "new_birth_unadmitted")
    elif type(event) is FamilyReceipt:
        if not any(r is event for r in state.family_receipts):
            state = replace(state, family_receipts=(*state.family_receipts, event))
    elif type(event) is ManagedMembership:
        if (any(c is event.contract for c in state.families)
                and _member_bound(state, event, event.contract)
                and not _record(state, event.contract.root).pin_exit
                and not _record(state, event.contract.root).actual_waitpid
                and not any(existing is event for existing in state.memberships)):
            state = replace(state, memberships=(*state.memberships, event))
    elif event is not None:
        state = replace(state, rejections=(*state.rejections, "unsupported_event"))
    state = _plan_resume(state)
    state = _plan_stop(state)
    if (state.cleanup is not None and state.cleanup.stop_status == "inflight"
            and now >= state.cleanup.stop_plan.deadline):
        state = replace(state, cleanup=replace(state.cleanup, stop_status="attempted_unknown"))
    return state, state.actions[before:]


def coverage_proof(state):
    exact = state.exact_coverage
    if (type(exact) is ExactCoverage and exact.owner is state.owner
            and _opaque(exact.complete_launch_path) and not state.births
            and len(exact.originals) == len(state.processes)
            and all(a is r.original for a, r in zip(exact.originals, state.processes))):
        return ModeledProof(True, "fake_exact_launch_coverage", ())
    roots = tuple(r for r in state.processes if r.original.direct)
    lineage_bound = all(_family_root(state, r.original) is not None for r in state.processes)
    if roots and lineage_bound and all(any(c.root is r.original and any(
            family_proof(c, receipt, r).passed and _managed_set_bound(state, c, receipt)
            for receipt in state.family_receipts)
                         for c in state.families) for r in roots):
        return ModeledProof(True, "fake_managed_family", ())
    return ModeledProof(False, "unproved", ("complete_birth_coverage_required",))


def _family_root(state, original):
    seen = []
    while original is not None and not any(o is original for o in seen):
        if not any(r.original is original for r in state.processes):
            return None
        if original.direct:
            return original
        seen.append(original)
        original = original.parent
    return None


def _member_bound(state, member, contract):
    if (type(member) is not ManagedMembership or type(contract) is not FamilyContract
            or member.owner is not state.owner or member.contract is not contract
            or member.original.direct or member.parent is not member.original.parent
            or not complete_binding(contract.binding) or member.binding != contract.binding
            or not _opaque(contract.complete_launch_path)
            or member.complete_launch_path is not contract.complete_launch_path):
        return False
    record = next((r for r in state.processes if r.original is member.original), None)
    parent = next((r.original for r in state.processes if r.original is member.parent), None)
    if (record is None or parent is None or _family_root(state, member.original) is not contract.root
            or not admitted(member.original, member.capture)
            or (record.capture is not None and member.capture is not record.capture)
            or member.original.identity.ancestors != (*parent.identity.ancestors,
                                                     (parent.identity.pid, parent.identity.start))
            or member.capture.image_before not in contract.binding.images
            or member.capture.image_after not in contract.binding.images):
        return False
    return True


def _managed_set_bound(state, contract, receipt):
    if type(receipt.memberships) is not tuple:
        return False
    if not all(type(member) is ManagedMembership and _member_bound(state, member, contract)
               and any(retained is member for retained in state.memberships)
               for member in receipt.memberships):
        return False
    members = tuple(r.original for r in state.processes
                    if r.original is not contract.root and _family_root(state, r.original) is contract.root)
    if not all(any(m.original is original and _member_bound(state, m, contract)
                   and any(retained is m for retained in state.memberships)
                   for m in receipt.memberships if type(m) is ManagedMembership) for original in members):
        return False
    # Every newly observed birth in this family must occur in the exact receipt's
    # managed set. An old receipt's unchecked uncovered_birth=False is insufficient.
    births = tuple(o for o in state.births if _family_root(state, o) is contract.root)
    return all(any(type(m) is ManagedMembership and m.original is birth
                   and _member_bound(state, m, contract)
                   and any(retained is m for retained in state.memberships)
                   for m in receipt.memberships) for birth in births)


@dataclass(frozen=True)
class ExitGate:
    may_exit: bool
    pending: tuple
    exit_code: object

    @property
    def runtime_authority(self):
        return False


def exit_gate(state):
    """Coverage never clears individually retained process/resource records."""
    pending = ["process:" + r.original.name for r in state.processes
               if not r.closed or not r.pin_exit
               or (r.original.direct and not matched_wait(r.original, r.wait))
               or (not r.original.direct and r.closure_method != "original_pin_exit_and_lifetime_absent")]
    pending.extend("resource:" + r.obligation.name for r in state.resources if not resource_closed(r))
    for process in state.processes:
        if not any(r.obligation.kind in ("pin", "raw_pin")
                   and r.obligation.original is process.original.pin and resource_closed(r)
                   for r in state.resources):
            pending.append("original_pin_close:" + process.original.name)
    if not any(r.original is state.root for r in state.processes):
        pending.append("original_root_missing")
    elif state.root.direct is not True or not matched_wait(state.root, _record(state, state.root).wait):
        pending.append("original_root_waitpid")
    if len(state.processes) > 32:
        pending.append("lifetime_limit_exceeded")
    if not coverage_proof(state).passed:
        pending.append("birth_coverage")
    if state.publication not in ("succeeded", "failed"):
        pending.append("publication_outcome")
    if state.resume is not None:
        pending.extend("action:continue:" + a.original.name for a in state.resume.attempts
                       if a.status == "inflight")
    if state.cleanup is not None and state.cleanup.stop_status == "inflight":
        pending.append("action:request_SIGINT")
    action_failure = (state.resume is not None
                      and any(a.status.startswith(("attempted_", "not_issued:"))
                              for a in state.resume.attempts))
    stop_failure = (state.cleanup is not None
                    and state.cleanup.stop_status.startswith(("attempted_", "not_issued:")))
    code = None if pending else (1 if state.errors or action_failure or stop_failure
                                or state.publication == "failed" else 0)
    return ExitGate(not pending, tuple(pending), code)
