"""Purpose: verify the public Linux bootstrap's file and local-owner identity boundaries and its Create review."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import unittest.mock
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

    ROOT = "/home/test/.local/share/omegahive/releases/linux-hive-v0.34"
    DIGEST = "sha256:" + "d" * 64

    def owner(self):
        studio = self.ROOT + "/apps/omegadesign"
        config = {"port": 8700, "runtime_root": self.ROOT,
                  "app_pins": {"omegadesign": {"release": studio, "digest": self.DIGEST, "files": {}}},
                  "plugin_dirs": [studio], "studio_maker_template": None}
        hello = {"ok": True, "local_owner": True, "pid": 123, "port": 8700,
                 "instance": "instance", "owner": "user:u_test",
                 "preflight": {"status": "incomplete", "minds": True, "tools": False, "reason": "tools unverified"}}
        control = SimpleNamespace(loader_agreement=Mock(), wait_for_hello=Mock(return_value=(hello, 123)),
                                  exe_matches=Mock(return_value=True), listener_matches=Mock(return_value=True))
        return config, hello, control

    def test_named_owner_is_verified_before_any_session(self):
        config, _hello, control = self.owner()
        bootstrap.verify_owner(control, config, Path("/home/test"))
        control.loader_agreement.assert_called_once_with(config)
        control.exe_matches.assert_called_once()
        control.listener_matches.assert_called_once()

    def test_anything_but_studio_from_its_own_folder_is_rejected_before_contact(self):
        elsewhere = {"omegadesign": {"release": "/external/omegadesign", "digest": self.DIGEST, "files": {}}}
        for changes in ({"app_pins": {"excluded": {}}}, {"app_pins": {}}, {"plugin_dirs": ["/external"]},
                        {"plugin_dirs": []}, {"app_pins": elsewhere}, {"studio_maker_template": "a_template"}):
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

    def test_hive_whose_preflight_refuses_minds_fails_with_its_reason(self):
        reason = "sandbox checks failed: mind.userns"
        for preflight in ({"status": "fail", "minds": False, "tools": False, "reason": reason}, None, {"minds": "yes"}):
            config, hello, control = self.owner()
            hello["preflight"] = preflight
            with self.subTest(preflight=preflight), self.assertRaises(bootstrap.MindsRefused) as caught:
                bootstrap.verify_owner(control, config, Path("/home/test"))
            message = bootstrap.failure_message(caught.exception)
            self.assertTrue(message.startswith("Your hive started, but its minds can't run in their sandbox"))
            self.assertEqual(reason in message, preflight is not None and preflight.get("reason") == reason)


class Turns(list):
    """Answers given in turn, the last one repeated: a route the hive answers differently as setup goes on."""


class FakeHive:
    """A scripted owner session: each route answers from `answers` (a Turns is consumed in turn), every call recorded."""

    def __init__(self, answers):
        self.answers, self.calls = answers, []
        self.principal, self.deadline = "user:u_test", bootstrap.time.monotonic() + 30

    def request(self, method, path, payload=None, *, cleanup=False):
        self.calls.append((method, path, payload))
        answer = self.answers.get((method, path))
        if isinstance(answer, Turns):
            return answer.pop(0) if len(answer) > 1 else answer[0]
        return answer


class CreateTests(unittest.TestCase):
    DIGEST = "sha256:" + "d" * 64
    PIN = {"release": "/r/apps/omegadesign", "digest": DIGEST, "files": {}}
    CONTROLLER = {"id": "a_ctl", "name": "Create · Code controller", "swarm_id": "s_code", "budget_usd": 0.5}

    def hive(self, changes=None):
        studio = "/api/programs/omegadesign"
        answers = {
            ("GET", studio): {"id": "omegadesign", "digest": self.DIGEST, "error": None, "ui": True},
            ("GET", "/api/agents"): Turns([[{"id": "a_me", "name": "Your mind"}], [{"id": "a_me", "name": "Your mind"}, self.CONTROLLER]]),
            ("GET", "/api/agents/a_ctl"): dict(self.CONTROLLER, budget_usd=5),
            ("GET", studio + "/install"): Turns([{"program": "omegadesign", "release_digest": self.DIGEST, "placement": "swarm", "installed": False},
                                           {"program": "omegadesign", "release_digest": self.DIGEST, "placement": "swarm", "installed": True,
                                            "review": {"revoked": False, "release_digest": self.DIGEST, "by": "user:u_test"}}]),
            ("POST", studio + "/install"): {"installed": True, "release_digest": self.DIGEST},
            ("GET", studio + "/activations"): [{"swarm_id": "s_code", "active": True}],
            ("GET", "/api/me/apps"): {"apps": [{"id": "omegadesign", "name": "Create", "placement": "swarm"}]},
        }
        answers.update(changes or {})
        return FakeHive(answers)

    def test_studio_is_reviewed_in_the_controllers_swarm_and_create_is_listed(self):
        api = self.hive()
        with unittest.mock.patch.object(bootstrap.time, "sleep"):
            bootstrap.put_in_create(api, self.PIN)
        writes = [(m, p, b) for m, p, b in api.calls if m != "GET"]
        self.assertEqual(writes, [("PATCH", "/api/agents/a_ctl", {"budget_usd": 5}),
                                  ("POST", "/api/programs/omegadesign/install",
                                   {"release_digest": self.DIGEST, "placement": "swarm", "use_in": ["s_code"]})])
        self.assertIn(("GET", "/api/me/apps", None), api.calls)

    def test_an_inactive_swarm_is_turned_on_and_an_installed_release_is_not_reviewed_again(self):
        done = {"program": "omegadesign", "release_digest": self.DIGEST, "placement": "swarm", "installed": True,
                "review": {"revoked": False, "release_digest": self.DIGEST, "by": "user:u_test"}}
        api = self.hive({("GET", "/api/programs/omegadesign/install"): done,
                           ("GET", "/api/programs/omegadesign/activations"): [],
                           ("GET", "/api/agents"): [dict(self.CONTROLLER, budget_usd=5)]})
        bootstrap.put_in_create(api, self.PIN)
        writes = [(m, p, b) for m, p, b in api.calls if m != "GET"]
        self.assertEqual(writes, [("POST", "/api/programs/omegadesign/activations", {"swarm_id": "s_code"})])

    def test_a_person_placement_installs_with_no_swarm(self):
        person = {"program": "omegadesign", "release_digest": self.DIGEST, "placement": "person", "installed": False}
        final = dict(person, installed=True, review={"revoked": False, "release_digest": self.DIGEST, "by": "user:u_test"})
        api = self.hive({("GET", "/api/programs/omegadesign/install"): Turns([person, final])})
        with unittest.mock.patch.object(bootstrap.time, "sleep"):
            bootstrap.put_in_create(api, self.PIN)
        self.assertIn(("POST", "/api/programs/omegadesign/install",
                       {"release_digest": self.DIGEST, "placement": "person", "use_in": []}), api.calls)
        self.assertNotIn("/api/programs/omegadesign/activations", [p for _m, p, _b in api.calls])

    def test_create_missing_from_the_app_list_or_another_release_refuses(self):
        cases = ({("GET", "/api/me/apps"): {"apps": [{"id": "omegadesign", "name": "Studio"}]}},
                 {("GET", "/api/me/apps"): {"apps": []}},
                 {("GET", "/api/programs/omegadesign"): {"id": "omegadesign", "digest": "sha256:" + "e" * 64, "error": None, "ui": True}},
                 {("GET", "/api/programs/omegadesign"): {"id": "omegadesign", "digest": self.DIGEST, "error": "broken", "ui": True}},
                 {("GET", "/api/agents/a_ctl"): dict(self.CONTROLLER, budget_usd=0.5)},
                 {("GET", "/api/agents"): [self.CONTROLLER, dict(self.CONTROLLER, id="a_two")]})
        for changes in cases:
            with self.subTest(changes=changes), unittest.mock.patch.object(bootstrap.time, "sleep"), \
                    self.assertRaises(bootstrap.Refused):
                bootstrap.put_in_create(self.hive(changes), self.PIN)

    def test_a_controller_that_never_appears_refuses_at_the_deadline(self):
        api = self.hive({("GET", "/api/agents"): []})
        api.deadline = bootstrap.time.monotonic() + 1
        with unittest.mock.patch.object(bootstrap.time, "sleep"), self.assertRaises(bootstrap.Refused) as caught:
            bootstrap.put_in_create(api, self.PIN)
        self.assertIn("Create · Code controller", str(caught.exception))

    def test_a_named_refusal_reaches_the_person_and_a_bare_one_stays_generic(self):
        self.assertTrue(bootstrap.failure_message(bootstrap.Refused("Studio did not load in your hive as reviewed."))
                        .startswith("Studio did not load in your hive as reviewed."))
        self.assertTrue(bootstrap.failure_message(bootstrap.Refused()).startswith("The installed hive could not confirm"))


if __name__ == "__main__":
    unittest.main()
