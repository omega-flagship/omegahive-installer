"""Real-server failure regressions; synthetic identities, no live package/service changes."""
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from test_install import install, catalogue, row, installed_fixture
import test_frontdoor
control = test_frontdoor.control

class ReadinessTests(unittest.TestCase):
    def wait(self, ready_at, previous=None, foreign=False, dead=False):
        clock=[0.0]
        def sleep(seconds): clock[0]+=seconds
        def request(*args):
            if dead: raise control.Refused('service_not_running')
            if foreign: raise control.Refused('supervised_peer_mismatch')
            if clock[0]<ready_at:
                if previous: return ({'instance':previous},4000)
                raise FileNotFoundError('starting')
            return ({'instance':'new'},4000)
        with patch.object(control.time,'monotonic',side_effect=lambda:clock[0]), patch.object(control.time,'sleep',side_effect=sleep), \
                patch.object(control,'request',side_effect=request), patch.object(control,'supervisor_pid',return_value=4000), \
                patch.object(control,'validated_hello',side_effect=lambda cfg,answer,home:answer):
            try:return control.wait_for_hello({},Path('/synthetic'),previous_instance=previous),clock[0]
            finally:self.assertIsNone(control._HELLO_DEADLINE.get())

    def test_first_start_accepts_97_seconds(self):
        answer,elapsed=self.wait(97); self.assertEqual(answer[0]['instance'],'new'); self.assertEqual(elapsed,97)
    def test_restart_waits_for_new_instance_for_97_seconds(self):
        answer,elapsed=self.wait(97,previous='old');self.assertEqual(answer[0]['instance'],'new');self.assertEqual(elapsed,97)
    def test_still_starting_remains_bounded(self):
        with self.assertRaisesRegex(control.Refused,'control_reply_timeout'):self.wait(181)
    def test_dead_unit_fails_without_waiting(self):
        with self.assertRaisesRegex(control.Refused,'service_not_running'):self.wait(97,dead=True)
    def test_wrong_peer_is_never_retried(self):
        with self.assertRaisesRegex(control.Refused,'supervised_peer_mismatch'):self.wait(97,foreign=True)
    def test_cancelled_readiness_does_not_request(self):
        with patch.object(control,'request') as request,self.assertRaisesRegex(control.Refused,'readiness_cancelled'):
            control.wait_for_hello({},Path('/synthetic'),cancelled=lambda:True)
        request.assert_not_called()
    def test_parent_budgets_cover_child_waits(self):
        self.assertGreater(install.BOOTSTRAP_TIMEOUT,2*control.HELLO_READY_SECONDS+50+45)
        self.assertGreater(install.OPEN_TIMEOUT,control.HELLO_READY_SECONDS+10)

class TunnelTests(unittest.TestCase):
    control_context = test_frontdoor.BoundaryTests.control_context

    def test_tunnel_does_not_mint_a_code(self):
        with self.control_context('tunnel', lambda *a: self.fail('tunnel must not issue hello or signin')) as (_, _, requests, opener, out):
            self.assertEqual(control.main(), 0)
            requests.assert_not_called(); opener.assert_not_called()
            self.assertIn('127.0.0.1:8701:127.0.0.1:8700', out.getvalue())
            self.assertIn('within 60 seconds', out.getvalue())

class ResumeTests(unittest.TestCase):
    def fixture(self,home):
        cat=catalogue();instance=install.Installer(home,cat,home)
        instance.root.mkdir(parents=True,mode=0o700)
        for name in ('logs','releases','data','cache'):(instance.root/name).mkdir(mode=0o700)
        runtime=instance.root/'releases/test-1'; instance.begin_progress(runtime)
        app=runtime/'app';app.mkdir();(app/'source.txt').write_bytes(b'reviewed')
        cat['platforms'][__import__('platform').machine()]['source_payload']['files']=[row('source.txt',b'reviewed')]
        python=runtime/'venv/bin/python';python.parent.mkdir(parents=True);python.write_bytes(b'never executed')
        lib=runtime/'runtime/python/lib';lib.mkdir(parents=True)
        (home/'.config/systemd/user').mkdir(parents=True)
        install.owned_file(home,'unit',b'synthetic unit')
        install.owned_file(home,'state',json.dumps({'python':str(python)}).encode())
        cfg={'runtime_root':str(runtime),'release_root':str(app),'python':str(python),'libpython_dir':str(lib),
             'data_dir':str(instance.root/'data'),'source_revision':cat['source_revision']}
        install.atomic_json(instance.root/'runtime.json',cfg)
        (instance.root/'data/sentinel').write_bytes(b'keep');(instance.root/'cache/sentinel').write_bytes(b'keep')
        return instance,app

    def test_resumes_without_package_or_build_commands(self):
        with tempfile.TemporaryDirectory() as d:
            instance,app=self.fixture(Path(d))
            with patch.object(instance,'run') as run,patch.object(instance,'complete_setup') as complete,patch.object(install,'control_env',return_value={}):
                instance.resume_setup()
            complete.assert_called_once()
            self.assertEqual([x.args[0][2] for x in run.call_args_list],['daemon-reload','enable','start'])
            self.assertTrue(all(x.args[0][0]=='/usr/bin/systemctl' for x in run.call_args_list))
            self.assertEqual((instance.root/'data/sentinel').read_bytes(),b'keep')
            self.assertEqual((instance.root/'cache/sentinel').read_bytes(),b'keep')

    def test_changed_source_or_entrypoint_blocks_resume_before_commands(self):
        for target in ('source','shim','identity','revision'):
            with self.subTest(target=target),tempfile.TemporaryDirectory() as d:
                instance,app=self.fixture(Path(d))
                if target=='source':(app/'source.txt').write_bytes(b'changed')
                elif target=='shim':(instance.home/'.local/bin/omegahive').write_bytes(b'changed')
                else:
                    p=instance.root/'install-progress.json';v=json.loads(p.read_text())
                    if target=='identity':v['runtime_identity']['inode']+=1
                    else:v['source_revision']='f'*40
                    install.atomic_json(p,v)
                with patch.object(instance,'run') as run,patch.object(instance,'complete_setup') as complete,self.assertRaises(install.Refused):
                    instance.resume_setup()
                run.assert_not_called();complete.assert_not_called()
                self.assertTrue((instance.root/'install-progress.json').exists())

    def test_unsafe_config_is_reported_before_preflight_or_sudo(self):
        with tempfile.TemporaryDirectory() as d:
            home=Path(d);(home/'.config').mkdir();(home/'.config').chmod(0o775)
            instance=install.Installer(home,{},home)
            with patch.object(install,'preflight') as preflight,patch.object(instance,'sudo') as sudo,self.assertRaisesRegex(install.Refused,r'\.config'):
                instance.install()
            preflight.assert_not_called();sudo.assert_not_called()

    def test_browser_failure_does_not_undo_completed_setup(self):
        instance=install.Installer(Path('/synthetic'),catalogue(),Path('/synthetic'))
        events=[]
        with patch.object(instance,'local',return_value=Path('/synthetic/helper')),patch.object(instance,'run'), \
                patch.object(instance,'finish_progress',side_effect=lambda:events.append('complete')), \
                patch.object(instance,'open_after_install',side_effect=install.Refused('browser')):
            with self.assertRaises(install.Refused):instance.complete_setup(Path('/app'),Path('/python'),Path('/lib'))
        self.assertEqual(events,['complete'])
    def test_bootstrap_failure_keeps_incomplete_record(self):
        instance=install.Installer(Path('/synthetic'),catalogue(),Path('/synthetic'))
        with patch.object(instance,'local',return_value=Path('/synthetic/helper')),patch.object(instance,'run',side_effect=install.Refused('bootstrap')), \
                patch.object(instance,'finish_progress') as finish:
            with self.assertRaises(install.Refused):instance.complete_setup(Path('/app'),Path('/python'),Path('/lib'))
        finish.assert_not_called()

class IncompleteStatusTests(unittest.TestCase):
    def test_incomplete_activated_install_can_report_status_without_starting(self):
        with tempfile.TemporaryDirectory() as d:
            home=Path(d); paths=installed_fixture(home)
            (paths['root']/'install-progress.json').write_text('{}')
            with patch.object(install,'control_env',return_value={}), patch.object(install.subprocess,'run') as run:
                run.return_value.returncode=0
                self.assertEqual(install.manage('status',home,json_output=True),0)
            self.assertEqual(run.call_count,1)
            self.assertEqual(run.call_args.args[0][-2:],['status','--json'])
            self.assertTrue((paths['root']/'install-progress.json').exists())

    def test_incomplete_open_refuses_without_minting_or_starting(self):
        with tempfile.TemporaryDirectory() as d:
            home=Path(d); paths=installed_fixture(home)
            (paths['root']/'install-progress.json').write_text('{}')
            with patch.object(install.subprocess,'run') as run, self.assertRaisesRegex(install.Refused,'same installer'):
                install.manage('open',home)
            run.assert_not_called()

class CleanupTests(unittest.TestCase):
    def test_snapshot_counts_other_process_groups_in_same_session(self):
        child_code='''import os,signal,time
child=os.fork()
if child==0:
 os.setpgrp()
 while True: time.sleep(1)
def stop(*_):
 os.kill(child,signal.SIGTERM);os.waitpid(child,0);raise SystemExit(0)
signal.signal(signal.SIGTERM,stop)
print('ready',flush=True)
while True: time.sleep(1)
'''
        p=subprocess.Popen([sys.executable,'-I','-B','-c',child_code],start_new_session=True,stdout=subprocess.PIPE,text=True)
        try:
            self.assertEqual(p.stdout.readline().strip(),'ready')
            instance=install.Installer(Path('/synthetic'),{},Path.home());instance.log=io.BytesIO()
            with tempfile.TemporaryFile() as log:
                instance.log=log
                rows=instance.group_rows(p,time.monotonic()+3)
            self.assertEqual(len(rows),2)
            self.assertTrue(any(row[2]!=p.pid and row[3]==p.pid for row in rows))
        finally:
            p.terminate();p.wait(timeout=5);p.stdout.close()

if __name__=='__main__':unittest.main()
