#!/usr/bin/env python3
"""Purpose: run the Mac and Windows installer's own code-folder swap (the block of install/macos/Install
OmegaHive.command that copies a release into $OH/app) on stand-in folders: an update carries the logins the old code
folder held to the data folder's connectors folder before deleting it, an old folder a stopped run left goes back in
place and is carried the same way, one that can be put in neither place stops the setup with the old folder kept, and
a fresh install makes no connectors folder."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / 'install/macos/Install OmegaHive.command'
LOGIN = 'memory/home_assistant.json'
PAIRING = 'modules/channel_whatsapp/src/whatsapp_bridge/auth/creds.json'
# The bridge's own code beside the pairing folder, which the pairing glob *auth* also names: every release ships it.
BRIDGE_CODE = 'modules/channel_whatsapp/src/whatsapp_bridge/hive-auth.mjs'


def swap_block():
    """The installer's copy step, from its `if` to the `fi` that closes it, as the installer runs it."""
    source = INSTALLER.read_text()
    start = source.index('if [ "$SRC" != "$OH/app" ]; then\n')
    return source[start:source.index('\nfi\n', start) + len('\nfi\n')]


def lay_out(base, files):
    for rel, text in files.items():
        path = base / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return base


class CodeSwapTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='installer-swap-')
        work = Path(self.folder.name)
        self.oh, self.src = work / 'OmegaHive', work / 'release'
        lay_out(self.src, {'RELEASE_COMMIT': 'new\n', BRIDGE_CODE: '// new\n', 'hive/core/connector_files.py':
                           (ROOT / 'hive/core/connector_files.py').read_text()})
        python = work / 'toolchain/bin/python3.12'
        python.parent.mkdir(parents=True)
        python.symlink_to(sys.executable)
        self.toolchain = python.parent.parent
        self.oh.mkdir()

    def tearDown(self):
        self.folder.cleanup()

    def install(self):
        """The swap block in bash with the installer's own settings: set -euo pipefail, OS Linux (cp -pR, as WSL)."""
        script = ('set -euo pipefail\nunquarantine() { :; }\nREFRESH=0\nOS=Linux\n' + swap_block())
        env = dict(os.environ, OH=str(self.oh), SRC=str(self.src), TOOLCHAIN=str(self.toolchain))
        return subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True)

    def old_release(self, where):
        return lay_out(self.oh / where, {'RELEASE_COMMIT': 'old\n', LOGIN: '{"token": "ha-old"}', PAIRING: '{"k": 1}',
                                         BRIDGE_CODE: '// old\n'})

    def assertCarried(self, run):
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual((self.oh / 'app/RELEASE_COMMIT').read_text(), 'new\n')
        self.assertFalse((self.oh / 'app.old').exists())
        self.assertEqual((self.oh / 'data/connectors' / LOGIN).read_text(), '{"token": "ha-old"}')
        self.assertEqual((self.oh / 'data/connectors' / PAIRING).read_text(), '{"k": 1}')
        self.assertFalse((self.oh / 'app' / LOGIN).exists())
        self.assertFalse((self.oh / 'data/connectors' / BRIDGE_CODE).exists())     # code goes with the old folder
        self.assertEqual((self.oh / 'app' / BRIDGE_CODE).read_text(), '// new\n')

    def test_an_update_carries_the_old_code_folders_logins_to_the_connectors_folder(self):
        self.old_release('app')
        (self.oh / 'data').mkdir()
        self.assertCarried(self.install())

    def test_an_old_folder_a_run_stopped_between_the_renames_left_goes_back_and_is_carried(self):
        self.old_release('app.old')                    # app moved aside, the new code not yet in place
        self.assertCarried(self.install())

    def test_a_stale_old_folder_beside_the_current_code_is_carried_before_the_swap(self):
        self.old_release('app.old')
        lay_out(self.oh / 'app', {'RELEASE_COMMIT': 'between\n'})     # the release a stopped run had put in place
        self.assertCarried(self.install())

    def test_a_login_neither_place_can_take_stops_the_setup_and_keeps_the_old_folder(self):
        self.old_release('app')
        lay_out(self.oh / 'data/connectors', {LOGIN: '{"token": "carried-before"}'})
        lay_out(self.src, {LOGIN: '{"token": "in-the-release"}'})
        run = self.install()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn(f'kept {LOGIN} in {self.oh / "app.old"}', run.stdout)
        self.assertEqual((self.oh / 'app.old' / LOGIN).read_text(), '{"token": "ha-old"}')
        self.assertEqual((self.oh / 'data/connectors' / PAIRING).read_text(), '{"k": 1}')

    def test_a_fresh_install_makes_no_connectors_folder(self):
        run = self.install()
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual((self.oh / 'app/RELEASE_COMMIT').read_text(), 'new\n')
        self.assertFalse((self.oh / 'data').exists())
        self.assertEqual(run.stdout, '')


if __name__ == '__main__':
    unittest.main()
