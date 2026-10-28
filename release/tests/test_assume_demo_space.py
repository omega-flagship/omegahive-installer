#!/usr/bin/env python3
"""Regression checks for the public SmartHabitat Assume demo space."""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "modules" / "assume" / "src"
DEMO_PATH = ROOT / "demos" / "assume" / "SmartHabitatDemoSpace.metta"
FABRIC_REPO = pathlib.Path(os.environ.get("FABRICPC_REPO", str(ROOT.parent / "FabricPC")))
FABRIC_PYTHON = pathlib.Path(os.environ.get("FABRICPC_PYTHON", FABRIC_REPO / ".venv/bin/python"))

sys.path.insert(0, str(SRC))

import assume  # noqa: E402
import assume_client  # noqa: E402


class SmartHabitatDemoSpaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.atoms = DEMO_PATH.read_text(encoding="utf-8")

    def start_fabric(self):
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join([str(SRC), str(FABRIC_REPO)])
        proc = subprocess.Popen(
            [str(FABRIC_PYTHON), "-u", str(SRC / "assume_fabricd.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )

        def call(request):
            assert proc.stdin is not None
            assert proc.stdout is not None
            proc.stdin.write(json.dumps(request) + "\n")
            proc.stdin.flush()
            return json.loads(proc.stdout.readline())

        ready = json.loads(proc.stdout.readline())
        self.assertTrue(ready["ready"])
        return proc, call

    def stop_fabric(self, proc, call):
        if proc.poll() is None:
            try:
                call({"cmd": "stop"})
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
                proc.wait(timeout=10)
        stderr = proc.stderr.read() if proc.stderr else ""
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream and not stream.closed:
                stream.close()
        self.assertEqual("", stderr.strip())

    def test_demo_space_is_substantial_but_below_caps(self):
        situations = assume._atom_rows(self.atoms, "AssumeSituation")
        contexts = assume._atom_rows(self.atoms, "AssumeContextFeature")
        actions = assume._atom_rows(self.atoms, "AssumeAction")
        edges = assume._atom_rows(self.atoms, "AssumeFeatureEdge")
        outcomes = assume._atom_rows(self.atoms, "AssumeOutcome")
        errors = assume._atom_rows(self.atoms, "AssumeError")

        feature_names = {row[2] for row in contexts}
        edge_pairs = {(row[1], row[2]) for row in edges}
        self.assertGreaterEqual(len(situations), 10)
        self.assertGreaterEqual(len(feature_names), 55)
        self.assertGreaterEqual(len(actions), 16)
        self.assertGreaterEqual(len(edges), 110)
        self.assertEqual(len(edges), len(edge_pairs))
        self.assertGreaterEqual(len(outcomes) + len(errors), 35)
        self.assertLess(len(self.atoms), assume.MAX_ATOM_TEXT_CHARS)

        context, parsed_actions, parsed_edges, _feedback = assume.atomspace_feature_graph(
            self.atoms,
            "smart-habitat",
            "movie-evening",
        )
        assume.validate_feature_graph(self.atoms, context, parsed_actions, parsed_edges)
        self.assertLessEqual(len(context), assume.MAX_ACTIVE_FEATURES)
        self.assertLessEqual(len(parsed_actions), assume.MAX_ACTIONS)
        self.assertLessEqual(len(parsed_edges), assume.MAX_FEATURE_EDGES)

    def test_movie_evening_prediction_is_inspectable(self):
        report = assume.assume_audit(
            "smart-habitat",
            "movie-evening",
            "dim-cinema-scene",
            self.atoms,
        )

        self.assertIn("(AssumeGuardReport smart-habitat movie-evening dim-cinema-scene", report)
        self.assertIn("(Verdict usable-assumption)", report)
        self.assertIn("(Reason supported-by-active-features)", report)
        self.assertIn("(NALTruth", report)

    def test_bad_movie_action_has_visible_error_pressure(self):
        report = assume.assume_audit(
            "smart-habitat",
            "movie-evening",
            "open-blinds",
            self.atoms,
        )

        self.assertIn("(Verdict error-pressure)", report)
        self.assertIn("(Reason recent-negative-evidence)", report)

    def test_demo_space_is_available_through_client_index(self):
        index = assume_client.demo_index()

        self.assertIn("AssumeDemoIndex", index)
        self.assertIn("SmartHabitatDemoSpace", index)
        self.assertIn("smart-habitat", index)
        self.assertIn("movie-evening", index)
        self.assertEqual(self.atoms, assume_client.demo_atoms("SmartHabitatDemoSpace"))

    def test_demo_space_can_import_as_normal_canonical_assume_atoms(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "assume.metta"
            trace = pathlib.Path(tmpdir) / "assume_trace.metta"
            old_trace = assume_client.TRACE_PATH
            try:
                assume_client.TRACE_PATH = trace
                result = assume_client.persist_demo("SmartHabitatDemoSpace", path=str(path))
            finally:
                assume_client.TRACE_PATH = old_trace

            self.assertIn("ASSUME-DEMO-IMPORTED", result)
            self.assertIn("added=252", result)
            imported_atoms = path.read_text(encoding="utf-8")
            context, actions, edges, _feedback = assume.atomspace_feature_graph(
                imported_atoms,
                "smart-habitat",
                "movie-evening",
            )
            assume.validate_feature_graph(imported_atoms, context, actions, edges)
            self.assertGreaterEqual(len(edges), 110)
            self.assertIn("AssumeMutationTrace", trace.read_text(encoding="utf-8"))

    @unittest.skipUnless(FABRIC_PYTHON.exists(), "FabricPC venv is not available")
    def test_demo_space_predicts_learns_and_writes_back(self):
        proc, call = self.start_fabric()
        try:
            load = call({
                "cmd": "load",
                "id": "smart-habitat::movie-evening",
                "domain": "smart-habitat",
                "situation": "movie-evening",
                "atoms": self.atoms,
            })
            self.assertTrue(load["ok"], load)
            self.assertGreaterEqual(load["edges"], 110)

            prediction = call({
                "cmd": "predict",
                "id": "smart-habitat::movie-evening",
                "atoms": self.atoms,
            })
            self.assertTrue(prediction["ok"], prediction)
            self.assertEqual("dim-cinema-scene", prediction["action"])
            self.assertIn("usable-assumption", prediction["report_atoms"])

            audit = call({
                "cmd": "audit",
                "id": "smart-habitat::movie-evening",
                "action": "open-blinds",
                "atoms": self.atoms,
            })
            self.assertTrue(audit["ok"], audit)
            self.assertIn("error-pressure", audit["report_atoms"])

            learned = call({
                "cmd": "learn",
                "id": "smart-habitat::movie-evening",
                "atoms": self.atoms,
                "targets": {
                    "dim-cinema-scene": 0.2,
                    "ask-before-action": 0.85,
                    "hold-silence": 0.7,
                    "open-blinds": 0.05,
                },
            })
            self.assertTrue(learned["ok"], learned)
            self.assertTrue(learned["dirty"])

            writeback = call({"cmd": "writeback", "id": "smart-habitat::movie-evening"})
            self.assertTrue(writeback["ok"], writeback)
            self.assertIn("AssumeUpdatedFeatureEdge", writeback["atoms"])
            self.assertIn("AssumeWeightMutation", writeback["atoms"])
            self.assertIn("AssumeWeightDelta", writeback["atoms"])
            self.assertIn("AssumeAdjustmentPressure", writeback["atoms"])
            self.assertIn("AssumeMutationSignedError", writeback["atoms"])
            self.assertIn("AssumeMutationTruth", writeback["atoms"])
            self.assertIn("AssumeMutationVerdict", writeback["atoms"])
            self.assertIn("AssumeFabricMutationVerdict", writeback["atoms"])
            self.assertEqual(
                writeback["changed_edges"],
                writeback["atoms"].count("AssumeUpdatedFeatureEdge"),
            )
            self.assertNotIn("send-channel", writeback["atoms"])
            self.assertNotIn("use-house-affordance", writeback["atoms"])

            with tempfile.TemporaryDirectory() as tmpdir:
                temp_demo = pathlib.Path(tmpdir) / "SmartHabitatDemoSpace.metta"
                temp_demo.write_text(self.atoms, encoding="utf-8")
                persisted = assume_client.persist_writeback_delta(
                    "smart-habitat",
                    "movie-evening",
                    writeback["atoms"],
                    path=str(temp_demo),
                )
                self.assertTrue(persisted.startswith("ASSUME-DELTA-PERSISTED"), persisted)
                committed_atoms = temp_demo.read_text(encoding="utf-8")
                self.assertNotIn("AssumeUpdatedFeatureEdge", committed_atoms)
                self.assertNotIn("AssumeWeightMutation", committed_atoms)
                self.assertNotEqual(committed_atoms, self.atoms)

                reloaded = call({
                    "cmd": "load",
                    "id": "smart-habitat::movie-evening",
                    "domain": "smart-habitat",
                    "situation": "movie-evening",
                    "atoms": committed_atoms,
                })
                self.assertTrue(reloaded["ok"], reloaded)
                self.assertEqual(load["edges"], reloaded["edges"])

                after = call({
                    "cmd": "predict",
                    "id": "smart-habitat::movie-evening",
                    "atoms": committed_atoms,
                })
                self.assertTrue(after["ok"], after)
                self.assertLess(
                    after["scores"]["dim-cinema-scene"],
                    prediction["scores"]["dim-cinema-scene"],
                )
                self.assertGreater(
                    after["scores"]["ask-before-action"],
                    prediction["scores"]["ask-before-action"],
                )
        finally:
            self.stop_fabric(proc, call)

    @unittest.skipUnless(FABRIC_PYTHON.exists(), "FabricPC venv is not available")
    def test_demo_space_survives_multi_episode_learning(self):
        proc, call = self.start_fabric()
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                temp_demo = pathlib.Path(tmpdir) / "SmartHabitatDemoSpace.metta"
                temp_demo.write_text(self.atoms, encoding="utf-8")
                atoms = self.atoms
                load = call({
                    "cmd": "load",
                    "id": "smart-habitat::movie-evening",
                    "domain": "smart-habitat",
                    "situation": "movie-evening",
                    "atoms": atoms,
                })
                self.assertTrue(load["ok"], load)
                before = call({"cmd": "predict", "id": "smart-habitat::movie-evening", "atoms": atoms})
                self.assertTrue(before["ok"], before)

                target_series = [
                    {"dim-cinema-scene": 0.25, "welcome-guest-mode": 0.05, "ask-before-action": 0.82, "hold-silence": 0.68},
                    {"dim-cinema-scene": 0.20, "welcome-guest-mode": 0.05, "ask-before-action": 0.86, "hold-silence": 0.70},
                    {"dim-cinema-scene": 0.15, "welcome-guest-mode": 0.05, "ask-before-action": 0.90, "hold-silence": 0.74},
                    {"dim-cinema-scene": 0.20, "welcome-guest-mode": 0.08, "ask-before-action": 0.88, "hold-silence": 0.72},
                    {"dim-cinema-scene": 0.18, "welcome-guest-mode": 0.05, "ask-before-action": 0.92, "hold-silence": 0.75},
                ]

                for targets in target_series:
                    learned = call({
                        "cmd": "learn",
                        "id": "smart-habitat::movie-evening",
                        "atoms": atoms,
                        "targets": targets,
                    })
                    self.assertTrue(learned["ok"], learned)
                    writeback = call({"cmd": "writeback", "id": "smart-habitat::movie-evening"})
                    self.assertTrue(writeback["ok"], writeback)
                    self.assertGreater(writeback["changed_edges"], 0)
                    self.assertLess(writeback["changed_edges"], load["edges"])
                    self.assertIn("AssumeWeightMutation", writeback["atoms"])
                    persisted = assume_client.persist_writeback_delta(
                        "smart-habitat",
                        "movie-evening",
                        writeback["atoms"],
                        path=str(temp_demo),
                    )
                    self.assertTrue(persisted.startswith("ASSUME-DELTA-PERSISTED"), persisted)
                    atoms = temp_demo.read_text(encoding="utf-8")
                    reloaded = call({
                        "cmd": "load",
                        "id": "smart-habitat::movie-evening",
                        "domain": "smart-habitat",
                        "situation": "movie-evening",
                        "atoms": atoms,
                    })
                    self.assertTrue(reloaded["ok"], reloaded)
                    self.assertEqual(load["edges"], reloaded["edges"])

                after = call({"cmd": "predict", "id": "smart-habitat::movie-evening", "atoms": atoms})
                self.assertTrue(after["ok"], after)
                self.assertGreater(after["scores"]["ask-before-action"], before["scores"]["ask-before-action"])
                self.assertLess(after["scores"]["dim-cinema-scene"], before["scores"]["dim-cinema-scene"])
                context, actions, edges, _feedback = assume.atomspace_feature_graph(
                    atoms,
                    "smart-habitat",
                    "movie-evening",
                )
                assume.validate_feature_graph(atoms, context, actions, edges)
                self.assertEqual(load["edges"], len(edges))
        finally:
            self.stop_fabric(proc, call)

    @unittest.skipUnless(FABRIC_PYTHON.exists(), "FabricPC venv is not available")
    def test_demo_space_proposes_growth_from_new_evidence_without_auto_committing(self):
        proc, call = self.start_fabric()
        try:
            load = call({
                "cmd": "load",
                "id": "smart-habitat::movie-evening",
                "domain": "smart-habitat",
                "situation": "movie-evening",
                "atoms": self.atoms,
            })
            self.assertTrue(load["ok"], load)
            learned = call({
                "cmd": "learn",
                "id": "smart-habitat::movie-evening",
                "atoms": self.atoms,
                "targets": {
                    "notify-resident": 0.95,
                    "ask-before-action": 0.85,
                },
            })
            self.assertTrue(learned["ok"], learned)
            pressure = call({
                "cmd": "growth_pressure",
                "id": "smart-habitat::movie-evening",
                "atoms": self.atoms,
            })
            self.assertTrue(pressure["ok"], pressure)
            self.assertIn("AssumeGrowthPressure", pressure["atoms"])
            self.assertIn("missing-edge", pressure["atoms"])

            proposals = call({
                "cmd": "growth_proposals",
                "id": "smart-habitat::movie-evening",
                "atoms": self.atoms,
            })
            self.assertTrue(proposals["ok"], proposals)
            self.assertGreater(proposals["proposal_count"], 0)
            self.assertIn("AssumeProposedFeatureEdge", proposals["atoms"])

            writeback = call({"cmd": "writeback", "id": "smart-habitat::movie-evening"})
            self.assertNotIn("AssumeProposedFeatureEdge", writeback["atoms"])
        finally:
            self.stop_fabric(proc, call)

    @unittest.skipUnless(FABRIC_PYTHON.exists(), "FabricPC venv is not available")
    def test_weight_mutation_atoms_are_reasonable_symbolic_evidence(self):
        proc, call = self.start_fabric()
        try:
            load = call({
                "cmd": "load",
                "id": "smart-habitat::movie-evening",
                "domain": "smart-habitat",
                "situation": "movie-evening",
                "atoms": self.atoms,
            })
            self.assertTrue(load["ok"], load)
            learned = call({
                "cmd": "learn",
                "id": "smart-habitat::movie-evening",
                "atoms": self.atoms,
                "targets": {
                    "dim-cinema-scene": 0.2,
                    "ask-before-action": 0.85,
                    "open-blinds": 0.05,
                },
            })
            self.assertTrue(learned["ok"], learned)
            writeback = call({"cmd": "writeback", "id": "smart-habitat::movie-evening"})
            rows = assume._atom_rows(writeback["atoms"], "AssumeWeightMutation")
            self.assertEqual(writeback["changed_edges"], len(rows))
            self.assertGreater(len(rows), 0)
            self.assertEqual(writeback["changed_edges"], writeback["atoms"].count("AssumeMutationTruth"))
            self.assertEqual(writeback["changed_edges"], writeback["atoms"].count("AssumeFabricMutationTruth"))
            self.assertEqual(writeback["changed_edges"], writeback["atoms"].count("AssumeWeightDelta"))
            self.assertIn("AssumeMutationPressure", writeback["atoms"])
            self.assertIn("AssumeMutationConflict", writeback["atoms"])
            self.assertIn("AssumeMutationReason", writeback["atoms"])
            self.assertIn("AssumeMutationTarget", writeback["atoms"])
            self.assertIn("AssumeMutationEvidence", writeback["atoms"])

            largest = max(rows, key=lambda row: abs(assume._to_float(row[6])))
            old_weight = assume._to_float(largest[4])
            new_weight = assume._to_float(largest[5])
            delta = assume._to_float(largest[6])
            direction = largest[11]
            cause = largest[13]
            self.assertAlmostEqual(new_weight - old_weight, delta, places=6)
            self.assertIn(direction, {"increase", "decrease", "metadata-only"})
            self.assertEqual("explicit-target", cause)
            if delta < 0:
                self.assertEqual("decrease", direction)
            elif delta > 0:
                self.assertEqual("increase", direction)

            with tempfile.TemporaryDirectory() as tmpdir:
                trace_path = pathlib.Path(tmpdir) / "assume_trace.metta"
                old_trace = assume_client.TRACE_PATH
                try:
                    assume_client.TRACE_PATH = trace_path
                    trace = assume_client.record_trace("smart-habitat", "movie-evening", writeback["atoms"])
                finally:
                    assume_client.TRACE_PATH = old_trace
                self.assertTrue(trace.startswith("ASSUME-TRACE-RECORDED"), trace)
                trace_text = trace_path.read_text(encoding="utf-8")
                self.assertIn("AssumeWeightMutation", trace_text)
                self.assertIn("AssumeMutationVerdict", trace_text)
                self.assertIn("AssumeFabricMutationVerdict", trace_text)
                self.assertIn("AssumeMutation", trace_text)
        finally:
            self.stop_fabric(proc, call)


if __name__ == "__main__":
    unittest.main()
