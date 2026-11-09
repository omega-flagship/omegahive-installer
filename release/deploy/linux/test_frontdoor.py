"""Self-contained L0 unit-test Source. NOT_RUN by Source author; no Hive imports.

Future admitted execution uses only stdlib and owned synthetic fixtures. These
are boundary unit tests, not Linux service/browser/First Light qualification.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location('l0_' + name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


control = load('control')
serve = load('serve')


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        # The service's executable is checked by exe_matches (its own tests are below).
        patcher = mock.patch.object(control, 'exe_matches', return_value=True)
        patcher.start(); self.addCleanup(patcher.stop)
        listener = mock.patch.object(control, 'listener_matches', return_value=True)
        listener.start(); self.addCleanup(listener.stop)

    def test_duplicate_and_nonfinite_json_are_refused(self):
        for module in (control, serve):
            for raw in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}'):
                with self.subTest(module=module.__name__, raw=raw):
                    with self.assertRaises(module.Refused):
                        module.strict_json(raw)

    def test_noncanonical_or_relative_paths_are_refused(self):
        for module in (control, serve):
            for value in ('relative', '/x/../y', '/x//y', '/x\nsecret', '/x\0y'):
                with self.subTest(module=module.__name__, value=value):
                    with self.assertRaises(module.Refused):
                        module.plain_path(value)

    def test_venv_link_outside_selected_bundle_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'bundle'
            root.mkdir()
            outside = Path(temp) / 'outside-python'
            outside.write_text('synthetic')
            outside.chmod(0o700)
            link = root / 'python'
            link.symlink_to(outside)
            for module in (control, serve):
                with mock.patch.object(module, 'ancestry'):
                    with self.assertRaises(module.Refused):
                        module.executable(str(link), root, allow_link=True)

    def test_status_does_not_print_control_secret_or_raw_preflight(self):
        cfg = {'port': 8700, 'browser_port': 8701, 'source_revision': 'a' * 40, 'libpython_dir': None}
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700,
                 'instance': 'b' * 32, 'preflight': {'private': 'DO_NOT_PRINT'}}
        out = io.StringIO()
        with mock.patch.object(control.sys, 'argv', ['control.py', '--runtime', '/synthetic', 'status', '--json']), \
             mock.patch.object(control.sys, 'platform', 'linux'), \
             mock.patch.object(control.os, 'getuid', return_value=1000), \
             mock.patch.object(control.os, 'geteuid', return_value=1000), \
             mock.patch.object(control, 'runtime', return_value=(cfg, Path('/home/test'), 'pin')), \
             mock.patch.dict(control.os.environ, {}, clear=True), \
             mock.patch.object(control, 'request', return_value=(hello, 4000)), \
             contextlib.redirect_stdout(out):
            self.assertEqual(control.main(), 0)
        self.assertNotIn('DO_NOT_PRINT', out.getvalue())
        self.assertNotIn('instance', out.getvalue())
        self.assertEqual(json.loads(out.getvalue())['pid'], 4000)

    def test_wrong_signin_url_never_reaches_browser(self):
        cfg = {'port': 8700, 'browser_port': 8701, 'libpython_dir': None}
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700, 'instance': 'b' * 32}
        reply = {'ok': True, 'code': 'c' * 43, 'expires_in': 60,
                 'url': 'https://outside.invalid/local-signin#' + 'c' * 43}
        with mock.patch.object(control.sys, 'argv', ['control.py', '--runtime', '/synthetic', 'open']), \
             mock.patch.object(control.sys, 'platform', 'linux'), \
             mock.patch.object(control.os, 'getuid', return_value=1000), \
             mock.patch.object(control.os, 'geteuid', return_value=1000), \
             mock.patch.dict(control.os.environ, {'DISPLAY': ':0'}, clear=True), \
             mock.patch.object(control, 'runtime', return_value=(cfg, Path('/home/test'), 'pin')), \
             mock.patch.object(control, 'request', side_effect=[(hello, 4000), (reply, 4000)]), \
             mock.patch.object(control, 'desktop_environment', return_value={}), \
             mock.patch.object(control, 'root_program'), \
             mock.patch.object(control.subprocess, 'run') as opener:
            with self.assertRaises(control.Refused):
                control.main()
            opener.assert_not_called()

    def test_serve_drops_ambient_secrets_and_only_sets_reviewed_template(self):
        cfg = {'python': '/selected/venv/bin/python', 'swipl_bin': '/selected/swipl/bin/swipl',
               'port': 8700, 'browser_port': 8701, 'sandbox_python': '/selected/runtime/python',
               'data_dir': '/private/data', 'release_root': '/selected/app',
               'petta_path': '/selected/petta', 'plugin_dirs': ['/selected/plugins'],
               'app_pins': {}, 'libpython_dir': '/selected/lib', 'studio_maker_template': None,
               'default_model': 'openrouter/example/real-model', 'embedding_model': 'mock/hash',
               'ssh_target': None}
        for template in (None, 'a_1234abcd'):
            cfg['studio_maker_template'] = template
            with self.subTest(template=template), \
                 mock.patch.object(serve.sys, 'argv', ['serve.py', '--runtime', '/synthetic']), \
                 mock.patch.object(serve.sys, 'platform', 'linux'), \
                 mock.patch.object(serve.os, 'getuid', return_value=1000), \
                 mock.patch.object(serve.os, 'geteuid', return_value=1000), \
                 mock.patch.dict(serve.os.environ, {'HIVE_SANDBOX_PYTHON': cfg['sandbox_python'],
                     'OPENAI_API_KEY': 'FAKE_SENTINEL', 'HIVE_GOOGLE_CLIENT_ID': 'FAKE_SENTINEL',
                     'LD_LIBRARY_PATH': cfg['libpython_dir']}, clear=True), \
                 mock.patch.object(serve, 'runtime', return_value=(cfg, Path('/home/test'), 'pin')), \
                 mock.patch.object(serve.os, 'umask'), \
                 mock.patch.object(serve.os, 'chdir'), \
                 mock.patch.object(serve.os, 'execve') as execute:
                serve.main()
                path, argv, env = execute.call_args.args
                self.assertEqual(argv, [path, '-B', '-m', 'hive'])
                for key in ('OPENAI_API_KEY', 'HIVE_GOOGLE_CLIENT_ID', 'PYTHONPATH', 'PYTHONHOME'):
                    self.assertNotIn(key, env)
                self.assertEqual(env['LD_LIBRARY_PATH'], '/selected/lib')
                self.assertEqual(env['HIVE_HOST'], '127.0.0.1')
                self.assertEqual(env['HIVE_PORT'], '8700')
                self.assertEqual(env['HIVE_LOCAL_BROWSER_PORT'], '8701')
                self.assertEqual(env['HIVE_MIND_SANDBOX'], '1')
                self.assertEqual(env['HIVE_DEFAULT_MODEL'], cfg['default_model'])
                self.assertEqual(env['HIVE_ASK_CONDUCTOR_MODEL'], cfg['default_model'])
                self.assertNotEqual(env['HIVE_DEFAULT_MODEL'], 'mock/echo')
                self.assertEqual(env['HIVE_APP_PINS_REQUIRED'], '1')
                if template is None:
                    self.assertNotIn('HIVE_STUDIO_MAKER_TEMPLATE', env)
                else:
                    self.assertEqual(env['HIVE_STUDIO_MAKER_TEMPLATE'], template)

    def test_nonhome_data_path_refuses_before_directory_access(self):
        for module in (control, serve):
            with mock.patch.object(module, 'directory') as read_directory:
                with self.assertRaises(module.Refused):
                    module.selected_data_dir('/outside/owned-data', Path('/home/test'))
                read_directory.assert_not_called()

    def test_mock_default_and_unsafe_ssh_target_refuse(self):
        for module in (control, serve):
            for model, target in [('mock/echo', None), ('openrouter/example/model', '-oProxyCommand=bad')]:
                with self.subTest(module=module.__name__, model=model, target=target):
                    with self.assertRaises(module.Refused):
                        module.runtime_choices({'default_model': model, 'embedding_model': 'mock/hash', 'ssh_target': target})

    def test_headless_guidance_issues_no_signin_code_or_browser(self):
        cfg = {'port': 8700, 'browser_port': 8701, 'ssh_target': 'test@linux.example', 'libpython_dir': None}
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700, 'instance': 'b' * 32}
        out = io.StringIO()
        with mock.patch.object(control.sys, 'argv', ['control.py', '--runtime', '/synthetic', 'open', '--defer-headless-signin']), \
             mock.patch.object(control.sys, 'platform', 'linux'), \
             mock.patch.object(control.os, 'getuid', return_value=1000), \
             mock.patch.object(control.os, 'geteuid', return_value=1000), \
             mock.patch.dict(control.os.environ, {}, clear=True), \
             mock.patch.object(control, 'runtime', return_value=(cfg, Path('/home/test'), 'pin')), \
             mock.patch.object(control, 'request', return_value=(hello, 4000)) as request, \
             mock.patch.object(control, 'desktop_environment', return_value={}), \
             mock.patch.object(control.subprocess, 'run') as opener, \
             contextlib.redirect_stdout(out):
            self.assertEqual(control.main(), 0)
            request.assert_called_once_with(cfg, Path('/home/test'), 'hello')
            opener.assert_not_called()
        self.assertIn('ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8701:127.0.0.1:8700 test@linux.example', out.getvalue())
        self.assertNotIn('/local-signin#', out.getvalue())

    def test_loader_agreement_rejects_append_preload_and_python_path(self):
        config = {'libpython_dir': '/selected/runtime/python/lib'}
        for module in (control, serve):
            self.assertEqual(module.loader_agreement(config, {'LD_LIBRARY_PATH': config['libpython_dir']}), config['libpython_dir'])
            for env in ({'LD_LIBRARY_PATH': config['libpython_dir'] + ':/outside'},
                        {'LD_LIBRARY_PATH': config['libpython_dir'], 'LD_PRELOAD': '/outside/sentinel.so'},
                        {'LD_LIBRARY_PATH': config['libpython_dir'], 'LD_AUDIT': '/outside/sentinel.so'},
                        {'LD_LIBRARY_PATH': config['libpython_dir'], 'PYTHONPATH': '/outside'},
                        {'LD_LIBRARY_PATH': config['libpython_dir'], 'PYTHONHOME': '/outside'}):
                with self.subTest(module=module.__name__, env=env):
                    with self.assertRaises(module.Refused):
                        module.loader_agreement(config, env)

    def test_null_loader_requires_absent_or_empty_path(self):
        for module in (control, serve):
            self.assertEqual(module.loader_agreement({'libpython_dir': None}, {}), '')
            self.assertEqual(module.loader_agreement({'libpython_dir': None}, {'LD_LIBRARY_PATH': ''}), '')
            with self.assertRaises(module.Refused):
                module.loader_agreement({'libpython_dir': None}, {'LD_LIBRARY_PATH': '/outside'})

    def test_unit_retains_user_service_cleanup_and_no_root_account(self):
        unit = (HERE / 'omegahive.service.in').read_text()
        self.assertIn('KillMode=control-group', unit)
        self.assertIn('UMask=0077', unit)
        self.assertIn('Environment=@SANDBOX_ENV@', unit)
        self.assertIn('Environment=@LIBPYTHON_ENV@', unit)
        self.assertIn('UnsetEnvironment=LD_PRELOAD LD_AUDIT PYTHONPATH PYTHONHOME', unit)
        self.assertNotIn('\nUser=', unit)
        self.assertNotIn('\nGroup=', unit)
        self.assertNotIn('sudo', unit)


    @contextlib.contextmanager
    def control_context(self, operation, request, extra=None, display=None):
        cfg = {'port': 8700, 'browser_port': 8701, 'source_revision': 'a' * 40, 'libpython_dir': None,
               'ssh_target': 'test@linux.example'}
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(control.sys, 'argv',
                ['control.py', '--runtime', '/synthetic', operation] + (extra or [])))
            stack.enter_context(mock.patch.object(control.sys, 'platform', 'linux'))
            stack.enter_context(mock.patch.object(control.os, 'getuid', return_value=1000))
            stack.enter_context(mock.patch.object(control.os, 'geteuid', return_value=1000))
            runtime = stack.enter_context(mock.patch.object(control, 'runtime',
                return_value=(cfg, Path('/home/test'), 'pin')))
            stack.enter_context(mock.patch.dict(control.os.environ, display or {}, clear=True))
            calls = stack.enter_context(mock.patch.object(control, 'request', side_effect=request))
            stack.enter_context(mock.patch.object(control, 'supervisor_pid', return_value=4000))
            stack.enter_context(mock.patch.object(control, 'desktop_environment', return_value={}))
            stack.enter_context(mock.patch.object(control, 'root_program'))
            opener = stack.enter_context(mock.patch.object(control.subprocess, 'run',
                return_value=mock.Mock(returncode=0)))
            out = io.StringIO()
            stack.enter_context(contextlib.redirect_stdout(out))
            yield cfg, runtime, calls, opener, out

    def test_default_status_is_plain_and_redacts_every_extra_hello_field(self):
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700,
                 'instance': 'b' * 32, 'preflight': {'private': 'DO_NOT_PRINT'},
                 'code': 'DO_NOT_PRINT', 'url': '/local-signin#DO_NOT_PRINT'}
        with self.control_context('status', lambda *args: (hello, 4000)) as (_, _, calls, opener, out):
            self.assertEqual(control.main(), 0)
            self.assertEqual(out.getvalue(), 'OmegaHive is running.\n')
            self.assertNotIn('DO_NOT_PRINT', out.getvalue())
            self.assertNotIn('instance', out.getvalue())
            self.assertNotIn('/local-signin#', out.getvalue())
            self.assertEqual(calls.call_count, 1)
            opener.assert_not_called()

    def test_json_flag_refuses_open_before_runtime_or_control_access(self):
        with self.control_context('open', lambda *args: self.fail('unexpected request'), ['--json']) as (_, runtime, calls, opener, _):
            with self.assertRaises(control.Refused):
                control.main()
            runtime.assert_not_called()
            calls.assert_not_called()
            opener.assert_not_called()

    def test_open_waits_for_hello_then_issues_exactly_one_signin(self):
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700,
                 'instance': 'b' * 32}
        seen = []
        def request(cfg, home, operation, *expected):
            seen.append(operation)
            if operation == 'hello':
                if len(seen) == 1:
                    raise FileNotFoundError('synthetic service still starting')
                return hello, 4000
            self.assertEqual(seen, ['hello', 'hello', 'signin'])
            self.assertIsNone(control._HELLO_DEADLINE.get())
            self.assertEqual(expected, (4000,))
            return {'ok': True, 'code': 'c' * 43, 'expires_in': 60,
                    'url': 'http://127.0.0.1:8700/local-signin#' + 'c' * 43}, 4000
        with self.control_context('open', request, display={'DISPLAY': ':0'}) as (cfg, _, calls, opener, out), \
             mock.patch.object(control.time, 'sleep'):
            self.assertEqual(control.main(), 0)
            self.assertEqual(calls.call_args_list, [mock.call(cfg, Path('/home/test'), 'hello'),
                mock.call(cfg, Path('/home/test'), 'hello'), mock.call(cfg, Path('/home/test'), 'signin', 4000)])
            self.assertEqual(opener.call_count, 1)
            self.assertEqual(out.getvalue(), 'Your hive is open in your browser.\n')
            self.assertNotIn('c' * 43, out.getvalue())
        self.assertIsNone(control._HELLO_DEADLINE.get())

    def test_readiness_timeout_never_issues_signin_and_restores_deadline(self):
        def unavailable(*args):
            raise FileNotFoundError('synthetic absent socket')
        with self.control_context('open', unavailable, display={'DISPLAY': ':0'}) as (cfg, _, calls, opener, _), \
             mock.patch.object(control.time, 'monotonic', side_effect=[0.0, control.HELLO_READY_SECONDS + 1.0]):
            with self.assertRaisesRegex(control.Refused, '^control_reply_timeout$'):
                control.main()
            calls.assert_called_once_with(cfg, Path('/home/test'), 'hello')
            opener.assert_not_called()
        self.assertIsNone(control._HELLO_DEADLINE.get())

    def test_foreign_hello_is_not_retried_and_cannot_issue_signin(self):
        hello = {'ok': True, 'local_owner': False, 'pid': 4000, 'port': 8700,
                 'instance': 'b' * 32}
        with self.control_context('open', lambda *args: (hello, 4000), display={'DISPLAY': ':0'}) as (cfg, _, calls, opener, _):
            with self.assertRaisesRegex(control.Refused, '^local_owner_hello_mismatch$'):
                control.main()
            calls.assert_called_once_with(cfg, Path('/home/test'), 'hello')
            opener.assert_not_called()
        self.assertIsNone(control._HELLO_DEADLINE.get())

    def test_unattested_listener_refuses_before_any_signin_request(self):
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700, 'instance': 'b' * 32}
        for display in ({'DISPLAY': ':0'}, {}):
            with self.subTest(display=display), mock.patch.object(control, 'listener_matches', return_value=False), \
                 self.control_context('open', lambda *args: (hello, 4000), display=display) as (cfg, _, calls, opener, _):
                with self.assertRaisesRegex(control.Refused, '^service_listener_mismatch$'):
                    control.main()
                self.assertEqual([c.args[2] for c in calls.call_args_list], ['hello'])   # never 'signin'
                opener.assert_not_called()

    def test_expired_hello_budget_refuses_before_supervisor_spawn(self):
        token = control._HELLO_DEADLINE.set(10.0)
        try:
            with mock.patch.object(control.time, 'monotonic', return_value=11.0), \
                 mock.patch.object(control, 'root_program'), \
                 mock.patch.object(control.subprocess, 'Popen') as spawn:
                with self.assertRaisesRegex(control.Refused, '^control_reply_timeout$'):
                    control.supervisor_pid(Path('/home/test'))
                spawn.assert_not_called()
        finally:
            control._HELLO_DEADLINE.reset(token)

    def test_friendly_cli_messages_never_expose_raw_reasons(self):
        expected = {
            'browser_handoff_failed_open_again': "Your browser didn't open in time. Run omegahive open again.",
            'control_reply_timeout': "Hive has not become ready within three minutes. Check omegahive status and journalctl --user -u omegahive.service; keep your data.",
            'remote_display_refused': "This window forwards a screen (ssh -X or -Y), which OmegaHive doesn't use. Sign in with plain ssh (without -X or -Y), then run omegahive open again.",
        }
        for reason, sentence in expected.items():
            with self.subTest(reason=reason):
                self.assertEqual(control.refusal_message(reason), sentence)
        out = io.StringIO()
        with mock.patch.object(control, 'main', side_effect=control.Refused('PRIVATE_RAW_SENTINEL')), \
             contextlib.redirect_stderr(out):
            self.assertEqual(control.run_cli(), 78)
        self.assertEqual(out.getvalue(), "OmegaHive couldn't open. Details are in ~/.local/share/omegahive/logs\n")
        self.assertNotIn('PRIVATE_RAW_SENTINEL', out.getvalue())
        out = io.StringIO()
        with mock.patch.object(control, 'main', side_effect=RuntimeError('PRIVATE_RAW_SENTINEL')), \
             contextlib.redirect_stderr(out):
            self.assertEqual(control.run_cli(), 78)
        self.assertEqual(out.getvalue(), "OmegaHive isn't running.\n")

    def test_headless_copy_is_explicitly_later_without_fake_credentials(self):
        # Guidance alone does not mint; explicit open does so after the shared checks.
        for target in (None, 'test@linux.example'):
            with self.subTest(target=target):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(control.headless_guidance({'ssh_target': target, 'port': 8700, 'browser_port': 8701}), 0)
                self.assertIn('ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8701:127.0.0.1:8700 ', out.getvalue())
                self.assertIn(target or '<you>@<this-server>', out.getvalue())
                self.assertNotIn('/local-signin#', out.getvalue())
                self.assertNotIn("isn't ready yet", out.getvalue())


    def test_explicit_headless_non_tty_open_prints_one_valid_link_and_clears_response(self):
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700, 'instance': 'b' * 32}
        code = 'c' * 43
        reply = {'ok': True, 'code': code, 'expires_in': 60,
                 'url': 'http://127.0.0.1:8700/local-signin#' + code}
        def request(cfg, home, operation, *expected):
            if operation == 'hello':
                return hello, 4000
            self.assertEqual(operation, 'signin')
            self.assertEqual(expected, (4000,))
            return reply, 4000
        with self.control_context('open', request) as (cfg, runtime, calls, opener, out), \
                mock.patch.object(control.os, 'isatty', side_effect=AssertionError('direct open must not require a TTY')):
            self.assertFalse(out.isatty())
            self.assertEqual(control.main(), 0)
            self.assertEqual([c.args[2] for c in calls.call_args_list], ['hello', 'signin'])
            self.assertEqual(runtime.call_count, 2)
            self.assertIn('127.0.0.1:8701:127.0.0.1:8700 test@linux.example', out.getvalue())
            self.assertIn('Open this link on your own computer, within a minute: http://127.0.0.1:8701/local-signin#' + code, out.getvalue())
            opener.assert_not_called()
        self.assertEqual(reply, {})

    def test_explicit_headless_open_without_ssh_target_uses_placeholders_and_still_mints(self):
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700, 'instance': 'b' * 32}
        code = 'd' * 43
        reply = {'ok': True, 'code': code, 'expires_in': 60,
                 'url': 'http://127.0.0.1:8700/local-signin#' + code}
        with self.control_context('open', lambda cfg, home, op, *args: (hello if op == 'hello' else reply, 4000)) as (cfg, _, calls, opener, out):
            cfg['ssh_target'] = None
            self.assertEqual(control.main(), 0)
            self.assertIn('<you>@<this-server>', out.getvalue())
            self.assertIn('/local-signin#' + code, out.getvalue())
            self.assertEqual(calls.call_count, 2)
            opener.assert_not_called()
        self.assertEqual(reply, {})

    def test_captured_headless_deferral_has_no_signin_request_or_secret_output(self):
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700, 'instance': 'b' * 32,
                 'code': 'SECRET_HELLO_EXTRA', 'url': '/local-signin#SECRET_HELLO_EXTRA'}
        def request(cfg, home, operation, *args):
            self.assertEqual(operation, 'hello', 'captured automatic handoff must never mint')
            return hello, 4000
        with self.control_context('open', request, ['--defer-headless-signin']) as (_, runtime, calls, opener, out):
            self.assertEqual(control.main(), 0)
            self.assertEqual(runtime.call_count, 1)
            self.assertEqual(calls.call_count, 1)
            self.assertIn('~/.local/bin/omegahive open', out.getvalue())
            self.assertIn('No link was issued', out.getvalue())
            self.assertNotIn('/local-signin#', out.getvalue())
            self.assertNotIn('SECRET_HELLO_EXTRA', out.getvalue())
            opener.assert_not_called()

    def test_deferred_headless_option_is_invalid_for_status_before_any_access(self):
        with self.control_context('status', lambda *args: self.fail('unexpected request'), ['--defer-headless-signin']) as (_, runtime, calls, opener, _):
            with self.assertRaisesRegex(control.Refused, '^defer_requires_open$'):
                control.main()
            runtime.assert_not_called()
            calls.assert_not_called()
            opener.assert_not_called()

    def test_headless_bad_signin_reply_never_prints_link_and_clears_reply(self):
        changes = [ {'expires_in': 59}, {'expires_in': True}, {'code': 'c' * 42},
            {'code': 'c' * 42 + '!'}, {'ok': 1}, {'extra': 'SECRET_EXTRA'},
            {'url': 'http://localhost:8700/local-signin#' + 'c' * 43},
            {'url': 'http://127.0.0.1:8701/local-signin#' + 'c' * 43},
            {'url': 'https://127.0.0.1:8700/local-signin#' + 'c' * 43} ]
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700, 'instance': 'b' * 32}
        for change in changes:
            with self.subTest(change=change):
                reply = {'ok': True, 'code': 'c' * 43, 'expires_in': 60,
                         'url': 'http://127.0.0.1:8700/local-signin#' + 'c' * 43}
                reply.update(change)
                with self.control_context('open', lambda cfg, home, op, *args: (hello if op == 'hello' else reply, 4000)) as (_, _, calls, opener, out):
                    with self.assertRaises(control.Refused):
                        control.main()
                    self.assertEqual(calls.call_count, 2)
                    self.assertNotIn('/local-signin#', out.getvalue())
                    self.assertNotIn('c' * 43, out.getvalue())
                    self.assertNotIn('SECRET_EXTRA', out.getvalue())
                    opener.assert_not_called()
                self.assertEqual(reply, {})

    def test_headless_descriptor_change_prevents_minting(self):
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700, 'instance': 'b' * 32}
        with self.control_context('open', lambda *args: (hello, 4000)) as (cfg, runtime, calls, opener, out):
            runtime.side_effect = [(cfg, Path('/home/test'), 'pin'), (cfg, Path('/home/test'), 'changed')]
            with self.assertRaisesRegex(control.Refused, '^descriptor_changed_before_signin$'):
                control.main()
            self.assertEqual(calls.call_count, 1)
            self.assertNotIn('/local-signin#', out.getvalue())
            opener.assert_not_called()

    def test_headless_print_failure_clears_reply_without_diagnostic_secret(self):
        class FailedTerminal(io.StringIO):
            def write(self, value):
                if '/local-signin#' in value:
                    raise OSError('synthetic terminal failure')
                return super().write(value)
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700, 'instance': 'b' * 32}
        code = 'e' * 43
        reply = {'ok': True, 'code': code, 'expires_in': 60,
                 'url': 'http://127.0.0.1:8700/local-signin#' + code}
        terminal = FailedTerminal(); err = io.StringIO()
        with self.control_context('open', lambda cfg, home, op, *args: (hello if op == 'hello' else reply, 4000)) as (_, _, calls, opener, _), \
                contextlib.redirect_stdout(terminal), contextlib.redirect_stderr(err):
            self.assertEqual(control.run_cli(), 78)
            self.assertEqual(calls.call_count, 2)
            opener.assert_not_called()
        self.assertEqual(reply, {})
        self.assertNotIn(code, terminal.getvalue() + err.getvalue())
        self.assertNotIn('/local-signin#', err.getvalue())
        self.assertEqual(err.getvalue(), "Your sign-in link couldn't be shown. Run omegahive open again.\n")


    def test_deferred_headless_flag_is_accepted_before_or_after_operation(self):
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700, 'instance': 'b' * 32}
        for tail in (['--defer-headless-signin', 'open'], ['open', '--defer-headless-signin']):
            with self.subTest(tail=tail), self.control_context('open', lambda *args: (hello, 4000)) as (_, _, calls, opener, out):
                with mock.patch.object(control.sys, 'argv', ['control.py', '--runtime', '/synthetic'] + tail):
                    self.assertEqual(control.main(), 0)
                self.assertEqual(calls.call_count, 1)
                self.assertIn('127.0.0.1:8701:127.0.0.1:8700', out.getvalue())
                self.assertNotIn('/local-signin#', out.getvalue())
                opener.assert_not_called()

    def test_headless_rewrites_only_the_port_after_validating_original_service_url(self):
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700, 'instance': 'b' * 32}
        code = 'f' * 43
        original = 'http://127.0.0.1:8700/local-signin#' + code
        reply = {'ok': True, 'code': code, 'url': original, 'expires_in': 60}
        with self.control_context('open', lambda cfg, home, op, *args: (hello if op == 'hello' else reply, 4000)) as (_, _, calls, opener, out):
            self.assertEqual(control.main(), 0)
            links = [line.split(': ', 1)[1] for line in out.getvalue().splitlines() if line.startswith('Open this link on your own computer, within a minute: ')]
            self.assertEqual(links, [original.replace(':8700/', ':8701/', 1)])
            self.assertEqual(links[0].split('#', 1)[1], code)
            self.assertEqual(calls.call_count, 2)
            opener.assert_not_called()
        self.assertEqual(reply, {})

    def test_headless_does_not_accept_a_pre_rewritten_8701_server_reply(self):
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700, 'instance': 'b' * 32}
        code = 'g' * 43
        reply = {'ok': True, 'code': code, 'url': 'http://127.0.0.1:8701/local-signin#' + code, 'expires_in': 60}
        with self.control_context('open', lambda cfg, home, op, *args: (hello if op == 'hello' else reply, 4000)) as (_, _, _, opener, out):
            with self.assertRaisesRegex(control.Refused, '^signin_url_refused$'):
                control.main()
            self.assertNotIn(code, out.getvalue())
            opener.assert_not_called()
        self.assertEqual(reply, {})

    def test_desktop_keeps_the_original_8700_url(self):
        hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700, 'instance': 'b' * 32}
        code = 'h' * 43; original = 'http://127.0.0.1:8700/local-signin#' + code
        reply = {'ok': True, 'code': code, 'url': original, 'expires_in': 60}
        with self.control_context('open', lambda cfg, home, op, *args: (hello if op == 'hello' else reply, 4000), display={'DISPLAY': ':0'}) as (_, _, _, opener, out):
            self.assertEqual(control.main(), 0)
            self.assertEqual(opener.call_args.args[0], [control.OPENER, original])
            self.assertNotIn(':8701', out.getvalue())
            self.assertNotIn(code, out.getvalue())
        self.assertEqual(reply, {})


class FixedBrowserRuntimeTests(unittest.TestCase):
    def fixture(self, home):
        root = home / '.local/share/omegahive/releases/test'
        app = root / 'app'; petta = root / 'PeTTa'; data = home / '.local/share/omegahive/data'
        for folder in (root, app, petta, data):
            folder.mkdir(parents=True, exist_ok=True); folder.chmod(0o700)
        data.parent.chmod(0o700)
        python = root / 'venv/bin/python'; swipl = root / 'runtime/swipl/lib/swipl/bin/aarch64-linux/swipl'
        for executable in (python, swipl):
            executable.parent.mkdir(parents=True, exist_ok=True)
            executable.write_bytes(b'synthetic regular executable, never run'); executable.chmod(0o700)
        cfg = {'schema': 'studio-linux-user-runtime/2', 'runtime_root': str(root), 'release_root': str(app),
            'python': str(python), 'sandbox_python': str(python), 'petta_path': str(petta), 'data_dir': str(data),
            'port': 8700, 'browser_port': 8701, 'source_revision': 'a' * 40, 'plugin_dirs': [], 'app_pins': {},
            'swipl_bin': str(swipl), 'libpython_dir': None, 'studio_maker_template': None,
            'default_model': 'openrouter/example/real', 'embedding_model': 'mock/hash', 'ssh_target': None}
        path = data.parent / 'runtime.json'
        return cfg, path

    def test_both_runtime_readers_accept_the_same_closed_eighteen_key_schema(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name).resolve(); cfg, path = self.fixture(home)
            path.write_text(json.dumps(cfg)); path.chmod(0o600)
            for module in (control, serve):
                with self.subTest(module=module.__name__), mock.patch.object(module, 'ancestry'), \
                        mock.patch.object(module.pwd, 'getpwuid', return_value=mock.Mock(pw_dir=str(home))), \
                        mock.patch.object(module.sys, 'executable', cfg['python']):
                    actual, selected_home, _ = module.runtime(str(path))
                self.assertEqual(actual, cfg)
                self.assertEqual(len(actual), 18)
                self.assertEqual(selected_home, home)

    def test_both_runtime_readers_refuse_missing_legacy_extra_or_nonfixed_ports(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name).resolve(); cfg, path = self.fixture(home)
            faults = [('browser_port', 8702), ('browser_port', 8700), ('browser_port', True),
                      ('port', 8701), ('port', 8702), ('port', True), ('schema', 'studio-linux-user-runtime/1'),
                      ('missing_browser_port', None), ('unexpected', 1)]
            for key, value in faults:
                bad = dict(cfg)
                if key == 'missing_browser_port': bad.pop('browser_port')
                else: bad[key] = value
                path.write_text(json.dumps(bad)); path.chmod(0o600)
                for module in (control, serve):
                    with self.subTest(key=key, value=value, module=module.__name__), mock.patch.object(module, 'ancestry'), \
                            mock.patch.object(module.pwd, 'getpwuid', return_value=mock.Mock(pw_dir=str(home))), \
                            mock.patch.object(module.sys, 'executable', cfg['python']):
                        with self.assertRaises(module.Refused): module.runtime(str(path))


class TemplateIdMatchesHiveTests(unittest.TestCase):
    """The Studio maker template id check in serve.py and control.py accepts exactly the hive's agent ids."""

    def test_launchers_accept_what_the_hive_mints(self):
        import re
        hive = (HERE.parent.parent / 'hive' / 'core' / 'studio_sessions.py').read_text(encoding='utf-8')
        agent_id = re.compile(re.search(r'AGENT_ID = re\.compile\(r"([^"]+)"\)', hive).group(1))
        samples = ['a_1234abcd', 'a_' + '0123456789abcdef' * 2, 'a_1234abc', 'a_' + 'f' * 31,
                   'a_' + 'f' * 33, 'a_1234ABCD', 'b_1234abcd', 'a_synthetic']
        for name in ('serve.py', 'control.py'):
            source = (HERE / name).read_text(encoding='utf-8')
            pattern = re.search(r"re\.fullmatch\('(a_[^']+)', template\)", source).group(1)
            for sample in samples:
                with self.subTest(file=name, sample=sample):
                    self.assertEqual(bool(re.fullmatch(pattern, sample)), bool(agent_id.fullmatch(sample)))


if __name__ == '__main__':
    unittest.main()


class ServiceExecutableTests(unittest.TestCase):
    HOME = Path('/synthetic/home')

    def show(self, python, serve, *, main='4000', exec_main='4000', started='4000', path=None, argv=None, extra=''):
        argv = argv if argv is not None else ' '.join([python, '-I', '-B', serve, '--runtime',
                                                       str(self.HOME / '.local/share/omegahive/runtime.json')])
        start = ('{ path=%s ; argv[]=%s ; ignore_errors=no ; start_time=[Mon 2026-11-09 13:00:00 UTC] ; '
                 'stop_time=[n/a] ; pid=%s ; code=(null) ; status=0/0 }' % (path or python, argv, started))
        return ('MainPID=%s\nExecMainPID=%s\nExecStart=%s%s\n' % (main, exec_main, start, extra)).encode()

    def setup_files(self, raw):
        python = Path(raw) / 'venv/bin/python'; python.parent.mkdir(parents=True); python.write_bytes(b'x')
        other = Path(raw) / 'other'; other.write_bytes(b'y')
        cfg = {'python': str(python), 'release_root': str(Path(raw) / 'app'), 'port': 8700}
        return cfg, python, other, str(Path(raw) / 'app/deploy/linux/serve.py')

    def test_systemd_record_must_be_the_configured_python_running_serve_for_this_main_process(self):
        with tempfile.TemporaryDirectory() as raw:
            cfg, python, other, serve = self.setup_files(raw)
            good = self.show(str(python), serve)
            with mock.patch.object(control, '_systemctl_show', return_value=good):
                self.assertTrue(control.service_started_from_configured_python(cfg, self.HOME, 4000))
                self.assertFalse(control.service_started_from_configured_python(cfg, self.HOME, 4001))   # another pid
            bad = [self.show(str(python), serve, exec_main='3999'),                     # main process is not what systemd started
                   self.show(str(python), serve, started='3999'),
                   self.show(str(python), serve, path=str(other)),                     # a different interpreter
                   self.show(str(python), serve, argv=' '.join([str(python), '-B', '-m', 'hive'])),
                   self.show(str(python), serve, argv=' '.join([str(python), '-I', '-B', serve + 'x', '--runtime', '/r'])),
                   self.show(str(python), serve, extra=' ; { path=/x ; argv[]=/x ; ignore_errors=no ; start_time=[] ; '
                             'stop_time=[] ; pid=4000 ; code=(null) ; status=0/0 }'),        # two ExecStart lines
                   self.show(str(python), serve) + b'MainPID=4000\n',                     # repeated key
                   b'MainPID=4000\nExecMainPID=4000\n',                                  # no ExecStart
                   b'\xff']
            for raw_show in bad:
                with self.subTest(show=raw_show[:120]), mock.patch.object(control, '_systemctl_show', return_value=raw_show):
                    self.assertFalse(control.service_started_from_configured_python(cfg, self.HOME, 4000))

    def test_hello_without_attestation_is_bound_by_systemd(self):
        with tempfile.TemporaryDirectory() as raw:
            cfg, python, _other, serve = self.setup_files(raw)
            for verdict in (True, False):
                with self.subTest(verdict=verdict), \
                        mock.patch.object(control, 'service_started_from_configured_python', return_value=verdict) as record:
                    self.assertIs(control.exe_matches(cfg, {'pid': 4000}, self.HOME, 4000), verdict)
                    record.assert_called_once_with(cfg, self.HOME, 4000)
            self.assertFalse(control.exe_matches(cfg, None, self.HOME, 4000))

    def test_an_attested_executable_must_also_be_the_configured_python_by_device_and_inode(self):
        with tempfile.TemporaryDirectory() as raw:
            cfg, python, other, _serve = self.setup_files(raw)
            real, wrong = os.stat(python), os.stat(other)
            with mock.patch.object(control, 'service_started_from_configured_python', return_value=True):
                self.assertTrue(control.exe_matches(cfg, {'exe': {'dev': real.st_dev, 'ino': real.st_ino}}, self.HOME, 4000))
                for bad in ({'exe': None}, {'exe': {'dev': real.st_dev}}, {'exe': {'dev': wrong.st_dev, 'ino': wrong.st_ino}},
                            {'exe': {'dev': str(real.st_dev), 'ino': real.st_ino}}, {'exe': {'dev': real.st_dev, 'ino': real.st_ino, 'x': 1}}):
                    with self.subTest(bad=bad):
                        self.assertFalse(control.exe_matches(cfg, bad, self.HOME, 4000))
            with mock.patch.object(control, 'service_started_from_configured_python', return_value=False):
                self.assertFalse(control.exe_matches(cfg, {'exe': {'dev': real.st_dev, 'ino': real.st_ino}}, self.HOME, 4000))

    def test_validated_hello_refuses_a_foreign_executable(self):
        with tempfile.TemporaryDirectory() as raw:
            cfg, _python, _other, _serve = self.setup_files(raw)
            hello = {'ok': True, 'local_owner': True, 'pid': 4000, 'port': 8700, 'instance': 'b' * 32, 'exe': {'dev': 0, 'ino': 0}}
            with mock.patch.object(control, 'service_started_from_configured_python', return_value=True), \
                    self.assertRaises(control.Refused):
                control.validated_hello(cfg, (hello, 4000), self.HOME)
            hello.pop('exe')
            with mock.patch.object(control, 'service_started_from_configured_python', return_value=False), \
                    self.assertRaises(control.Refused):
                control.validated_hello(cfg, (hello, 4000), self.HOME)
            with mock.patch.object(control, 'service_started_from_configured_python', return_value=True):
                self.assertEqual(control.validated_hello(cfg, (hello, 4000), self.HOME), (hello, 4000))


class AttestedListenerTests(unittest.TestCase):
    def tcp(self, rows):
        header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
        body = ''.join('   0: %s 00000000:0000 %s 00000000:00000000 00:00000000 00000000  %s        0 %s 1 0 0 0 0\n' % r for r in rows)
        read_fd, write_fd = os.pipe(); os.write(write_fd, (header + body).encode()); os.close(write_fd)
        return mock.patch.object(control.os, 'open', return_value=read_fd)

    def test_only_the_attested_inode_listening_on_the_port_matches(self):
        me = str(os.getuid()); port = '0100007F:21FC'   # 8700
        cases = [
            ([(port, '0A', me, '777')], {'listener_inode': '777'}, True),
            ([(port, '0A', me, '777'), (port, '0A', me, '778')], {'listener_inode': '777'}, False),   # a second listener
            ([(port, '0A', me, '778')], {'listener_inode': '777'}, False),                            # not the attested one
            ([(port, '0A', '0', '777')], {'listener_inode': '777'}, False),                           # another account
            ([(port, '01', me, '777')], {'listener_inode': '777'}, False),                            # not listening
            ([(port, '0A', me, '777')], {'listener_inode': None}, False),
            ([(port, '0A', me, '777')], {'listener_inode': '7a7'}, False),
            # The current hive attests no listener: exactly one LISTEN socket on the port, owned by this account.
            ([(port, '0A', me, '777')], {}, True),
            ([(port, '0A', me, '777'), (port, '0A', me, '778')], {}, False),
            ([(port, '0A', '0', '777')], {}, False),
            ([(port, '0A', me, '777'), (port, '0A', '0', '778')], {}, False),
            ([(port, '01', me, '777')], {}, False),
            ([], {}, False),
        ]
        for rows, hello, want in cases:
            with self.subTest(rows=rows, hello=hello), self.tcp(rows):
                self.assertIs(control.listener_matches({'port': 8700}, hello), want)

