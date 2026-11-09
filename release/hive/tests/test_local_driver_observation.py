"""Deterministic unit tests of the full driver module with OS adapters mocked.

The candidate module is loaded unmodified. Its workspace/sandbox imports are
inert fixtures; no process, signal, socket, or real PID file is used.
"""
import importlib.util
import ast
import asyncio
import contextlib
import logging
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch


HERE = Path(__file__).resolve().parent
SOURCE = HERE / 'drivers.py'
if not SOURCE.exists():
    SOURCE = HERE.parent / 'supervisor/drivers.py'
if os.environ.get('OMEGACODE_DRIVER_SOURCE'):
    SOURCE = Path(os.environ['OMEGACODE_DRIVER_SOURCE'])
PACKAGE = '_code_driver_observation_fixture'
package = ModuleType(PACKAGE)
package.__path__ = [str(SOURCE.parent)]
sandbox = ModuleType(PACKAGE + '.sandbox')
for name in ('available', 'loopback_ports', 'mind_environment', 'mind_sandbox_requested', 'runtime_roots', 'wrap'):
    setattr(sandbox, name, Mock(side_effect=AssertionError('unexpected sandbox/workspace execution')))
workspace = ModuleType(PACKAGE + '.workspace')
workspace.Workspace = object
sys.modules.update({PACKAGE: package, sandbox.__name__: sandbox, workspace.__name__: workspace})
spec = importlib.util.spec_from_file_location(PACKAGE + '.drivers', SOURCE)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class MemoryPidfile:
    def __init__(self, text='424242', error=None):
        self.text, self.error, self.removed = text, error, False

    def read_text(self):
        if self.error:
            raise self.error
        return self.text

    def unlink(self):
        self.removed = True


class Clock:
    value = 0.0

    def time(self):
        return self.value

    def sleep(self, amount):
        self.value += amount


class DriverObservationTests(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath('/__in_memory_driver_fixture__/a_test')
        self.pidfile = MemoryPidfile()
        self.d = module.LocalDriver(SimpleNamespace(path=lambda _: Path(self.root)), '/unused')
        self.d._pidfile = lambda _: self.pidfile
        self.run = Mock(return_value=SimpleNamespace(returncode=0, stdout='', stderr=''))
        self.signals = []
        self.killpg = Mock(side_effect=lambda pgid, sig: self.signals.append((pgid, sig)))
        self.originals = module.os, module.subprocess, module.time, module.pathlib
        module.os = SimpleNamespace(path=os.path, killpg=self.killpg,
                                    readlink=Mock(side_effect=AssertionError("unexpected kernel read")))
        module.subprocess = SimpleNamespace(run=self.run, SubprocessError=subprocess.SubprocessError,
                                           TimeoutExpired=subprocess.TimeoutExpired)
        module.time = Clock()
        module.open = Mock(side_effect=AssertionError('unexpected real file open'))
        self.addCleanup(self.restore)

    def restore(self):
        module.os, module.subprocess, module.time, module.pathlib = self.originals
        del module.open

    def owned(self):
        self.d._group_members = Mock(return_value=[(424243, 'worker')])
        self.d._cwd = Mock(return_value=self.root)

    def cwd_adapter(self, *, present=False):
        # Replace this module's pathlib binding, not global pathlib.Path. Keep
        # the actual LocalDriver._cwd implementation under test on every OS.
        self.cwd_path = SimpleNamespace(exists=Mock(return_value=present))
        module.pathlib = SimpleNamespace(Path=Mock(return_value=self.cwd_path))
        return self.cwd_path

    def failed_lsof_after_live_ps(self):
        self.cwd_adapter()
        def query(argv, **kwargs):
            if argv[0] == 'ps':
                text = '' if self.signals else '424243 424242 S worker\n'
                return SimpleNamespace(returncode=0, stdout=text, stderr='')
            self.assertEqual(argv, ['lsof', '-a', '-d', 'cwd', '-p', '424243', '-Fn'])
            return SimpleNamespace(returncode=1, stdout='p424243\nn' + self.root + '\n',
                                   stderr='private failed-query diagnostic')
        self.run.side_effect = query

    def test_failed_lsof_matching_output_is_not_ownership(self):
        self.failed_lsof_after_live_ps()
        with self.assertRaises(module.ProcessObservationError) as found:
            self.d.stop('a_test')
        self.assertNotIn('private failed-query diagnostic', str(found.exception))
        self.assertEqual(self.signals, [])
        self.assertFalse(self.pidfile.removed)

    def test_real_failed_cwd_adapter_prevents_status_execution_and_start(self):
        self.failed_lsof_after_live_ps()
        proc = SimpleNamespace(pid=424242, poll=Mock(return_value=0))
        self.d.procs['a_test'] = proc
        for action in (lambda: self.d.status('a_test'), lambda: self.d.execution('a_test'),
                       lambda: self.d.start({'id': 'a_test', 'kind': 'omega'}, {})):
            with self.assertRaises(module.ProcessObservationError):
                action()
        self.assertIs(self.d.procs['a_test'], proc)
        module.open.assert_not_called()
        self.assertFalse(self.pidfile.removed)
        self.assertEqual(self.signals, [])

    def test_successful_lsof_reads_the_cwd(self):
        self.cwd_adapter()
        self.run.return_value = SimpleNamespace(returncode=0, stdout='p424243\nn' + self.root + '\n')
        self.assertEqual(self.d._cwd(424243), self.root)
        self.run.assert_called_once_with(['lsof', '-a', '-d', 'cwd', '-p', '424243', '-Fn'],
                                         capture_output=True, text=True, timeout=5)

    def test_lsof_exception_is_unknown(self):
        self.cwd_adapter()
        for exc in (PermissionError('private'), subprocess.TimeoutExpired('lsof', 5)):
            with self.subTest(exception=type(exc).__name__):
                self.run.side_effect = exc
                with self.assertRaises(module.ProcessObservationError):
                    self.d._cwd(424243)

    def test_successful_but_missing_relative_or_ambiguous_lsof_cwd_is_unknown(self):
        self.cwd_adapter()
        for output in ('', 'p424243\n', 'nrelative/path\n', 'n\n',
                       'n' + self.root + '\nn/other\n'):
            with self.subTest(output=output):
                self.run.return_value = SimpleNamespace(returncode=0, stdout=output)
                with self.assertRaises(module.ProcessObservationError):
                    self.d._cwd(424243)

    def test_kernel_cwd_uses_a_successfully_read_link(self):
        path = self.cwd_adapter(present=True)
        module.os.readlink.return_value = self.root
        module.os.readlink.side_effect = None
        self.assertEqual(self.d._cwd(424243), self.root)
        module.os.readlink.assert_called_once_with(path)
        self.run.assert_not_called()

    def test_unreadable_kernel_cwd_does_not_accept_an_unresolved_realpath(self):
        self.cwd_adapter(present=True)
        module.os.readlink.side_effect = PermissionError('private')
        with self.assertRaises(module.ProcessObservationError):
            self.d._cwd(424243)
        self.run.assert_not_called()

    def test_relative_kernel_cwd_is_unknown(self):
        self.cwd_adapter(present=True)
        module.os.readlink.side_effect = None
        module.os.readlink.return_value = 'relative/path'
        with self.assertRaises(module.ProcessObservationError):
            self.d._cwd(424243)

    def test_failed_kernel_cwd_existence_query_is_unknown(self):
        path = self.cwd_adapter()
        path.exists.side_effect = PermissionError('private')
        with self.assertRaises(module.ProcessObservationError):
            self.d._cwd(424243)
        self.run.assert_not_called()

    def test_failed_ps_is_unknown(self):
        self.run.return_value = SimpleNamespace(returncode=1, stdout='', stderr='private text')
        with self.assertRaises(module.ProcessObservationError) as found:
            self.d._group_members(424242)
        self.assertNotIn('private text', str(found.exception))

    def test_timed_out_ps_is_unknown(self):
        self.run.side_effect = subprocess.TimeoutExpired('ps', 5)
        with self.assertRaises(module.ProcessObservationError):
            self.d._group_members(424242)

    def test_os_error_is_unknown(self):
        self.run.side_effect = PermissionError('denied')
        with self.assertRaises(module.ProcessObservationError):
            self.d._group_members(424242)

    def test_successful_ps_filters_only_the_requested_live_group(self):
        self.run.return_value = SimpleNamespace(returncode=0, stderr='', stdout=(
            '12 424242 S worker one\n13 424242 Z zombie\n14 101 S elsewhere\n'))
        self.assertEqual(self.d._group_members(424242), [(12, 'worker one')])

    def test_unknown_status_is_not_absent(self):
        self.owned()
        self.d._cwd.return_value = None
        with self.assertRaises(module.ProcessObservationError):
            self.d.status('a_test')

    def test_unknown_status_prevents_start_before_open_or_spawn(self):
        self.owned()
        self.d._cwd.return_value = None
        with self.assertRaises(module.ProcessObservationError):
            self.d.start({'id': 'a_test', 'kind': 'omega'}, {})
        module.open.assert_not_called()

    def test_status_then_unknown_stop_keeps_record_and_sends_no_signal(self):
        self.owned()
        self.d._cwd.side_effect = [self.root, None]
        self.assertEqual(self.d.status('a_test'), 'running')
        with self.assertRaises(module.ProcessObservationError):
            self.d.stop('a_test')
        self.assertFalse(self.pidfile.removed)
        self.assertEqual(self.signals, [])

    def test_unknown_ownership_does_not_discard_the_owned_child_handle(self):
        self.owned()
        self.d._cwd.return_value = None
        proc = SimpleNamespace(pid=424242, poll=Mock(return_value=None))
        self.d.procs['a_test'] = proc
        with self.assertRaises(module.ProcessObservationError):
            self.d.stop('a_test')
        self.assertIs(self.d.procs['a_test'], proc)
        self.assertFalse(self.pidfile.removed)
        self.assertEqual(self.signals, [])

    def test_unknown_after_term_does_not_report_success(self):
        self.owned()
        self.d._group_members.side_effect = [[(424243, 'worker')], module.ProcessObservationError('denied')]
        with self.assertRaises(module.ProcessObservationError):
            self.d.stop('a_test')
        self.assertFalse(self.pidfile.removed)
        self.assertEqual(self.signals, [(424242, signal.SIGTERM)])

    def test_failed_stop_keeps_own_child_handle(self):
        self.owned()
        proc = SimpleNamespace(pid=424242, poll=Mock(), wait=Mock())
        self.d.procs['a_test'] = proc
        self.d._group_members.side_effect = [[(424243, 'worker')], module.ProcessObservationError('denied')]
        with self.assertRaises(module.ProcessObservationError):
            self.d.stop('a_test')
        self.assertIs(self.d.procs['a_test'], proc)
        self.assertFalse(self.pidfile.removed)
        proc.wait.assert_not_called()

    def test_confirmed_empty_group_clears_the_old_record(self):
        self.assertEqual(self.d.status('a_test'), 'absent')
        self.d.stop('a_test')
        self.assertTrue(self.pidfile.removed)
        self.assertEqual(self.signals, [])

    def test_different_group_is_ignored_when_recorded_group_is_absent(self):
        self.run.return_value = SimpleNamespace(returncode=0, stderr='',
            stdout='424243 101 S unrelated-process\n')
        self.assertEqual(self.d.status('a_test'), 'absent')
        self.d.stop('a_test')
        self.assertTrue(self.pidfile.removed)
        self.assertEqual(self.signals, [])

    def test_another_member_can_supply_positive_ownership(self):
        self.owned()
        self.d._group_members.return_value = [(424243, 'one'), (424244, 'two')]
        self.d._cwd.side_effect = [None, self.root]
        self.assertEqual(self.d.status('a_test'), 'running')

    def test_exited_leader_with_moved_child_keeps_unresolved_custody(self):
        self.owned()
        self.d._cwd.return_value = '/changed/by/legitimate-child'
        proc = SimpleNamespace(pid=424242, poll=Mock(return_value=0), wait=Mock())
        self.d.procs['a_test'] = proc
        for action in (self.d.status, self.d.execution, self.d.stop):
            with self.assertRaises(module.ProcessObservationError):
                action('a_test')
        self.assertFalse(self.pidfile.removed)
        self.assertEqual(self.signals, [])
        self.assertIs(self.d.procs['a_test'], proc)

    def test_unverified_same_number_group_is_not_assumed_unrelated(self):
        self.owned()
        self.d._cwd.return_value = '/another/workspace'
        with self.assertRaises(module.ProcessObservationError):
            self.d.stop('a_test')
        self.assertFalse(self.pidfile.removed)
        self.assertEqual(self.signals, [])

    def test_owned_survivor_remains_running_with_the_same_execution_identity(self):
        self.owned()
        self.d.procs['a_test'] = SimpleNamespace(pid=424242, poll=Mock(return_value=0))
        self.d.isolation['a_test'] = {'started_at': 123.0}
        self.assertEqual(self.d.status('a_test'), 'running')
        self.assertEqual(self.d.execution('a_test'), 'local:424242:123.0')

    def test_exited_leader_and_confirmed_empty_group_are_exited(self):
        self.d.procs['a_test'] = SimpleNamespace(pid=424242, poll=Mock(return_value=0))
        self.assertEqual(self.d.status('a_test'), 'exited')
        self.assertIsNone(self.d.execution('a_test'))

    def test_command_workspace_proof_still_works(self):
        self.owned()
        self.d._group_members.return_value = [(424243, self.root + '/run.metta')]
        self.d._cwd.side_effect = AssertionError('unnecessary cwd query')
        self.assertEqual(self.d.status('a_test'), 'running')

    def test_unreadable_pid_record_is_unknown(self):
        self.pidfile.error = PermissionError('denied')
        with self.assertRaises(module.ProcessObservationError):
            self.d.stop('a_test')
        self.assertFalse(self.pidfile.removed)
        self.assertEqual(self.signals, [])

    def test_invalid_pid_record_is_kept(self):
        for text in ('bad', '-20', '0', '1'):
            with self.subTest(text=text):
                self.pidfile.text = text
                with self.assertRaises(module.ProcessObservationError):
                    self.d.stop('a_test')
                self.assertFalse(self.pidfile.removed)
        self.assertEqual(self.signals, [])

    def test_missing_pid_record_is_absent(self):
        self.pidfile.error = FileNotFoundError()
        self.assertEqual(self.d.status('a_test'), 'absent')

    def test_verified_stop_escalates_then_clears_record(self):
        self.owned()
        live = [(424243, 'worker')]
        self.d._group_members.side_effect = lambda _: [] if self.signals and self.signals[-1][1] == signal.SIGKILL else live
        self.d.stop('a_test')
        self.assertEqual(self.signals, [(424242, signal.SIGTERM), (424242, signal.SIGKILL)])
        self.assertTrue(self.pidfile.removed)

    def test_verified_stop_failure_keeps_record_and_handle(self):
        self.owned()
        proc = SimpleNamespace(pid=424242, poll=Mock(), wait=Mock())
        self.d.procs['a_test'] = proc
        with self.assertRaises(RuntimeError):
            self.d.stop('a_test')
        self.assertFalse(self.pidfile.removed)
        self.assertIs(self.d.procs['a_test'], proc)
        self.assertEqual(self.signals, [(424242, signal.SIGTERM), (424242, signal.SIGKILL)])

    def test_supervisor_cannot_verify_an_unknown_driver_stopped(self):
        self.owned()
        self.d._cwd.return_value = None
        supervisor = module.Supervisor.__new__(module.Supervisor)
        supervisor._agent = lambda _: {'id': 'a_test'}
        supervisor.driver = lambda _: self.d
        with self.assertRaises(module.ProcessObservationError):
            supervisor.verify_stopped('a_test')


    def test_signal_permission_failure_keeps_custody_without_waiting(self):
        self.owned()
        self.killpg.side_effect = PermissionError('denied')
        with self.assertRaises(module.ProcessObservationError):
            self.d.stop('a_test')
        self.assertFalse(self.pidfile.removed)
        self.killpg.assert_called_once_with(424242, signal.SIGTERM)
        self.assertEqual(module.time.value, 0.0)

    def test_signal_reports_missing_group_then_query_confirms_empty(self):
        self.owned()
        self.d._group_members.side_effect = [[(424243, 'worker')], []]
        self.killpg.side_effect = ProcessLookupError('gone')
        self.d.stop('a_test')
        self.assertTrue(self.pidfile.removed)
        self.killpg.assert_called_once_with(424242, signal.SIGTERM)

    def test_one_unobservable_mind_does_not_abort_reconciliation(self):
        supervisor = module.Supervisor.__new__(module.Supervisor)
        supervisor.hive = SimpleNamespace(db=SimpleNamespace(all=lambda _: [{'id':'A'}, {'id':'B'}]))
        supervisor._stop = SimpleNamespace(is_set=lambda: False)
        supervisor.lock = lambda _: contextlib.nullcontext()
        supervisor._reconcile = Mock(side_effect=[module.ProcessObservationError('unknown'), None])
        with self.assertLogs('hive', level='WARNING'):
            supervisor.check()
        self.assertEqual([call.args for call in supervisor._reconcile.call_args_list], [('A',), ('B',)])

    def test_stubborn_stop_and_observation_failure_do_not_block_later_minds(self):
        supervisor = module.Supervisor.__new__(module.Supervisor)
        supervisor.hive = SimpleNamespace(db=SimpleNamespace(all=lambda _: [{'id':'A'}, {'id':'B'}, {'id':'C'}]))
        supervisor._stop = SimpleNamespace(is_set=lambda: False)
        supervisor.lock = lambda _: contextlib.nullcontext()
        def reconcile(mind):
            if mind == 'A':
                raise module.ProcessObservationError('unknown')
            if mind == 'B':
                self.owned()
                self.d.stop('a_test')   # actual verified TERM/KILL path refuses to report success
        supervisor._reconcile = Mock(side_effect=reconcile)
        with self.assertLogs('hive', level='WARNING') as logs:
            supervisor.check()
        self.assertEqual([call.args for call in supervisor._reconcile.call_args_list], [('A',), ('B',), ('C',)])
        self.assertFalse(self.pidfile.removed)
        self.assertEqual(self.signals, [(424242, signal.SIGTERM), (424242, signal.SIGKILL)])
        self.assertTrue(any('RuntimeError' in row for row in logs.output))

    def _assert_shutdown_lifespan(self, local_owner, stop_failure):
        # Execute the actual integrated handler with inert service boundaries.
        # Both local-owner and ordinary-host paths have explicit order assertions.
        # Exercise the actual resource decorator/retirement without creating a
        # bootstrap attempt, process, cgroup, map worker or real repository map.
        from hive.core.code_aggregate import _CodeAggregate
        app_source = HERE / 'app.py'
        if not app_source.exists():
            app_source = HERE.parent / 'core/app.py'
        source_text = app_source.read_text()
        tree = ast.parse(source_text)
        factory = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_create_app')
        helpers = [n for n in factory.body if isinstance(n, ast.AsyncFunctionDef)
                   and n.name in ('prepare_installed_map', 'lifespan')]
        self.assertEqual([n.name for n in helpers], ['prepare_installed_map', 'lifespan'])
        code = ast.fix_missing_locations(ast.Module(body=helpers, type_ignores=[]))
        # No ast.dump/source digest assertion: the actual handler below must
        # contain stop failures per mind, continue, drain and close in order.
        # The context marker also proves shutdown occurs after the yield.
        events = []
        async def nothing():
            pass
        async def restore():
            events.append('restore')
        async def conductor_close():
            events.append('conductor-close')
        async def gateway_close():
            events.append('gateway-close')
        async def local_start():
            events.append('local-start')
        async def local_stop():
            events.append('local-stop')
        @contextlib.asynccontextmanager
        async def code_bridge_running(owner):
            self.assertIs(owner, hive)
            events.append('code-bridge-start')
            try:
                yield
            finally:
                events.append('code-bridge-stop')
        def stop(mind):
            events.append(mind)
            if mind == 'A':
                raise stop_failure
        async def threadpool(fn, *args):
            return fn(*args)
        # The map is the same explicit synthetic service boundary as the
        # preflight/gateway stand-ins. Keep the original helper coroutine and
        # dispatch its one to_thread callback inline, with no shared patch.
        installed_map = SimpleNamespace(run_once=Mock(), stop=Mock(), worker_failed=Mock())
        fixture_asyncio = SimpleNamespace(get_running_loop=asyncio.get_running_loop,
            create_task=asyncio.create_task, wait=asyncio.wait,
            CancelledError=asyncio.CancelledError, to_thread=threadpool)
        supervisor = SimpleNamespace(stop=stop, shutdown=lambda: events.append('shutdown'))
        hive = SimpleNamespace(events=SimpleNamespace(bind=Mock()), restore=restore,
            db=SimpleNamespace(all=lambda _: [{'id':'A'}, {'id':'B'}]),
            ask=SimpleNamespace(conductor=SimpleNamespace(aclose=conductor_close)),
            # gate A r1.3's stored-answer sweeper thread: an inert stand-in that returns at once (start/stop no-ops)
            mind_idempotency=SimpleNamespace(sweeper=lambda stop: None))
        local = SimpleNamespace(start=local_start, stop=local_stop, preflight=None) if local_owner else None
        settings = SimpleNamespace(data_dir=Path('/__in_memory_lifecycle_fixture__'))
        aggregate = _CodeAggregate(settings)
        self.assertFalse(aggregate.start_attempted)
        self.assertIsNone(aggregate.attempt)
        preflight_result = object()
        def preflight_run(data_dir):
            events.append('preflight')
            self.assertEqual(data_dir, settings.data_dir)
            return preflight_result
        # Satisfy the handler's actual relative import without loading or calling
        # host preflight, launchers, sandboxes or local-owner services.
        pkg_name = '_code_driver_lifespan_fixture'
        pkg = ModuleType(pkg_name)
        pkg.__path__ = []
        fake_supervisor = ModuleType(pkg_name + '.supervisor')
        fake_supervisor.__path__ = []
        preflight = ModuleType(pkg_name + '.supervisor.preflight')
        preflight.run_and_record = Mock(side_effect=preflight_run)
        fake_supervisor.preflight = preflight
        env = dict(__name__=pkg_name + '.core.app', __package__=pkg_name + '.core',
            asyncio=fixture_asyncio, contextlib=contextlib, logging=logging, threading=threading,
            hive=hive, supervisor=supervisor, reconcile_seconds=0, reconcile=nothing,
            warm_catalog=nothing, app_ask_expiry=nothing, run_in_threadpool=threadpool, local=local, settings=settings,
            installed_map=installed_map, _code_aggregate=aggregate,
            code_local_enrolment=SimpleNamespace(running=code_bridge_running),
            gateway=SimpleNamespace(client=SimpleNamespace(aclose=gateway_close)))
        async def run():
            async with env['lifespan'](None):
                events.append('context-active')
            await asyncio.sleep(0)
        with patch.dict(sys.modules, {pkg_name:pkg, fake_supervisor.__name__:fake_supervisor,
                                     preflight.__name__:preflight}):
            exec(compile(code, str(app_source), 'exec'), env)
            with self.assertLogs('hive', level='WARNING') as logs:
                asyncio.run(run())
        expected = ['restore', 'code-bridge-start', 'context-active', 'code-bridge-stop',
                    'shutdown', 'A', 'B', 'conductor-close', 'gateway-close']
        if local_owner:
            expected = ['preflight', 'local-start'] + expected + ['local-stop']
            preflight.run_and_record.assert_called_once_with(settings.data_dir)
            self.assertIs(local.preflight, preflight_result)
        else:
            preflight.run_and_record.assert_not_called()
        self.assertEqual(events, expected)
        self.assertTrue(any('unresolved' in row for row in logs.output))
        installed_map.run_once.assert_called_once_with()
        installed_map.stop.assert_called_once_with()
        installed_map.worker_failed.assert_not_called()
        self.assertTrue(hive._installed_map_job.done())
        self.assertFalse(hive._installed_map_job.cancelled())
        self.assertIsNone(hive._installed_map_job.exception())
        self.assertFalse(aggregate.start_attempted)
        self.assertIsNone(aggregate.attempt)
        self.assertEqual(aggregate._runner_contexts, [])
        self.assertTrue(aggregate.retirement_attempted)
        self.assertEqual(aggregate.phase, 'retired-no-attempt')
        self.assertFalse(aggregate.observation_incomplete)

    def test_shutdown_attempts_later_minds_and_closes_conductor_and_gateway(self):
        self._assert_shutdown_lifespan(local_owner=False,
            stop_failure=module.ProcessObservationError('unknown'))

    def test_local_owner_preflight_start_restore_and_shutdown_order(self):
        self._assert_shutdown_lifespan(local_owner=True,
            stop_failure=RuntimeError('verified stubborn stop'))


    def test_missing_pidfile_does_not_discard_an_exited_leaders_survivor(self):
        self.owned()
        self.pidfile.error = FileNotFoundError()
        self.d._cwd.return_value = '/changed/by/legitimate-child'
        proc = SimpleNamespace(pid=424242, poll=Mock(return_value=0), wait=Mock())
        self.d.procs['a_test'] = proc
        for action in (self.d.status, self.d.execution, self.d.stop):
            with self.assertRaises(module.ProcessObservationError):
                action('a_test')
        self.assertIs(self.d.procs['a_test'], proc)
        self.assertFalse(self.pidfile.removed)
        self.assertEqual(self.signals, [])

    def test_missing_pidfile_and_confirmed_empty_known_group_can_clear_handle(self):
        self.pidfile.error = FileNotFoundError()
        self.d.procs['a_test'] = SimpleNamespace(pid=424242, poll=Mock(return_value=0), wait=Mock())
        self.assertEqual(self.d.status('a_test'), 'exited')
        self.d.stop('a_test')
        self.assertNotIn('a_test', self.d.procs)
        self.assertEqual(self.signals, [])

    def test_conflicting_pidfile_and_owned_handle_are_retained_unresolved(self):
        self.owned()
        proc = SimpleNamespace(pid=424244, poll=Mock(return_value=0), wait=Mock())
        self.d.procs['a_test'] = proc
        for action in (self.d.status, self.d.execution, self.d.stop):
            with self.assertRaises(module.ProcessObservationError):
                action('a_test')
        self.assertIs(self.d.procs['a_test'], proc)
        self.assertFalse(self.pidfile.removed)
        self.assertEqual(self.signals, [])


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(DriverObservationTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    print(json.dumps({'tests': result.testsRun, 'failures': len(result.failures),
                      'errors': len(result.errors), 'native_processes_or_signals': False}))
    raise SystemExit(not result.wasSuccessful())
