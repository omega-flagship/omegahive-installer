"""Purpose: verify the public Linux bootstrap's file and local-owner identity boundaries."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("bootstrap_under_test", Path(__file__).with_name("bootstrap.py"))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def test_control_pin_matches_the_release_control_module(self):
        raw = Path(__file__).with_name("control.py").read_bytes()
        self.assertEqual(bootstrap.CONTROL_PIN, (len(raw), hashlib.sha256(raw).hexdigest()))

    def test_exact_private_owner_file_is_read_and_changed_bytes_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "runtime.json"
            raw = b'{"public":true}'
            path.write_bytes(raw)
            path.chmod(0o600)
            pin = (len(raw), hashlib.sha256(raw).hexdigest())
            self.assertEqual(bootstrap.read_owned(path, private=True, pin=pin), raw)
            path.write_bytes(b'{"public":false}')
            with self.assertRaises(bootstrap.Refused):
                bootstrap.read_owned(path, private=True, pin=pin)

    def test_links_shared_files_and_writable_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "runtime.json"
            path.write_text("{}")
            path.chmod(0o600)
            linked = Path(folder) / "linked"
            linked.symlink_to(path)
            with self.assertRaises(bootstrap.Refused):
                bootstrap.read_owned(linked)
            linked.unlink()
            os.link(path, linked)
            with self.assertRaises(bootstrap.Refused):
                bootstrap.read_owned(path)
            linked.unlink()
            path.chmod(0o666)
            with self.assertRaises(bootstrap.Refused):
                bootstrap.read_owned(path)

    def test_duplicate_keys_and_nonfinite_values_are_rejected(self):
        for raw in ('{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}'):
            with self.subTest(raw=raw), self.assertRaises(bootstrap.Refused):
                bootstrap.strict_json(raw)

    def owner(self):
        config = {"port": 8700, "app_pins": {}, "plugin_dirs": [], "studio_maker_template": None}
        hello = {"ok": True, "local_owner": True, "pid": 123, "port": 8700,
                 "instance": "instance", "owner": "user:u_test"}
        control = SimpleNamespace(loader_agreement=Mock(), wait_for_hello=Mock(return_value=(hello, 123)),
                                  exe_matches=Mock(return_value=True), listener_matches=Mock(return_value=True))
        return config, hello, control

    def test_named_owner_is_verified_without_creating_a_session_or_mind(self):
        config, _hello, control = self.owner()
        bootstrap.verify_owner(control, config, Path("/home/test"))
        control.loader_agreement.assert_called_once_with(config)
        control.exe_matches.assert_called_once()
        control.listener_matches.assert_called_once()

    def test_external_app_pins_or_templates_are_rejected_before_contact(self):
        for changes in ({"app_pins": {"excluded": {}}}, {"plugin_dirs": ["/external"]},
                        {"studio_maker_template": "a_template"}):
            config, _hello, control = self.owner()
            config.update(changes)
            with self.assertRaises(bootstrap.Refused):
                bootstrap.verify_owner(control, config, Path("/home/test"))
            control.wait_for_hello.assert_not_called()

    def test_wrong_owner_or_process_reply_is_rejected(self):
        for changes in ({"ok": False}, {"local_owner": False}, {"owner": "user:operator"},
                        {"pid": 124}, {"port": 9999}, {"instance": None}):
            config, hello, control = self.owner()
            hello.update(changes)
            with self.assertRaises(bootstrap.Refused):
                bootstrap.verify_owner(control, config, Path("/home/test"))

    def test_executable_or_listener_mismatch_is_rejected(self):
        for name in ("exe_matches", "listener_matches"):
            config, _hello, control = self.owner()
            getattr(control, name).return_value = False
            with self.assertRaises(bootstrap.Refused):
                bootstrap.verify_owner(control, config, Path("/home/test"))


if __name__ == "__main__":
    unittest.main()
