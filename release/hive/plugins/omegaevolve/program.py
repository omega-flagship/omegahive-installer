"""OmegaEvolve's contribution and experiment graph. Host authority stays outside knowledge."""
from hive.core.evolve_preflight import OBJECTIVE, digest
from hive.core.evolve_seed import seed_plan


def describe():
    return {"contract": "0.1",
            "kinds": [{"id": "objective", "label": "Objective", "role": "question"},
                      {"id": "seed", "label": "Initial evolving subject", "role": "other"},
                      {"id": "contribution", "label": "Contribution", "role": "claim"},
                      {"id": "experiment", "label": "Experiment", "role": "hypothesis"},
                      {"id": "qualification", "label": "Qualification", "role": "assessment"},
                      {"id": "benchmark", "label": "Benchmark registration", "role": "hypothesis"},
                      {"id": "benchmark-assessment", "label": "Imported benchmark assessment", "role": "assessment"}],
            "relations": [{"id": "advances", "label": "advances", "polarity": "neutral"},
                          {"id": "subject-of", "label": "evolves toward", "polarity": "neutral"},
                          {"id": "depends_on", "label": "depends on", "polarity": "neutral"},
                          {"id": "revises", "label": "revises", "polarity": "qualify"},
                          {"id": "references", "label": "references", "polarity": "neutral"}],
            "actions": [{"id": "contribute", "label": "Offer research", "applies_to": ["objective"], "agents": True},
                        {"id": "register", "label": "Register experiment", "applies_to": ["objective"]},
                        {"id": "lab-receipt", "label": "Record protocol qualification", "applies_to": ["experiment"]},
                        {"id": "register-benchmark", "label": "Register benchmark comparison", "applies_to": ["objective"]},
                        {"id": "attach-benchmark-receipt", "label": "Attach evaluator report receipt", "applies_to": ["benchmark"]},
                        {"id": "assess-benchmark", "label": "Assess imported task evidence", "applies_to": ["benchmark"]}]}


def view(ctx, focus, stage):
    snapshot = ctx.evolve_snapshot(focus)
    records = [entry["record"] for entry in snapshot]
    plan = seed_plan()
    # Figures are producer content shown with a recorded report; attaching one never changes the record itself.
    figures = ctx.evolve_figures() if hasattr(ctx, "evolve_figures") else {}
    items = [{"id": "objective", "kind": "objective", "label": OBJECTIVE}]
    for entry in snapshot:
        row, assessment = entry["record"], entry["assessment"]
        body = row["body"]
        items.append({"id": row["id"], "kind": row["kind"], "label": body.get("title", row["kind"]),
                      "status": assessment.get("status", "current"), "text": body.get("claim", body["state"]),
                      "flags": assessment.get("flags", []),
                      "uncertainty": {"method": "qualitative", "status": "unverified"},
                      "meta": dict(body, assessment=body.get("assessment", assessment),
                                   lineage_assessment=assessment)})
        if figures.get(row["id"]):
            items[-1]["figures"] = figures[row["id"]]
    items.extend({"id": "seed-" + seed["kind"], "kind": "seed", "label": seed["name"],
                  "status": "current", "text": "Initial evolving subject; runtime binding not recorded by this app.",
                  "meta": {"runtime_kind": seed["kind"], "phase": "planned", "provisioning": "unverified",
                           "budget": plan["budget"], "adoption_authorized": False}}
                 for seed in plan["members"])
    ids = {item["id"] for item in items}
    links = [{"id": row["id"] + "-objective", "from": row["id"], "to": "objective", "rel": "advances"} for row in records]
    links.extend({"id": "seed-" + seed["kind"] + "-objective", "from": "seed-" + seed["kind"],
                  "to": "objective", "rel": "subject-of"} for seed in plan["members"])
    for row in records:
        for target in row["body"].get("depends_on", []):
            if target in ids:
                links.append({"id": row["id"] + "-dep-" + target, "from": row["id"], "to": target, "rel": "depends_on"})
        parent = row["body"].get("predecessor")
        if parent in ids:
            relation = "revises" if row["body"].get("relation") in ("correction", "retraction") else "references"
            links.append({"id": row["id"] + "-rev-" + parent, "from": row["id"], "to": parent, "rel": relation})
    pinned = {"research": snapshot, "seed_plan": plan}
    if figures:                     # a hive with no figures keeps the revision it had before figures existed
        pinned["figures"] = figures
    return {"revision": digest(pinned), "title": "OmegaEvolve", "focus": focus if focus in ids else "objective",
            "suggested_stage": stage, "items": items,
            "links": links,
            "notes": ["Recorded claims confer no authority. Evidence custody is unresolved.",
                      "Protocol qualification is not measured improvement, independent review or adoption.",
                      "Native shared AtomSpace publication is not enabled by this candidate.",
                      "Omega and Iter are both initial evolving subjects. Planned subjects do not prove live provisioning."]}


def act(ctx, action, items, params):
    graph = view(ctx, params.get("focus"), params.get("stage") or "unfold")
    if params.get("base_revision") != graph["revision"]:
        return {"status": "stale", "message": "Reload the current research graph", "graph": graph}
    try:
        if action == "contribute" and items == ["objective"]:
            record = ctx.evolve_contribute(params.get("contribution") or {})
        elif action == "register" and items == ["objective"]:
            record = ctx.evolve_register(params.get("registration") or {})
        elif action == "register-benchmark" and items == ["objective"]:
            record = ctx.evolve_benchmark_register(params.get("registration") or {})
        elif action == "assess-benchmark" and len(items) == 1:
            record = ctx.evolve_benchmark_assess(items[0], params.get("export") or {})
        elif action == "attach-benchmark-receipt" and len(items) == 1:
            record = ctx.evolve_benchmark_receipt(items[0], params.get("export") or {}, params.get("receipt") or {})
        elif action == "lab-receipt" and len(items) == 1:
            record = ctx.evolve_lab_receipt(items[0], params.get("run_id"))
        else:
            return {"status": "refused", "message": "Choose the applicable research item"}
    except (ValueError, PermissionError) as exc:
        return {"status": "refused", "message": str(exc)}
    return {"status": "done", "message": "Research record retained; adoption is a separate host action",
            "detail": {"record_id": record["id"], "digest": record["digest"]},
            "graph": view(ctx, record["id"], "detail")}


def validate_result(ctx, goal, proposal):
    return {"errors": ["OmegaEvolve candidate evaluation and independent review are not yet wired; completion refused"]}
