"""Pure fake clock/process/pidfd/channel support: no subprocess or /proc I/O."""
import importlib.util
from pathlib import Path
import sys


def load(name, filename):
    path = Path(__file__).resolve().parents[2] / "scripts" / "fixtures" / filename
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


owned = load("owned_fixture_owner_test", "owned-fixture-owner.py")
rpc = load("owned_fixture_rpc_test", "owned-fixture-rpc.py")


class Clock:
    def __init__(self):
        self.value = 0.0

    def now(self):
        return self.value

    def advance(self, seconds=.05):
        self.value += seconds


def scope(data_identity=(11, 22)):
    return owned.Scope("1" * 32, "2" * 32, "3" * 32,
                       "owned_" + "1" * 32, (43001, 43002, 43003), data_identity)


class Ports:
    def __init__(self, occupied=()):
        self.occupied, self.calls = set(occupied), []

    def reserve_exact(self, ports, run_id, nonce):
        self.calls.append((ports, run_id, nonce))
        if any(port in self.occupied for port in ports):
            return False
        self.occupied.update(ports)
        return True


class Backend:
    def __init__(self, current_scope, clock, children=2):
        self.scope, self.clock = current_scope, clock
        self.claimed = False
        self.admissions = []
        self.rows = {}
        self.calls, self.tokens, self.plans = [], {}, {}
        self.reports = []
        self.driver = "active"
        self.cascade = True
        self.attempted_reopens = 0
        self.original_child = object()
        for index in range(children + 1):
            root = index == children
            name = "root" if root else f"child_{index}"
            a = owned.Admission(name, owned.Identity(100 + index, str(1000 + index), "a" * 64),
                                None if root else "root", object(), self.original_child if root else None,
                                "fresh_spawn", current_scope.run_id, current_scope.owner_nonce)
            self.admissions.append(a)
            self.rows[name] = {"readiness": "alive", "identity_matches": True, "parent_matches": True,
                               "execution_state": "running", "closure_proof": "none",
                               "original_lifetime_absent": False, "waitpid_status": None, "original_child": None}

    def attest_scope(self, value):
        if self.claimed or value != self.scope:
            return False
        self.claimed = True
        return True

    def observe(self, pin, identity):
        admission = next(a for a in self.admissions if a.pin is pin)
        if identity is not admission.identity:
            raise AssertionError("fake backend forbids rebuilt/imported identity")
        return owned.Observation(admission.lifetime_id, pin, **self.rows[admission.lifetime_id])

    def owns_admission(self, admission):
        return any(original is admission for original in self.admissions)

    def exited(self, name, closed=True):
        row = self.rows[name]
        row.update(readiness="exited", execution_state="unknown", identity_matches=False)
        if closed:
            if name == "root":
                row.update(closure_proof="original_waitpid", original_child=self.original_child, waitpid_status=0)
            else:
                row.update(closure_proof="original_lifetime_absent", original_lifetime_absent=True)

    def begin(self, action, pin, identity, child, deadline):
        admission = next(a for a in self.admissions if a.pin is pin)
        if identity is not admission.identity or child is not admission.original_child:
            raise AssertionError("commands must use original opaque objects")
        if self.clock.now() >= deadline:
            raise AssertionError("expired action must not reach backend")
        self.calls.append((admission.lifetime_id, action, deadline))
        plan = self.plans.get((admission.lifetime_id, action), {})
        if plan.get("raise"):
            raise RuntimeError("fake sensitive password=do-not-serialize")
        if plan.get("mutate", True):
            if action == "pause":
                self.rows[admission.lifetime_id]["execution_state"] = "stopped"
            elif action == "continue":
                self.rows[admission.lifetime_id]["execution_state"] = "running"
                if plan.get("exit"):
                    self.exited(admission.lifetime_id, plan.get("closed", True))
            elif action in {"stop", "force_stop"}:
                self.exited(admission.lifetime_id, plan.get("closed", True))
                if admission.lifetime_id == "root" and action == "stop" and self.cascade:
                    for name in self.rows:
                        if name != "root":
                            self.exited(name)
        token = object()
        self.tokens[token] = {"ready": self.clock.now() + plan.get("delay", 0),
                              "outcome": plan.get("outcome", "succeeded")}
        return token

    def poll(self, token, now):
        row = self.tokens[token]
        if row["outcome"] == "pending" or now < row["ready"]:
            return None
        return owned.Completion(token, row["outcome"])

    def driver_event(self, _now):
        if self.driver == "blocking":
            return None
        if self.driver == "crash":
            raise RuntimeError("fake driver token=private-value")
        return owned.DriverEvent(self.driver)

    def begin_report(self, value, deadline):
        self.reports.append(value)
        plan = self.plans.get(("report", "report"), {})
        if plan.get("raise"):
            raise OSError("fake credential-bearing report sink failure")
        token = object()
        self.tokens[token] = {"ready": self.clock.now() + plan.get("delay", 0),
                              "outcome": plan.get("outcome", "succeeded")}
        return token


def make_owner(children=2, limits=None, current_scope=None):
    clock = Clock()
    current_scope = current_scope or scope()
    backend = Backend(current_scope, clock, children)
    limits = limits or owned.Limits(workload=500, lease=60, cleanup=30, action=1, report=1)
    owner = owned.FixtureOwner(current_scope, backend.admissions, backend, clock, limits)
    return owner, backend, clock


def drive(owner, clock, until, maximum=2000, step=.05, front=None):
    for _ in range(maximum):
        if until():
            return
        if front is not None:
            front.poll()
        owner.tick()
        if front is not None:
            front.poll()
        clock.advance(step)
    raise AssertionError("fake owner did not reach the bounded expected state")


def paused(owner, backend, clock):
    op = owner.dispatch("pause_fixture")
    drive(owner, clock, lambda: op.state != "pending")
    return op
