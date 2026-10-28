#!/usr/bin/env python3
"""Tests for the experimental Assume dynamics boundary."""

import json
import math
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
ASSUME_SRC = ROOT / "modules" / "assume" / "src"
sys.path.insert(0, str(ASSUME_SRC))

import assume  # noqa: E402
import assume_client  # noqa: E402

FABRIC_PYTHON = pathlib.Path(
    os.environ.get(
        "FABRICPC_PYTHON",
        str(ROOT.parent / "FabricPC" / ".venv" / "bin" / "python"),
    )
)


class AssumeDynamicsTests(unittest.TestCase):
    def test_habitat_control_assumption_flips_after_feedback(self):
        edges = [
            ["house", "resident-movie-evening", "yellow-moody-scene", 0.48],
            ["house", "resident-movie-evening", "bright-practical-scene", 0.58],
            ["house", "resident-movie-evening", "ask-before-changing", 0.52],
        ]
        feedback = [
            ["house", "resident-movie-evening", "yellow-moody-scene", 0.24, "resident-approved-movie-lighting", "approved"],
            ["house", "resident-movie-evening", "bright-practical-scene", -0.22, "too-bright-for-movie", "rejected"],
        ]

        result = assume.assume_step(
            "house",
            "resident-movie-evening",
            json.dumps(edges),
            json.dumps(feedback),
        )

        self.assertIn("(Engine dense-list-fabric-compatible)", result)
        self.assertIn("(AssumeBestBefore house resident-movie-evening bright-practical-scene 0.58)", result)
        self.assertIn("(AssumeBestAfter house resident-movie-evening yellow-moody-scene 0.72)", result)
        self.assertIn("(AssumeUpdatedEdge house resident-movie-evening bright-practical-scene 0.36)", result)
        self.assertIn("(AssumeOutcome house resident-movie-evening yellow-moody-scene approved", result)
        self.assertIn("(AssumeError house resident-movie-evening bright-practical-scene rejected", result)

    def test_strengths_are_clamped(self):
        edges = [["house", "test", "action", 0.95]]
        feedback = [["house", "test", "action", 0.5, "large-reinforcement", "approved"]]
        result = assume.assume_step("house", "test", json.dumps(edges), json.dumps(feedback))
        self.assertIn("(AssumeBestAfter house test action 1)", result)

    def test_fabricpc_backend_reports_unavailable_without_dependency(self):
        edges = json.dumps([
            ["habitat", "movie-evening", "soft-scene", 0.48],
            ["habitat", "movie-evening", "bright-scene", 0.58],
            ["habitat", "movie-evening", "ask-first", 0.52],
        ])
        feedback = json.dumps([
            ["habitat", "movie-evening", "soft-scene", 0.24, "resident-approved", "approved"],
            ["habitat", "movie-evening", "bright-scene", -0.22, "too-bright", "rejected"],
        ])
        result = assume.assume_step_fabricpc("habitat", "movie-evening", edges, feedback)
        if "AssumeBackendUnavailable" in result:
            self.assertIn("fabricpc-jax", result)
        else:
            self.assertIn("(Engine fabricpc-jax)", result)
            self.assertIn("(AssumeBestBefore habitat movie-evening bright-scene 0.58)", result)
            self.assertIn("AssumeBestAfter habitat movie-evening soft-scene", result)

    def test_atomspace_repr_can_drive_assume_step(self):
        atoms = """
        ((AssumeContextFeature house resident-movie-evening resident-watching-movie 0.95)
         (AssumeContextFeature house resident-movie-evening evening 0.8)
         (AssumeEdge house resident-movie-evening yellow-moody-scene 0.48)
         (AssumeEdge house resident-movie-evening bright-practical-scene 0.58)
         (AssumeEdge house resident-movie-evening ask-before-changing 0.52)
         (AssumeOutcome house resident-movie-evening yellow-moody-scene approved resident-approved-movie-lighting 0.24)
         (AssumeError house resident-movie-evening bright-practical-scene rejected too-bright-for-movie 0.22))
        """
        result = assume.assume_step_from_atoms("house", "resident-movie-evening", atoms, "dense")
        self.assertIn("(Engine dense-list-fabric-compatible)", result)
        self.assertIn("(AssumeBestBefore house resident-movie-evening bright-practical-scene 0.58)", result)
        self.assertIn("(AssumeBestAfter house resident-movie-evening yellow-moody-scene 0.72)", result)

    def test_feature_graph_can_drive_assumption(self):
        atoms = """
        ((AssumeContextFeature house resident-movie-evening resident-watching-movie 0.95 0.9 observation)
         (AssumeContextFeature house resident-movie-evening evening 0.8 0.8 clock)
         (AssumeAction house yellow-moody-scene lighting)
         (AssumeAction house bright-practical-scene lighting)
         (AssumeFeatureEdge house resident-watching-movie yellow-moody-scene 0.50 0.7 2)
         (AssumeFeatureEdge house resident-watching-movie bright-practical-scene 0.60 0.7 2)
         (AssumeFeatureEdge house evening yellow-moody-scene 0.45 0.6 1)
         (AssumeFeatureEdge house evening bright-practical-scene 0.56 0.6 1)
         (AssumeOutcome house resident-movie-evening yellow-moody-scene approved resident-approved-movie-lighting 0.24)
         (AssumeError house resident-movie-evening bright-practical-scene rejected too-bright-for-movie 0.22))
        """
        result = assume.assume_feature_step("house", "resident-movie-evening", atoms, "dense")
        self.assertIn("(Engine dense-feature-fabric-compatible)", result)
        self.assertIn("AssumeBestBefore house resident-movie-evening bright-practical-scene", result)
        self.assertIn("AssumeBestAfter house resident-movie-evening yellow-moody-scene", result)
        self.assertIn("AssumeUpdatedFeatureEdge house resident-watching-movie yellow-moody-scene", result)

    def test_invalid_numeric_atoms_are_rejected_not_crashed(self):
        atoms = """
        ((AssumeContextFeature house ctx feature nope 0.9 observation)
         (AssumeAction house action lighting)
         (AssumeFeatureEdge house feature action nan 0.7 1))
        """
        result = assume.assume_feature_step("house", "ctx", atoms, "dense")
        self.assertIn("AssumeInputError", result)

    def test_metta_special_chars_are_quoted_on_output(self):
        result = assume.assume_step(
            "house domain",
            "ctx",
            json.dumps([["house domain", "ctx", "action with space", 0.4]]),
            "[]",
        )
        self.assertIn('"house domain"', result)
        self.assertIn('"action with space"', result)

    def test_feature_graph_size_cap_prevents_explosion(self):
        features = "\n".join(
            f"(AssumeContextFeature house ctx feature-{idx} 0.5 0.8 test)"
            for idx in range(80)
        )
        actions = "\n".join(
            f"(AssumeAction house action-{idx} lighting)"
            for idx in range(80)
        )
        result = assume.assume_feature_step("house", "ctx", f"({features} {actions})", "dense")
        self.assertIn("AssumeInputError", result)

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

    def test_quoted_symbolic_names_with_spaces_survive(self):
        atoms = """
        ((AssumeContextFeature house ctx "watching tv" 0.8 0.8 observation)
         (AssumeAction house "warm white lights" lighting)
         (AssumeFeatureEdge house "watching tv" "warm white lights" 0.4 0.6 1))
        """
        result = assume.assume_feature_step("house", "ctx", atoms, "dense")
        self.assertIn('"warm white lights"', result)
        self.assertIn('"watching tv"', result)

    def test_atom_symbol_escapes_control_characters_on_one_line(self):
        symbol = assume._atom_symbol('line one\nline two\t"quoted"')
        self.assertNotIn("\n", symbol)
        self.assertIn("\\n", symbol)
        self.assertIn("\\t", symbol)
        self.assertIn('\\"quoted\\"', symbol)
        self.assertEqual(
            assume._split_metta_tokens(symbol)[0],
            'line one\nline two\t"quoted"',
        )

    def test_assume_client_atom_text_uses_canonical_atom_writer(self):
        cases = {
            "family-care": "family-care",
            "sleep:transition": "sleep:transition",
            "睡眠": "睡眠",
            "quiet mode": '"quiet mode"',
            'quote"inside': '"quote\\"inside"',
            "line one\nline two": '"line one\\nline two"',
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(assume_client.atom_text(value), expected)

    def test_sparse_feature_graph_does_not_create_hidden_edges(self):
        atoms = """
        ((AssumeContextFeature house ctx f1 1.0 0.8 observation)
         (AssumeContextFeature house ctx f2 1.0 0.8 observation)
         (AssumeAction house action-a lighting)
         (AssumeAction house action-b lighting)
         (AssumeFeatureEdge house f1 action-a 0.8 0.7 2)
         (AssumeFeatureEdge house f2 action-b 0.2 0.7 2)
         (AssumeOutcome house ctx action-b approved test 0.2))
        """
        result = assume.assume_feature_step("house", "ctx", atoms, "dense")
        self.assertIn("(AssumeUpdatedFeatureEdge house f1 action-a", result)
        self.assertIn("(AssumeUpdatedFeatureEdge house f2 action-b", result)
        self.assertNotIn("(AssumeUpdatedFeatureEdge house f1 action-b", result)
        self.assertNotIn("(AssumeUpdatedFeatureEdge house f2 action-a", result)

    def test_fabric_feature_graph_preserves_sparse_edge_surface(self):
        atoms = """
        ((AssumeContextFeature house ctx f1 1.0 0.8 observation)
         (AssumeContextFeature house ctx f2 1.0 0.8 observation)
         (AssumeAction house action-a lighting)
         (AssumeAction house action-b lighting)
         (AssumeFeatureEdge house f1 action-a 0.8 0.7 2)
         (AssumeFeatureEdge house f2 action-b 0.2 0.7 2)
         (AssumeOutcome house ctx action-b approved test 0.2))
        """
        result = assume.assume_feature_step("house", "ctx", atoms, "fabricpc")
        self.assertIn("AssumeFeatureStepResult", result)
        self.assertIn("(AssumeUpdatedFeatureEdge house f1 action-a", result)
        self.assertIn("(AssumeUpdatedFeatureEdge house f2 action-b", result)
        self.assertNotIn("(AssumeUpdatedFeatureEdge house f1 action-b", result)
        self.assertNotIn("(AssumeUpdatedFeatureEdge house f2 action-a", result)
        self.assertNotIn("use-house-affordance", result)

    def test_guard_reports_usable_assumption_when_well_supported(self):
        atoms = """
        ((AssumeContextFeature house movie-night resident-watching-movie 0.9 0.9 observation)
         (AssumeContextFeature house movie-night evening 0.8 0.8 clock)
         (AssumeAction house yellow-moody-scene lighting)
         (AssumeFeatureEdge house resident-watching-movie yellow-moody-scene 0.72 0.82 5)
         (AssumeFeatureEdge house evening yellow-moody-scene 0.69 0.75 4)
         (AssumeOutcome house movie-night yellow-moody-scene approved resident-approved 0.8))
        """
        result = assume.assume_audit("house", "movie-night", "yellow-moody-scene", atoms)
        self.assertIn("(AssumeGuardReport house movie-night yellow-moody-scene", result)
        self.assertIn("(Verdict usable-assumption)", result)
        self.assertIn("(NALTruth (stv 1", result)

    def test_guard_reports_thin_context_when_active_features_are_uncovered(self):
        atoms = """
        ((AssumeContextFeature house movie-night resident-watching-movie 0.8 0.9 observation)
         (AssumeContextFeature house movie-night unknown-visitor 1.0 0.6 observation)
         (AssumeAction house yellow-moody-scene lighting)
         (AssumeFeatureEdge house resident-watching-movie yellow-moody-scene 0.72 0.82 5))
        """
        result = assume.assume_audit("house", "movie-night", "yellow-moody-scene", atoms)
        self.assertIn("(Verdict thin-context)", result)
        self.assertIn("(Reason active-features-poorly-covered)", result)

    def test_guard_reports_ask_or_observe_for_low_evidence(self):
        atoms = """
        ((AssumeContextFeature house movie-night resident-watching-movie 0.9 0.9 observation)
         (AssumeAction house yellow-moody-scene lighting)
         (AssumeFeatureEdge house resident-watching-movie yellow-moody-scene 0.72 0.3 0))
        """
        result = assume.assume_audit("house", "movie-night", "yellow-moody-scene", atoms)
        self.assertIn("(Verdict ask-or-observe)", result)
        self.assertIn("(Reason low-confidence-or-low-evidence)", result)

    def test_guard_reports_error_pressure_for_recent_negative_evidence(self):
        atoms = """
        ((AssumeContextFeature house movie-night resident-watching-movie 0.9 0.9 observation)
         (AssumeAction house bright-practical-scene lighting)
         (AssumeFeatureEdge house resident-watching-movie bright-practical-scene 0.72 0.82 5)
         (AssumeError house movie-night bright-practical-scene rejected too-bright 0.4))
        """
        result = assume.assume_audit("house", "movie-night", "bright-practical-scene", atoms)
        self.assertIn("(Verdict error-pressure)", result)
        self.assertIn("(Reason recent-negative-evidence)", result)

    def test_guard_reports_no_context(self):
        atoms = "((AssumeAction house yellow-moody-scene lighting))"
        result = assume.assume_audit("house", "movie-night", "yellow-moody-scene", atoms)
        self.assertIn("(Verdict no-context)", result)

    def test_guard_reports_input_error_without_throwing(self):
        atoms = """
        ((AssumeContextFeature house movie-night feature nope 0.9 observation)
         (AssumeAction house yellow-moody-scene lighting))
        """
        result = assume.assume_audit("house", "movie-night", "yellow-moody-scene", atoms)
        self.assertIn("(Verdict input-error)", result)

    def test_persist_evidence_atom_appends_once(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "assume.metta"
            trace_path = pathlib.Path(tmpdir) / "assume_trace.metta"
            atom = '(AssumeOutcome house ctx action approved "worked: with colon" 0.8)'
            old_trace_path = assume_client.TRACE_PATH

            try:
                assume_client.TRACE_PATH = trace_path
                first = assume_client.persist_evidence_atom(atom, str(path))
                second = assume_client.persist_evidence_atom(atom, str(path))
            finally:
                assume_client.TRACE_PATH = old_trace_path

            self.assertIn("ASSUME-EVIDENCE-PERSISTED", first)
            self.assertIn("duplicate=false", first)
            self.assertIn("duplicate=true", second)
            self.assertEqual(path.read_text(encoding="utf-8").count(atom), 1)
            self.assertFalse(trace_path.exists())

    def test_canonical_evidence_persist_records_mutation_trace(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "assume.metta"
            trace_path = pathlib.Path(tmpdir) / "assume_trace.metta"
            atom = '(AssumeOutcome house ctx action approved "worked: with colon" 0.8)'
            old_assume_path = assume_client.ASSUME_PATH
            old_trace_path = assume_client.TRACE_PATH
            try:
                assume_client.ASSUME_PATH = path
                assume_client.TRACE_PATH = trace_path
                result = assume_client.persist_evidence_atom(atom)
            finally:
                assume_client.ASSUME_PATH = old_assume_path
                assume_client.TRACE_PATH = old_trace_path

            self.assertIn("ASSUME-EVIDENCE-PERSISTED", result)
            self.assertIn("trace=", result)
            trace_text = trace_path.read_text(encoding="utf-8")
            self.assertIn("AssumeMutationTrace", trace_text)
            self.assertIn(atom, trace_text)

    def test_persist_evidence_atom_rejects_non_evidence(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "assume.metta"
            result = assume_client.persist_evidence_atom(
                "(AssumeFeatureEdge house feature action 0.5 0.5 1)",
                str(path),
            )
            self.assertIn("ASSUME-EVIDENCE-PERSIST-ERROR", result)
            self.assertFalse(path.exists())

    def test_parseable_persist_result_atoms_distinguish_success_and_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "assume.metta"
            good_structural = assume_client.persist_structural_atom_result(
                "(AssumeAction house action lighting)",
                "AssumeAction",
                str(path),
            )
            bad_structural = assume_client.persist_structural_atom_result(
                "(AssumeFeatureEdge house feature action nope 0.6 1)",
                "AssumeFeatureEdge",
                str(path),
            )
            good_evidence = assume_client.persist_evidence_atom_result(
                "(AssumeOutcome house ctx action approved worked 0.8)",
                str(path),
            )
            bad_evidence = assume_client.persist_evidence_atom_result(
                "(AssumeAction house action lighting)",
                str(path),
            )

            self.assertIn("(AssumeStructuralPersisted AssumeAction", good_structural)
            self.assertIn("(AssumeStructuralPersistError AssumeFeatureEdge", bad_structural)
            self.assertIn("(AssumeEvidencePersisted", good_evidence)
            self.assertIn("(AssumeEvidencePersistError", bad_evidence)

    def test_commit_adjustment_requires_acceptable_review_and_persists_one_edge(self):
        atoms = """
        ((AssumeContextFeature house ctx feature 1.0 0.8 test)
         (AssumeAction house action lighting)
         (AssumeFeatureEdge house feature action 0.4 0.6 1)
         (AssumeOutcome house ctx action approved test 0.6))
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "assume.metta"
            path.write_text(atoms, encoding="utf-8")
            old_reload = assume_client.reload
            old_audit = assume_client.audit
            old_record_trace = assume_client.record_trace
            try:
                assume_client.reload = lambda domain, situation, text: "ASSUME-RELOADED graph=house::ctx"
                assume_client.audit = lambda domain, situation, action, text: "(AssumePrediction house ctx action 0.7)"
                assume_client.record_trace = lambda domain, situation, text: "ASSUME-TRACE-RECORDED test"

                result = assume_client.commit_adjustment_explicit(
                    "house",
                    "ctx",
                    "feature",
                    "action",
                    0.7,
                    0.65,
                    2,
                    "increase",
                    "acceptable",
                    0.4,
                    0.7,
                    0.3,
                    1.0,
                    0.4,
                    0.6,
                    0.6,
                    "increase",
                    0.0,
                    atoms,
                    "reviewed edge update",
                    str(path),
                )
            finally:
                assume_client.reload = old_reload
                assume_client.audit = old_audit
                assume_client.record_trace = old_record_trace

            text = path.read_text(encoding="utf-8")
            self.assertIn("(AssumeAdjustmentCommitted house ctx feature action", result)
            self.assertIn("(AssumeFeatureEdge house feature action 0.7 0.65 2)", text)
            self.assertIn("(AssumeAcceptedAdjustment house ctx feature action 0.7 0.65 2 increase", text)
            self.assertIn("(AssumeAdjustmentReview symbolic-review house ctx feature action acceptable", text)

    def test_commit_adjustment_rejected_review_does_not_write_file(self):
        atoms = """
        ((AssumeContextFeature house ctx feature 1.0 0.8 test)
         (AssumeAction house action lighting)
         (AssumeFeatureEdge house feature action 0.4 0.6 1)
         (AssumeOutcome house ctx action approved test 0.6))
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "assume.metta"
            path.write_text(atoms, encoding="utf-8")
            before = path.read_text(encoding="utf-8")
            result = assume_client.commit_adjustment_explicit(
                "house",
                "ctx",
                "feature",
                "action",
                0.7,
                0.65,
                2,
                "increase",
                "wait-evidence",
                0.4,
                0.7,
                0.3,
                1.0,
                0.4,
                0.6,
                0.6,
                "increase",
                0.0,
                atoms,
                "not accepted",
                str(path),
            )
            self.assertIn("AssumeAdjustmentCommitError", result)
            self.assertEqual(before, path.read_text(encoding="utf-8"))

    @unittest.skipUnless(FABRIC_PYTHON.exists(), "FabricPC venv is not available")
    def test_commit_growth_edge_requires_review_and_persists_trace_atoms(self):
        atoms = """
        ((AssumeSituation house ctx "scratch")
         (AssumeContextFeature house ctx feature 1.0 0.8 test)
         (AssumeAction house action lighting)
         (AssumeOutcome house ctx action approved test 0.8))
        """
        proposal = "(AssumeProposedFeatureEdge house ctx feature action 0.74 0.6 1.2 positive-target-missing-edge)"
        review = "(AssumeGrowthJudgement symbolic-review house ctx feature action acceptable 0.2 0.8 0.7 0.0 0.6)"
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "assume.metta"
            trace_path = pathlib.Path(tmpdir) / "assume_trace.metta"
            path.write_text(atoms, encoding="utf-8")
            old_trace_path = assume_client.TRACE_PATH
            try:
                assume_client.TRACE_PATH = trace_path
                result = assume_client.commit_growth_edge(
                    "house",
                    "ctx",
                    proposal,
                    review,
                    atoms,
                    "reviewed growth",
                    str(path),
                )
            finally:
                assume_client.TRACE_PATH = old_trace_path
                assume_client.stop()

            text = path.read_text(encoding="utf-8")
            self.assertIn("(AssumeGrowthCommitted house ctx feature action", result)
            self.assertIn("(AssumeFeatureEdge house feature action 0.74 0.6 1.2)", text)
            self.assertIn("(AssumeAcceptedFeatureEdge house ctx feature action", text)
            self.assertIn("(AssumeGrowthReview symbolic-review house ctx feature action acceptable", text)
            trace_text = trace_path.read_text(encoding="utf-8")
            self.assertIn("AssumeMutationTrace", trace_text)
            self.assertIn("AssumeAcceptedFeatureEdge", trace_text)

    def test_commit_growth_edge_rejected_review_does_not_write_file(self):
        atoms = """
        ((AssumeSituation house ctx "scratch")
         (AssumeContextFeature house ctx feature 1.0 0.8 test)
         (AssumeAction house action lighting)
         (AssumeOutcome house ctx action approved test 0.8))
        """
        proposal = "(AssumeProposedFeatureEdge house ctx feature action 0.74 0.6 1.2 positive-target-missing-edge)"
        review = "(AssumeGrowthJudgement symbolic-review house ctx feature action wait-evidence 0.2 0.8 0.7 0.0 0.6)"
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "assume.metta"
            path.write_text(atoms, encoding="utf-8")
            result = assume_client.commit_growth_edge(
                "house",
                "ctx",
                proposal,
                review,
                atoms,
                "rejected growth",
                str(path),
            )
            self.assertIn("AssumeGrowthCommitError", result)
            self.assertNotIn("AssumeFeatureEdge house feature action", path.read_text(encoding="utf-8"))

    def test_parseable_writeback_commit_result_reports_failure_without_live_apply_claim(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "assume.metta"
            old_assume_path = assume_client.ASSUME_PATH
            try:
                assume_client.ASSUME_PATH = path
                result = assume_client.commit_writeback_delta_result(
                    "house",
                    "ctx",
                    "((AssumeUpdatedFeatureEdge house missing action 0.7 0.6 1))",
                )
            finally:
                assume_client.ASSUME_PATH = old_assume_path

            self.assertIn("(AssumeWritebackCommitError house ctx", result)
            self.assertNotIn("AssumeWritebackCommitSucceeded", result)

    def test_validated_writeback_errors_are_parseable_atom_bundles(self):
        result = assume_client.validated_writeback("house", "missing", "")
        self.assertIn("(AssumeSaveError house missing", result)
        rows = assume._atom_rows(result, "AssumeSaveError")
        self.assertEqual(1, len(rows))
        self.assertIn("unknown graph id", rows[0][2])

    @unittest.skipUnless(FABRIC_PYTHON.exists(), "FabricPC venv is not available")
    def test_commit_adjustment_real_reload_round_trip(self):
        atoms = """
        ((AssumeContextFeature house ctx feature 1.0 0.8 test)
         (AssumeAction house action lighting)
         (AssumeFeatureEdge house feature action 0.4 0.6 1)
         (AssumeOutcome house ctx action approved test 0.8))
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "assume.metta"
            trace_path = pathlib.Path(tmpdir) / "assume_trace.metta"
            path.write_text(atoms, encoding="utf-8")
            old_trace_path = assume_client.TRACE_PATH
            try:
                assume_client.TRACE_PATH = trace_path
                result = assume_client.commit_adjustment_explicit(
                    "house",
                    "ctx",
                    "feature",
                    "action",
                    0.7,
                    0.65,
                    2,
                    "increase",
                    "acceptable",
                    0.4,
                    0.7,
                    0.3,
                    1.0,
                    0.4,
                    0.6,
                    0.6,
                    "increase",
                    0.0,
                    atoms,
                    "real reload check",
                    str(path),
                )
            finally:
                assume_client.TRACE_PATH = old_trace_path
                assume_client.stop()

            text = path.read_text(encoding="utf-8")
            self.assertIn("(AssumeAdjustmentCommitted house ctx feature action", result)
            self.assertIn("(AssumeFeatureEdge house feature action 0.7 0.65 2)", text)
            self.assertIn("AssumeAcceptedAdjustment", text)
            trace_text = trace_path.read_text(encoding="utf-8")
            self.assertIn("AssumeMutationTrace", trace_text)
            self.assertIn("(AssumeMutation ", trace_text)
            self.assertIn("(AssumeFeatureEdge house feature action 0.7 0.65 2)", trace_text)

    def test_assume_trace_splits_bundles_without_losing_colons_or_newlines(self):
        bundle = '((AssumeFeatureEdge house feature action 0.7 0.65 2) (AssumeAcceptedAdjustment house ctx feature action "line one: ok\\nline two" reason))'
        atoms = assume_client._top_level_atom_texts(bundle)
        self.assertEqual(2, len(atoms))
        self.assertIn("AssumeFeatureEdge", atoms[0])
        self.assertIn('line one: ok\\nline two', atoms[1])

    def test_structural_assume_atoms_persist_idempotently(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "assume.metta"
            trace_path = pathlib.Path(tmpdir) / "assume_trace.metta"
            atoms = [
                assume_client.assume_situation_atom("family-care", "sleep-transition", "sleep test: start"),
                assume_client.assume_context_feature_atom(
                    "family-care", "sleep-transition", "house-asleep", 0.95, 0.85, "event"
                ),
                assume_client.assume_action_atom("family-care", "quiet-listening-mode", "attention"),
                assume_client.assume_feature_edge_atom(
                    "family-care", "house-asleep", "quiet-listening-mode", 0.7, 0.7, 1
                ),
            ]
            names = [
                "AssumeSituation",
                "AssumeContextFeature",
                "AssumeAction",
                "AssumeFeatureEdge",
            ]
            old_trace_path = assume_client.TRACE_PATH

            try:
                assume_client.TRACE_PATH = trace_path
                for atom, name in zip(atoms, names):
                    first = assume_client.persist_structural_atom(atom, name, str(path))
                    second = assume_client.persist_structural_atom(atom, name, str(path))
                    self.assertIn("duplicate=false", first)
                    self.assertIn("duplicate=true", second)
            finally:
                assume_client.TRACE_PATH = old_trace_path

            text = path.read_text(encoding="utf-8")
            self.assertEqual(1, text.count("AssumeSituation family-care sleep-transition"))
            self.assertEqual(1, text.count("AssumeContextFeature family-care sleep-transition house-asleep"))
            self.assertEqual(1, text.count("AssumeAction family-care quiet-listening-mode"))
            self.assertEqual(1, text.count("AssumeFeatureEdge family-care house-asleep quiet-listening-mode"))
            self.assertFalse(trace_path.exists())

    def test_canonical_structural_persist_records_mutation_trace(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "assume.metta"
            trace_path = pathlib.Path(tmpdir) / "assume_trace.metta"
            atom = assume_client.assume_context_feature_atom(
                "family-care", "sleep-transition", "house-asleep", 0.95, 0.85, "event"
            )
            old_assume_path = assume_client.ASSUME_PATH
            old_trace_path = assume_client.TRACE_PATH
            try:
                assume_client.ASSUME_PATH = path
                assume_client.TRACE_PATH = trace_path
                result = assume_client.persist_structural_atom(atom, "AssumeContextFeature")
            finally:
                assume_client.ASSUME_PATH = old_assume_path
                assume_client.TRACE_PATH = old_trace_path

            self.assertIn("ASSUME-STRUCTURAL-ATOM-PERSISTED", result)
            self.assertIn("trace=", result)
            trace_text = trace_path.read_text(encoding="utf-8")
            self.assertIn("AssumeMutationTrace", trace_text)
            self.assertIn(atom, trace_text)

    def test_situation_status_reports_newborn_and_covered_graphs(self):
        newborn = """
        ((AssumeSituation family-care sleep-transition "scratch")
         (AssumeContextFeature family-care sleep-transition house-asleep 0.95 0.85 event)
         (AssumeContextFeature family-care sleep-transition resident-going-to-sleep 0.95 0.9 event)
         (AssumeAction family-care quiet-listening-mode attention)
         (AssumeOutcome family-care sleep-transition quiet-listening-mode positive correct 0.9))
        """
        newborn_status = assume_client.situation_status("family-care", "sleep-transition", newborn)
        self.assertIn("(Coverage zero-edge)", newborn_status)
        self.assertIn("(Advice learn-from-atoms-then-growth)", newborn_status)

        covered = """
        ((AssumeSituation family-care sleep-transition "scratch")
         (AssumeContextFeature family-care sleep-transition house-asleep 0.95 0.85 event)
         (AssumeAction family-care quiet-listening-mode attention)
         (AssumeFeatureEdge family-care house-asleep quiet-listening-mode 0.7 0.7 1)
         (AssumeOutcome family-care sleep-transition quiet-listening-mode positive correct 0.9))
        """
        covered_status = assume_client.situation_status("family-care", "sleep-transition", covered)
        self.assertIn("(Coverage usable-for-audit)", covered_status)
        self.assertIn("(Advice predict-audit-review)", covered_status)

    def test_graph_not_ready_bundle_exposes_symbolic_status(self):
        atoms = """
        ((AssumeSituation family-care sleep-transition "scratch")
         (AssumeAction family-care quiet-listening-mode attention))
        """
        result = assume_client._bundle_error_with_readiness(
            "AssumePredictError",
            "family-care",
            "sleep-transition",
            "graph requires at least one active context feature",
            atoms,
        )
        self.assertIn("(AssumePredictError family-care sleep-transition", result)
        self.assertIn("(AssumeGraphNotReady family-care sleep-transition", result)
        self.assertIn("(SearchedSpace assume)", result)
        self.assertIn("(Coverage no-context)", result)
        self.assertIn("(Advice add-context-features)", result)
        self.assertIn("assume-add-context-feature", result)

    def test_load_error_includes_symbolic_readiness_warning(self):
        class FakeRequest:
            def __call__(self, payload):
                return {"ok": False, "error": "graph requires at least one active context feature"}

        old_request = assume_client._request
        try:
            assume_client._request = FakeRequest()
            result = assume_client._load(
                "family-care",
                "sleep-transition",
                "((AssumeSituation family-care sleep-transition scratch))",
                "ASSUME-LOADED",
            )
        finally:
            assume_client._request = old_request

        self.assertIn("ASSUME-LOADED-ERROR graph requires at least one active context feature", result)
        self.assertIn("(AssumeGraphNotReady family-care sleep-transition", result)
        self.assertIn("(SearchedSpace assume)", result)
        self.assertIn("(Advice add-context-features)", result)

    def test_structural_persist_rejects_bad_shape(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "assume.metta"
            result = assume_client.persist_structural_atom(
                "(AssumeFeatureEdge house feature action nope 0.6 1)",
                "AssumeFeatureEdge",
                str(path),
            )
            self.assertIn("ASSUME-STRUCTURAL-ATOM-PERSIST-ERROR", result)
            self.assertFalse(path.exists())

    def test_daemon_read_timeout_clears_stuck_process(self):
        proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(10)"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        old_proc = assume_client._PROC
        old_timeout = os.environ.get("OMEGACLAW_ASSUME_REQUEST_TIMEOUT_SECONDS")
        try:
            assume_client._PROC = proc
            os.environ["OMEGACLAW_ASSUME_REQUEST_TIMEOUT_SECONDS"] = "0.1"
            with self.assertRaises(TimeoutError):
                assume_client._readline_with_timeout(proc, "test")
            self.assertIsNone(assume_client._PROC)
            self.assertIsNotNone(proc.poll())
        finally:
            assume_client._PROC = old_proc
            if old_timeout is None:
                os.environ.pop("OMEGACLAW_ASSUME_REQUEST_TIMEOUT_SECONDS", None)
            else:
                os.environ["OMEGACLAW_ASSUME_REQUEST_TIMEOUT_SECONDS"] = old_timeout
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=2)


if __name__ == "__main__":
    unittest.main()
