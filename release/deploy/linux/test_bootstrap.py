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


class ProposalTestsTests(unittest.TestCase):
    """bootstrap.enable_proposal_tests: Create's Code tab tests proposals once its service has joined the hive."""

    @staticmethod
    def setup_code(folder, enabled=False, policy="proposal-only"):
        root = Path(folder) / "code"; root.mkdir(mode=0o700)
        path = root / "config.json"
        path.write_text(json.dumps({"port": 8724, "proposal_tests_enabled": enabled, "sandbox_project_tests_enabled": True,
                                    "repositories": {"small-app": {"path": "/r", "execution_policy": policy}}}))
        path.chmod(0o600)
        return {"code_service": {"root": str(root), "config": str(path), "port": 8724}}

    def test_tests_go_on_after_enrolment_and_the_service_restarts_into_them(self):
        with tempfile.TemporaryDirectory() as folder:
            config = self.setup_code(folder); CodeEnrolmentTests.register_as(config, CodeEnrolmentTests.NEW)
            with unittest.mock.patch.object(bootstrap.subprocess, "run") as run, \
                    unittest.mock.patch.object(bootstrap, "loopback_listener_owned", side_effect=[False, True]), \
                    unittest.mock.patch.object(bootstrap.time, "sleep"):
                bootstrap.enable_proposal_tests(config, bootstrap.time.monotonic() + 60)
            path = Path(config["code_service"]["config"])
            self.assertIs(json.loads(path.read_text())["proposal_tests_enabled"], True)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(run.call_args.args[0], ["/usr/bin/systemctl", "--user", "restart", "omegacode.service"])
            self.assertEqual(run.call_args.kwargs["env"]["XDG_RUNTIME_DIR"], "/run/user/" + str(os.getuid()))

    def test_a_service_already_testing_is_left_running(self):
        with tempfile.TemporaryDirectory() as folder:
            config = self.setup_code(folder, enabled=True); CodeEnrolmentTests.register_as(config, CodeEnrolmentTests.NEW)
            with unittest.mock.patch.object(bootstrap.subprocess, "run") as run:
                bootstrap.enable_proposal_tests(config, bootstrap.time.monotonic() + 60)
            run.assert_not_called()

    def test_a_service_not_joined_or_set_to_run_natively_is_refused(self):
        for joined, policy in ((False, "proposal-only"), (True, "trusted-native")):
            with self.subTest(joined=joined, policy=policy), tempfile.TemporaryDirectory() as folder:
                config = self.setup_code(folder, policy=policy)
                if joined:
                    CodeEnrolmentTests.register_as(config, CodeEnrolmentTests.NEW)
                with unittest.mock.patch.object(bootstrap.subprocess, "run") as run, self.assertRaises(bootstrap.Refused):
                    bootstrap.enable_proposal_tests(config, bootstrap.time.monotonic() + 60)
                run.assert_not_called()


class CodeAcceptedTests(unittest.TestCase):
    """bootstrap.code_accepted: setup ends once the hive's Code guard accepts the Code service it just restarted."""

    def test_refusals_while_the_service_comes_back_are_waited_out(self):
        api = SimpleNamespace(deadline=bootstrap.time.monotonic() + 30, relay_accepts=Mock(side_effect=[False, False, True]))
        with unittest.mock.patch.object(bootstrap.time, "sleep") as slept:
            bootstrap.code_accepted(api)
        self.assertEqual((api.relay_accepts.call_count, slept.call_count), (3, 2))

    def test_a_guard_that_never_accepts_refuses_at_the_deadline(self):
        api = SimpleNamespace(deadline=bootstrap.time.monotonic() + 0.5, relay_accepts=Mock(return_value=False))
        with unittest.mock.patch.object(bootstrap.time, "sleep"), self.assertRaises(bootstrap.Refused) as refused:
            bootstrap.code_accepted(api)
        self.assertIn("didn't accept Create's Code service", str(refused.exception))

    def test_only_the_relay_answer_and_the_guard_refusal_are_read(self):
        # hive/core/code.py: CodeError(404, "not_relayed", ...) for a route Code doesn't carry, 503 while the guard refuses
        self.assertTrue(bootstrap.relay_verdict(404, {"error": "not_relayed", "detail": "GET /setup-ready is not available"}))
        self.assertFalse(bootstrap.relay_verdict(503, {"error": "service_release_mismatch"}))
        for status, value in ((404, {"error": "not_found"}), (200, {}), (502, {"error": "not_relayed"})):
            with self.subTest(status=status, value=value), self.assertRaises(bootstrap.Refused):
                bootstrap.relay_verdict(status, value)

    def test_the_owner_client_keeps_the_relay_probe_out_of_its_ordinary_routes(self):
        client = bootstrap.OwnerAPI(Mock(), {"port": 8700}, Path("/home/test"), 1, {}, bootstrap.time.monotonic() + 30)
        with self.assertRaises(bootstrap.Refused):
            client.request("GET", bootstrap.OwnerAPI.RELAY_PROBE)


class CodeEnrolmentTests(unittest.TestCase):
    TOKEN = "t" * 48
    OLD, NEW = "svc_" + "0" * 32, "svc_" + "1" * 32

    def config(self, folder):
        root = Path(folder) / "code"; root.mkdir(mode=0o700)
        token = root / "operator-token"; token.write_text(self.TOKEN); token.chmod(0o600)
        return {"code_service": {"root": str(root), "port": 8724}}

    @staticmethod
    def register_as(config, service_id, status="active"):
        """What omegacode's registration.py leaves in its state folder: the registration, 0600, its receipt's status."""
        state = Path(config["code_service"]["root"]) / "state"; state.mkdir(mode=0o700, exist_ok=True)
        path = state / "registration.json"
        path.write_text(json.dumps({"service_id": service_id, "receipt": {"service_id": service_id, "status": status}}))
        path.chmod(0o600)

    def test_an_enrolled_service_is_left_alone(self):
        with tempfile.TemporaryDirectory() as folder:
            config = self.config(folder); self.register_as(config, self.NEW)
            api = FakeHive({("GET", "/api/services"): [{"id": self.NEW, "name": "omegacode", "enabled": True}]})
            with unittest.mock.patch.object(bootstrap, "code_register") as register:
                bootstrap.enrol_code(api, config)
            register.assert_not_called()
            self.assertEqual({m for m, _p, _b in api.calls}, {"GET"})

    def test_the_owner_enrols_and_the_service_registers_with_its_own_token(self):
        with tempfile.TemporaryDirectory() as folder:
            config = self.config(folder)
            api = FakeHive({("GET", "/api/services"): Turns([[], [{"id": self.NEW, "name": "omegacode"}]]),
                            ("POST", "/api/services/enrol"): {"enrol_token": "e" * 40}})
            with unittest.mock.patch.object(bootstrap, "code_register",
                                            side_effect=lambda *_a: self.register_as(config, self.NEW)) as register:
                bootstrap.enrol_code(api, config)
            self.assertIn(("POST", "/api/services/enrol", {"name": "omegacode"}), api.calls)
            register.assert_called_once_with(8724, self.TOKEN, "e" * 40, api.deadline)
            self.assertNotIn("DELETE", [m for m, _p, _b in api.calls])

    def test_an_update_enrols_the_new_service_and_removes_the_hives_record_of_the_gone_one(self):
        # Uninstall removed the Code folder with its registration; the kept hive still lists the old service, whose id
        # the new service would answer 404 to. The old record goes only once the new service is listed.
        with tempfile.TemporaryDirectory() as folder:
            config = self.config(folder)
            old = {"id": self.OLD, "name": "omegacode", "enabled": True}
            api = FakeHive({("GET", "/api/services"): Turns([[old], [old, {"id": self.NEW, "name": "omegacode"}]]),
                            ("POST", "/api/services/enrol"): {"enrol_token": "e" * 40}})
            with unittest.mock.patch.object(bootstrap, "code_register",
                                            side_effect=lambda *_a: self.register_as(config, self.NEW)) as register:
                bootstrap.enrol_code(api, config)
            register.assert_called_once()
            deletes = [p for m, p, _b in api.calls if m == "DELETE"]
            self.assertEqual(deletes, ["/api/services/" + self.OLD])
            self.assertLess(api.calls.index(("POST", "/api/services/enrol", {"name": "omegacode"})),
                            api.calls.index(("DELETE", "/api/services/" + self.OLD, None)))

    def test_a_registration_naming_another_service_or_still_pending_enrols_anew(self):
        for registered, status in ((self.OLD, "active"), (self.NEW, "pending")):
            with self.subTest(registered=registered, status=status), tempfile.TemporaryDirectory() as folder:
                config = self.config(folder); self.register_as(config, registered, status)
                api = FakeHive({("GET", "/api/services"): Turns([[{"id": self.NEW, "name": "omegacode"}],
                                                                 [{"id": self.NEW, "name": "omegacode"}]]),
                                ("POST", "/api/services/enrol"): {"enrol_token": "e" * 40}})
                with unittest.mock.patch.object(bootstrap, "code_register",
                                                side_effect=lambda *_a: self.register_as(config, self.NEW)) as register:
                    bootstrap.enrol_code(api, config)
                register.assert_called_once()

    def test_a_service_the_hive_does_not_list_after_registering_refuses(self):
        with tempfile.TemporaryDirectory() as folder:
            config = self.config(folder)
            api = FakeHive({("GET", "/api/services"): [], ("POST", "/api/services/enrol"): {"enrol_token": "e" * 40}})
            with unittest.mock.patch.object(bootstrap, "code_register", side_effect=lambda *_a: self.register_as(config, self.NEW)), \
                    self.assertRaisesRegex(bootstrap.Refused, "doesn't list it"):
                bootstrap.enrol_code(api, config)

    def test_the_owner_client_deletes_only_a_service_record_and_with_no_body(self):
        client = bootstrap.OwnerAPI(Mock(), {"port": 8700}, Path("/home/test"), 1, {}, bootstrap.time.monotonic() + 30)
        for method, path, payload in (("DELETE", "/api/agents/a_x", None), ("DELETE", "/api/services/enrol", None),
                                      ("DELETE", "/api/services/" + self.OLD, {}), ("PUT", "/api/services/" + self.OLD, None),
                                      ("POST", "/api/services/" + self.OLD, None)):
            with self.subTest(method=method, path=path), self.assertRaises(bootstrap.Refused):
                client.request(method, path, payload)

    def serve(self, status):
        """One loopback HTTP server this account owns, answering every POST with `status`, recording what came."""
        import http.server, threading
        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                seen.append((self.path, self.headers.get("Authorization"),
                             json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                self.send_response(status); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"{}")

            def log_message(self, *_args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        return server.server_address[1], seen

    def test_registration_goes_to_our_own_loopback_listener_with_the_operator_token(self):
        port, seen = self.serve(200)
        bootstrap.code_register(port, self.TOKEN, "e" * 40, bootstrap.time.monotonic() + 10)
        self.assertEqual(seen, [("/v1/operator/register", "Bearer " + self.TOKEN, {"enrol_token": "e" * 40})])

    def test_a_refused_registration_or_a_port_nobody_listens_on_refuses(self):
        port, _seen = self.serve(403)
        with self.assertRaisesRegex(bootstrap.Refused, "refused its registration"):
            bootstrap.code_register(port, self.TOKEN, "e" * 40, bootstrap.time.monotonic() + 10)
        with unittest.mock.patch.object(bootstrap.time, "sleep"), self.assertRaisesRegex(bootstrap.Refused, "did not start listening"):
            bootstrap.code_register(1, self.TOKEN, "e" * 40, bootstrap.time.monotonic() + 2)


if __name__ == "__main__":
    unittest.main()
