"""Temporary-file RPC checks only; no subprocess, socket, service or signal."""
from dataclasses import replace
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))
from owned_fixture_fake import Backend, Clock, Ports, drive, make_owner, owned, rpc


class RPCTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="owned-fake-rpc-")
        self.root = Path(self.temporary.name)
        self.ports = Ports()
        self.directory = self.create()
        self.owner, self.backend, self.clock = make_owner(current_scope=self.directory.scope)
        self.front = rpc.FileRPC(self.directory, self.owner)
        self.clients = []

    def tearDown(self):
        for client in self.clients:
            client.directory.close()
        self.directory.close()
        self.temporary.cleanup()

    def create(self, **overrides):
        args = {"root_directory": self.root, "run_id": "1" * 32, "owner_nonce": "2" * 32,
                "client_nonce": "3" * 32, "ports": (43001, 43002, 43003), "denied_ports": (),
                "allocator": self.ports, "scope_type": owned.Scope}
        args.update(overrides)
        return rpc.PrivateRunDirectory.create(**args)

    def request(self, operation="status", sequence=1, key=None, **overrides):
        value = {"version": 1, "run_id": self.directory.scope.run_id,
                 "owner_nonce": self.directory.scope.owner_nonce, "client_nonce": self.directory.scope.client_nonce,
                 "sequence": sequence, "idempotency_key": key or f"{sequence:032x}", "operation": operation}
        value.update(overrides)
        return value

    def write_raw(self, request, raw):
        path = self.directory.path / rpc.FileRPC.request_name(request)
        path.write_bytes(raw)
        path.chmod(0o600)
        return path

    def service(self):
        self.front.poll()
        self.owner.tick()
        self.front.poll()

    def attached_client(self):
        directory = rpc.PrivateRunDirectory.attach_control(self.directory.path, self.directory.scope,
                                                           self.directory.directory_identity)
        client = rpc.FileRPCClient(directory)
        self.clients.append(client)
        return client

    def test_private_exclusive_directories_and_atomic_regular_files(self):
        for path in (self.directory.path, self.directory.path / "data"):
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        request = self.request()
        self.front.submit(request)
        self.service()
        for name in ("control.json", self.front.request_name(request), self.front.reply_name(request)):
            st = (self.directory.path / name).stat()
            self.assertEqual(st.st_mode & 0o777, 0o600)
            self.assertEqual(st.st_nlink, 1)
        self.assertFalse(any(name.endswith(".tmp") for name in os.listdir(self.directory.path)))

    def test_existing_run_directory_is_rejected_without_reuse(self):
        marker = self.directory.path / "marker"
        marker.write_text("preserve")
        with self.assertRaises(FileExistsError):
            self.create(allocator=Ports())
        self.assertEqual(marker.read_text(), "preserve")

    def test_existing_data_directory_is_never_imported(self):
        old_data = self.directory.path / "data"
        (old_data / "sentinel").write_text("old")
        with self.assertRaises(FileExistsError):
            self.create(allocator=Ports())
        self.assertEqual((old_data / "sentinel").read_text(), "old")

    def test_symlink_root_and_symlink_components_are_refused(self):
        symlink = self.root / "link"
        symlink.symlink_to(self.root, target_is_directory=True)
        for root in (symlink, symlink / self.directory.path.name):
            with self.subTest(root=root):
                with self.assertRaises(rpc.ChannelError):
                    self.create(root_directory=root, allocator=Ports())

    def test_non_private_root_directory_is_refused(self):
        public = self.root / "public"
        public.mkdir(mode=0o755)
        public.chmod(0o755)  # Explicit negative regardless of runner's umask.
        with self.assertRaises(rpc.ChannelError):
            self.create(root_directory=public, allocator=Ports())

    def test_old_scope_tokens_and_path_overlap_are_refused(self):
        for key in ("run_id", "owner_nonce", "client_nonce"):
            with self.subTest(key=key):
                with self.assertRaises(rpc.ChannelError):
                    self.create(**{key: "15e2d8bb" + "0" * 24}, allocator=Ports())
        sealed = self.root / owned.OLD_RUN_ID
        sealed.mkdir(mode=0o700)
        with self.assertRaises(rpc.ChannelError):
            self.create(root_directory=sealed, allocator=Ports())

    def test_equal_nonces_are_refused(self):
        with self.assertRaises(rpc.ChannelError):
            self.create(run_id="4" * 32, owner_nonce="4" * 32, allocator=Ports())

    def test_reused_owner_or_client_nonce_is_refused_across_fresh_runs(self):
        for changes in ({"run_id": "4" * 32, "owner_nonce": "2" * 32, "client_nonce": "5" * 32},
                        {"run_id": "6" * 32, "owner_nonce": "7" * 32, "client_nonce": "3" * 32}):
            with self.subTest(changes=changes):
                allocator = Ports()
                with self.assertRaises(FileExistsError):
                    self.create(**changes, allocator=allocator)
                self.assertEqual(allocator.calls, [])
                self.assertFalse((self.root / ("owned-" + changes["run_id"])).exists())
        for nonce in ("1" * 32, "2" * 32, "3" * 32):
            self.assertEqual((self.root / ("nonce-" + nonce + ".claim")).stat().st_mode & 0o777, 0o600)

    def test_old_and_occupied_ports_are_refused_without_connection(self):
        for ports, denied, allocator in (((33637,), (), Ports()),
                                         ((33535,), (), Ports()),
                                         ((44001,), (44001,), Ports()),
                                         ((44002,), (), Ports(occupied=(44002,)))):
            with self.subTest(ports=ports):
                with self.assertRaises(rpc.ChannelError):
                    self.create(run_id="4" * 32, owner_nonce="5" * 32, client_nonce="6" * 32,
                                ports=ports, denied_ports=denied, allocator=allocator)
        self.assertEqual(self.backend.calls, [])

    def test_control_attach_does_not_import_or_replace_an_owner(self):
        client = self.attached_client()
        self.assertFalse(hasattr(client, "owner"))
        self.assertFalse(hasattr(client, "backend"))
        request = self.request()
        client.submit(request)
        self.service()
        reply = client.caller_result(request, self.clock.now() + 1, self.clock)
        self.assertTrue(reply["terminal"])
        self.assertEqual(reply["result"]["run_id"], self.owner.scope.run_id)
        self.assertEqual(self.backend.calls, [])

    def test_inaccessible_control_attach_has_no_owner_takeover(self):
        with self.assertRaises(FileNotFoundError):
            rpc.PrivateRunDirectory.attach_control(self.root / "missing", self.directory.scope,
                                                    self.directory.directory_identity)
        with self.assertRaises(rpc.ChannelError):
            rpc.PrivateRunDirectory.attach_control(self.directory.path, self.directory.scope, (0, 0))
        self.assertEqual(self.backend.calls, [])

    def test_wrong_owner_manifest_cannot_attach(self):
        path = self.directory.path / "control.json"
        content = json.loads(path.read_text())
        content["owner_nonce"] = "f" * 32
        path.write_text(json.dumps(content))
        with self.assertRaises(rpc.ChannelError):
            self.attached_client()

    def test_status_returns_terminal_reply_without_waiting_for_result_file(self):
        request = self.request()
        self.front.submit(request)
        self.service()
        result = self.front.caller_result(request, self.clock.now(), self.clock)
        self.assertTrue(result["terminal"])
        self.assertEqual(result["result"]["state"], "driver_running")

    def test_exact_schema_rejects_all_process_control_and_network_fields(self):
        for field in ("pid", "path", "url", "shell", "signal", "credentials", "executable", "timestamp"):
            with self.subTest(field=field):
                with self.assertRaises(rpc.ChannelError):
                    self.front.submit(self.request(**{field: "forbidden"}))
        self.assertEqual(self.backend.calls, [])

    def test_version_sequence_and_operation_types_are_exact(self):
        for change in ({"version": True}, {"version": 2}, {"sequence": True}, {"sequence": 0},
                       {"sequence": 129}, {"operation": {}}, {"operation": "kill"}, {"idempotency_key": "short"}):
            with self.subTest(change=change):
                with self.assertRaises(rpc.ChannelError):
                    self.front.submit(self.request(**change))

    def test_cross_run_and_stale_nonce_requests_do_not_reach_owner(self):
        for key in ("run_id", "owner_nonce", "client_nonce"):
            with self.subTest(key=key):
                request = self.request(sequence=len(self.front.rejected) + 1, **{key: "e" * 32})
                self.write_raw(request, json.dumps(request).encode())
                self.service()
        self.assertEqual(self.backend.calls, [])
        self.assertEqual(len(self.front.rejected), 3)
        self.assertFalse(self.front.channel_lost)

    def test_malformed_partial_duplicate_and_nonfinite_json_are_rejected(self):
        controls = (b"{", b"not-json", b'{"version":1,"version":1}', b'{"version":NaN}', b'\xff')
        for index, raw in enumerate(controls, 1):
            request = self.request(sequence=index)
            self.write_raw(request, raw)
            self.service()
            rejection, _inode, _digest = self.directory.read(f"rejection-{index:06d}-{request['idempotency_key']}.json", 2048)
            self.assertEqual(rejection["outcome"], "request_rejected")
        self.assertEqual(self.backend.calls, [])
        self.assertFalse(self.front.channel_lost)

    def test_oversized_file_and_symlink_trigger_sticky_channel_loss(self):
        request = self.request()
        self.write_raw(request, b"x" * (rpc.MAX_REQUEST_BYTES + 1))
        self.service()
        self.assertTrue(self.front.channel_lost)
        self.assertTrue(self.owner.control_lost)
        self.assertEqual(len(self.front.requests), 0)

    def test_symlink_and_hardlink_requests_are_never_followed(self):
        request = self.request()
        outside = self.root / "foreign"
        outside.write_text(json.dumps(request))
        outside.chmod(0o600)
        path = self.directory.path / self.front.request_name(request)
        path.symlink_to(outside)
        self.service()
        self.assertTrue(self.owner.control_lost)
        self.assertEqual(self.front.requests, {})

    def test_hardlinked_request_is_not_exclusive(self):
        request = self.request()
        outside = self.root / "foreign"
        outside.write_text(json.dumps(request))
        outside.chmod(0o600)
        os.link(outside, self.directory.path / self.front.request_name(request))
        self.service()
        self.assertTrue(self.owner.control_lost)
        self.assertEqual(self.front.requests, {})

    def test_partial_temporary_file_is_not_a_published_request(self):
        path = self.directory.path / ("incoming-" + "a" * 32 + ".tmp")
        path.write_bytes(b"{")
        path.chmod(0o600)
        self.service()
        self.assertFalse(self.front.requests)
        self.assertFalse(self.front.channel_lost)

    def test_atomic_link_publication_window_is_pending_not_permanent_rejection(self):
        request = self.request()
        original = os.link
        windows = []
        def linked(source, destination, **kwargs):
            original(source, destination, **kwargs)
            if destination.startswith("request-"):
                self.front.poll()
                windows.append(bool(self.front.publication_waits))
        with patch.object(os, "link", side_effect=linked):
            self.front.submit(request)
        self.service()
        self.assertEqual(windows, [True])
        self.assertFalse(self.front.rejected)
        self.assertFalse(self.front.channel_lost)
        self.assertTrue(self.front.read_reply(request)["terminal"])

    def test_unfinished_publication_is_bounded_and_cannot_block_owner(self):
        request = self.request()
        temporary = self.directory.path / ("incoming-" + "a" * 32 + ".tmp")
        temporary.write_text(json.dumps(request))
        temporary.chmod(0o600)
        os.link(temporary, self.directory.path / self.front.request_name(request))
        for _ in range(9):
            self.front.poll()
        self.assertFalse(self.front.channel_lost)
        self.clock.advance(rpc.PUBLICATION_TIMEOUT)
        self.front.poll()
        self.owner.tick()
        self.assertTrue(self.owner.control_lost)
        self.assertEqual(self.front.requests, {})

    def test_same_idempotency_key_never_dispatches_a_second_operation(self):
        request = self.request("restore_fixture")
        self.front.submit(request)
        self.service()
        ticket = self.front.requests[request["idempotency_key"]]["ticket"]
        for _ in range(10):
            self.service()
        self.assertIs(self.front.requests[request["idempotency_key"]]["ticket"], ticket)
        self.assertEqual(len(self.owner.operations), 1)
        with self.assertRaises(FileExistsError):
            self.front.submit(request)

    def test_conflicting_key_reuse_is_rejected_without_another_operation(self):
        first = self.request("restore_fixture")
        self.front.submit(first)
        self.service()
        conflicting = self.request("stop_fixture", sequence=2, key=first["idempotency_key"])
        self.front.submit(conflicting)
        self.service()
        self.assertTrue(self.owner.control_lost)
        self.assertEqual(len(self.front.requests), 1)

    def test_stale_sequence_is_rejected_and_preserves_original_result(self):
        first = self.request(sequence=2)
        self.front.submit(first)
        self.service()
        stale = self.request(sequence=1)
        self.front.submit(stale)
        self.service()
        self.assertIn(self.front.request_name(stale), self.front.rejected)
        self.assertFalse(self.owner.control_lost)
        self.assertTrue(self.front.read_reply(first)["terminal"])

    def test_replaced_request_and_mutated_reply_cannot_be_reused(self):
        request = self.request()
        self.front.submit(request)
        self.service()
        path = self.directory.path / self.front.request_name(request)
        replacement = self.root / "replacement"
        replacement.write_text(json.dumps(request))
        replacement.chmod(0o600)
        os.replace(replacement, path)
        self.service()
        self.assertTrue(self.owner.control_lost)

    def test_changed_reply_is_detected_by_immutable_file_identity(self):
        request = self.request()
        self.front.submit(request)
        self.service()
        path = self.directory.path / self.front.reply_name(request)
        path.write_text('{"forged":true}')
        self.service()
        self.assertTrue(self.owner.control_lost)

    def test_cross_run_replies_are_rejected_by_caller(self):
        request = self.request()
        self.front.submit(request)
        self.service()
        path = self.directory.path / self.front.reply_name(request)
        value = json.loads(path.read_text())
        value["owner_nonce"] = "f" * 32
        path.write_text(json.dumps(value))
        with self.assertRaises(rpc.ChannelError):
            self.front.read_reply(request)

    def test_directory_replacement_or_loss_is_sticky_without_replacement_owner(self):
        displaced = self.root / "displaced"
        self.directory.path.rename(displaced)
        self.directory.path.mkdir(mode=0o700)
        self.service()
        self.assertTrue(self.owner.control_lost)
        self.assertTrue(self.front.channel_lost)
        self.assertFalse(self.owner.snapshot()["owner_may_exit"])

    def test_data_directory_replacement_is_rejected(self):
        data = self.directory.path / "data"
        data.rename(self.directory.path / "former-data")
        data.mkdir(mode=0o700)
        self.service()
        self.assertTrue(self.owner.control_lost)

    def test_shared_restore_stop_and_caller_timeout_late_result(self):
        for state in self.owner.lifetimes.values():
            state.suspension_possible = True
            self.backend.rows[state.admission.lifetime_id]["execution_state"] = "stopped"
        self.backend.plans[("child_0", "continue")] = {"delay": .5}
        restore = self.request("restore_fixture")
        stop = self.request("stop_fixture", sequence=2)
        client = self.attached_client()
        client.submit(restore)
        self.service()
        original = self.owner.restore_operation
        client.submit(stop)
        self.service()
        self.assertIs(self.owner.restore_operation, original)
        timeout = client.caller_result(restore, self.clock.now(), self.clock)
        self.assertEqual(timeout["outcome"], "caller_timeout")
        self.assertTrue(timeout["pending"])
        drive(self.owner, self.clock, lambda: self.owner._terminal, front=self.front)
        self.front.poll()
        self.assertEqual(client.caller_result(restore, self.clock.now(), self.clock)["result"]["state"], "completed")
        self.assertEqual(sum(n == "child_0" and a == "continue" for n, a, _d in self.backend.calls), 1)

    def test_slow_or_absent_file_front_does_not_run_inside_owner_tick(self):
        self.backend.driver = "blocking"
        self.clock.advance(61)
        # No front.poll at all: owner cleanup still proceeds independently.
        drive(self.owner, self.clock, lambda: self.owner._terminal)
        self.assertTrue(self.owner.lifetimes["root"].actual_waitpid)
        self.assertEqual(self.front.requests, {})

    def test_reply_sink_failure_is_preserved_and_cleanup_stays_independent(self):
        request = self.request("restore_fixture")
        self.front.submit(request)
        original = self.directory.write_new
        def failed(name, value, maximum):
            if name.startswith("reply-"):
                raise OSError("fake secret sink error")
            return original(name, value, maximum)
        with patch.object(self.directory, "write_new", side_effect=failed):
            self.service()
            self.owner.tick()
        self.assertTrue(self.owner.control_lost)
        self.assertEqual(self.owner.errors[self.owner.primary_error]["code"], "owner_control_lost")
        self.assertNotIn("fake secret", json.dumps(self.owner.snapshot()))
        drive(self.owner, self.clock, lambda: self.owner._terminal)
        self.assertEqual(self.owner.state, "unresolved")

    def test_rejection_ledger_is_bounded_even_when_bad_files_are_removed(self):
        for index in range(1, rpc.MAX_REQUESTS + 1):
            request = self.request(sequence=index)
            path = self.write_raw(request, b"{")
            self.service()
            path.unlink()
        request = self.request(sequence=1, key="f" * 32)
        self.write_raw(request, b"{")
        self.service()
        self.assertTrue(self.front.channel_lost)
        self.assertEqual(len(self.front.rejected), rpc.MAX_REQUESTS)


if __name__ == "__main__":
    unittest.main()
