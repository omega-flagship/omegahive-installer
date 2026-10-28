import unittest
from hive.core.evolve_preflight import OBJECTIVE, assess, digest, seal


def fixture():
    r = {"objective": OBJECTIVE, "baseline_pin": digest("baseline"),
         "candidate_pin": digest("candidate"), "evaluator_pin": digest("evaluator"),
         "heldout_digest": digest("hidden synthetic tasks"),
         "budget": {"model_calls": 0, "network_calls": 0},
         "quality_rubric": "independent semantic task success, scored 0 to 1",
         "beneficialness_criteria": "no unresolved protected-floor concerns",
         "stop_rule": "stop on cap, invalid evidence or protected-floor concern",
         "review_owners": ["OmegaReview", "OmegaAlignment"],
         "thresholds": {"min_quality": .8, "min_quality_gain": .1,
                        "max_attempts": 3, "max_cost": 0}}
    pin = seal(r)
    result = {"registration_pin": pin,
              "evaluator_pin": r["evaluator_pin"], "heldout_digest": r["heldout_digest"],
              "baseline": {"pin": r["baseline_pin"], "quality": .6, "attempts": 2, "cost": 0},
              "candidate": {"pin": r["candidate_pin"], "quality": .9, "attempts": 1, "cost": 0},
              "beneficialness": "no-unresolved-concerns"}
    return r, pin, result


class PreflightChecks(unittest.TestCase):
    def test_even_passing_export_does_not_authorize_adoption(self):
        r, pin, result = fixture()
        result["adopter"] = "Quinn"
        result["reviews"] = ["accepted"]
        report = assess(r, pin, result)
        self.assertEqual(report["status"], "ready-for-independent-review")
        self.assertFalse(report["adoption_authorized"])
        self.assertEqual(report["recursive_improvement"], "unproven")

    def test_threshold_tampering_refused(self):
        r, pin, result = fixture()
        r["thresholds"]["min_quality"] = 0
        with self.assertRaises(ValueError):
            assess(r, pin, result)

    def test_revision_substitution_refused(self):
        r, pin, result = fixture()
        result["candidate"]["pin"] = digest("substituted")
        with self.assertRaises(ValueError):
            assess(r, pin, result)

    def test_evaluator_and_dataset_substitution_refused(self):
        for field in ("evaluator_pin", "heldout_digest"):
            r, pin, result = fixture()
            result[field] = digest("substituted")
            with self.assertRaises(ValueError):
                assess(r, pin, result)

    def test_fast_low_quality_candidate_held(self):
        r, pin, result = fixture()
        result["candidate"]["quality"] = .2
        self.assertEqual(assess(r, pin, result)["status"], "held")

    def test_unresolved_beneficialness_held(self):
        r, pin, result = fixture()
        result["beneficialness"] = "unknown"
        self.assertIn("beneficialness unresolved", assess(r, pin, result)["reasons"])

    def test_caps_enforced(self):
        r, pin, result = fixture()
        result["candidate"]["attempts"] = 4
        self.assertEqual(assess(r, pin, result)["status"], "held")

    def test_invalid_measurements_refused(self):
        for value in (float("nan"), float("inf"), True, -1, 2):
            r, pin, result = fixture()
            result["candidate"]["quality"] = value
            with self.assertRaises(ValueError):
                assess(r, pin, result)

    def test_objective_change_refused(self):
        r, _, _ = fixture()
        r["objective"] = "maximize acceptance"
        with self.assertRaises(ValueError):
            seal(r)


if __name__ == "__main__":
    unittest.main()
