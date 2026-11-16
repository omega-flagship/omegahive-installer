#!/usr/bin/env python3
"""Regression tests for the supervised terminal mirror."""

import pathlib
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
MIRROR = ROOT / "src" / "terminal_mirror.py"


class TerminalMirrorTests(unittest.TestCase):
    def test_mirror_strips_nulls_and_bounds_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = pathlib.Path(tmp) / "terminal.log"
            payload = b"alpha\x00\n" + (b"0123456789\n" * 40) + b"omega\x00\n"

            proc = subprocess.run(
                [sys.executable, str(MIRROR), str(log), "120"],
                input=payload,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )

            self.assertNotIn(b"\x00", proc.stdout)
            data = log.read_bytes()
            self.assertNotIn(b"\x00", data)
            self.assertLessEqual(len(data), 120)
            self.assertTrue(data.endswith(b"omega\n"))


if __name__ == "__main__":
    unittest.main()
