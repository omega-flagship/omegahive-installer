"""tests/ci-requirements.lock, which hive-ci's core-tests installs with pip --require-hashes, pins every package
tests/ci-requirements.txt names, at the version hive/ci-constraints.txt pins wherever it pins one, each with a hash.
A change to either file that leaves the lock behind fails here, so core-tests never tests other versions than the
constraints say. The lock's header has the command that regenerates it."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "tests" / "ci-requirements.lock"
PIN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\;]+)", re.M)
NAME = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)")


def canonical(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def pins(text):
    return {canonical(name): version for name, version in PIN.findall(text)}


class CiRequirementsLockTests(unittest.TestCase):
    def setUp(self):
        self.lock_text = LOCK.read_text(encoding="utf-8")
        self.lock = pins(self.lock_text)

    def test_every_requirement_is_locked(self):
        for line in (ROOT / "tests" / "ci-requirements.txt").read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                name = canonical(NAME.match(line).group(1))
                self.assertTrue(name in self.lock, f"{name} is not in {LOCK.name}; regenerate it (its header has the command)")

    def test_locked_versions_are_the_constraints(self):
        constraints = pins((ROOT / "hive" / "ci-constraints.txt").read_text(encoding="utf-8"))
        for name, version in self.lock.items():
            if name in constraints:
                self.assertEqual(version, constraints[name],
                                 f"{LOCK.name} has {name}=={version}, hive/ci-constraints.txt {constraints[name]}")

    def test_every_locked_package_has_a_hash(self):
        entries = re.split(r"^(?=[A-Za-z0-9])", self.lock_text, flags=re.M)
        for entry in entries:
            if PIN.match(entry):
                self.assertIn("--hash=sha256:", entry, entry.splitlines()[0])
        self.assertTrue(self.lock, f"{LOCK.name} pins nothing")


if __name__ == "__main__":
    unittest.main()
