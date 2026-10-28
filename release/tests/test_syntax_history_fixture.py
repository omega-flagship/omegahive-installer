#!/usr/bin/env python3
"""Portable history replay for the syntax command membrane.

Live history replay is useful locally, but it cannot be part of an upstream
patch because memory is runtime state. This fixture keeps the same parser path
exercised with sanitized historic command shapes.
"""

import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

import helper_command_parser as parser  # noqa: E402
import helper_metta_syntax as metta  # noqa: E402
import replay_recent_syntax as replay  # noqa: E402


class SyntaxHistoryFixtureTests(unittest.TestCase):
    def test_sanitized_history_fixture_replays_without_syntax_failures(self):
        fixture = ROOT / "tests" / "fixtures" / "syntax_history_sample.metta"
        text = fixture.read_text(encoding="utf-8")
        commands = []
        for expr in replay.history_command_forms(text, recent_entries=0):
            raw = replay.sexpr_to_command_line(expr)
            if raw:
                commands.append(raw)

        self.assertGreaterEqual(len(commands), 6)
        for raw in commands:
            with self.subTest(raw=raw):
                parsed = parser.signature_balance_parentheses(raw)
                self.assertNotIn("(syntax-error ", parsed)
                self.assertEqual(metta.test_metta_expression(parsed), "METTA-SYNTAX-OK")


if __name__ == "__main__":
    unittest.main(verbosity=2)
