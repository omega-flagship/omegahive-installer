#!/usr/bin/env python3
"""Regression checks for the energy/cost ledger membrane."""

import importlib
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


class EnergyTests(unittest.TestCase):
    def load_energy(self, memory_dir):
        sys.modules.pop("energy", None)
        with mock.patch.dict(os.environ, {"OMEGACLAW_MEMORY_DIR": str(memory_dir)}, clear=False):
            return importlib.import_module("energy")

    def test_budget_and_ledger_use_configured_memory_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            memory_dir = pathlib.Path(tmpdir)
            energy = self.load_energy(memory_dir)

            self.assertEqual(
                energy.set_energy_targets(1.25, 7.5, 30, "usd"),
                "ENERGY-TARGETS-SET currency=USD daily=1.250000 weekly=7.500000 monthly=30.000000",
            )
            event = energy.log_provider_call(
                "Test",
                "model-x",
                "llm",
                {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cost": 0.012345678},
            )

            self.assertEqual(event["cost_usd"], 0.01234568)
            self.assertTrue((memory_dir / "energy_budget.json").exists())
            self.assertTrue((memory_dir / "cost_ledger.jsonl").exists())
            status = energy.energy_status()
            self.assertIn("daily_target=1.250000", status)
            self.assertIn("last_model=model-x", status)

    def test_usage_without_provider_cost_is_visible_but_not_accounted(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            energy = self.load_energy(pathlib.Path(tmpdir))

            event = energy.log_provider_call(
                "Test",
                "model-y",
                "llm",
                {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16},
            )

            self.assertEqual(event["cost_usd"], 0.0)
            self.assertEqual(event["confidence"], "usage-no-cost")
            self.assertIn('"confidence": "usage-no-cost"', energy.cost_last_call())


if __name__ == "__main__":
    unittest.main()
