#!/usr/bin/env python3
"""Private, exclusive, bounded file RPC for one future fixture owner.

Only four verbs are accepted. Caller data never chooses a PID, signal, path,
URL, command, credentials or a replacement owner. Real fixture launch is off.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat


MAX_REQUEST_BYTES = 2048
MAX_REPLY_BYTES = 256 * 1024
MAX_REQUESTS = 128
TOKEN = re.compile(r"^[a-f0-9]{32}$")
REQUEST_NAME = re.compile(r"^request-([0-9]{6})-([a-f0-9]{32})\.json$")
OLD_SCOPE = "15e2d8bb"
SEALED_KNOWN_PORTS = frozenset({33535, 33637})
PUBLICATION_TIMEOUT = 2.0
OPERATIONS = {"status", "pause_fixture", "restore_fixture", "stop_fixture"}
FIELDS = {"version", "run_id", "owner_nonce", "client_nonce", "sequence", "idempotency_key", "operation"}


class ChannelError(RuntimeError):
    pass


class PublicationPending(ChannelError):
    """A complete private file is linked but its temporary name still exists."""
    pass


def _identity(st):
    return st.st_dev, st.st_ino


def _file_identity(st):
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns


def _strict_json(raw):
    def pairs(rows):
        result = {}
        for key, value in rows:
            if key in result:
                raise ChannelError("duplicate JSON field")
            result[key] = value
        return result

    def invalid_number(_value):
        raise ChannelError("non-finite JSON value")

    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=invalid_number)
    except (ValueError, UnicodeError) as error:
        raise ChannelError("malformed or partial JSON") from error


def validate_request(value, scope):
    if (type(value) is not dict or set(value) != FIELDS
            or type(value["version"]) is not int or value["version"] != 1
            or value["run_id"] != scope.run_id or value["owner_nonce"] != scope.owner_nonce
            or value["client_nonce"] != scope.client_nonce
            or type(value["sequence"]) is not int or not 1 <= value["sequence"] <= MAX_REQUESTS
            or type(value["idempotency_key"]) is not str or not TOKEN.fullmatch(value["idempotency_key"])
            or type(value["operation"]) is not str or value["operation"] not in OPERATIONS):
        raise ChannelError("invalid, stale, or cross-run fixture request")
    if scope.purpose == "kernel_probe" and value["operation"] not in {"status", "stop_fixture"}:
        raise ChannelError("networkless kernel probe supports only status/stop")
    return value


class PrivateRunDirectory:
    """Open dirfd authority plus path-identity checks; never adopts replacement.

    root_directory must already be a private owner directory. create() only
    creates one previously absent direct child and its previously absent data
    child. No directory is deleted/reused on failure, and no occupied port is
    accepted. The supplied allocator is fake-only for this code slice.
    """
    def __init__(self, path, fd, data_fd, scope):
        self.path, self.fd, self.data_fd, self.scope = Path(path), fd, data_fd, scope
        self.directory_identity = _identity(os.fstat(fd))
        self.data_identity = _identity(os.fstat(data_fd))
        self.uid = os.getuid()
        self.closed = False
        self.data_closed = self.run_closed = False
        self.data_close_unknown = self.run_close_unknown = False
        self.transient_close_unknown = False

    @classmethod
    def create(cls, root_directory, run_id, owner_nonce, client_nonce, ports,
               denied_ports, allocator, scope_type, purpose="postgres_future"):
        for token in (run_id, owner_nonce, client_nonce):
            if type(token) is not str or not TOKEN.fullmatch(token) or OLD_SCOPE in token:
                raise ChannelError("old or invalid run identity refused")
        if len({run_id, owner_nonce, client_nonce}) != 3:
            raise ChannelError("run and control nonces must be distinct")
        if (purpose not in {"postgres_future", "kernel_probe"}
                or (purpose == "postgres_future" and not ports)
                or (purpose == "kernel_probe" and (ports != () or allocator is not None))
                or type(ports) is not tuple or len(set(ports)) != len(ports)
                or any(type(p) is not int or not 1024 <= p <= 65535
                       or p in set(denied_ports) | SEALED_KNOWN_PORTS for p in ports)):
            raise ChannelError("old, duplicate, or invalid port refused")
        root = Path(root_directory)
        # Reject symlink components, including a symlink to a private directory.
        absolute = root.absolute()
        if any(OLD_SCOPE in component.name.lower() for component in (absolute, *absolute.parents)):
            raise ChannelError("sealed old fixture path overlap refused")
        for component in (absolute, *absolute.parents):
            if stat.S_ISLNK(os.lstat(component).st_mode):
                raise ChannelError("symlink directory component refused")
        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        fd = data_fd = None
        try:
            cls._private_directory(os.fstat(root_fd))
            # A different run cannot reuse a nonce from this owner's private
            # root. Claims are exclusive and survive failed startup; never
            # delete them to make a retry look fresh.
            for nonce_kind, nonce in (("run", run_id), ("owner", owner_nonce), ("client", client_nonce)):
                claim_fd = os.open("nonce-" + nonce + ".claim",
                                   os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                   0o600, dir_fd=root_fd)
                try:
                    raw = json.dumps({"version": 1, "run_id": run_id, "purpose": nonce_kind},
                                     sort_keys=True, separators=(",", ":")).encode()
                    if os.write(claim_fd, raw) != len(raw):
                        raise ChannelError("partial nonce claim remains consumed")
                    os.fsync(claim_fd)
                    cls._private_file(os.fstat(claim_fd))
                finally:
                    os.close(claim_fd)
            os.fsync(root_fd)
            if purpose == "postgres_future" and allocator.reserve_exact(ports, run_id, owner_nonce) is not True:
                raise ChannelError("occupied or unreserved new-run ports")
            name = "owned-" + run_id
            os.mkdir(name, mode=0o700, dir_fd=root_fd)
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
            cls._private_directory(os.fstat(fd))
            os.mkdir("data", mode=0o700, dir_fd=fd)
            data_fd = os.open("data", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            cls._private_directory(os.fstat(data_fd))
            scope = scope_type(run_id, owner_nonce, client_nonce,
                               "owned_" + run_id if purpose == "postgres_future" else None,
                               ports, _identity(os.fstat(data_fd)), purpose=purpose)
            result = cls(root / name, fd, data_fd, scope)
            result.write_new("control.json", {"version": 1, "run_id": run_id,
                             "owner_nonce": owner_nonce, "client_nonce": client_nonce,
                             "purpose": purpose,
                             "real_launch_available": False}, MAX_REQUEST_BYTES)
            return result
        except Exception:
            # Failure never deletes an exclusive directory or reclaims a port
            # reservation silently. The caller retains explicit pending scope.
            if data_fd is not None:
                os.close(data_fd)
            if fd is not None:
                os.close(fd)
            raise
        finally:
            os.close(root_fd)

    @classmethod
    def attach_control(cls, path, scope, directory_identity):
        """Attach a caller channel to an existing original owner, not an owner.

        path/identity are the trusted launch handle, never an RPC field. This
        method grants no backend or process handles and cannot launch/take over.
        Actual cross-exec persistence is a later authorized runtime gate.
        """
        absolute = Path(path).absolute()
        if any(OLD_SCOPE in component.name.lower() for component in (absolute, *absolute.parents)):
            raise ChannelError("sealed old fixture path overlap refused")
        for component in (absolute, *absolute.parents):
            if stat.S_ISLNK(os.lstat(component).st_mode):
                raise ChannelError("symlink directory component refused")
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        data_fd = None
        try:
            cls._private_directory(os.fstat(fd))
            if _identity(os.fstat(fd)) != directory_identity:
                raise ChannelError("replacement owner channel refused")
            data_fd = os.open("data", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            if _identity(os.fstat(data_fd)) != scope.data_directory_identity:
                raise ChannelError("replacement data directory refused")
            result = cls(path, fd, data_fd, scope)
            manifest, _inode, _digest = result.read("control.json", MAX_REQUEST_BYTES)
            if manifest != {"version": 1, "run_id": scope.run_id,
                            "owner_nonce": scope.owner_nonce, "client_nonce": scope.client_nonce,
                            "purpose": scope.purpose,
                            "real_launch_available": False}:
                raise ChannelError("stale or foreign owner control manifest")
            return result
        except Exception:
            if data_fd is not None:
                os.close(data_fd)
            os.close(fd)
            raise

    @staticmethod
    def _private_directory(st):
        if (not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid()
                or stat.S_IMODE(st.st_mode) != 0o700):
            raise ChannelError("owner-only directory permissions required")

    def check(self):
        if self.closed or self.data_closed or self.run_closed or self.data_close_unknown or self.run_close_unknown:
            raise ChannelError("closed channel cannot be replaced")
        try:
            absolute = self.path.absolute()
            if any(OLD_SCOPE in component.name.lower() for component in (absolute, *absolute.parents)):
                raise ChannelError("sealed old fixture path overlap refused")
            for component in (absolute, *absolute.parents):
                if stat.S_ISLNK(os.lstat(component).st_mode):
                    raise ChannelError("symlink directory component refused")
            current = os.lstat(self.path)
            data = os.stat("data", dir_fd=self.fd, follow_symlinks=False)
            self._private_directory(current)
            self._private_directory(data)
            if (_identity(current) != self.directory_identity or _identity(data) != self.data_identity
                    or _identity(os.fstat(self.fd)) != self.directory_identity
                    or _identity(os.fstat(self.data_fd)) != self.data_identity):
                raise ChannelError("run directory replaced")
        except OSError as error:
            raise ChannelError("private owner channel inaccessible") from error

    @staticmethod
    def _filename(name):
        if (type(name) is not str or len(name) > 96 or not re.fullmatch(r"[a-z0-9.-]+", name)
                or name.startswith(".") or ".." in name):
            raise ChannelError("internal channel filename refused")

    def write_new(self, name, value, maximum):
        self._filename(name)
        self.check()
        raw = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(raw) > maximum:
            raise ChannelError("bounded channel output exceeded")
        temporary = "incoming-" + secrets.token_hex(16) + ".tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        try:
            with os.fdopen(fd, "wb", closefd=False) as output:
                output.write(raw)
                output.flush()
                os.fsync(fd)
            self.check()
            # link creates the final name only if it is still absent. Unlike
            # rename/replace it cannot replace a response, symlink or request.
            os.link(temporary, name, src_dir_fd=self.fd, dst_dir_fd=self.fd, follow_symlinks=False)
            os.unlink(temporary, dir_fd=self.fd)
            os.fsync(self.fd)
            result = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            self._private_file(result)
            return _file_identity(result)
        finally:
            self._close_transient(fd)
            try:
                os.unlink(temporary, dir_fd=self.fd)
            except FileNotFoundError:
                pass

    @staticmethod
    def _private_file(st):
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid()
                or stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink != 1):
            raise ChannelError("exclusive owner-only regular file required")

    def _readable_file(self, name, st):
        if st.st_nlink == 2 and stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and stat.S_IMODE(st.st_mode) == 0o600:
            matches = []
            names = os.listdir(self.fd)
            if len(names) > (4 if self.scope.purpose == "kernel_probe" else 3) * MAX_REQUESTS + 12:
                raise ChannelError("bounded channel directory exceeded")
            for temporary in names:
                if re.fullmatch(r"incoming-[a-f0-9]{32}\.tmp", temporary):
                    other = os.stat(temporary, dir_fd=self.fd, follow_symlinks=False)
                    if _identity(other) == _identity(st):
                        matches.append(temporary)
            if len(matches) == 1 and matches[0] != name:
                raise PublicationPending("atomic link publication not finished")
        self._private_file(st)

    def read_raw(self, name, maximum, expected_identity=None):
        self._filename(name)
        self.check()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        try:
            before = os.fstat(fd)
            self._readable_file(name, before)
            if before.st_size > maximum or (expected_identity is not None and _file_identity(before) != expected_identity):
                raise ChannelError("oversized or replaced file refused")
            raw = os.read(fd, maximum + 1)
            after = os.fstat(fd)
            named = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            if (len(raw) > maximum or _identity(before) != _identity(named)
                    or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) !=
                       (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                    or len(raw) != before.st_size):
                raise ChannelError("partial or replaced channel file")
            self._private_file(named)
            self.check()
            return raw, _file_identity(before), hashlib.sha256(raw).hexdigest()
        finally:
            self._close_transient(fd)

    def read(self, name, maximum, expected_identity=None):
        raw, identity, digest = self.read_raw(name, maximum, expected_identity)
        return _strict_json(raw), identity, digest

    def names(self):
        self.check()
        names = os.listdir(self.fd)
        if len(names) > (4 if self.scope.purpose == "kernel_probe" else 3) * MAX_REQUESTS + 12:
            raise ChannelError("bounded channel directory exceeded")
        return sorted(name for name in names if REQUEST_NAME.fullmatch(name))

    def close(self):
        errors = []
        for name, fd in (("data", self.data_fd), ("run", self.fd)):
            if getattr(self, name + "_closed") or getattr(self, name + "_close_unknown"):
                continue
            try:
                os.close(fd)
                setattr(self, name + "_closed", True)
            except BaseException as error:
                setattr(self, name + "_close_unknown", True)
                errors.append(error)
        self.closed = self.data_closed and self.run_closed
        if errors:
            raise errors[0]

    def _close_transient(self, fd):
        try:
            os.close(fd)
        except BaseException:
            self.transient_close_unknown = True
            raise

    def resource_closure(self):
        return {"run_fd_closed": self.run_closed, "data_fd_closed": self.data_closed,
                "run_fd_unknown": self.run_close_unknown, "data_fd_unknown": self.data_close_unknown,
                "transient_fd_unknown": self.transient_close_unknown,
                "all_closed": self.closed and not self.transient_close_unknown}


class FileRPC:
    """One admitted owner, exact request ledger, immutable ACK/result files."""
    def __init__(self, directory, owner):
        if directory.scope != owner.scope:
            raise ChannelError("cross-run owner channel refused")
        self.directory, self.owner = directory, owner
        self.requests, self.sequences, self.rejected = {}, {}, {}
        self.last_sequence = 0
        self.channel_lost = False
        self.publication_waits = {}

    @staticmethod
    def request_name(request):
        return f"request-{request['sequence']:06d}-{request['idempotency_key']}.json"

    @staticmethod
    def reply_name(request, terminal=False):
        return f"{'result' if terminal else 'reply'}-{request['sequence']:06d}-{request['idempotency_key']}.json"

    def submit(self, request):
        validate_request(request, self.directory.scope)
        return self.directory.write_new(self.request_name(request), request, MAX_REQUEST_BYTES)

    def _reply(self, record, terminal=False):
        request = record["request"]
        op = record["operation"]
        payload = self.owner.operation_snapshot(op) if op is not None else record["status"]
        value = {"version": 1, "run_id": request["run_id"], "owner_nonce": request["owner_nonce"],
                 "client_nonce": request["client_nonce"], "sequence": request["sequence"],
                 "idempotency_key": request["idempotency_key"], "operation": request["operation"],
                 "terminal": terminal or op is None, "result": payload}
        identity = self.directory.write_new(self.reply_name(request, terminal), value, MAX_REPLY_BYTES)
        record["final_inode" if terminal else "reply_inode"] = identity

    def _reject(self, name, inode, digest):
        match = REQUEST_NAME.fullmatch(name)
        self.rejected[name] = {"inode": inode, "digest": digest}
        self.directory.write_new(f"rejection-{match[1]}-{match[2]}.json",
                                 {"version": 1, "run_id": self.directory.scope.run_id,
                                  "sequence": int(match[1]), "idempotency_key": match[2],
                                  "outcome": "request_rejected"}, MAX_REQUEST_BYTES)

    def poll(self):
        if self.channel_lost:
            return
        try:
            names = self.directory.names()
            for name in names:
                if name in self.rejected:
                    # A rejected request cannot be repaired/replaced in place.
                    _raw, _inode, digest = self.directory.read_raw(name, MAX_REQUEST_BYTES, self.rejected[name]["inode"])
                    if digest != self.rejected[name]["digest"]:
                        raise ChannelError("rejected request replaced")
                    continue
                match = REQUEST_NAME.fullmatch(name)
                accepted_names = {self.request_name(record["request"]) for record in self.requests.values()}
                if name not in accepted_names and len(self.requests) + len(self.rejected) >= MAX_REQUESTS:
                    raise ChannelError("bounded request/rejection ledger exceeded")
                try:
                    raw, inode, digest = self.directory.read_raw(name, MAX_REQUEST_BYTES)
                except PublicationPending:
                    deadline = self.publication_waits.setdefault(name, self.owner.clock.now() + PUBLICATION_TIMEOUT)
                    if self.owner.clock.now() >= deadline:
                        raise ChannelError("bounded publication window exceeded")
                    continue
                self.publication_waits.pop(name, None)
                try:
                    request = _strict_json(raw)
                    validate_request(request, self.directory.scope)
                    if (request["sequence"] != int(match[1]) or request["idempotency_key"] != match[2]):
                        raise ChannelError("request filename/payload conflict")
                    key = request["idempotency_key"]
                    if key in self.requests:
                        original = self.requests[key]
                        if original["request"] != request or original["inode"] != inode or original["digest"] != digest:
                            raise ChannelError("replaced or conflicting idempotent request")
                        continue
                    if (request["sequence"] <= self.last_sequence or request["sequence"] in self.sequences
                            or len(self.requests) >= MAX_REQUESTS):
                        raise ChannelError("stale or conflicting request sequence")
                except (ChannelError, TypeError) as error:
                    if isinstance(error, ChannelError) and str(error) == "replaced or conflicting idempotent request":
                        raise
                    self._reject(name, inode, digest)
                    continue
                try:
                    ticket = self.owner.post_control(request["operation"])
                except RuntimeError:
                    self._reject(name, inode, digest)
                    continue
                record = {"request": request, "inode": inode, "digest": digest,
                          "ticket": ticket, "operation": None, "status": None,
                          "reply_written": False, "final_written": False}
                self.requests[key] = record
                self.sequences[request["sequence"]] = key
                self.last_sequence = request["sequence"]
            for record in self.requests.values():
                name = self.request_name(record["request"])
                if name not in names:
                    raise ChannelError("admitted request disappeared")
                self.directory.read_raw(name, MAX_REQUEST_BYTES, record["inode"])
                ticket = record["ticket"]
                if not ticket.handled:
                    continue
                if ticket.error is not None:
                    if not record["reply_written"]:
                        self._reject(name, record["inode"], record["digest"])
                        record["reply_written"] = True
                    continue
                if not record["reply_written"]:
                    record["operation"] = None if record["request"]["operation"] == "status" else ticket.result
                    record["status"] = ticket.result if record["request"]["operation"] == "status" else None
                    self._reply(record)
                    record["reply_written"] = True
                self.directory.read_raw(self.reply_name(record["request"]), MAX_REPLY_BYTES, record["reply_inode"])
                op = record["operation"]
                if op is not None and op.state != "pending" and not record["final_written"]:
                    self._reply(record, terminal=True)
                    record["final_written"] = True
                elif record["final_written"]:
                    self.directory.read_raw(self.reply_name(record["request"], terminal=True), MAX_REPLY_BYTES, record["final_inode"])
        except Exception as error:
            self.channel_lost = True
            self.owner.post_control_loss(error)

    def read_reply(self, request, terminal=False):
        validate_request(request, self.directory.scope)
        value, _inode, _digest = self.directory.read(self.reply_name(request, terminal), MAX_REPLY_BYTES)
        if (type(value) is not dict or set(value) != {"version", "run_id", "owner_nonce", "client_nonce", "sequence", "idempotency_key", "operation", "terminal", "result"}
                or value["version"] != 1 or type(value["terminal"]) is not bool
                or any(value[field] != request[field] for field in ("run_id", "owner_nonce", "client_nonce", "sequence", "idempotency_key", "operation"))
                or (terminal and value["terminal"] is not True)):
            raise ChannelError("invalid or cross-run reply")
        return value

    def caller_result(self, request, deadline, clock):
        """Nonblocking caller poll; timeout never changes owner/operation."""
        try:
            return self.read_reply(request, terminal=request["operation"] != "status")
        except (FileNotFoundError, PublicationPending):
            if clock.now() >= deadline:
                return {"outcome": "caller_timeout", "pending": True,
                        "run_id": request["run_id"], "idempotency_key": request["idempotency_key"]}
            return None


class FileRPCClient:
    """Caller-only facade; no FixtureOwner/backend reference or spawn method."""
    def __init__(self, directory):
        self.directory = directory

    def submit(self, request):
        validate_request(request, self.directory.scope)
        return self.directory.write_new(FileRPC.request_name(request), request, MAX_REQUEST_BYTES)

    def read_reply(self, request, terminal=False):
        # Reuse the strict response reader without admitting an owner/backend.
        return FileRPC.read_reply(self, request, terminal)

    def reply_name(self, request, terminal=False):
        return FileRPC.reply_name(request, terminal)

    def caller_result(self, request, deadline, clock):
        return FileRPC.caller_result(self, request, deadline, clock)
