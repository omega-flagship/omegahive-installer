"""A source release builds from the tracked tree (scripts/build_release.py): nothing tracked is a file the builder
refuses, a submodule's pin is left out instead of refused, and a generated or private file still stops the build."""
import importlib.util
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location('build_release', ROOT / 'scripts' / 'build_release.py')
build_release = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_release)

REQUIRED = ('.gitignore', '.dockerignore', '.gitattributes', '.github/workflows/ci.yml', '.tours/start.tour')


def git(repo, *args):
    subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)


class ReleaseNamesTests(unittest.TestCase):
    def repo(self, *files):
        """A new repository tracking what a release requires and the given files."""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        repo = Path(temp.name)
        git(repo, 'init', '-q')
        for name in REQUIRED + files:
            (repo / name).parent.mkdir(parents=True, exist_ok=True)
            (repo / name).write_text('x\n')
        git(repo, 'add', '-f', '.')
        return repo

    def test_this_tree_builds_a_release(self):
        names = build_release.release_names()
        self.assertIn('scripts/build_release.py', names)
        self.assertEqual([n for n in names if n.startswith('third_party/')], [])

    def test_a_submodule_pin_is_left_out(self):
        repo = self.repo('core-dependency.json')
        git(repo, 'update-index', '--add', '--cacheinfo', '160000,a6bd77859fa326b43bf924e6b65d327d17204376,third_party/Omega')
        self.assertEqual(build_release.release_names(repo), sorted(REQUIRED + ('core-dependency.json',)))

    def test_a_generated_or_private_file_stops_the_build(self):
        for name in ('hive/__pycache__/core.cpython-311.pyc', 'docs/.DS_Store', 'third_party/copied.py', '.env'):
            with self.subTest(name=name):
                with self.assertRaisesRegex(RuntimeError, 'Refusing generated/private file: ' + re.escape(name)):
                    build_release.release_names(self.repo(name))


if __name__ == '__main__':
    unittest.main()
