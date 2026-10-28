"""bench-epistemic: Epistemic Resolve (Crawford & Hammer, AGI-26) against the hive commons.

The harness (github.com/khellar/epistemic-resolve, Apache-2.0) feeds a belief
store a sequence of evidence from sources of different trust and scores the
stored verdict at every step: correction latency, corruption susceptibility,
retention and recovery.

Our backend sends every step through the real swarm commons. Each source is
its own mind, so independent sources revise and a repeated source cannot.
Evidence is published with confidence = source trust, and the verdict is read
back from the commons truth value.

Steps are text, and this backend has no language model. Each step's polarity
(supports, contradicts, or carries no evidence about the claim) is
hand-annotated in POLARITY below. This measures the commons' update
discipline, not reading comprehension.
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
import time

from .harness import metric, scratch_hive, series
from .protocol import emit

DEFAULT_ROOT = pathlib.Path(__file__).resolve().parents[3] / "research" / "khellar" / "epistemic-resolve"

# +1 supports the focal claim, -1 contradicts it, 0 carries no evidence (probes, delays).
POLARITY = {
    "correction_insurance_coverage_001": [+1, -1, 0],
    "corruption_tea_house_hours_001": [+1, -1, -1, -1],
    "provenance_bookshop_payment_001": [-1, +1],
    "recovery_package_delivery_001": [+1, -1, +1],
    "retention_family_allergy_001": [+1, -1, 0, 0],
}
COMMIT_CONFIDENCE = 0.6
PREDICTIONS: list = []  # filled step by step by _commons_trace  # below this the commons holds a belief but does not commit to it


def verdict(tv):
    if tv is None:
        return "provisional"
    f, c = tv["f"], tv["c"]
    if c >= COMMIT_CONFIDENCE and f >= 0.6:
        return "accept"
    if c >= COMMIT_CONFIDENCE and f <= 0.4:
        return "reject"
    return "quarantine"


def root():
    return pathlib.Path(os.environ.get("HIVE_EPISTEMIC_RESOLVE", DEFAULT_ROOT))


def available():
    return (root() / "eval" / "metrics.py").exists()


def _harness():
    sys.path.insert(0, str(root() / "eval"))
    import metrics  # noqa: E402
    from backends.base import Step  # noqa: E402
    from backends.mock import MockBypassBackend, MockPerfectResolveBackend, MockProvenanceBackend  # noqa: E402
    return metrics, Step, {"mock-perfect-resolve": MockPerfectResolveBackend, "mock-bypass": MockBypassBackend,
                           "mock-provenance": MockProvenanceBackend}


def _scenarios():
    return [json.loads(p.read_text()) for p in sorted((root() / "seeds").rglob("*.json"))]


def _commons_trace(scenario):
    """Run one scenario through a fresh swarm commons; returns (statuses, confidence points)."""
    statement = "(--> focal-claim holds)"
    with scratch_hive() as b:
        swarm = b.swarm(scenario["scenario_id"][:40])
        dots = {}
        statuses, points = [], []
        for step, polarity in zip(scenario["steps"], POLARITY[scenario["scenario_id"]]):
            if polarity:
                source = step.get("source_id", "unknown")
                if source not in dots:
                    (dots[source],) = b.agents(swarm, 1, name=f"src-{source}"[:40])
                trust = min(0.99, max(0.01, float(step.get("source_trust", 0.5))))
                b.publish(dots[source], statement, 1.0 if polarity > 0 else 0.0, trust)
            belief = b.belief(swarm, statement)
            tv = belief["tv"] if belief else None
            statuses.append(verdict(tv))
            points.append((step["t"], tv["f"] if tv else 0.5))
            # NAL expectation: the commons' probability that the claim is true.
            PREDICTIONS.append((tv["c"] * (tv["f"] - 0.5) + 0.5) if tv else 0.5)
        return statuses, points


def run():
    if not available():
        emit("case", id="bench-epistemic::harness", name="Epistemic Resolve", group="epistemic", status="skipped",
             duration_ms=0, message="clone github.com/khellar/epistemic-resolve and set HIVE_EPISTEMIC_RESOLVE")
        return "skipped"
    metrics, Step, mocks = _harness()
    scenarios = _scenarios()
    worst = "passed"
    summaries = {}
    forecasts = []  # (probability the claim is true, what was warranted) for the Brier score
    for backend in ["omegadots-commons", *mocks]:
        start = time.perf_counter()
        rows = []
        for scenario in scenarios:
            target = [x["target_status"] for x in scenario["target_status_timeline"]]
            if backend == "omegadots-commons":
                PREDICTIONS.clear()
                actual, points = _commons_trace(scenario)
                for p, want in zip(PREDICTIONS, target):
                    if want in ("accept", "reject"):
                        forecasts.append((p, 1.0 if want == "accept" else 0.0))
            else:
                impl = mocks[backend]()
                history, actual = [], []
                for raw in scenario["steps"]:
                    step = Step.from_dict(raw)
                    actual.append(impl.predict(scenario, step, history).status)
                    history.append(step)
                points = None
            result = dict(metrics.evaluate_status_trace(actual, target), scenario_id=scenario["scenario_id"],
                          family=scenario["family"])
            rows.append(result)
            if backend == "omegadots-commons":
                ok = result["recovery_score"] == 1.0
                emit("case", id=f"bench-epistemic::{scenario['scenario_id']}",
                     name=f"{scenario['family'].title()}: {scenario['claim']}", group="epistemic scenarios", dimension="accuracy",
                     status="passed" if ok else "failed",
                     duration_ms=0, notes=" → ".join(f"{a} (want {t})" for a, t in zip(actual, target)),
                     message=None if ok else "ended on the wrong verdict",
                     metrics=[metric("retention", result["retention_score"], "", "higher"),
                              metric("corruption", result["corruption_susceptibility"], "", "lower"),
                              metric("recovery", result["recovery_score"], "", "higher", 1)],
                     series=[series("commons frequency (1 = claim true)", points, "", "step", "t")])
        summary = metrics.suite_summary(rows)
        summaries[backend] = summary
        ours = backend == "omegadots-commons"
        values = [metric("correction latency", summary["mean_correction_latency"] or 0, "steps", "lower",
                         0.4 if ours else None),
                  metric("corruption susceptibility", summary["mean_corruption_susceptibility"], "", "lower",
                         0.12 if ours else None),
                  metric("retention", summary["mean_retention_score"], "", "higher", 0.88 if ours else None),
                  metric("recovery", summary["mean_recovery_score"], "", "higher", 1.0 if ours else None)]
        failing = [m["name"] for m in values if m["ok"] is False]
        status = "failed" if failing else "passed"
        if ours:
            worst = status
        emit("case", id=f"bench-epistemic::{backend}", name=f"Suite score: {backend}", group="epistemic suite", dimension="accuracy",
             status=status, duration_ms=round((time.perf_counter() - start) * 1000, 1),
             message=f"behind mock-provenance on: {', '.join(failing)}" if failing else None,
             notes=("Our swarm commons. Targets are the mock-provenance row of the paper's Table 1."
                    if ours else "Calibration mock shipped with the harness; reproduces Table 1 of the paper."),
             metrics=values)
    _emit_brier(forecasts)
    emit("log", text="epistemic summary " + json.dumps(summaries, default=str))
    return worst


def _emit_brier(forecasts):
    """Prediction reliability: Brier score and calibration of the commons' beliefs."""
    if not forecasts:
        return
    brier = sum((p - o) ** 2 for p, o in forecasts) / len(forecasts)
    bins = []
    for lo in (0.0, 0.2, 0.4, 0.6, 0.8):
        inside = [(p, o) for p, o in forecasts if lo <= p < lo + 0.2 or (lo == 0.8 and p == 1.0)]
        if inside:
            bins.append((sum(p for p, _ in inside) / len(inside), sum(o for _, o in inside) / len(inside)))
    calibration_error = sum(abs(p - o) for p, o in bins) / len(bins) if bins else 0.0
    emit("case", id="bench-epistemic::brier", name="Prediction reliability (Brier score)",
         group="epistemic suite", dimension="accuracy", status="passed" if brier <= 0.1 else "failed",
         duration_ms=0, message=None if brier <= 0.1 else "Brier score above 0.1",
         notes="Each step's commons belief read as a probability (NAL expectation) and scored against the "
               "warranted verdict. 0 is perfect; 0.25 is a coin flip. Steps whose warranted verdict is "
               "quarantine or provisional are left out.",
         metrics=[metric("Brier score", brier, "", "lower", 0.1),
                  metric("Brier skill vs coin flip", 1 - brier / 0.25, "", "higher", 0.5),
                  metric("calibration error", calibration_error, "", "lower"),
                  metric("forecasts scored", len(forecasts), "", "higher")],
         series=[series("calibration (observed vs predicted)", bins, "", "line", "predicted probability"),
                 series("perfect calibration", [(0, 0), (1, 1)], "", "line", "predicted probability")])
