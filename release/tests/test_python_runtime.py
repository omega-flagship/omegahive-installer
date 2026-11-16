#!/usr/bin/env python3

import importlib
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


class PythonRuntimeTests(unittest.TestCase):
    def test_embedded_runtime_uses_configured_python_for_multiprocessing(self):
        runtime = importlib.import_module("python_runtime")
        with tempfile.TemporaryDirectory() as tmp:
            python = pathlib.Path(tmp) / "python"
            python.write_text("#!/bin/sh\n", encoding="utf-8")
            original_executable = sys.executable
            try:
                with mock.patch.dict(os.environ, {"OMEGACLAW_PYTHON_EXECUTABLE": str(python)}, clear=False):
                    with mock.patch.object(runtime.multiprocessing, "set_executable") as set_executable:
                        configured = runtime.configure_embedded_python_runtime()
                self.assertEqual(configured, str(python))
                self.assertEqual(sys.executable, str(python))
                set_executable.assert_called_once_with(str(python))
            finally:
                sys.executable = original_executable


if __name__ == "__main__":
    unittest.main()
