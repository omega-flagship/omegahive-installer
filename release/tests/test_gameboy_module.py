#!/usr/bin/env python3
"""Smoke tests for the optional Game Boy simulation organ."""

from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))


@unittest.skipUnless(importlib.util.find_spec("pyboy"), "pyboy optional dependency is not installed")
class GameBoyModuleTests(unittest.TestCase):
    def test_demo_rom_observe_step_and_screenshot(self):
        import gameboy

        loaded = gameboy.gb_load("demo")
        self.assertIn("GAMEBOY-LOADED", loaded)
        observed = gameboy.gb_observe()
        self.assertIn("GAMEBOY-OBSERVE", observed)
        self.assertIn("screenshot=", observed)
        before_hash = observed.split("screen_sha1=", 1)[1].split()[0]

        stepped = gameboy.gb_step("a start frames 20")
        self.assertIn("GAMEBOY-STEP", stepped)
        self.assertIn("buttons=a,start", stepped)
        after_hash = stepped.split("screen_sha1=", 1)[1].split()[0]
        self.assertNotEqual(before_hash, after_hash)

        screenshot = gameboy.gb_screenshot()
        self.assertIn("GAMEBOY-SCREENSHOT", screenshot)
        path = pathlib.Path(screenshot.split(maxsplit=1)[1])
        self.assertTrue(path.exists())

        trace = gameboy.gb_last_trace()
        self.assertIn("GameBoyActionTaken", trace)
        self.assertIn("GAMEBOY-STOPPED", gameboy.gb_stop())


if __name__ == "__main__":
    unittest.main(verbosity=2)
