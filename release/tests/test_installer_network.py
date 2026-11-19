#!/usr/bin/env python3
"""Purpose: run the installer's real Python-package step against interrupted and failed package downloads."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PackageNetworkTests(unittest.TestCase):
    def run_packages(self, failures):
        """Exercise the package step without downloading packages or building the rest of the hive."""
        source = (ROOT / 'install/macos/Install OmegaHive.command').read_text()
        section = source.split('PYLOCK=$SCRIPT_DIR/locks/python-$PLATFORM.txt\n', 1)[1]
        section = section.split('# Everything the release\'s hive asks for', 1)[0]
        with tempfile.TemporaryDirectory(prefix='installer-network-') as folder:
            work = Path(folder)
            (work / 'locks').mkdir()
            (work / 'locks/python-test.txt').write_text('# download: 1 MB\n')
            (work / 'logs').mkdir()
            (work / 'bin').mkdir()
            python = work / 'bin/python3.12'
            python.write_text('#!/bin/bash\nmkdir -p "$3/bin"\ntouch "$3/bin/python"\n')
            python.chmod(0o755)
            uv = work / 'bin/uv'
            uv.write_text('#!' + sys.executable + '\n' + '''import json, os, pathlib, sys
log = pathlib.Path(os.environ['NETWORK_CALLS'])
calls = json.loads(log.read_text()) if log.exists() else []
marker = pathlib.Path(os.environ['OH']) / 'venv/kept-between-attempts'
assert not calls or marker.exists(), 'retry recreated the virtual environment'
marker.touch()
calls.append({'retries': os.environ.get('UV_HTTP_RETRIES'), 'connect_timeout': os.environ.get('UV_HTTP_CONNECT_TIMEOUT'), 'timeout': os.environ.get('UV_HTTP_TIMEOUT'), 'args': sys.argv[1:]})
log.write_text(json.dumps(calls))
print('invented dropped connection')
sys.exit(47 if len(calls) <= int(os.environ['NETWORK_FAILURES']) else 0)
''')
            uv.chmod(0o755)
            env = dict(os.environ, OH=str(work), TOOLCHAIN=str(work), SCRIPT_DIR=str(work),
                       PLATFORM='test', REFRESH='0', NETWORK_CALLS=str(work / 'calls.json'),
                       NETWORK_FAILURES=str(failures), PATH=str(work / 'bin') + os.pathsep + os.environ['PATH'])
            prelude = '''set -euo pipefail
sha1() { printf 'locked-list\\n'; }
fetching() { :; }
fetched() { :; }
say() { printf '%s\\n' "$*"; }
sleep() { :; }
PYLOCK=$SCRIPT_DIR/locks/python-$PLATFORM.txt
'''
            result = subprocess.run(['/bin/bash', '-c', prelude + section], env=env,
                                    capture_output=True, text=True)
            calls = json.loads((work / 'calls.json').read_text())
            return result, calls, (work / 'logs/python-packages.log').read_text()

    def test_dropped_package_downloads_retry_without_recreating_the_environment(self):
        result, calls, log = self.run_packages(2)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr + log)
        self.assertEqual(len(calls), 3)
        for call in calls:
            self.assertGreater(int(call['retries']), 3)
            self.assertGreater(int(call['connect_timeout']), 10)
            self.assertGreater(int(call['timeout']), 30)
            self.assertIn('--require-hashes', call['args'])
            self.assertIn('--only-binary', call['args'])

    def test_exhausted_package_downloads_keep_the_failure_status_and_diagnostic(self):
        result, calls, log = self.run_packages(10)
        self.assertEqual(result.returncode, 47)
        self.assertEqual(len(calls), 3)
        self.assertIn('invented dropped connection', log)

    def test_a_successful_download_needs_one_attempt(self):
        result, calls, _ = self.run_packages(0)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
