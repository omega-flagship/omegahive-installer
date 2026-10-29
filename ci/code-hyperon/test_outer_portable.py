"""Only portable invented cgroup files and mocked admission; never systemd/Hyperon."""
import contextlib
import importlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import outer_gate


class OuterSourceControls(unittest.TestCase):
    def test_missing_post_stop_cgroup_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(outer_gate.census("invented.service", Path(tmp)), [])

    def test_census_includes_nested_descendants(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            unit = base / "invented.service"
            (unit / "child").mkdir(parents=True)
            (unit / "cgroup.procs").write_text("123\n")
            (unit / "child/cgroup.procs").write_text("456\n")
            self.assertEqual(outer_gate.census("invented.service", base), [123, 456])

    def test_malformed_census_cannot_pass_as_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            unit = Path(tmp) / "invented.service"
            unit.mkdir()
            (unit / "cgroup.procs").write_text("invented-invalid\n")
            with self.assertRaises(ValueError):
                outer_gate.census("invented.service", Path(tmp))

    def test_nonlinux_admission_starts_no_os_command(self):
        args = ["outer_gate.py", "--source-archive", "/invented/source.zip", "--wheel", "/invented/worker.whl",
                "--worker-python", "/invented/worker/bin/python", "--worker-root", "/invented/worker",
                "--receipt", "/invented/receipt.json", "--architecture", "x86_64"]
        output = io.StringIO()
        with patch.object(sys, "argv", args), patch.object(outer_gate.os, "geteuid", return_value=0), \
             patch.object(outer_gate.platform, "system", return_value="Darwin"), \
             patch.object(outer_gate, "command") as command, contextlib.redirect_stdout(output):
            self.assertEqual(outer_gate.main(), 2)
        command.assert_not_called()
        self.assertFalse(json.loads(output.getvalue())["ok"])

    def test_native_cases_import_has_no_hyperon_import(self):
        prior = {name for name in sys.modules if name == "hyperon" or name.startswith("hyperon.") or name == "hyperonpy"}
        native = importlib.import_module("native_cases")
        after = {name for name in sys.modules if name == "hyperon" or name.startswith("hyperon.") or name == "hyperonpy"}
        self.assertEqual(prior, after)
        self.assertEqual(len(native.CHECK_IDS), 9)


if __name__ == "__main__":
    unittest.main()
