"""OmegaEvolve's two initial subjects. Plans and metadata checks confer no authority."""
import re

from hive.core.evolve_preflight import OBJECTIVE, digest

SEEDS = {"omega": "OmegaEvolve Omega", "iter": "OmegaEvolve Iter"}


def seed_plan():
    """Operator-readable specification; never creates, starts, or grants a mind."""
    common = (
        f"Your shared objective is {OBJECTIVE}. You and your peer are both evolving subjects. "
        "Inspect your own runtime and reasoning, propose improvements to yourself and your peer, "
        "and contribute source-pinned hypotheses and uncertainty to the hive research commons. "
        "Keep your identity, memory and revision history separate. Shared knowledge is not shared authority. "
        "Use your own isolated candidate area; never rewrite the shared Omega core or another mind's files. "
        "Candidate selection must compare against the target's own pinned baseline and independent held-out evidence. "
        "Peer criticism is not independent adoption approval. The hive owner adopts changes to OmegaEvolve. "
        "The objective cannot self-amend. Preserve new memory deltas across rollback. "
        "Do not claim RSI from a proposal or a protocol test."
    )
    return {
        "schema": "omegaevolve-seed-pair/1", "objective": OBJECTIVE,
        "swarm": {"name": "OmegaEvolve", "visibility": "private"},
        "members": [dict(name=name, kind=kind, visibility="private", budget_usd=0.5,
                         persona=common + f" Your initial runtime kind is {kind}.")
                    for kind, name in SEEDS.items()],
        "budget": {"swarm_day_usd": 10.0, "bootstrap_agent_total_usd": 0.5,
                   "bootstrap_combined_usd": 1.0},
        "initial_state": "stopped", "iter_driver": "docker",
        "bootstrap": "Each mind inspects itself and proposes an improvement for itself and its peer; owner reviews.",
        "adoption_authorized": False,
    }


def inspect_pair(swarm_id, agents, budget_rules, source_pins):
    """Check current operator metadata before a bounded run. No credential fields copied.

    This is not a runtime isolation or source-custody proof. The operator must
    observe the sandbox and own candidate areas before starting the pair.
    """
    if not isinstance(swarm_id, str) or not re.fullmatch(r"s_[0-9a-f]{8}", swarm_id):
        raise ValueError("invalid research swarm id")
    errors = []
    members = [a for a in agents if a.get("swarm_id") == swarm_id]
    if len(members) != 2 or sorted(a.get("kind", "") for a in members) != ["iter", "omega"]:
        errors.append("research swarm requires exactly one Omega and one Iter")
    ids = [a.get("id") for a in members]
    if len(set(ids)) != len(ids) or any(not isinstance(i, str) or not re.fullmatch(r"a_[0-9a-f]{8}", i) for i in ids):
        errors.append("seed identities must be distinct native agent ids")
    for agent in members:
        if agent.get("status") not in {"created", "stopped"}:
            errors.append("all seeds must be stopped before bootstrap")
        if agent.get("kind") == "iter" and agent.get("driver") != "docker":
            errors.append("Iter requires the supported Docker isolation route")
        if agent.get("visibility") != "private":
            errors.append("initial seed visibility must be private")
        pin = source_pins.get(agent.get("id"))
        if not isinstance(pin, str) or not re.fullmatch(r"[0-9a-f]{64}", pin):
            errors.append("each subject requires its own source content pin")
    day = [r for r in budget_rules if r.get("scope") == f"swarm:{swarm_id}" and r.get("period") == "day"]
    if len(day) != 1 or day[0].get("limit_usd") != 10.0:
        errors.append("one combined $10/day swarm rule is required")
    for agent_id in ids:
        rules = [r for r in budget_rules if r.get("scope") == f"agent:{agent_id}" and r.get("period") == "total"]
        if len(rules) != 1 or rules[0].get("limit_usd") != 0.5:
            errors.append("each seed requires a $0.50 total bootstrap rule")
    # Only explicitly selected metadata can enter the receipt (never token/persona/options).
    subjects = [{k: a.get(k) for k in ("id", "kind", "status", "driver", "swarm_id")} |
                {"source_pin": source_pins.get(a.get("id"))} for a in members]
    subjects.sort(key=lambda a: str(a["id"]))
    receipt = {"schema": "omegaevolve-seed-observation/1", "objective": OBJECTIVE,
               "swarm_id": swarm_id, "subjects": subjects, "errors": sorted(set(errors)),
               "status": "metadata-qualified" if not errors else "held",
               "runtime_verified": False, "adoption_authorized": False}
    return dict(receipt, digest=digest(receipt))
