#!/usr/bin/env python3
"""Protocol tests for the warm Assume FabricPC organ."""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "modules" / "assume" / "src"
FABRIC_REPO = pathlib.Path(os.environ.get("FABRICPC_REPO", str(ROOT.parent / "FabricPC")))
FABRIC_PYTHON = pathlib.Path(os.environ.get("FABRICPC_PYTHON", FABRIC_REPO / ".venv/bin/python"))


ATOMS = """
((AssumeContextFeature house ctx movie-night 0.9 0.8 observation)
 (AssumeContextFeature house ctx resident-present 0.8 0.8 observation)
 (AssumeAction house yellow-moody-scene lighting)
 (AssumeAction house bright-practical-scene lighting)
 (AssumeAction house ask-before-changing communication)
 (AssumeFeatureEdge house movie-night yellow-moody-scene 0.72 0.8 4)
 (AssumeFeatureEdge house movie-night ask-before-changing 0.45 0.7 2)
 (AssumeFeatureEdge house resident-present yellow-moody-scene 0.68 0.8 4)
 (AssumeFeatureEdge house resident-present bright-practical-scene 0.25 0.6 1)
 (AssumeOutcome house ctx yellow-moody-scene approved resident-liked-it 0.5))
"""


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def edge_weight(atoms: str, feature: str, action: str) -> float:
    pattern = re.compile(
        r"\(AssumeUpdatedFeatureEdge\s+house\s+"
        + re.escape(feature)
        + r"\s+"
        + re.escape(action)
        + r"\s+([^()\s]+)"
    )
    match = pattern.search(atoms)
    if not match:
        raise AssertionError(f"missing updated edge for {feature}/{action}: {atoms}")
    return float(match.group(1))


@unittest.skipUnless(FABRIC_PYTHON.exists(), "FabricPC venv is not available")
class AssumeFabricDaemonTests(unittest.TestCase):
    def setUp(self):
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join([str(SRC), str(FABRIC_REPO)])
        self.proc = subprocess.Popen(
            [str(FABRIC_PYTHON), "-u", str(SRC / "assume_fabricd.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        ready = json.loads(self.proc.stdout.readline())
        self.assertTrue(ready["ready"])

    def tearDown(self):
        if self.proc.poll() is None:
            try:
                self.call({"cmd": "stop"})
                self.proc.wait(timeout=10)
            except (BrokenPipeError, json.JSONDecodeError, subprocess.TimeoutExpired):
                self.proc.kill()
                self.proc.wait(timeout=10)
        stderr = self.proc.stderr.read()
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            if stream and not stream.closed:
                stream.close()
        self.assertEqual("", stderr.strip())

    def call(self, request):
        self.proc.stdin.write(json.dumps(request) + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def load(self):
        response = self.call({
            "cmd": "load",
            "id": "house-v1",
            "domain": "house",
            "situation": "ctx",
            "atoms": ATOMS,
        })
        self.assertTrue(response["ok"], response)
        self.assertEqual(3, response["actions"])
        self.assertEqual(4, response["edges"])
        return response

    def test_predict_and_audit_are_consumptive_reads(self):
        self.load()
        before = self.call({"cmd": "writeback", "id": "house-v1"})
        before_hash = digest(before["atoms"])

        prediction = self.call({"cmd": "predict", "id": "house-v1", "atoms": ATOMS})
        self.assertTrue(prediction["ok"], prediction)
        self.assertIn("AssumePredictionReport", prediction["report_atoms"])
        self.assertIn("AssumeSupport", prediction["report_atoms"])
        self.assertIn("AssumeEvidence", prediction["report_atoms"])
        self.assertIn("NALTruth", prediction["report_atoms"])

        audit = self.call({
            "cmd": "audit",
            "id": "house-v1",
            "action": prediction["action"],
            "atoms": ATOMS,
        })
        self.assertTrue(audit["ok"], audit)
        self.assertIn("AssumePredictionReport", audit["report_atoms"])

        after = self.call({"cmd": "writeback", "id": "house-v1"})
        self.assertEqual(before_hash, digest(after["atoms"]))

    def test_learn_is_explicit_and_writeback_is_assume_only(self):
        self.load()
        before = self.call({"cmd": "writeback", "id": "house-v1"})
        before_hash = digest(before["atoms"])

        learned = self.call({
            "cmd": "learn",
            "id": "house-v1",
            "atoms": ATOMS,
            "targets": {
                "yellow-moody-scene": 0.8,
                "bright-practical-scene": 0.2,
                "ask-before-changing": 0.5,
            },
        })
        self.assertTrue(learned["ok"], learned)
        status = self.call({"cmd": "status", "id": "house-v1"})
        self.assertTrue(status["dirty"])

        after = self.call({"cmd": "writeback", "id": "house-v1"})
        self.assertNotEqual(before_hash, digest(after["atoms"]))
        self.assertTrue(after["dirty"])
        self.assertIn("AssumeUpdatedFeatureEdge", after["atoms"])
        self.assertIn("AssumeWeightMutation", after["atoms"])
        self.assertIn("AssumeWeightDelta", after["atoms"])
        self.assertIn("AssumeMutationSignedError", after["atoms"])
        self.assertIn("AssumeMutationTruth", after["atoms"])
        self.assertIn("AssumeMutationVerdict", after["atoms"])
        self.assertIn("AssumeFabricMutationVerdict", after["atoms"])
        self.assertEqual(
            after["changed_edges"],
            after["atoms"].count("AssumeUpdatedFeatureEdge"),
        )
        self.assertNotIn("use-house-affordance", after["atoms"])
        self.assertNotIn("turn-on", after["atoms"])
        self.assertNotIn("send-channel", after["atoms"])

        clean = self.call({"cmd": "mark_clean", "id": "house-v1"})
        self.assertTrue(clean["ok"], clean)
        self.assertFalse(clean["dirty"])

    def test_sparse_graph_does_not_create_hidden_edges(self):
        self.load()
        learned = self.call({
            "cmd": "learn",
            "id": "house-v1",
            "atoms": ATOMS,
            "targets": {
                "yellow-moody-scene": 0.8,
                "bright-practical-scene": 0.2,
                "ask-before-changing": 0.5,
            },
        })
        self.assertTrue(learned["ok"], learned)
        writeback = self.call({"cmd": "writeback", "id": "house-v1"})["atoms"]
        self.assertIn("(AssumeUpdatedFeatureEdge house movie-night yellow-moody-scene", writeback)
        self.assertIn("(AssumeWeightMutation house ctx movie-night yellow-moody-scene", writeback)
        self.assertIn("(AssumeWeightDelta house ctx movie-night yellow-moody-scene", writeback)
        self.assertIn("(AssumeAdjustmentPressure house ctx movie-night yellow-moody-scene", writeback)
        self.assertIn("(AssumeMutationVerdict house ctx movie-night yellow-moody-scene", writeback)
        self.assertIn("(AssumeFabricMutationVerdict house ctx movie-night yellow-moody-scene", writeback)
        self.assertIn("(AssumeUpdatedFeatureEdge house movie-night ask-before-changing", writeback)
        self.assertIn("(AssumeUpdatedFeatureEdge house resident-present yellow-moody-scene", writeback)
        self.assertIn("(AssumeUpdatedFeatureEdge house resident-present bright-practical-scene", writeback)
        self.assertNotIn("(AssumeUpdatedFeatureEdge house movie-night bright-practical-scene", writeback)
        self.assertNotIn("(AssumeUpdatedFeatureEdge house resident-present ask-before-changing", writeback)

    def test_learn_from_atoms_does_not_treat_missing_evidence_as_negative_evidence(self):
        self.load()
        learned = self.call({
            "cmd": "learn_from_atoms",
            "id": "house-v1",
            "atoms": ATOMS,
        })
        self.assertTrue(learned["ok"], learned)
        pressure = self.call({"cmd": "adjustment_pressure", "id": "house-v1", "atoms": ATOMS})
        self.assertTrue(pressure["ok"], pressure)
        self.assertIn("AssumeAdjustmentPressure house ctx movie-night yellow-moody-scene", pressure["atoms"])
        self.assertIn("AssumeAdjustmentPressure house ctx resident-present yellow-moody-scene", pressure["atoms"])
        self.assertNotIn("AssumeAdjustmentPressure house ctx resident-present bright-practical-scene", pressure["atoms"])
        self.assertNotIn("AssumeAdjustmentPressure house ctx movie-night ask-before-changing", pressure["atoms"])

        writeback = self.call({"cmd": "writeback", "id": "house-v1"})["atoms"]
        self.assertIn("(AssumeUpdatedFeatureEdge house movie-night yellow-moody-scene", writeback)
        self.assertIn("(AssumeWeightMutation house ctx movie-night yellow-moody-scene", writeback)
        self.assertIn("(AssumeUpdatedFeatureEdge house resident-present yellow-moody-scene", writeback)
        self.assertNotIn("(AssumeUpdatedFeatureEdge house resident-present bright-practical-scene", writeback)
        self.assertNotIn("(AssumeUpdatedFeatureEdge house movie-night ask-before-changing", writeback)

    def test_bad_graph_is_rejected_without_stopping_daemon(self):
        bad = self.call({
            "cmd": "load",
            "id": "bad",
            "domain": "house",
            "situation": "ctx",
            "atoms": "((AssumeContextFeature house ctx f nope 0.8 test))",
        })
        self.assertFalse(bad["ok"])
        good = self.load()
        self.assertTrue(good["ok"])


@unittest.skipUnless(FABRIC_PYTHON.exists(), "FabricPC venv is not available")
class AssumeClientProcessTests(unittest.TestCase):
    def test_clear_process_closes_runtime_stderr_handle(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env = {
                "FABRICPC_PYTHON": str(FABRIC_PYTHON),
                "FABRICPC_REPO": str(FABRIC_REPO),
                "OMEGACLAW_ASSUME_STDERR_PATH": str(pathlib.Path(tmpdir) / "assume.stderr.log"),
            }
            code = (
                "import assume_client; "
                "print(assume_client.start()); "
                "print(assume_client.status()); "
                "print(assume_client.stop()); "
                "print(assume_client._STDERR_HANDLE is None)"
            )
            completed = subprocess.run(
                [str(sys.executable), "-c", code],
                cwd=str(ROOT),
                env={**os.environ, **env, "PYTHONPATH": os.pathsep.join([str(SRC), str(FABRIC_REPO)])},
                text=True,
                capture_output=True,
                timeout=20,
            )

            self.assertEqual(0, completed.returncode, completed.stderr)
            self.assertIn("ASSUME-ORGAN-STARTED", completed.stdout)
            self.assertIn("ASSUME-ORGAN-STOPPED", completed.stdout)
            self.assertTrue(completed.stdout.strip().endswith("True"))


if __name__ == "__main__":
    unittest.main()
