"""Failure diagnostics preserve the original cause without weakening process ownership."""
import io
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from test_install import install
from test_bootstrap import bootstrap

class DiagnosticsTests(unittest.TestCase):
    def test_command_failure_survives_snapshot_and_cleanup_failure(self):
        instance=install.Installer(Path('/unused'), {}, Path('/unused'))
        instance.log=io.BytesIO()
        process=SimpleNamespace(pid=12345,returncode=None)
        with patch.object(install.subprocess,'Popen',return_value=process), \
             patch.object(install.os,'waitid',return_value=SimpleNamespace(si_status=1)), \
             patch.object(instance,'group_rows',side_effect=install.Refused('The numeric setup monitor timed out.')), \
             patch.object(instance,'cleanup_group',side_effect=install.Refused('cleanup snapshot unavailable')):
            with self.assertRaises(install.Refused) as error: instance.run(['/synthetic/bootstrap'])
        message=str(error.exception)
        self.assertTrue(message.startswith('Setup command failed (status 1).'))
        self.assertIn('Process verification:',message)
        self.assertIn('Cleanup incomplete:',message)
        self.assertIn('Do not retry',message)
        self.assertIn(b'Setup command failed',instance.log.getvalue())
        self.assertIsNone(process.returncode)

    def test_step_timeout_survives_cleanup_failure(self):
        instance=install.Installer(Path('/unused'), {}, Path('/unused'))
        process=SimpleNamespace(pid=12345,returncode=None)
        with patch.object(install.subprocess,'Popen',return_value=process), \
             patch.object(instance,'cleanup_group',side_effect=install.Refused('snapshot timeout')):
            with self.assertRaises(install.Refused) as error: instance.run(['/synthetic/step'],timeout=-1)
        self.assertIn('one step took too long',str(error.exception))
        self.assertIn('Cleanup incomplete: snapshot timeout',str(error.exception))

    def test_snapshot_allows_more_than_two_seconds_without_reaping_anchor(self):
        instance=install.Installer(Path('/unused'), {}, Path('/unused'))
        original=subprocess.Popen
        child=original([sys.executable,'-c','import time; time.sleep(20)'],start_new_session=True)
        def slow_ps(argv,**kwargs):
            self.assertEqual(argv[0],'/usr/bin/ps')
            return original([sys.executable,'-c',
                'import os,time; time.sleep(2.2); os.execv("/usr/bin/ps", ["ps","-e","-o","pid=,ppid=,pgid=,sid=,ruid=,stat="])'],**kwargs)
        try:
            with patch.object(install.subprocess,'Popen',side_effect=slow_ps):
                rows=instance.group_rows(child,time.monotonic()+10)
            self.assertTrue(any(r[0]==child.pid for r in rows))
            self.assertIsNone(child.returncode)
        finally:
            child.terminate();child.wait(timeout=5)

    def test_bootstrap_names_readiness_timeout_without_serializing_other_errors(self):
        self.assertIn('readiness timed out',bootstrap.failure_message(bootstrap.Refused('control_reply_timeout')))
        self.assertNotIn('synthetic-private-value',bootstrap.failure_message(ValueError('synthetic-private-value')))
