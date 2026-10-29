"""PTY integration tests: fake sudo, real detached children and cleanup; no privilege."""
import importlib.util
import io
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import tempfile
import termios
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('terminal_install', Path(__file__).with_name('install.py'))
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)

FAKE = r'''
import os, sys, termios, time
assert os.getsid(0) == os.getpid() == os.getpgrp()
assert os.isatty(0) and os.isatty(2)
assert not termios.tcgetattr(0)[3] & (termios.ECHO | termios.ECHONL)
os.write(2, b'PASSWORD-PROMPT\n')
value = sys.stdin.readline()
if not value:
    sys.exit(9)
assert value == 'synthetic-test-input\n'
if sys.argv[1] == 'timeout':
    time.sleep(30)
if sys.argv[1] == 'failure':
    sys.exit(7)
print('STEP-OK', flush=True)
'''

class TerminalTests(unittest.TestCase):
    def exercise(self, mode):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            pid, master = pty.fork()
            if pid == 0:
                try:
                    install.STOP = False
                    signal.signal(signal.SIGINT, install.stop_requested)
                    # Reproduce the shell wrapper's consumed/non-terminal stdin.
                    fd = os.open('/dev/null', os.O_RDONLY)
                    os.dup2(fd, 0); os.close(fd)
                    instance = install.Installer(root, {}, root)
                    original = subprocess.Popen
                    children = []
                    def launch(argv, **kwargs):
                        if argv[0] == '/usr/bin/sudo':
                            assert argv[:2] == ['/usr/bin/sudo', '-S']
                            argv = [sys.executable, '-I', '-B', '-c', FAKE, mode]
                        child = original(argv, **kwargs)
                        if '-c' in argv:
                            children.append(child.pid)
                        return child
                    outcome = 'ok'
                    with (root/'step.log').open('wb') as log, patch.object(install.subprocess, 'Popen', side_effect=launch):
                        instance.log = log
                        try:
                            for _ in range(3 if mode == 'success' else 1):
                                instance.sudo(['/usr/bin/true'], timeout=0.7 if mode == 'timeout' else 8)
                        except install.Refused as error:
                            outcome = str(error)
                    (root/'result.json').write_text(json.dumps({'outcome': outcome, 'children': children}))
                    os._exit(0)
                except BaseException:
                    import traceback
                    traceback.print_exc()
                    os._exit(2)
            before = termios.tcgetattr(master)
            data = bytearray(); answered = 0; status = None
            try:
                end = time.monotonic() + 15
                while time.monotonic() < end:
                    ready, _, _ = select.select([master], [], [], 0.05)
                    if ready:
                        try:
                            chunk = os.read(master, 65536)
                        except OSError:
                            chunk = b''
                        data.extend(chunk)
                        prompts = data.count(b'PASSWORD-PROMPT')
                        if prompts > answered:
                            answered = prompts
                            self.assertFalse(termios.tcgetattr(master)[3] & (termios.ECHO | termios.ECHONL))
                            if mode == 'cancel':
                                os.write(master, b'\x03')
                            elif mode == 'eof':
                                os.write(master, b'\x04')
                            else:
                                os.write(master, b'synthetic-test-input\n')
                    finished, status = os.waitpid(pid, os.WNOHANG)
                    if finished:
                        break
                else:
                    self.fail('PTY test exceeded deadline')
                self.assertEqual(os.waitstatus_to_exitcode(status), 0, data.decode(errors='replace'))
                self.assertEqual(termios.tcgetattr(master), before)
                self.assertNotIn(b'synthetic-test-input', data)
                log = (root/'step.log').read_bytes()
                self.assertNotIn(b'synthetic-test-input', log)
                self.assertNotIn(b'PASSWORD-PROMPT', log)
                result = json.loads((root/'result.json').read_text())
                for child in result['children']:
                    with self.assertRaises(ProcessLookupError):
                        os.kill(child, 0)
                if mode == 'success':
                    self.assertEqual(result['outcome'], 'ok')
                    self.assertEqual(answered, 3)
                    self.assertEqual(log.count(b'STEP-OK'), 3)
                else:
                    self.assertNotEqual(result['outcome'], 'ok')
            finally:
                if status is None:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                os.close(master)

    def test_three_prompts_with_consumed_stdin(self): self.exercise('success')
    def test_failed_authentication_restores_terminal(self): self.exercise('failure')
    def test_timeout_cleans_child_and_restores_terminal(self): self.exercise('timeout')
    def test_ctrl_c_cleans_child_and_restores_terminal(self): self.exercise('cancel')
    def test_eof_restores_terminal(self): self.exercise('eof')

    def test_no_terminal_fails_before_launch(self):
        instance = install.Installer(Path('/unused'), {}, Path('/unused'))
        with patch('builtins.open', side_effect=OSError('no controlling tty')), patch.object(instance, 'run') as run:
            with self.assertRaisesRegex(install.Refused, 'interactive terminal'):
                instance.sudo(['/usr/bin/true'], timeout=1)
        run.assert_not_called()

    def test_background_terminal_fails_before_launch(self):
        master, slave = pty.openpty()
        try:
            with os.fdopen(os.dup(slave), 'r+b', buffering=0) as terminal:
                instance = install.Installer(Path('/unused'), {}, Path('/unused'))
                with patch('builtins.open', return_value=terminal), patch.object(install.os, 'tcgetpgrp', return_value=-1), patch.object(instance, 'run') as run:
                    with self.assertRaisesRegex(install.Refused, 'foreground'):
                        instance.sudo(['/usr/bin/true'], timeout=1)
                    run.assert_not_called()
        finally:
            os.close(master); os.close(slave)

if __name__ == '__main__': unittest.main()
