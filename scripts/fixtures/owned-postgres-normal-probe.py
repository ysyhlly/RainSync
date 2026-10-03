#!/usr/bin/env python3
"""Static normal PostgreSQL owner adapter. Runtime admission is DISABLED.

One future original owner, fixed initdb/postmaster, private Unix socket, and
status/stop file RPC. No pause, force, numeric signals, SQL, or owner adoption.
The real operations below are source for review; current CLI fails before any
resource is created. Pure tests use fake operations and guard native syscalls.
"""
import argparse
from dataclasses import dataclass, field
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import secrets
import select
import signal
import stat
import subprocess
import sys
import threading
import time

TOOLCHAIN = Path('/workspace/scratch/8cbaa022c1e0/tooling/toolchains/postgresql-17.11')
BIN = TOOLCHAIN / 'usr/lib/postgresql/17/bin'
SHARE = TOOLCHAIN / 'usr/share/postgresql/17'
PHASE_ROOT = Path('/tmp/rainsync-owned-pg-normal-v1')
IMAGE_HASHES = {
    'initdb': 'a0363354125bc00f25075bb47fc32a2838fa7668c008326227f5bc04d628ca1d',
    'postgres': '6468a969338215cb3912cf9c0b894bdbbd37b9a709926db078e9a5bf8bdc3e16',
}
INPUT_NAMES = ('postgres.bki', 'pg_hba.conf.sample', 'pg_ident.conf.sample',
               'postgresql.conf.sample', 'snowball_create.sql',
               'information_schema.sql', 'sql_features.txt',
               'system_constraints.sql', 'system_functions.sql', 'system_views.sql')
FIXED_GUCS = (
    'unix_socket_permissions=0700', 'logging_collector=off',
    'shared_preload_libraries=', 'session_preload_libraries=', 'local_preload_libraries=',
    'archive_mode=off', 'archive_command=', 'archive_library=', 'restore_command=',
    'max_connections=8', 'max_worker_processes=0', 'max_parallel_workers=0',
    'autovacuum=off', 'max_wal_senders=0', 'ssl=off', 'jit=off',
)
SETUP_TOTAL = 30.0
IMAGE_BUDGET = 2.0
INITDB_BUDGET = 20.0
POSTMASTER_BUDGET = 8.0
WORKLOAD_BUDGET = 30.0
LEASE_BUDGET = 5.0
CLEANUP_BUDGET = 20.0
ACTION_BUDGET = 2.0
PUBLICATION_BUDGET = 1.0
JOIN_BUDGET = .2
MAX_REQUEST_BYTES = 2048
MAX_REPLY_BYTES = 256 * 1024
MAX_REQUESTS = 128
TOKEN = re.compile(r'^[a-f0-9]{32}$')
REQUEST_NAME = re.compile(r'^request-([0-9]{6})-([a-f0-9]{32})\.json$')
REQUEST_FIELDS = {'version', 'run_id', 'owner_nonce', 'client_nonce',
                  'sequence', 'idempotency_key', 'operation'}
LOCATOR_FIELDS = {'version', 'purpose', 'run_id', 'owner_nonce', 'client_nonce',
                  'root_identity', 'run_identity', 'data_identity', 'socket_identity'}
PURPOSE = 'postgres_process_probe'
# This is a code-review boundary, never a caller-provided bool/token/model proof.
# A separately reviewed source change must bind the complete package/path proof.
_APPROVED_REVIEW = None
_RUNTIME_PERMIT = object()


class ProbeError(RuntimeError):
    pass


class AdmissionDisabled(ProbeError):
    pass


class Clock:
    def now(self):
        return time.monotonic()


def checked_time(value):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ProbeError('finite monotonic time required')
    return float(value)


def identity(st):
    return st.st_dev, st.st_ino


def version(st):
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ProbeError('duplicate JSON key')
            result[key] = value
        return result
    def nonfinite(_value):
        raise ProbeError('non-finite JSON number')
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=nonfinite)
    except (ValueError, UnicodeError) as error:
        raise ProbeError('malformed JSON') from error


@dataclass(frozen=True)
class ReviewedPaths:
    """Exact review data. Construction itself grants NO execution authority."""
    source_package_sha256: str
    source_patch_set_sha256: str
    initdb_normal_path_sha256: str
    postmaster_normal_path_sha256: str
    readiness_path_sha256: str
    files: tuple  # (absolute path, sha256), including all runtime dependencies
    owner_source_sha256: str


def admission_gate(execute_reviewed):
    if execute_reviewed is not True or _APPROVED_REVIEW is None:
        raise AdmissionDisabled('normal PostgreSQL source/package/path review and exact run approval pending')
    if type(_APPROVED_REVIEW) is not ReviewedPaths:
        raise AdmissionDisabled('invalid compiled review authority')
    return _RUNTIME_PERMIT, _APPROVED_REVIEW


@dataclass
class Handle:
    name: str
    kind: str
    fd: object = None
    state: str = 'not_attempted'
    original: object = None
    error: object = None


class ResourceBook:
    """Records an attempt before creation; uncertain closes are never retried."""
    def __init__(self):
        self.handles = []

    def attempt(self, name, kind):
        record = Handle(name, kind, state='attempting')
        self.handles.append(record)
        return record

    def open(self, name, path, flags, mode=0o600, dir_fd=None):
        record = self.attempt(name, 'fd')
        try:
            record.fd = os.open(path, flags, mode, dir_fd=dir_fd)
            record.original = record.fd
            record.state = 'open'
            return record
        except OSError as error:
            # open(2) failure does not return an allocated descriptor.
            record.state, record.error = 'not_created', error
            raise
        except BaseException as error:
            record.state, record.error = 'unknown', error
            raise

    def close(self, record):
        if record.state in {'closed', 'not_created', 'not_attempted'}:
            return
        if record.state != 'open':
            raise ProbeError('unknown original descriptor close is never retried')
        try:
            os.close(record.fd)
        except BaseException as error:
            record.state, record.error = 'unknown', error
            raise
        record.state = 'closed'

    def all_closed(self):
        return all(record.state in {'closed', 'not_created', 'not_attempted'} for record in self.handles)

    def pending(self):
        return [record.name for record in self.handles
                if record.state not in {'closed', 'not_created', 'not_attempted'}]


@dataclass
class Child:
    kind: str
    popen: object = None
    popen_attempted: bool = False
    popen_complete: bool = False
    popen_uncertain: bool = False
    pin: object = None
    pending_pin: object = None
    pin_exit: bool = False
    raw_wait: object = None
    wait_original: object = None
    capture: object = None
    launch_binding: object = None
    family_closed: bool = False
    family_receipt: object = None
    ready: object = None
    signal_attempted: bool = False
    signal_result: object = None
    signal_at: object = None
    signal_deadline: object = None
    signal_completed: object = None
    errors: list = field(default_factory=list)

    def root_closed(self):
        return (self.popen_complete and self.pin is not None and self.pin_exit
                and self.wait_original is self.popen and type(self.raw_wait) is int)

    def no_spawn(self):
        return not self.popen_attempted and not self.popen_uncertain


@dataclass(frozen=True)
class Capture:
    popen: object
    pin: object
    pid: int
    start: str
    parent: int
    image: str
    image_version: tuple
    image_sha256: str


@dataclass(frozen=True)
class LaunchBinding:
    review: object
    kind: str
    argv: tuple
    environment: tuple
    images: tuple
    inputs: tuple
    generated_config: tuple
    data_identity: tuple
    socket_identity: tuple


@dataclass(frozen=True)
class Readiness:
    popen: object
    pin: object
    capture: object
    launch_binding: object
    file_version: tuple
    source_path: str
    observed_at: float


@dataclass(frozen=True)
class FamilyReceipt:
    kind: str
    popen: object
    pin: object
    capture: object
    binding: object
    raw_wait: int
    readiness: object
    requested_signal: str
    action_result: object
    source_path: str


@dataclass
class Job:
    kind: str
    deadline: float
    function: object
    args: tuple = ()
    state: str = 'queued'
    result: object = None
    error: object = None
    completed_at: object = None


@dataclass
class ThreadRecord:
    thread: object = None
    start_attempted: bool = False
    start_confirmed: bool = False
    uncertain: bool = False
    joined: bool = False


class FileWorker:
    """One retained thread; blocked FS/spawn work never owns the owner clock."""
    def __init__(self, context):
        self.context = context
        self.jobs = queue.Queue()
        self.stop = threading.Event()
        self.record = ThreadRecord()
        self.context.threads.append(self.record)
        try:
            self.record.thread = threading.Thread.__new__(threading.Thread)
            threading.Thread.__init__(self.record.thread, target=self._work,
                                      name='owned-pg-normal-files', daemon=False)
            self.record.start_attempted = True
            self.record.thread.start()
            self.record.start_confirmed = True
        except BaseException:
            self.record.uncertain = True
            raise

    def submit(self, job):
        self.jobs.put_nowait(job)

    def _work(self):
        while not self.stop.is_set() or not self.jobs.empty():
            try:
                job = self.jobs.get(timeout=.02)
            except queue.Empty:
                continue
            job.state = 'running'
            try:
                job.result = job.function(*job.args)
            except BaseException as error:
                job.error = error
            finally:
                job.completed_at = self.context.clock.now()
                job.state = 'settled'
                self.jobs.task_done()

    def finish(self):
        self.stop.set()
        if self.record.uncertain or not self.record.start_confirmed:
            return False
        self.record.thread.join(JOIN_BUDGET)
        if not self.record.thread.is_alive():
            self.record.joined = True
        return self.record.joined


class PrivateChannel:
    """New paths only; immutable no-follow bounded files and retained dirfds."""
    def __init__(self, context, create=False, locator=None):
        self.context, self.book = context, context.resources
        self.root = PHASE_ROOT
        self.root_handle = self.run_handle = self.data_handle = self.socket_handle = self.home_handle = None
        self.run_id = self.owner_nonce = self.client_nonce = None
        self.root_identity = self.run_identity = self.data_identity = self.socket_identity = None
        if create:
            self._create()
        elif locator is not None:
            self._attach(locator)
        else:
            raise ProbeError('explicit creation or verified locator required')

    @staticmethod
    def private_dir(st):
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o700:
            raise ProbeError('private original directory required')

    @staticmethod
    def private_file(st):
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid()
                or stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink != 1):
            raise ProbeError('private exclusive regular file required')

    def _create(self):
        for component in PHASE_ROOT.parent.parents:
            if stat.S_ISLNK(os.lstat(component).st_mode):
                raise ProbeError('symlink path component refused')
        parent = self.book.open('phase-parent', str(PHASE_ROOT.parent), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.mkdir(PHASE_ROOT.name, 0o700, dir_fd=parent.fd)  # EEXIST is final; never adopt or delete.
            self.root_handle = self.book.open('phase-root', PHASE_ROOT.name,
                                              os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent.fd)
            self.private_dir(os.fstat(self.root_handle.fd))
            self.root_identity = identity(os.fstat(self.root_handle.fd))
        finally:
            self.book.close(parent)
        tokens = tuple(secrets.token_hex(16) for _ in range(3))
        if len(set(tokens)) != 3 or any(not TOKEN.fullmatch(t) or '15e2d8bb' in t for t in tokens):
            raise ProbeError('fresh distinct nonce generation failed')
        self.run_id, self.owner_nonce, self.client_nonce = tokens
        for nonce in tokens:
            self._write_at(self.root_handle, 'nonce-' + nonce + '.claim',
                           json.dumps({'version': 1, 'run_id': self.run_id}).encode(), MAX_REQUEST_BYTES)
        self.run_handle = self._new_dir(self.root_handle, 'owned-' + self.run_id, 'run')
        self.run_identity = identity(os.fstat(self.run_handle.fd))
        self.data_handle = self._new_dir(self.run_handle, 'data', 'data')
        self.socket_handle = self._new_dir(self.run_handle, 'socket', 'socket')
        self.home_handle = self._new_dir(self.run_handle, 'home', 'home')
        self.data_identity = identity(os.fstat(self.data_handle.fd))
        self.socket_identity = identity(os.fstat(self.socket_handle.fd))
        self.path = self.root / ('owned-' + self.run_id)
        self.data = self.path / 'data'
        self.socket = self.path / 'socket'
        self.home = self.path / 'home'
        if len(os.fsencode(str(self.socket / '.s.PGSQL.55473'))) >= 108:
            raise ProbeError('Unix socket path length unsupported')
        self._write_at(self.run_handle, 'password', (secrets.token_hex(32) + '\n').encode(), 128)
        self.password = self.path / 'password'

    def _new_dir(self, parent, name, label):
        os.mkdir(name, 0o700, dir_fd=parent.fd)
        handle = self.book.open(label + '-directory', name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=parent.fd)
        self.private_dir(os.fstat(handle.fd))
        return handle

    def locator(self):
        return {'version': 1, 'purpose': PURPOSE, 'run_id': self.run_id,
                'owner_nonce': self.owner_nonce, 'client_nonce': self.client_nonce,
                'root_identity': self.root_identity, 'run_identity': self.run_identity,
                'data_identity': self.data_identity, 'socket_identity': self.socket_identity}

    def _attach(self, value):
        if (type(value) is not dict or set(value) != LOCATOR_FIELDS or value['version'] != 1
                or value['purpose'] != PURPOSE):
            raise ProbeError('invalid normal-probe locator')
        tokens = tuple(value[key] for key in ('run_id', 'owner_nonce', 'client_nonce'))
        if (any(type(t) is not str or not TOKEN.fullmatch(t) or '15e2d8bb' in t for t in tokens)
                or len(set(tokens)) != 3):
            raise ProbeError('foreign or reused locator nonce')
        self.run_id, self.owner_nonce, self.client_nonce = tokens
        self.root_handle = self.book.open('client-root', str(self.root), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.root_identity = tuple(value['root_identity'])
        self.run_handle = self.book.open('client-run', 'owned-' + self.run_id,
                                         os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.root_handle.fd)
        self.run_identity = tuple(value['run_identity'])
        self.data_handle = self.book.open('client-data', 'data', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                          dir_fd=self.run_handle.fd)
        self.socket_handle = self.book.open('client-socket', 'socket', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                            dir_fd=self.run_handle.fd)
        self.data_identity, self.socket_identity = tuple(value['data_identity']), tuple(value['socket_identity'])
        self.path = self.root / ('owned-' + self.run_id)
        self.check()
        if self.read_json(self.root_handle, 'locator.json', MAX_REQUEST_BYTES)[0] != value:
            raise ProbeError('replaced normal-probe locator')

    def check(self):
        for handle, expected in ((self.root_handle, self.root_identity), (self.run_handle, self.run_identity),
                                 (self.data_handle, self.data_identity), (self.socket_handle, self.socket_identity)):
            if handle is None or handle.state != 'open':
                raise ProbeError('original channel descriptor unavailable')
            current = os.fstat(handle.fd)
            self.private_dir(current)
            if identity(current) != expected:
                raise ProbeError('original directory identity changed')
        for handle, parent, name in ((self.root_handle, None, str(self.root)),
                                     (self.run_handle, self.root_handle, 'owned-' + self.run_id),
                                     (self.data_handle, self.run_handle, 'data'),
                                     (self.socket_handle, self.run_handle, 'socket')):
            current = os.stat(name, dir_fd=None if parent is None else parent.fd, follow_symlinks=False)
            self.private_dir(current)
            if identity(current) != identity(os.fstat(handle.fd)):
                raise ProbeError('named original directory replaced')

    @staticmethod
    def filename(name):
        if type(name) is not str or len(name) > 96 or not re.fullmatch(r'[a-z0-9][a-z0-9.-]*', name) or '..' in name:
            raise ProbeError('fixed internal filename required')

    def _write_at(self, directory, name, raw, maximum):
        self.filename(name)
        if len(raw) > maximum:
            raise ProbeError('bounded channel write exceeded')
        handle = self.book.open('write:' + name, name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                dir_fd=directory.fd)
        try:
            if os.write(handle.fd, raw) != len(raw):
                raise ProbeError('partial create-new file remains consumed')
            os.fsync(handle.fd)
            self.private_file(os.fstat(handle.fd))
            result = version(os.fstat(handle.fd))
        finally:
            self.book.close(handle)
        os.fsync(directory.fd)
        return result

    def write_json(self, name, value, root=False):
        self.check()
        raw = json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
        return self._write_at(self.root_handle if root else self.run_handle, name, raw, MAX_REPLY_BYTES)

    def read_json(self, directory, name, maximum):
        self.filename(name)
        handle = self.book.open('read:' + name, name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                dir_fd=directory.fd)
        try:
            before = os.fstat(handle.fd)
            self.private_file(before)
            if before.st_size > maximum:
                raise ProbeError('bounded file exceeded')
            raw = os.read(handle.fd, maximum + 1)
            after = os.fstat(handle.fd)
            named = os.stat(name, dir_fd=directory.fd, follow_symlinks=False)
            if version(before) != version(after) or version(before) != version(named) or len(raw) != before.st_size:
                raise ProbeError('partial or replaced file refused')
            return strict_json(raw), version(before), hashlib.sha256(raw).hexdigest()
        finally:
            self.book.close(handle)

    def requests(self):
        self.check()
        names = os.listdir(self.run_handle.fd)
        if len(names) > 4 * MAX_REQUESTS + 16:
            raise ProbeError('bounded channel directory exceeded')
        result = []
        for name in sorted(names):
            if REQUEST_NAME.fullmatch(name):
                result.append((name, *self.read_json(self.run_handle, name, MAX_REQUEST_BYTES)))
        self.check()
        return result

    def close(self):
        errors = []
        for handle in reversed(self.book.handles):
            if handle.kind != 'pin' and handle.state == 'open':
                try:
                    self.book.close(handle)
                except BaseException as error:
                    errors.append(error)
        if errors:
            raise errors[0]


class LinuxOperations:
    """Only the two new original direct children; no enumeration or adoption."""
    def __init__(self, context, permit, review):
        if permit is not _RUNTIME_PERMIT or review is not _APPROVED_REVIEW or review is None:
            raise AdmissionDisabled('no reviewed real PostgreSQL authority')
        self.context, self.review = context, review
        self.owner_pid = os.getpid()
        self.channel = None
        self.images = self.inputs = ()

    def _hash(self, path, deadline, maximum=64 * 1024 * 1024):
        handle = self.context.resources.open('hash:' + str(path), str(path), os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(handle.fd)
            digest, size = hashlib.sha256(), 0
            while True:
                if self.context.clock.now() >= deadline:
                    raise ProbeError('binding observation deadline')
                block = os.read(handle.fd, 65536)
                if not block:
                    break
                size += len(block)
                if size > maximum:
                    raise ProbeError('bounded binding file exceeded')
                digest.update(block)
            after = os.fstat(handle.fd)
            if version(before) != version(after):
                raise ProbeError('binding changed while hashed')
            return str(path), digest.hexdigest(), version(after)
        finally:
            self.context.resources.close(handle)

    def setup(self):
        ctx = self.context
        if os.getuid() == 0:
            raise ProbeError('official PostgreSQL cannot run as root; no user-switch workaround')
        if not all(hasattr(os, n) for n in ('pidfd_open', 'WNOHANG', 'waitstatus_to_exitcode')) or not hasattr(signal, 'pidfd_send_signal'):
            raise ProbeError('Linux original-child APIs unavailable')
        deadline = min(ctx.setup_deadline, ctx.started_at + IMAGE_BUDGET)
        checked = tuple(self._hash(path, deadline) for path, _digest in self.review.files)
        if not checked or any(row[1] != expected for row, (_path, expected) in zip(checked, self.review.files)):
            raise ProbeError('complete reviewed dependency binding mismatch')
        by_path = {row[0]: row for row in checked}
        for name, expected in IMAGE_HASHES.items():
            if by_path.get(str(BIN / name), (None, None))[1] != expected:
                raise ProbeError('fixed PostgreSQL image mismatch')
        if any(str(SHARE / name) not in by_path for name in INPUT_NAMES):
            raise ProbeError('initdb bootstrap input binding incomplete')
        self.images = tuple(by_path[str(BIN / name)] for name in ('initdb', 'postgres'))
        self.inputs = checked
        # Setup owns this object before any private directory/file construction.
        self.channel = PrivateChannel.__new__(PrivateChannel)
        ctx.channel = self.channel
        PrivateChannel.__init__(self.channel, ctx, create=True)
        return self.channel

    def fixed_argv(self, kind):
        channel = self.channel
        if kind == 'initdb':
            return (str(BIN / 'initdb'), '-D', str(channel.data), '-L', str(SHARE), '-U', 'owned_fixture',
                    '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--encoding=UTF8',
                    '--no-locale', '--no-clean', '--no-instructions', '--pwfile=' + str(channel.password))
        if kind == 'postmaster':
            values = (str(BIN / 'postgres'), '-D', str(channel.data), '-h', '', '-p', '55473', '-k', str(channel.socket))
            return values + tuple(value for setting in FIXED_GUCS for value in ('-c', setting))
        raise ProbeError('fixed original child kind required')

    def fixed_environment(self):
        # No inherited PG/LD/PYTHON/shell variables or caller-provided additions.
        return {'HOME': str(self.channel.home), 'LC_ALL': 'C', 'TZ': 'UTC',
                'PATH': str(BIN) + ':/usr/bin:/bin',
                'LD_LIBRARY_PATH': str(TOOLCHAIN / 'usr/lib/x86_64-linux-gnu')}

    def _generated(self, deadline):
        channel = self.channel
        result = []
        for name in ('postgresql.conf', 'postgresql.auto.conf', 'pg_hba.conf', 'pg_ident.conf'):
            result.append(self._hash(channel.data / name, deadline, 1024 * 1024))
        for name in ('standby.signal', 'recovery.signal'):
            try:
                os.stat(name, dir_fd=channel.data_handle.fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise ProbeError('new normal cluster must not enter recovery/standby')
        return tuple(result)

    def spawn(self, record, deadline):
        ctx = self.context
        if record not in (ctx.initdb, ctx.postmaster) or record.kind not in ('initdb', 'postmaster'):
            raise ProbeError('only original context children may spawn')
        if ctx.halt_spawns.is_set() or ctx.clock.now() >= deadline or record.popen_attempted:
            raise ProbeError('spawn deadline/one-attempt gate')
        self.channel.check()
        configs = () if record.kind == 'initdb' else self._generated(deadline)
        argv, environment = self.fixed_argv(record.kind), self.fixed_environment()
        binding = LaunchBinding(self.review, record.kind, argv, tuple(sorted(environment.items())),
                                self.images, self.inputs, configs, self.channel.data_identity, self.channel.socket_identity)
        record.launch_binding = binding
        record.popen_attempted = True
        try:
            record.popen = subprocess.Popen.__new__(subprocess.Popen)
            subprocess.Popen.__init__(record.popen, argv, stdin=subprocess.DEVNULL,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                      close_fds=True, env=environment)
            record.popen_complete = True
        except BaseException:
            record.popen_uncertain = True
            raise
        # Raw fd survives wrapper/allocation failure independently.
        record.pending_pin = ctx.resources.attempt(record.kind + '-pin', 'pin')
        try:
            record.pending_pin.fd = os.pidfd_open(record.popen.pid, 0)
            record.pending_pin.original = record.pending_pin.fd
            record.pending_pin.state = 'open'
            record.pin = record.pending_pin
            record.pending_pin = None
        except OSError as error:
            record.pending_pin.state, record.pending_pin.error = 'not_created', error
            raise
        except BaseException as error:
            record.pending_pin.state, record.pending_pin.error = 'unknown', error
            raise
        record.capture = self.capture(record, deadline)
        return record.capture

    def pin_state(self, pin):
        if pin is None or pin.state != 'open':
            return 'unknown'
        poller = select.poll()
        poller.register(pin.fd, select.POLLIN)
        events = poller.poll(0)
        if not events:
            return 'alive'
        if len(events) != 1 or events[0][0] != pin.fd or events[0][1] & select.POLLNVAL:
            return 'unknown'
        return 'exited' if events[0][1] & select.POLLIN else 'unknown'

    def _stat(self, record):
        handle = self.context.resources.open('stat:' + record.kind, '/proc/' + str(record.popen.pid) + '/stat',
                                             os.O_RDONLY | os.O_NOFOLLOW)
        try:
            raw = os.read(handle.fd, 8193)
            if len(raw) > 8192:
                raise ProbeError('bounded original-child stat exceeded')
            fields = raw.rsplit(b')', 1)[1].split()
            return int(fields[1]), fields[19].decode('ascii'), fields[0].decode('ascii')
        finally:
            self.context.resources.close(handle)

    def capture(self, record, deadline):
        if self.pin_state(record.pin) != 'alive' or self.context.clock.now() >= deadline:
            raise ProbeError('original live-child capture deadline')
        before = self._stat(record)
        image = str(BIN / ('postgres' if record.kind == 'postmaster' else 'initdb'))
        path = '/proc/' + str(record.popen.pid) + '/exe'
        # proc exe is an intentional kernel symlink, only of this original Popen.
        handle = self.context.resources.open('exe:' + record.kind, path, os.O_RDONLY)
        try:
            image_stat = os.fstat(handle.fd)
            named = os.readlink(path)
        finally:
            self.context.resources.close(handle)
        after = self._stat(record)
        expected = next(row for row in self.images if row[0] == image)
        if (before[:2] != after[:2] or before[0] != self.owner_pid or named != image
                or version(image_stat) != expected[2] or self.pin_state(record.pin) != 'alive'
                or self.context.clock.now() >= deadline):
            raise ProbeError('original child/image/start/parent capture mismatch')
        return Capture(record.popen, record.pin, record.popen.pid, before[1], before[0], image,
                       version(image_stat), expected[1])

    def observe(self, record):
        if record.popen is None or not record.popen_complete:
            return
        # No poll()/wait()/communicate(): actual raw original-child waitpid only.
        if record.raw_wait is None:
            try:
                pid, status = os.waitpid(record.popen.pid, os.WNOHANG)
            except ChildProcessError as error:
                record.errors.append('ECHILD is not original wait proof')
                return
            if pid == record.popen.pid:
                if not (os.WIFEXITED(status) or os.WIFSIGNALED(status)):
                    raise ProbeError('nonterminal raw original wait refused')
                record.raw_wait, record.wait_original = status, record.popen
                record.popen.returncode = os.waitstatus_to_exitcode(status)
            elif pid != 0:
                raise ProbeError('unmatched original waitpid result')
        if record.pin is not None and self.pin_state(record.pin) == 'exited':
            record.pin_exit = True

    def readiness(self, record, deadline):
        if record is not self.context.postmaster or record.capture is None or record.raw_wait is not None:
            raise ProbeError('original admitted live postmaster required')
        self.channel.check()
        if self.capture(record, deadline) != record.capture:
            raise ProbeError('postmaster lifetime changed before readiness')
        handle = self.context.resources.open('read:postmaster.pid', 'postmaster.pid',
                                             os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                             dir_fd=self.channel.data_handle.fd)
        try:
            before = os.fstat(handle.fd)
            # PostgreSQL creates this private regular file; owned pid is observation only.
            if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_size > 2048:
                raise ProbeError('invalid owned readiness file')
            raw = os.read(handle.fd, 2049)
            after = os.fstat(handle.fd)
            named = os.stat('postmaster.pid', dir_fd=self.channel.data_handle.fd, follow_symlinks=False)
            if version(before) != version(after) or version(before) != version(named) or len(raw) != before.st_size:
                raise ProbeError('partial or replaced readiness file')
        finally:
            self.context.resources.close(handle)
        rows = raw.decode('ascii').splitlines()
        if len(rows) != 8 or rows[0] != str(record.capture.pid) or rows[1] != str(self.channel.data):
            raise ProbeError('readiness marker does not name the new original cluster')
        if rows[3] != '55473' or rows[4] != str(self.channel.socket) or rows[5] != '':
            raise ProbeError('Unix-only ready shape mismatch')
        if rows[7].strip() != 'ready':
            return None
        if self._generated(deadline) != record.launch_binding.generated_config:
            raise ProbeError('generated config changed after original spawn')
        if self.capture(record, deadline) != record.capture:
            raise ProbeError('postmaster lifetime changed after readiness')
        return Readiness(record.popen, record.pin, record.capture, record.launch_binding, version(before),
                         self.review.readiness_path_sha256, self.context.clock.now())

    def signal_fast(self, record):
        if record is not self.context.postmaster or record.capture is None or record.pin is not record.capture.pin:
            raise ProbeError('only original captured postmaster pin may receive SIGINT')
        if self.pin_state(record.pin) != 'alive' or record.raw_wait is not None:
            raise ProbeError('exited/unobserved postmaster is never re-signalled')
        signal.pidfd_send_signal(record.pin.fd, signal.SIGINT, None, 0)

    def family(self, record):
        if (record.capture is None or record.launch_binding is None or not record.root_closed()
                or record.raw_wait != 0 or record.launch_binding.review is not self.review
                or record.capture.popen is not record.popen or record.capture.pin is not record.pin):
            return None
        expected = IMAGE_HASHES['initdb' if record.kind == 'initdb' else 'postgres']
        if record.capture.image_sha256 != expected:
            return None
        if record.kind == 'initdb':
            return FamilyReceipt(record.kind, record.popen, record.pin, record.capture, record.launch_binding,
                                 0, None, 'normal_success', None, self.review.initdb_normal_path_sha256)
        if (record.ready is None or record.ready.popen is not record.popen or record.ready.pin is not record.pin
                or record.ready.launch_binding is not record.launch_binding
                or record.signal_result != 'succeeded' or record.signal_at is None
                or record.ready.observed_at > record.signal_at):
            return None
        return FamilyReceipt(record.kind, record.popen, record.pin, record.capture, record.launch_binding,
                             0, record.ready, 'SIGINT', record.signal_result, self.review.postmaster_normal_path_sha256)

    def publish_locator(self):
        return self.channel.write_json('locator.json', self.channel.locator(), root=True)

    def poll_requests(self):
        return self.channel.requests()

    def publish(self, name, value):
        return self.channel.write_json(name, value)

    def close_files(self):
        # Setup failure may occur before PrivateChannel.__init__ completed.
        errors = []
        for handle in reversed(self.context.resources.handles):
            if handle.kind != 'pin' and handle.state == 'open':
                try:
                    self.context.resources.close(handle)
                except BaseException as error:
                    errors.append(error)
        if errors:
            raise errors[0]

    def close_pin(self, record):
        if not record.root_closed():
            return
        if record.pin is not None and record.pin.state == 'open':
            self.context.resources.close(record.pin)
        pending = record.pending_pin
        if pending is not None and pending.state == 'open' and self.pin_state(pending) == 'exited':
            self.context.resources.close(pending)


class OwnerContext:
    """Exists BEFORE kernel/setup/Popen; failures never discard original custody."""
    def __init__(self, clock):
        self.clock = clock
        self.started_at = checked_time(clock.now())
        self.setup_deadline = self.started_at + SETUP_TOTAL
        self.initdb_deadline = self.postmaster_deadline = None
        self.workload_deadline = self.lease_deadline = self.cleanup_deadline = None
        self.resources = ResourceBook()
        self.initdb, self.postmaster = Child('initdb'), Child('postmaster')
        self.threads, self.jobs = [], []
        self.operations = self.worker = self.channel = None
        self.halt_spawns = threading.Event()
        self.state, self.errors = 'new', []
        self.last_time = self.started_at
        self.accepted, self.sequences = {}, {}
        self.last_sequence = 0
        self.seen_files = {}
        self.stop_key = None
        self.delivery_failed = False
        self.final_job = self.close_job = self.poll_job = self.ready_job = None
        self.locator_job = None
        self.publication_deadline = None
        self.finished_threads = False

    def attach(self, operations, worker):
        if self.operations is not None or self.worker is not None:
            raise ProbeError('original context cannot be reconstructed')
        self.operations, self.worker = operations, worker

    def submit(self, kind, deadline, function, *args):
        job = Job(kind, deadline, function, args)
        self.jobs.append(job)  # Retained before submit can fail or enqueue ambiguously.
        try:
            self.worker.submit(job)
        except BaseException as error:
            job.state, job.error = 'unknown', error
            self.fail('file job submission unknown')
        return job

    def initialize(self):
        if self.state != 'new':
            raise ProbeError('one initialization attempt only')
        self.state = 'setup'
        self.submit('setup', self.setup_deadline, self.operations.setup)

    def fail(self, reason):
        if reason not in self.errors:
            self.errors.append(reason)
        self.halt_spawns.set()
        if self.cleanup_deadline is None:
            self.cleanup_deadline = checked_time(self.clock.now()) + CLEANUP_BUDGET
        self.state = 'stopping'

    def _time(self):
        now = checked_time(self.clock.now())
        if now < self.last_time:
            raise ProbeError('monotonic clock moved backwards')
        self.last_time = now
        return now

    def expire(self, now):
        # Runs BEFORE any accepted/replayed RPC can renew the lease.
        if self.cleanup_deadline is not None:
            if now >= self.cleanup_deadline and not self.processes_closed():
                self.fail('cleanup observation deadline exceeded')
            return
        if self.state in {'new', 'setup', 'initdb', 'starting'}:
            if now >= self.setup_deadline:
                self.fail('total setup deadline exceeded')
            elif self.state == 'initdb' and now >= self.initdb_deadline:
                self.fail('initdb normal-success deadline exceeded')
            elif self.state == 'starting' and now >= self.postmaster_deadline:
                self.fail('postmaster normal-ready deadline exceeded')
        elif self.state == 'ready':
            if now >= self.workload_deadline:
                self.fail('absolute normal workload deadline exceeded')
            elif now >= self.lease_deadline:
                self.fail('driver lease lost')

    def _settled_jobs(self, now):
        for job in self.jobs:
            if job.state != 'settled':
                if now >= job.deadline and job.kind not in {'close'}:
                    self.fail(job.kind + ' job observation deadline exceeded')
                continue
            if getattr(job, 'handled', False):
                continue
            job.handled = True
            if job.error is not None:
                if job.kind == 'ready' and isinstance(job.error, FileNotFoundError):
                    self.ready_job = None
                    continue
                if job.kind in {'reply', 'final', 'locator'}:
                    self.delivery_failed = True
                self.fail(job.kind + ' job failed: ' + type(job.error).__name__)
                continue
            if job.completed_at >= job.deadline and job.kind != 'close':
                self.fail(job.kind + ' job completed outside observation deadline')
                continue
            if job.kind == 'setup' and self.cleanup_deadline is None:
                self.channel = job.result
                self.state = 'initdb'
                self.initdb_deadline = min(self.setup_deadline, now + INITDB_BUDGET)
                self.submit('initdb-spawn', self.initdb_deadline, self.operations.spawn, self.initdb, self.initdb_deadline)
            elif job.kind == 'ready':
                self.ready_job = None
                if job.result is not None and self.cleanup_deadline is None:
                    self.postmaster.ready = job.result
                    self.state = 'ready'
                    self.workload_deadline, self.lease_deadline = now + WORKLOAD_BUDGET, now + LEASE_BUDGET
                    self.locator_job = self.submit('locator', now + PUBLICATION_BUDGET, self.operations.publish_locator)
            elif job.kind == 'poll':
                self.poll_job = None
                for row in job.result:
                    self.receive(*row, now=now)

    def _observe(self):
        for record in (self.initdb, self.postmaster):
            try:
                self.operations.observe(record)
                if record.root_closed() and not record.family_closed:
                    receipt = self.operations.family(record)
                    if receipt is not None:
                        record.family_receipt, record.family_closed = receipt, True
                    else:
                        self.fail(record.kind + ' managed family closure unknown')
                if record.root_closed():
                    self.operations.close_pin(record)
            except BaseException as error:
                self.fail(record.kind + ' observation/close failed: ' + type(error).__name__)

    def _signal(self, now):
        root = self.postmaster
        if (self.cleanup_deadline is None or root.no_spawn() or root.signal_attempted
                or root.capture is None or root.pin_exit or root.raw_wait is not None):
            return
        if now >= self.cleanup_deadline:
            self.fail('SIGINT not issued: cleanup deadline expired')
            return
        root.signal_attempted = True
        root.signal_at, root.signal_deadline = now, min(self.cleanup_deadline, now + ACTION_BUDGET)
        try:
            self.operations.signal_fast(root)
            root.signal_completed = checked_time(self.clock.now())
            root.signal_result = 'succeeded' if root.signal_completed < root.signal_deadline else 'late'
        except BaseException as error:
            root.signal_result, root.signal_completed = 'unknown', checked_time(self.clock.now())
            root.errors.append(type(error).__name__)
        if root.signal_result != 'succeeded':
            self.fail('original SIGINT result unknown/late; no repeat or force')

    def _normal_start(self, now):
        if self.cleanup_deadline is not None:
            return
        if self.state == 'initdb' and self.initdb.family_closed and self.initdb.pin.state == 'closed':
            self.state = 'starting'
            self.postmaster_deadline = min(self.setup_deadline, now + POSTMASTER_BUDGET)
            self.submit('postmaster-spawn', self.postmaster_deadline, self.operations.spawn,
                        self.postmaster, self.postmaster_deadline)
        elif (self.state == 'starting' and self.postmaster.capture is not None
              and self.ready_job is None and not self.postmaster.pin_exit):
            self.ready_job = self.submit('ready', self.postmaster_deadline, self.operations.readiness,
                                         self.postmaster, self.postmaster_deadline)

    def snapshot(self):
        return {'state': self.state, 'normal_ready': self.postmaster.ready is not None,
                'original_pin_alive': (self.postmaster.capture is not None and not self.postmaster.pin_exit
                                       and self.postmaster.raw_wait is None),
                'initdb_family_closed': self.initdb.family_closed,
                'postmaster_family_closed': self.postmaster.family_closed,
                'raw_initdb_wait': self.initdb.raw_wait, 'raw_postmaster_wait': self.postmaster.raw_wait,
                'actual_original_waitpid': self.postmaster.wait_original is self.postmaster.popen
                                         and self.postmaster.raw_wait is not None,
                'requested_signal': 'SIGINT' if self.postmaster.signal_attempted else None,
                'signal_result': self.postmaster.signal_result,
                'cleanup_deadline': self.cleanup_deadline, 'errors': list(self.errors),
                'resource_gate': False, 'runtime_acceptance': False, 'release_ready': False}

    def receive(self, name, request, inode, digest, now):
        now = checked_time(now)
        self.expire(now)
        if self.cleanup_deadline is not None and self.stop_key is None:
            raise ProbeError('expired control cannot revive original owner')
        if name in self.seen_files:
            if self.seen_files[name] != (inode, digest):
                self.fail('immutable RPC request replaced')
            return
        validate_request(request, self.channel)
        if name != request_name(request):
            raise ProbeError('RPC filename/request mismatch')
        sequence, key, operation = request['sequence'], request['idempotency_key'], request['operation']
        if sequence in self.sequences or sequence <= self.last_sequence or len(self.sequences) >= MAX_REQUESTS:
            raise ProbeError('stale/replayed sequence rejected')
        cached = self.accepted.get(key)
        if cached is not None and cached['request']['operation'] != operation:
            raise ProbeError('idempotency key changed operation')
        self.seen_files[name] = inode, digest
        self.sequences[sequence], self.last_sequence = key, sequence
        if cached is None:
            cached = {'request': request, 'received_at': now, 'snapshot': self.snapshot(), 'terminal_written': False}
            self.accepted[key] = cached
            if self.cleanup_deadline is None:
                self.lease_deadline = min(self.workload_deadline, now + LEASE_BUDGET)
            if operation == 'stop':
                if self.stop_key is None:
                    self.stop_key = key
                    self.halt_spawns.set()
                    self.cleanup_deadline = now + CLEANUP_BUDGET
                    self.state = 'stopping'
        value = reply_value(request, cached['received_at'], cached['snapshot'], operation == 'status')
        self.submit('reply', now + PUBLICATION_BUDGET, self.operations.publish, reply_name(request), value)
        cached.setdefault('transports', []).append(request)

    def processes_closed(self):
        return all(record.no_spawn() or (record.root_closed() and record.family_closed
                                        and record.pin.state == 'closed' and record.pending_pin is None)
                   for record in (self.initdb, self.postmaster))

    def _finish(self, now):
        if self.cleanup_deadline is None or not self.processes_closed():
            return
        if any(job.state not in {'settled'} for job in self.jobs):
            return
        if self.final_job is None:
            self.publication_deadline = now + PUBLICATION_BUDGET
            payload = self.snapshot()
            payload['state'] = 'failed' if self.errors else 'completed'
            payload['positive_family_closed'] = True
            if self.channel is not None and hasattr(self.channel, 'run_handle') and self.channel.run_handle is not None:
                for record in self.accepted.values():
                    if record['request']['operation'] == 'stop':
                        for request in record.get('transports', []):
                            self.submit('reply', self.publication_deadline, self.operations.publish,
                                        reply_name(request, True), reply_value(request, record['received_at'], payload, True))
                self.final_job = self.submit('final', self.publication_deadline, self.operations.publish,
                                             'normal-probe-final.json', payload)
                return
            self.final_job = False
        if any(job.state != 'settled' for job in self.jobs):
            return
        if self.close_job is None:
            self.close_job = self.submit('close', now + PUBLICATION_BUDGET, self.operations.close_files)
            return
        if self.close_job.state == 'settled' and self.close_job.error is None and self.resources.all_closed():
            self.finished_threads = self.worker.finish()

    def tick(self):
        now = self._time()
        self.expire(now)
        self._settled_jobs(now)
        self._observe()
        self._signal(checked_time(self.clock.now()))
        self._normal_start(checked_time(self.clock.now()))
        if (self.locator_job is not None and self.locator_job.state == 'settled' and self.locator_job.error is None
                and self.poll_job is None and not self.processes_closed()):
            self.poll_job = self.submit('poll', now + PUBLICATION_BUDGET, self.operations.poll_requests)
        self._finish(checked_time(self.clock.now()))

    def exit_code(self):
        if (not self.processes_closed() or not self.resources.all_closed() or not self.finished_threads
                or any(record.uncertain or not record.joined for record in self.threads)
                or any(job.state != 'settled' for job in self.jobs)):
            return None
        return 1 if self.errors or self.delivery_failed else 0

    def run(self):
        try:
            self.initialize()
        except BaseException as error:
            self.fail('initialization failed: ' + type(error).__name__)
        while True:
            try:
                self.tick()
            except BaseException as error:
                self.fail('owner tick failure: ' + type(error).__name__)
            result = self.exit_code()
            if result is not None:
                return result
            time.sleep(.02)  # Same original foreground context, including unknown resources.


def validate_request(request, channel):
    if (type(request) is not dict or set(request) != REQUEST_FIELDS or type(request['version']) is not int
            or request['version'] != 1 or request['run_id'] != channel.run_id
            or request['owner_nonce'] != channel.owner_nonce or request['client_nonce'] != channel.client_nonce
            or type(request['sequence']) is not int or not 1 <= request['sequence'] <= MAX_REQUESTS
            or type(request['idempotency_key']) is not str or not TOKEN.fullmatch(request['idempotency_key'])
            or request['operation'] not in ('status', 'stop')):
        raise ProbeError('foreign, oversized, expired, or non-fixed RPC request')
    return request


def request_name(request):
    return 'request-%06d-%s.json' % (request['sequence'], request['idempotency_key'])


def reply_name(request, terminal=False):
    return ('result' if terminal else 'reply') + '-%06d-%s.json' % (request['sequence'], request['idempotency_key'])


def reply_value(request, receipt, result, terminal):
    return {**request, 'received_at': receipt, 'terminal': terminal, 'result': result}


def run_owner(execute_reviewed=False):
    permit, review = admission_gate(execute_reviewed)  # BEFORE context/resources/native constructors.
    context = OwnerContext(Clock())
    try:
        operations = LinuxOperations(context, permit, review)
        context.operations = operations
        context.worker = FileWorker(context)
    except BaseException as error:
        context.fail('owner setup failed: ' + type(error).__name__)
        # No replacement worker/context. Unknown thread construction/start stays retained.
        while context.exit_code() is None:
            if context.operations is not None and context.worker is not None:
                try:
                    context.tick()
                except BaseException:
                    pass
            time.sleep(.02)
        return context.exit_code()
    return context.run()


def read_locator(context):
    book = context.resources
    root = book.open('client-locator-root', str(PHASE_ROOT), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = PrivateChannel.__new__(PrivateChannel)
    temporary.context, temporary.book = context, book
    try:
        PrivateChannel.private_dir(os.fstat(root.fd))
        value, _inode, _digest = temporary.read_json(root, 'locator.json', MAX_REQUEST_BYTES)
        if tuple(value.get('root_identity', ())) != identity(os.fstat(root.fd)):
            raise ProbeError('replacement locator root')
        return value
    finally:
        book.close(root)


def new_request(channel, operation):
    if operation == 'stop':
        try:
            original, _inode, _digest = channel.read_json(channel.run_handle, 'client-stop.json', MAX_REQUEST_BYTES)
            validate_request(original, channel)
            if original['operation'] != 'stop':
                raise ProbeError('conflicting persistent stop key')
            return original
        except FileNotFoundError:
            pass
    for sequence in range(1, MAX_REQUESTS + 1):
        try:
            channel.write_json('client-sequence-%06d.json' % sequence, {'version': 1, 'run_id': channel.run_id})
            break
        except FileExistsError:
            continue
    else:
        raise ProbeError('client sequence limit')
    request = {'version': 1, 'run_id': channel.run_id, 'owner_nonce': channel.owner_nonce,
               'client_nonce': channel.client_nonce, 'sequence': sequence,
               'idempotency_key': secrets.token_hex(16), 'operation': operation}
    if operation == 'stop':
        try:
            channel.write_json('client-stop.json', request)
        except FileExistsError:
            original, _inode, _digest = channel.read_json(channel.run_handle, 'client-stop.json', MAX_REQUEST_BYTES)
            validate_request(original, channel)
            if original['operation'] != 'stop':
                raise ProbeError('conflicting persistent stop key')
            return original
    return request


def run_client(action, execute_reviewed=False):
    admission_gate(execute_reviewed)
    if action not in ('status', 'status_then_stop'):
        raise ProbeError('fixed client action required')
    context = OwnerContext(Clock())  # Client owns only its local file descriptors.
    channel = None
    total = context.started_at + 50.0
    result = 2
    try:
        channel = PrivateChannel(context, locator=read_locator(context))
        for operation in (('status', 'stop') if action == 'status_then_stop' else ('status',)):
            request = new_request(channel, operation)
            try:
                channel.write_json(request_name(request), request)
            except FileExistsError:
                old, _inode, _digest = channel.read_json(channel.run_handle, request_name(request), MAX_REQUEST_BYTES)
                if old != request:
                    raise ProbeError('persistent request replaced')
            deadline = min(total, context.clock.now() + (22.0 if operation == 'stop' else 8.0))
            while context.clock.now() < deadline:
                try:
                    value, _inode, _digest = channel.read_json(channel.run_handle, reply_name(request, operation == 'stop'), MAX_REPLY_BYTES)
                except FileNotFoundError:
                    time.sleep(.02)
                    continue
                if (type(value) is not dict or any(value.get(k) != v for k, v in request.items())
                        or value.get('terminal') is not True or type(value.get('received_at')) not in (int, float)):
                    raise ProbeError('foreign or incomplete reply')
                snapshot = value.get('result', {})
                if operation == 'status' and (snapshot.get('normal_ready') is not True or snapshot.get('original_pin_alive') is not True):
                    raise ProbeError('fresh original normal-ready status not established')
                if operation == 'stop' and (snapshot.get('state') != 'completed' or snapshot.get('positive_family_closed') is not True):
                    raise ProbeError('normal original fast shutdown not established')
                print(json.dumps(value, sort_keys=True))
                break
            else:
                raise ProbeError('caller deadline lost; original owner cleanup remains autonomous')
        result = 0
    except BaseException as error:
        print(json.dumps({'outcome': 'control_unavailable', 'error': type(error).__name__, 'replacement_owner_started': False}))
    finally:
        if channel is not None:
            try:
                channel.close()
            except BaseException:
                result = 2
        else:
            for handle in reversed(context.resources.handles):
                if handle.state == 'open':
                    try:
                        context.resources.close(handle)
                    except BaseException:
                        result = 2
        # Client descriptor loss does not remove the independent foreground owner.
        if not context.resources.all_closed():
            while True:
                time.sleep(.02)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('role', choices=('owner', 'client'))
    parser.add_argument('--phase', choices=('normal',), required=True)
    parser.add_argument('--action', choices=('status', 'status_then_stop'), default='status')
    parser.add_argument('--execute-reviewed-normal-probe', action='store_true')
    args = parser.parse_args(argv)
    try:
        return run_owner(args.execute_reviewed_normal_probe) if args.role == 'owner' else run_client(args.action, args.execute_reviewed_normal_probe)
    except AdmissionDisabled as error:
        print(json.dumps({'outcome': 'runtime_admission_disabled', 'reason': str(error), 'resources_created': False}))
        return 3


if __name__ == '__main__':
    raise SystemExit(main())
