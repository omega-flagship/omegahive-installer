#!/usr/bin/env python3
"""Smoke tests for the grounded body-container organ."""

from __future__ import annotations

import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))


class BodyContainerModuleTests(unittest.TestCase):
    def test_status_self_and_trace(self):
        import body_container

        status = body_container.body_container_status()
        self.assertIn("BODY-CONTAINER-STATUS", status)
        self.assertIn("omega-body-vm", status)

        atoms = body_container.body_container_self()
        self.assertIn("(BodyContainer omega-body-vm)", atoms)
        self.assertIn("(Embodies omega-body-vm agent-self)", atoms)

        launcher = body_container.body_container_launcher()
        self.assertIn("BODY-CONTAINER-LAUNCHER", launcher)

        trace = body_container.body_container_last_trace()
        self.assertIn("BodyContainer", trace)


if __name__ == "__main__":
    unittest.main(verbosity=2)
