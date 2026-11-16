import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve()
CORE = ROOT.parents[1]
sys.path.insert(0, str(CORE))
sys.path.insert(0, str(CORE / 'src'))

import codex_code  # noqa: E402
import modules.codex_code.src.codex_code as impl  # noqa: E402


class CodexCodeModuleTests(unittest.TestCase):
    def test_entry_imports_facade_for_janus_builtin_name(self):
        entry = (CORE / 'modules' / 'codex_code' / 'entry.metta').read_text(encoding='utf-8')
        self.assertIn('./src/codex_code.py', entry)
        self.assertNotIn('./modules/codex_code/src/codex_code.py', entry)

    def test_status_does_not_expose_secret(self):
        with mock.patch.dict(os.environ, {'OPENROUTER_API_KEY': 'secret-value'}, clear=False):
            status = codex_code.codex_code_status()
        self.assertIn('openrouter_key=True', status)
        self.assertIn('containment=', status)
        self.assertNotIn('secret-value', status)

    def test_atoms_surface_runtime_containment_without_secrets(self):
        env = {
            'OPENROUTER_API_KEY': 'secret-value',
            'OMEGACLAW_CODEX_SANDBOX_READONLY': 'danger-full-access',
            'OMEGACLAW_CODEX_SANDBOX_EDIT': 'danger-full-access',
            'OMEGACLAW_CODEX_DANGEROUS_BYPASS': '1',
        }
        with mock.patch.dict(os.environ, env, clear=False):
            atoms = impl.codex_code_atoms()
        self.assertIn('(CodexCodeContainment codex-code vm-boundary)', atoms)
        self.assertIn('(CodexCodeContainmentLevel codex-code deployment-vm-boundary)', atoms)
        self.assertIn('(CodexCodeSandboxBypass codex-code active)', atoms)
        self.assertIn('(CodexCodeSandboxReadonly codex-code danger-full-access)', atoms)
        self.assertNotIn('secret-value', atoms)

    def test_containment_check_reports_vm_boundary_when_bypass_is_active(self):
        env = {
            'OPENROUTER_API_KEY': 'secret-value',
            'OMEGACLAW_CODEX_SANDBOX_READONLY': 'danger-full-access',
            'OMEGACLAW_CODEX_SANDBOX_EDIT': 'danger-full-access',
            'OMEGACLAW_CODEX_DANGEROUS_BYPASS': '1',
        }
        with mock.patch.dict(os.environ, env, clear=False):
            check = impl.codex_code_containment_check()
        self.assertIn('verdict=vm-boundary-required', check)
        self.assertIn('(CodexCodeContainmentCheck codex-code vm-boundary-required)', check)
        self.assertIn('(CodexCodeContainment codex-code vm-boundary)', check)
        self.assertNotIn('secret-value', check)

    def test_containment_check_reports_codex_sandbox_by_default(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            check = impl.codex_code_containment_check()
        self.assertIn('verdict=codex-sandbox-active', check)
        self.assertIn('(CodexCodeContainment codex-code codex-sandbox)', check)
        self.assertIn('(CodexCodeSandboxBypass codex-code inactive)', check)

    def test_containment_check_reports_invalid_config(self):
        with mock.patch.dict(os.environ, {'OMEGACLAW_CODEX_SANDBOX_READONLY': 'moonbase'}, clear=True):
            atoms = impl.codex_code_atoms()
            check = impl.codex_code_containment_check()
        self.assertIn('(CodexCodeContainmentLevel codex-code invalid-config)', atoms)
        self.assertIn('(CodexCodeSandboxConfigError codex-code ', atoms)
        self.assertIn('verdict=invalid-config', check)

    def test_empty_task_is_rejected(self):
        self.assertEqual(codex_code.codex_code('   '), 'CODEX-CODE-ERROR empty task')

    def test_incomplete_success_is_not_reported_ok(self):
        fake = mock.Mock()
        fake.returncode = 0
        fake.stdout = '{"type":"thread.started"}\n{"type":"turn.started"}\n'
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(impl, 'TRACE_FILE', pathlib.Path(tmp) / 'trace.jsonl'), \
             mock.patch.dict(os.environ, {'OPENROUTER_API_KEY': 'present'}, clear=False), \
             mock.patch.object(impl, '_codex_bin', return_value='/bin/true'), \
             mock.patch('subprocess.run', return_value=fake):
            result = impl.codex_code_readonly('x')
            self.assertIn('CODEX-CODE-INCOMPLETE', result)
            self.assertIn('containment=codex-sandbox', result)
            trace = (pathlib.Path(tmp) / 'trace.jsonl').read_text(encoding='utf-8')
            self.assertIn('"status": "incomplete"', trace)

    def test_async_start_returns_job_without_running_codex_inline(self):
        fake_status = {
            'codex_bin': '/bin/true',
            'codex_present': True,
            'profile': 'qwen-coder-next',
            'model': 'qwen/qwen3-coder-next',
            'openrouter_key_present': True,
            'cwd': str(CORE),
            'trace': '',
            'jobs_dir': '',
            'events': '',
            'max_active_jobs': 1,
            'sandbox_readonly': 'read-only',
            'sandbox_edit': 'workspace-write',
            'dangerous_bypass': False,
            'sandbox_error': '',
        }
        fake_process = mock.Mock()
        fake_process.pid = 12345
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(impl, 'JOBS_DIR', pathlib.Path(tmp) / 'jobs'), \
             mock.patch.object(impl, 'EVENTS_FILE', pathlib.Path(tmp) / 'events.metta'), \
             mock.patch.object(impl, 'TRACE_FILE', pathlib.Path(tmp) / 'trace.jsonl'), \
             mock.patch.object(impl, '_status_dict', return_value=fake_status), \
             mock.patch.object(impl, '_start_worker_reaper') as reaper, \
             mock.patch('subprocess.Popen', return_value=fake_process):
            result = impl.codex_code_readonly_start('inspect the persistence registry')
            self.assertIn('CODEX-CODE-JOB-STARTED', result)
            self.assertIn('mode=readonly', result)
            self.assertIn('CodexJobStarted', (pathlib.Path(tmp) / 'events.metta').read_text(encoding='utf-8'))
            self.assertEqual(len(list((pathlib.Path(tmp) / 'jobs').glob('*/state.json'))), 1)
            reaper.assert_called_once_with(fake_process)

    def test_async_rejects_second_active_job(self):
        fake_status = {
            'codex_bin': '/bin/true',
            'codex_present': True,
            'profile': 'qwen-coder-next',
            'model': 'qwen/qwen3-coder-next',
            'openrouter_key_present': True,
            'cwd': str(CORE),
            'trace': '',
            'jobs_dir': '',
            'events': '',
            'max_active_jobs': 1,
            'sandbox_readonly': 'read-only',
            'sandbox_edit': 'workspace-write',
            'dangerous_bypass': False,
            'sandbox_error': '',
        }
        fake_process = mock.Mock()
        fake_process.pid = 12345
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(impl, 'JOBS_DIR', pathlib.Path(tmp) / 'jobs'), \
             mock.patch.object(impl, 'EVENTS_FILE', pathlib.Path(tmp) / 'events.metta'), \
             mock.patch.object(impl, 'TRACE_FILE', pathlib.Path(tmp) / 'trace.jsonl'), \
             mock.patch.object(impl, '_status_dict', return_value=fake_status), \
             mock.patch.object(impl, '_pid_alive', return_value=True), \
             mock.patch.object(impl, '_start_worker_reaper'), \
             mock.patch('subprocess.Popen', return_value=fake_process):
            first = impl.codex_code_start('edit one')
            second = impl.codex_code_start('edit two')
        self.assertIn('CODEX-CODE-JOB-STARTED', first)
        self.assertIn('CODEX-CODE-JOB-REJECTED', second)
        self.assertIn('reason=max-active-jobs', second)

    def test_pid_alive_treats_linux_zombie_as_dead(self):
        with mock.patch.object(impl, '_pid_process_state', return_value='Z'), \
             mock.patch('os.kill') as kill:
            self.assertFalse(impl._pid_alive(12345))
            kill.assert_not_called()

    def test_running_job_with_zombie_worker_is_marked_stale(self):
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(impl, 'JOBS_DIR', pathlib.Path(tmp) / 'jobs'), \
             mock.patch.object(impl, 'EVENTS_FILE', pathlib.Path(tmp) / 'events.metta'), \
             mock.patch.object(impl, 'TRACE_FILE', pathlib.Path(tmp) / 'trace.jsonl'), \
             mock.patch.object(impl, '_pid_process_state', return_value='Z'):
            impl._write_job_state({
                'id': 'codex-zombie',
                'mode': 'edit',
                'status': 'running',
                'worker_pid': 12345,
                'created_at': 'now',
                'result_path': str(pathlib.Path(tmp) / 'jobs' / 'codex-zombie' / 'result.txt'),
            })
            status = impl.codex_code_job_status('codex-zombie')
            events = impl.codex_code_events()
        self.assertIn('status=stale', status)
        self.assertIn('CodexJobStale', events)

    def test_worker_writes_result_and_completion_event(self):
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(impl, 'JOBS_DIR', pathlib.Path(tmp) / 'jobs'), \
             mock.patch.object(impl, 'EVENTS_FILE', pathlib.Path(tmp) / 'events.metta'), \
             mock.patch.object(impl, 'TRACE_FILE', pathlib.Path(tmp) / 'trace.jsonl'), \
             mock.patch.object(impl, '_run_codex', return_value='CODEX-CODE-OK mode=readonly\nDone'):
            state = {
                'id': 'codex-test',
                'mode': 'readonly',
                'readonly': True,
                'status': 'running',
                'task': 'inspect x',
                'created_at': 'now',
                'result_path': str(pathlib.Path(tmp) / 'jobs' / 'codex-test' / 'result.txt'),
            }
            impl._write_job_state(state)
            code = impl._worker('codex-test')
            status = impl.codex_code_job_status('codex-test')
            result = impl.codex_code_result('codex-test')
            events = impl.codex_code_events()
        self.assertEqual(code, 0)
        self.assertIn('status=complete', status)
        self.assertIn('CODEX-CODE-OK', result)
        self.assertIn('CodexJobComplete', events)

    def test_default_sandbox_policy_is_conservative(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(impl._codex_sandbox_args(True), ('read-only', False, ['--sandbox', 'read-only']))
            self.assertEqual(impl._codex_sandbox_args(False), ('workspace-write', False, ['--sandbox', 'workspace-write']))

    def test_sandbox_policy_can_be_overridden_by_deployment(self):
        env = {
            'OMEGACLAW_CODEX_SANDBOX_READONLY': 'danger-full-access',
            'OMEGACLAW_CODEX_SANDBOX_EDIT': 'danger-full-access',
        }
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(
                impl._codex_sandbox_args(True),
                ('danger-full-access', False, ['--sandbox', 'danger-full-access']),
            )
            self.assertEqual(
                impl._codex_sandbox_args(False),
                ('danger-full-access', False, ['--sandbox', 'danger-full-access']),
            )

    def test_dangerous_bypass_requires_explicit_flag(self):
        env = {
            'OMEGACLAW_CODEX_SANDBOX_READONLY': 'read-only',
            'OMEGACLAW_CODEX_DANGEROUS_BYPASS': '1',
        }
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(
                impl._codex_sandbox_args(True),
                ('read-only', True, ['--dangerously-bypass-approvals-and-sandbox']),
            )


if __name__ == '__main__':
    unittest.main()
