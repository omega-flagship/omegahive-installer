import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import attention_ledger  # noqa: E402
import helper  # noqa: E402


class AttentionLedgerTests(unittest.TestCase):
    def test_scan_is_non_destructive_and_writes_reviewable_candidates(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_metta = attention_ledger.ATTENTION_METTA
            old_json = attention_ledger.ATTENTION_JSON
            attention_ledger.ATTENTION_METTA = pathlib.Path(tmp) / "attention.metta"
            attention_ledger.ATTENTION_JSON = pathlib.Path(tmp) / "attention_ledger.json"
            try:
                atoms = '((PersistentNote "omega" "phase1 practice syntax debris" "0.8") (PersistentNote "omega" "identity continuity and family care" "0.95"))'
                report = attention_ledger.scan_persistent(atoms, 10)
                self.assertIn("non_destructive=true", report)
                candidates = attention_ledger.candidates(10)
                self.assertIn("review-retire", candidates)
                self.assertTrue(attention_ledger.ATTENTION_METTA.exists())
                rendered = attention_ledger.ATTENTION_METTA.read_text()
                self.assertIn("AttentionValue", rendered)
                self.assertIn("SupportedBy", rendered)
                self.assertIn("TruthValue", rendered)
                self.assertIn("AttentionCandidate", rendered)
                self.assertIn("AttentionCacheRole", rendered)
                state = attention_ledger._load_state()
                key = next(iter(state["records"]))
                review = attention_ledger.review(key)
                self.assertIn("ATOM", review)
                self.assertIn("evidence=", review)
            finally:
                attention_ledger.ATTENTION_METTA = old_metta
                attention_ledger.ATTENTION_JSON = old_json

    def test_ecan_pass_writes_full_audit_without_target_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_metta = attention_ledger.ATTENTION_METTA
            old_json = attention_ledger.ATTENTION_JSON
            attention_ledger.ATTENTION_METTA = pathlib.Path(tmp) / "attention.metta"
            attention_ledger.ATTENTION_JSON = pathlib.Path(tmp) / "attention_ledger.json"
            try:
                atoms = '((PersistentNote "omega" "phase1 practice syntax debris" "0.8") (PersistentNote "omega" "identity continuity and family care" "0.95"))'
                report = attention_ledger.ecan_pass(atoms, "persistent", "review-only", 10)
                self.assertIn("ECAN-PASS complete", report)
                self.assertIn("non_destructive_target=true", report)
                self.assertIn("target_mutations=0", report)
                rendered = attention_ledger.ATTENTION_METTA.read_text()
                self.assertIn("ECANPass", rendered)
                self.assertIn("ECANAction", rendered)
                self.assertIn("ECANOutcome", rendered)
                self.assertIn("AttentionCandidate", rendered)
            finally:
                attention_ledger.ATTENTION_METTA = old_metta
                attention_ledger.ATTENTION_JSON = old_json

    def test_rescan_preserves_wage_and_rent_for_same_atom(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_metta = attention_ledger.ATTENTION_METTA
            old_json = attention_ledger.ATTENTION_JSON
            attention_ledger.ATTENTION_METTA = pathlib.Path(tmp) / "attention.metta"
            attention_ledger.ATTENTION_JSON = pathlib.Path(tmp) / "attention_ledger.json"
            try:
                atoms = '((PersistentNote "omega" "phase1 practice syntax debris" "0.8"))'
                attention_ledger.scan_persistent(atoms, 10)
                key = next(iter(attention_ledger._load_state()["records"]))
                attention_ledger.wage(key, 2.0, "useful reminder")
                after_wage = attention_ledger._load_state()["records"][key]
                attention_ledger.scan_persistent(atoms, 10)
                after_rescan = attention_ledger._load_state()["records"][key]
                self.assertEqual(after_wage["sti"], after_rescan["sti"])
                self.assertEqual(after_wage["lti"], after_rescan["lti"])
                self.assertEqual(after_wage["uses"], after_rescan["uses"])
            finally:
                attention_ledger.ATTENTION_METTA = old_metta
                attention_ledger.ATTENTION_JSON = old_json

    def test_explicit_retire_button_is_review_gated_and_traced(self):
        source = (ROOT / "src" / "skills_attention.metta").read_text(encoding="utf-8")
        retire_body = source.split("(= (attention-retire-candidate", 1)[1].split("(= (attention-wage", 1)[0]

        self.assertIn('(AtomRef "persistent" $hash $expr)', retire_body)
        self.assertIn('(== $action "review-retire")', retire_body)
        self.assertIn("remove-atom &persistent", retire_body)
        self.assertIn('(ECANOutcome "manual-attention-retire" $hash "retired" $reason)', retire_body)
        self.assertIn('(ECANOutcome "manual-attention-retire" $hash "not-retire-candidate" $reason)', retire_body)
        self.assertIn('(ECANOutcome "manual-attention-retire" $hash "ambiguous" $reason)', retire_body)
        self.assertIn('(Event "omega" "attention-retire-candidate" $reason "0.9")', retire_body)

    def test_command_normalizer_knows_attention_ledger_commands(self):
        self.assertEqual(helper.balance_parentheses("attention-ledger-status"), "((attention-ledger-status))")
        self.assertEqual(helper.balance_parentheses("attention-scan-persistent 30"), "((attention-scan-persistent 30))")
        self.assertEqual(helper.balance_parentheses("immune-candidates 10"), "((immune-candidates 10))")
        self.assertEqual(helper.balance_parentheses("attention-native-candidates"), "((attention-native-candidates))")
        self.assertEqual(helper.balance_parentheses("attention-reload"), "((attention-reload))")
        self.assertEqual(helper.balance_parentheses("ecan-pass persistent review-only 30"), '((ecan-pass "persistent" "review-only" 30))')
        self.assertEqual(helper.balance_parentheses("attention-review abc123"), '((attention-review "abc123"))')
        self.assertEqual(
            helper.balance_parentheses("attention-retire-candidate abc123 stale practice debris"),
            '((attention-retire-candidate "abc123" "stale practice debris"))',
        )
        self.assertEqual(
            helper.balance_parentheses("attention-wage abc123 1.0 useful cleanup candidate"),
            '((attention-wage "abc123" 1.0 "useful cleanup candidate"))',
        )

    def test_attention_memory_dir_honors_runtime_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = os.environ.copy()
            env["OMEGACLAW_MEMORY_DIR"] = tmp
            result = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    (
                        "import pathlib, sys; "
                        f"sys.path.insert(0, {str(ROOT / 'src')!r}); "
                        "import attention_ledger; "
                        "print(attention_ledger.MEMORY_DIR)"
                    ),
                ],
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )
            self.assertEqual(str(pathlib.Path(tmp)), result.stdout.strip())


if __name__ == "__main__":
    unittest.main()
