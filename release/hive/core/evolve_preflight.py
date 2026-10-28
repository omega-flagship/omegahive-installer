"""Offline experiment preflight. No host actions, model calls or adoption authority."""
import hashlib
import json
import math

OBJECTIVE = "RSI toward Beneficial General Intelligence and beneficial superintelligence"


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def seal(registration):
    """Produce a content pin; independent custody of this pin is a host responsibility."""
    r = registration
    if r.get("objective") != OBJECTIVE:
        raise ValueError("objective missing or changed")
    for key in ("baseline_pin", "candidate_pin", "evaluator_pin", "heldout_digest"):
        value = r.get(key)
        if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise ValueError(f"{key} must be a sha256 content pin")
    if r["baseline_pin"] == r["candidate_pin"]:
        raise ValueError("baseline and candidate must differ")
    if r.get("budget") != {"model_calls": 0, "network_calls": 0}:
        raise ValueError("this first preflight permits offline qualification only")
    for key in ("quality_rubric", "beneficialness_criteria", "stop_rule", "review_owners"):
        if not r.get(key):
            raise ValueError(f"missing {key}")
    thresholds = r.get("thresholds", {})
    if set(thresholds) != {"min_quality", "min_quality_gain", "max_attempts", "max_cost"}:
        raise ValueError("incomplete thresholds")
    for value in thresholds.values():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("thresholds must be finite numbers")
    if not 0 <= thresholds["min_quality"] <= 1 or not 0 <= thresholds["min_quality_gain"] <= 1:
        raise ValueError("quality thresholds must be in [0, 1]")
    if thresholds["max_attempts"] < 1 or thresholds["max_cost"] < 0:
        raise ValueError("invalid resource limits")
    return digest(r)


def assess(registration, registered_pin, result):
    """Check a Lab export. Self-reported scores remain unverified evidence."""
    if seal(registration) != registered_pin:
        raise ValueError("registration changed after sealing")
    if result.get("registration_pin") != registered_pin:
        raise ValueError("result belongs to a different experiment")
    for field in ("evaluator_pin", "heldout_digest"):
        if result.get(field) != registration[field]:
            raise ValueError(f"wrong {field}")
    thresholds = registration["thresholds"]
    reasons = []
    for arm in ("baseline", "candidate"):
        row = result.get(arm, {})
        if row.get("pin") != registration[f"{arm}_pin"]:
            raise ValueError(f"wrong {arm} revision")
        for field in ("quality", "attempts", "cost"):
            value = row.get(field)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"invalid {arm} {field}")
        if not 0 <= row["quality"] <= 1 or row["cost"] < 0 or row["attempts"] < 1 or int(row["attempts"]) != row["attempts"]:
            raise ValueError(f"out-of-range {arm} measurement")
        if row["attempts"] > thresholds["max_attempts"] or row["cost"] > thresholds["max_cost"]:
            reasons.append(f"{arm} exceeds resource limit")
    candidate, baseline = result["candidate"], result["baseline"]
    if candidate["quality"] < thresholds["min_quality"]:
        reasons.append("candidate quality below floor")
    if candidate["quality"] - baseline["quality"] < thresholds["min_quality_gain"]:
        reasons.append("quality gain below threshold")
    if result.get("beneficialness") != "no-unresolved-concerns":
        reasons.append("beneficialness unresolved")
    # These reports are not authenticated here; host review is always still required.
    return {"status": "held" if reasons else "ready-for-independent-review",
            "reasons": reasons, "adoption_authorized": False,
            "evidence_tier": "unverified-lab-export",
            "recursive_improvement": "unproven", "live_improvement": "unproven",
            "registration_pin": registered_pin, "result_digest": digest(result)}
