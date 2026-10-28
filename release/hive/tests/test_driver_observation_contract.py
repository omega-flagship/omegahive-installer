"""The same expectations exercise old full modules and the corrected module.

Only the selected full driver module changes; the fixture and assertions do not.
Use OMEGACODE_DRIVER_SOURCE to select an unchanged baseline for the red control.
"""
import importlib.util
import contextlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


path = Path(__file__).with_name('test_local_driver_observation.py')
spec = importlib.util.spec_from_file_location('_driver_observation_contract_fixture', path)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class StopFailureContractTests(unittest.TestCase):
    setUp = fixture.DriverObservationTests.setUp
    restore = fixture.DriverObservationTests.restore
    owned = fixture.DriverObservationTests.owned
    cwd_adapter = fixture.DriverObservationTests.cwd_adapter
    failed_lsof_after_live_ps = fixture.DriverObservationTests.failed_lsof_after_live_ps

    def test_failed_process_query_must_not_mean_empty(self):
        self.run.return_value = SimpleNamespace(returncode=1, stdout='', stderr='denied')
        with self.assertRaises(RuntimeError):
            self.d._group_members(424242)

    def test_failed_query_after_term_must_not_mean_stopped(self):
        self.run.return_value = SimpleNamespace(returncode=1, stdout='', stderr='denied')
        with self.assertRaises(RuntimeError):
            self.d._end_group(424242)

    def test_lost_ownership_observation_must_keep_the_record(self):
        self.owned()
        self.d._cwd.side_effect = [self.root, None]
        self.assertEqual(self.d.status('a_test'), 'running')
        with self.assertRaises(RuntimeError):
            self.d.stop('a_test')
        self.assertFalse(self.pidfile.removed)
        self.assertEqual(self.signals, [])


    def test_exited_leader_and_moved_child_do_not_lose_custody(self):
        self.owned()
        self.d._cwd.return_value = '/changed/by/legitimate-child'
        proc = SimpleNamespace(pid=424242, poll=Mock(return_value=0), wait=Mock())
        self.d.procs['a_test'] = proc
        with self.assertRaises(RuntimeError):
            self.d.stop('a_test')
        self.assertFalse(self.pidfile.removed)
        self.assertIs(self.d.procs.get('a_test'), proc)
        self.assertEqual(self.signals, [])

    def test_failed_lsof_output_does_not_authorize_a_signal_or_record_removal(self):
        # Intentionally uses the real _cwd, group observation and stop methods.
        self.failed_lsof_after_live_ps()
        error = None
        try:
            self.d.stop('a_test')
        except RuntimeError as exc:
            error = exc
        self.assertEqual(self.signals, [], 'failed cwd query must never authorize TERM')
        self.assertFalse(self.pidfile.removed)
        self.assertIsNotNone(error, 'failed cwd query must remain unknown')

    def test_one_stubborn_stop_does_not_abort_later_minds_reconciliation(self):
        supervisor = fixture.module.Supervisor.__new__(fixture.module.Supervisor)
        supervisor.hive = SimpleNamespace(db=SimpleNamespace(all=lambda _: [{'id':'A'}, {'id':'B'}]))
        supervisor._stop = SimpleNamespace(is_set=lambda: False)
        supervisor.lock = lambda _: contextlib.nullcontext()
        supervisor._reconcile = Mock(side_effect=[RuntimeError('stubborn verified group'), None])
        error = None
        with self.assertLogs('hive', level='WARNING'):
            try:
                supervisor.check()
            except RuntimeError as exc:
                error = exc
                # Baselines do not log this exception; give assertLogs a known
                # diagnostic so the control fails for containment, not fixtures.
                fixture.logging.getLogger('hive').warning('fixture observed uncaught RuntimeError')
        self.assertIsNone(error, 'one failing mind must not abort reconciliation')
        self.assertEqual([call.args for call in supervisor._reconcile.call_args_list], [('A',), ('B',)])


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(StopFailureContractTests))
    print(json.dumps({'tests': result.testsRun, 'failures': len(result.failures),
                      'errors': len(result.errors), 'native_processes_or_signals': False}))
    raise SystemExit(not result.wasSuccessful())
