#!/usr/bin/env python3
"""Focused tests for the pure Assume symbolic graph engine."""

import json
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import assume  # noqa: E402


class AssumeEngineTests(unittest.TestCase):
    def test_dense_assumption_flips_after_feedback(self):
        edges = [
            ["house", "movie", "yellow", 0.48],
            ["house", "movie", "bright", 0.58],
        ]
        feedback = [
            ["house", "movie", "yellow", 0.24, "approved", "approved"],
            ["house", "movie", "bright", -0.22, "rejected", "rejected"],
        ]

        result = assume.assume_step("house", "movie", json.dumps(edges), json.dumps(feedback))

        self.assertIn("(AssumeBestBefore house movie bright 0.58)", result)
        self.assertIn("(AssumeBestAfter house movie yellow 0.72)", result)
        self.assertIn("(AssumeError house movie bright rejected rejected 0.22)", result)

    def test_feature_graph_audit_reports_usable_when_supported(self):
        atoms = """
        ((AssumeContextFeature house movie watching 0.9 0.9 observation)
         (AssumeAction house yellow lighting)
         (AssumeFeatureEdge house watching yellow 0.72 0.82 5)
         (AssumeOutcome house movie yellow approved ok 0.8))
        """

        result = assume.assume_audit("house", "movie", "yellow", atoms)

        self.assertIn("(Verdict usable-assumption)", result)
        self.assertIn("(NALTruth (stv 1", result)

    def test_invalid_numeric_atoms_return_input_error(self):
        atoms = """
        ((AssumeContextFeature house movie watching nope 0.9 observation)
         (AssumeAction house yellow lighting))
        """

        result = assume.assume_feature_step("house", "movie", atoms, "dense")

        self.assertIn("AssumeInputError", result)

    def test_quoted_parentheses_in_natural_labels_round_trip(self):
        atoms = """
        ((AssumeContextFeature house ctx "watching (movie)" 0.8 0.8 observation)
         (AssumeAction house "warm (soft)" lighting)
         (AssumeFeatureEdge house "watching (movie)" "warm (soft)" 0.7 0.8 2))
        """

        context, actions, edges, feedback = assume.atomspace_feature_graph(atoms, "house", "ctx")
        audit = assume.assume_audit("house", "ctx", "warm (soft)", atoms)

        self.assertEqual("watching (movie)", context[0].feature)
        self.assertIn("warm (soft)", actions)
        self.assertEqual("warm (soft)", edges[0].action)
        self.assertEqual([], feedback)
        self.assertIn('"warm (soft)"', audit)
        self.assertNotIn("(Verdict no-context)", audit)

    def test_nested_or_malformed_atoms_are_ignored_not_executed(self):
        atoms = """
        ((AssumeContextFeature house ctx feature 0.8 0.8 observation)
         (AssumeAction house action lighting)
         (AssumeFeatureEdge house feature action 0.4 0.6 1)
         (AssumeFeatureEdge house feature evil-action (shell rm -rf /) 0.9 99))
        """

        result = assume.assume_feature_step("house", "ctx", atoms, "dense")

        self.assertIn("AssumeBest", result)
        self.assertNotIn("shell", result)


if __name__ == "__main__":
    unittest.main()
