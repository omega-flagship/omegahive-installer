"""Own bootstrap contract tests. Synthetic responses only; no live Hive imports."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bootstrap_under_test', Path(__file__).with_name('bootstrap.py'))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
SEED = json.loads(Path(__file__).with_name('studio-maker-template.json').read_text())
PERSON = 'user:u_synthetic'


def role():
    return dict(copy.deepcopy(SEED['role']), id='role_synthetic')


def mind(status='asleep'):
    return dict(copy.deepcopy(SEED['mind']), id='a_synthetic', role_id='role_synthetic',
                owner=PERSON, visibility='private', swarm_id=None, persona='', spent_usd=0,
                connected=False, status=status)


class FakeAPI:
    def __init__(self, existing_role=True, existing_mind=False):
        self.principal = PERSON
        self.roles = [role()] if existing_role else []
        self.minds = [mind()] if existing_mind else []
        self.calls = []
        self.fail_create = False

    def request(self, method, path, payload=None, **_kwargs):
        self.calls.append((method, path, copy.deepcopy(payload)))
        if (method, path) == ('GET', '/api/roles'): return copy.deepcopy(self.roles)
        if (method, path) == ('POST', '/api/roles'):
            self.roles = [role()]; return role()
        if (method, path) == ('GET', '/api/agents'): return copy.deepcopy(self.minds)
        if (method, path) == ('POST', '/api/agents'):
            self.minds = [mind('created')]
            if self.fail_create: raise OSError('synthetic lost response')
            return dict(self.minds[0], token='synthetic-token-must-not-be-stored')
        if (method, path) == ('POST', '/api/agents/a_synthetic/sleep'):
            self.minds[0]['status'] = 'asleep'; return copy.deepcopy(self.minds[0])
        if (method, path) == ('GET', '/api/agents/a_synthetic'): return copy.deepcopy(self.minds[0])
        raise AssertionError('unexpected synthetic route')


class BootstrapTests(unittest.TestCase):
    def test_exact_public_seed_model_budget_and_policy_are_used(self):
        seed = bootstrap.seed_document(Path(__file__).with_name('studio-maker-template.json'))
        self.assertEqual(seed['mind']['model'], 'openrouter/anthropic/claude-sonnet-5.5')
        self.assertEqual(seed['mind']['budget_usd'], 3.0)
        self.assertEqual(seed['role']['default_model'], 'mock/echo')
        self.assertEqual(seed['role']['default_budget'], 0.0)
        self.assertEqual(seed['role']['rules'], [{'skill': '*', 'mode': 'deny'}])

    def test_modified_seed_cannot_change_model_budget_or_rules(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / 'seed.json'
            for change in ({'budget_usd': 3000.0}, {'model': 'openrouter/unreviewed/model'}):
                seed = copy.deepcopy(SEED); seed['mind'].update(change)
                path.write_text(json.dumps(seed))
                with self.assertRaises(bootstrap.Refused): bootstrap.seed_document(path)

    def test_role_matching_never_treats_false_as_zero_budget_or_drops_deny(self):
        self.assertTrue(bootstrap.role_matches(role(), SEED['role']))
        for changes in ({'default_budget': False}, {'rules': []}, {'rules': [{'skill': '*', 'mode': 'allow'}]}):
            candidate = role(); candidate.update(changes)
            self.assertFalse(bootstrap.role_matches(candidate, SEED['role']))

    def test_fresh_template_uses_only_normal_role_agent_and_sleep_routes(self):
        api = FakeAPI(existing_role=False)
        self.assertEqual(bootstrap.ensure_template(api, SEED, PERSON), ('a_synthetic', 'role_synthetic'))
        posts = [(path, payload) for method, path, payload in api.calls if method == 'POST']
        self.assertEqual([path for path, _ in posts], ['/api/roles', '/api/agents', '/api/agents/a_synthetic/sleep'])
        self.assertEqual(posts[0][1], SEED['role'])
        payload = posts[1][1]
        self.assertEqual(payload['model'], SEED['mind']['model'])
        self.assertEqual(payload['budget_usd'], SEED['mind']['budget_usd'])
        self.assertEqual(payload['options'], {})
        self.assertNotIn('owner', payload); self.assertNotIn('personal_of', payload)
        self.assertEqual(api.minds[0]['status'], 'asleep')
        self.assertEqual(api.minds[0]['spent_usd'], 0)

    def test_exact_existing_template_reuses_id_without_creating_a_duplicate(self):
        api = FakeAPI(existing_mind=True)
        self.assertEqual(bootstrap.ensure_template(api, SEED, PERSON)[0], 'a_synthetic')
        self.assertNotIn(('POST', '/api/agents'), [(m, p) for m, p, _ in api.calls])
        self.assertNotIn(('POST', '/api/roles'), [(m, p) for m, p, _ in api.calls])

    def test_conflicting_role_is_not_rewritten(self):
        api = FakeAPI(); api.roles[0]['prompt'] = 'different existing role'
        with self.assertRaises(bootstrap.Refused): bootstrap.ensure_template(api, SEED, PERSON)
        self.assertFalse(any(method == 'POST' for method, _path, _payload in api.calls))

    def test_foreign_spending_or_awake_named_template_is_not_taken_over(self):
        for changes in ({'owner': 'user:u_other'}, {'spent_usd': 0.01}, {'status': 'awake'}, {'options': {'key': 'not-inherited'}}):
            api = FakeAPI(existing_mind=True); api.minds[0].update(changes)
            with self.assertRaises(bootstrap.Refused): bootstrap.ensure_template(api, SEED, PERSON)
            self.assertFalse(any(method == 'POST' for method, _path, _payload in api.calls))

    def test_lost_create_response_is_not_automatically_retried(self):
        api = FakeAPI(); api.fail_create = True
        with self.assertRaises(OSError): bootstrap.ensure_template(api, SEED, PERSON)
        self.assertEqual(sum((m, p) == ('POST', '/api/agents') for m, p, _ in api.calls), 1)
        # A separate explicit invocation reconciles the persisted exact stopped template.
        api.fail_create = False
        bootstrap.ensure_template(api, SEED, PERSON)
        self.assertEqual(sum((m, p) == ('POST', '/api/agents') for m, p, _ in api.calls), 1)

    def test_descriptor_update_is_atomic_and_refuses_a_changed_subject(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / 'runtime.json'
            path.write_text(json.dumps({'studio_maker_template': None, 'other': 'kept'})); path.chmod(0o600)
            raw, identity = bootstrap.read_owned(path, private=True)
            bootstrap.descriptor_write(path, raw, identity, 'a_synthetic')
            self.assertEqual(json.loads(path.read_text()), {'studio_maker_template': 'a_synthetic', 'other': 'kept'})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(bootstrap.Refused): bootstrap.descriptor_write(path, raw, identity, 'a_other')
            self.assertEqual(json.loads(path.read_text())['studio_maker_template'], 'a_synthetic')

    def test_plain_operator_and_setup_bearers_cannot_gain_named_owner_authority(self):
        for change in ({'local_operator': True}, {'kind': 'sso-bootstrap'}, {'role': 'member'}, {'principal': 'user:u_other'}):
            api = bootstrap.OwnerAPI(None, {}, None, 1, 1)
            me = {'principal': PERSON, 'kind': 'sso', 'role': 'admin', 'person_kind': 'person', 'local_operator': False}
            me.update(change)
            def response(_method, path, _payload=None, **_kwargs):
                return {'token': 't' * 43} if path.endswith('/exchange') else me
            api.request = response
            with self.assertRaises(bootstrap.Refused): api.login('c' * 43, PERSON)
            self.assertIsNone(api.principal)

    def test_logout_attempt_clears_memory_even_when_retirement_fails(self):
        api = bootstrap.OwnerAPI(None, {}, None, 1, 1); api.token = 't' * 43
        def failed(*_args, **kwargs):
            self.assertTrue(kwargs['cleanup']); raise bootstrap.Refused()
        api.request = failed
        with patch.object(bootstrap, 'STOP', True), self.assertRaises(bootstrap.Refused): api.logout()
        self.assertIsNone(api.token)

    def test_http_owner_mismatch_sends_no_code_or_bearer(self):
        class Transport:
            def __init__(self): self.sent = []
            def settimeout(self, _value): pass
            def connect(self, address): self.address = address
            def getpeername(self): return ('127.0.0.1', 8700)
            def getsockname(self): return ('127.0.0.1', 40000)
            def sendall(self, raw): self.sent.append(raw)
            def close(self): pass
        transport = Transport(); control = SimpleNamespace(supervisor_pid=lambda _home: 123, exe_matches=lambda _c, _h: True)
        api = bootstrap.OwnerAPI(control, {'python': '/synthetic/python', 'port': 8700}, Path('/synthetic/home'), 123, bootstrap.time.monotonic() + 30,
                                 {'pid': 123, 'listener_inode': '4242'})
        with patch.object(bootstrap.socket, 'socket', return_value=transport), \
                patch.object(bootstrap.Path, 'resolve', return_value=Path('/synthetic/python')), \
                patch.object(bootstrap, 'socket_inode', side_effect=bootstrap.Refused()), self.assertRaises(bootstrap.Refused):
            api.request('POST', '/api/auth/local/exchange', {'code': 'c' * 43})
        self.assertEqual(transport.sent, [])

    def test_app_review_uses_exact_pins_without_activations_or_person_consent(self):
        calls = []
        api = SimpleNamespace(principal=PERSON)
        digest = 'sha256:' + 'a' * 64
        def respond(method, path, payload=None):
            calls.append((method, path, payload))
            program = path.split('/')[3]
            if not path.endswith('/install'):
                return {'id': program, 'digest': digest, 'error': None, 'ui': True}
            return {'program': program, 'placement': 'person', 'installed': True, 'release_digest': digest,
                    'review': {'release_digest': digest, 'revoked': False, 'by': PERSON}}
        api.request = respond
        bootstrap.inspect_apps(api, {'app_pins': {program: {'digest': digest} for program in bootstrap.APPS}})
        posts = [(path, payload) for method, path, payload in calls if method == 'POST']
        self.assertEqual(len(posts), 2)
        self.assertTrue(all(path.endswith('/install') and payload == {'release_digest': digest, 'placement': 'person', 'use_in': []} for path, payload in posts))
        self.assertFalse(any('consent' in path or 'activations' in path or 'grants' in path for _method, path, _payload in calls))



    def test_first_hello_waits_for_the_freshly_started_service(self):
        # Type=simple start: data/run may not exist yet, so the first hello must be the bounded retry.
        source = Path(bootstrap.__file__).read_text()
        body = source[source.index("def bootstrap("):source.index("def failure_message(")]
        first = body.index('"hello"') if '"hello"' in body else len(body)
        self.assertLess(body.index("control.wait_for_hello(config, home)"), first)
        self.assertLess(body.index("control.wait_for_hello(config, home)"), body.index('"signin"'))

    def test_failure_message_is_plain_and_does_not_promise_data_safety(self):
        message = bootstrap.failure_message()
        self.assertEqual(message, "The last setup step didn't finish. The details are in ~/.local/share/omegahive/logs")
        self.assertNotIn('Your data is safe', message)
        self.assertNotIn('session', message)
        self.assertNotIn('sign-in secret', message)

if __name__ == '__main__':
    unittest.main()
