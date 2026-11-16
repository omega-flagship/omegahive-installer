"""Contract 0.1 fixture: one synthetic, public question.

"Is the Riverside footbridge rated for 5-tonne loads?" It has two supporting
reports that share one origin, one independent piece of counterevidence, a
rival hypothesis, an assessment and a research gap. It answers inspect-source,
compare, challenge, investigate-gap and correct. A correction keeps every id,
records the prior revision, and flags the conclusions that depended on it.

Everything here is invented for testing; example.org links go nowhere.
"""

import copy
import datetime

CONTRACT = "0.1"


def describe():
    return {
        "contract": CONTRACT,
        "kinds": [
            {"id": "question", "label": "Question", "role": "question"},
            {"id": "claim", "label": "Claim", "role": "claim"},
            {"id": "evidence", "label": "Evidence", "role": "evidence"},
            {"id": "hypothesis", "label": "Hypothesis", "role": "hypothesis"},
            {"id": "assessment", "label": "Assessment", "role": "assessment"},
            {"id": "gap", "label": "Gap", "role": "gap"},
        ],
        "relations": [
            {"id": "answers", "label": "answers", "polarity": "neutral"},
            {"id": "supports", "label": "supports", "polarity": "support"},
            {"id": "contradicts", "label": "contradicts", "polarity": "oppose"},
            {"id": "qualifies", "label": "qualifies", "polarity": "qualify"},
            {"id": "depends_on", "label": "depends on", "polarity": "neutral"},
        ],
        "actions": [
            {"id": "inspect-source", "label": "Open source", "applies_to": ["evidence"]},
            {"id": "compare", "label": "Compare", "applies_to": ["claim", "hypothesis"], "stage": "compare"},
            {"id": "challenge", "label": "Challenge", "applies_to": ["claim", "assessment"]},
            {"id": "investigate-gap", "label": "Investigate", "applies_to": ["gap"]},
            {"id": "correct", "label": "Correct", "applies_to": ["evidence"],
             "params": {"text": "the corrected wording", "note": "why it changed"}},
        ],
    }


SOURCES = {
    "s-inspection": {"id": "s-inspection", "label": "Council inspection report 2024", "kind": "document",
                     "url": "https://example.org/riverside/inspection-2024.pdf", "date": "2024-03-12",
                     "locator": "p. 4, table 2", "status": "inspected", "origin": "riverside-council"},
    "s-press": {"id": "s-press", "label": "Council press release", "kind": "document",
                "url": "https://example.org/riverside/press-2024-04.html", "date": "2024-04-02",
                "locator": "paragraph 3", "status": "retrieved", "origin": "riverside-council"},
    "s-blog": {"id": "s-blog", "label": "Structural engineering blog post", "kind": "document",
               "url": "https://example.org/engineering/riverside-after-the-flood", "date": "2025-11-20",
               "locator": "section 'Load rating'", "status": "retrieved", "origin": "independent-engineer"},
}


def _seed():
    items = [
        {"id": "q1", "kind": "question", "label": "Is the Riverside footbridge rated for 5-tonne loads?"},
        {"id": "c1", "kind": "claim", "label": "The footbridge is rated for 5 t",
         "uncertainty": {"method": "nal", "f": 0.8, "c": 0.55}},
        {"id": "e1", "kind": "evidence", "label": "Inspection report lists a 5 t rating",
         "sources": [SOURCES["s-inspection"]], "uncertainty": {"method": "nal", "f": 0.9, "c": 0.8}},
        {"id": "e2", "kind": "evidence", "label": "Press release repeats the 5 t rating",
         "sources": [SOURCES["s-press"]], "uncertainty": {"method": "nal", "f": 0.9, "c": 0.5},
         "meta": {"note": "same origin as e1; not independent"}},
        {"id": "e3", "kind": "evidence", "label": "Engineer reports the rating was cut to 3 t after the 2025 flood",
         "sources": [SOURCES["s-blog"]], "uncertainty": {"method": "qualitative", "status": "unverified"}},
        {"id": "h1", "kind": "hypothesis", "label": "The rating was reduced after the flood"},
        {"id": "a1", "kind": "assessment", "label": "Contested: both supporting reports share one origin",
         "uncertainty": {"method": "qualitative", "status": "contested"}},
        {"id": "g1", "kind": "gap", "label": "No inspection after the 2025 flood has been found"},
    ]
    links = [
        {"id": "l1", "from": "c1", "to": "q1", "rel": "answers"},
        {"id": "l2", "from": "h1", "to": "q1", "rel": "answers"},
        {"id": "l3", "from": "e1", "to": "c1", "rel": "supports", "weight": 0.8},
        {"id": "l4", "from": "e2", "to": "c1", "rel": "supports", "weight": 0.3},
        {"id": "l5", "from": "e3", "to": "c1", "rel": "contradicts", "weight": 0.6},
        {"id": "l6", "from": "e3", "to": "h1", "rel": "supports", "weight": 0.6},
        {"id": "l7", "from": "c1", "to": "e1", "rel": "depends_on"},
        {"id": "l8", "from": "a1", "to": "c1", "rel": "qualifies"},
        {"id": "l9", "from": "g1", "to": "a1", "rel": "qualifies"},
    ]
    groups = [
        {"id": "agreement", "label": "Supports a 5 t rating", "items": ["c1", "e1", "e2"]},
        {"id": "conflict", "label": "Points to a lower rating", "items": ["e3", "h1"]},
        {"id": "common-origin", "label": "Same origin: Riverside council", "items": ["e1", "e2"]},
        {"id": "gap", "label": "Missing research", "items": ["g1"]},
    ]
    return {"n": 1, "items": items, "links": links, "groups": groups, "tasks": {}}


STATE = {}  # swarm id -> the fixture's records; a real program keeps its own private store


def _state(ctx):
    return STATE.setdefault(getattr(ctx, "swarm_id", "local"), _seed())


def _graph(state, focus=None, stage="unfold"):
    return {"revision": f"r{state['n']}", "focus": focus or "q1",
            "title": "Riverside footbridge load rating (synthetic fixture)",
            "suggested_stage": stage, "items": copy.deepcopy(state["items"]),
            "links": copy.deepcopy(state["links"]), "groups": copy.deepcopy(state["groups"]),
            "notes": ["Synthetic test data. Sources are example.org placeholders."]}


def view(ctx, focus, stage):
    return _graph(_state(ctx), focus, stage)


async def act(ctx, action, items, params):
    state = _state(ctx)
    base = params.get("base_revision")
    if base and base != f"r{state['n']}":
        return {"status": "stale", "message": f"the view changed (now r{state['n']}); reload and try again",
                "graph": _graph(state)}
    by_id = {i["id"]: i for i in state["items"]}
    targets = [by_id[i] for i in items if i in by_id]
    if not targets:
        return {"status": "refused", "message": "choose at least one item from this view"}
    if action == "inspect-source":
        sources = [s for t in targets for s in t.get("sources", [])]
        return {"status": "done", "detail": {"sources": sources},
                "message": "references only: opening a URL or local file is up to the person"}
    if action == "compare":
        return {"status": "done", "graph": _graph(state, targets[0]["id"], "compare")}
    if action in ("challenge", "investigate-gap"):
        title = ("Find counterevidence for: " if action == "challenge" else "Research: ") + targets[0]["label"]
        goal = await ctx.create_goal(title, f"Opened from the contract fixture on {targets[0]['id']}")
        return {"status": "started", "task": {"id": goal["id"], "kind": "goal", "status": goal["status"]},
                "message": f"posted goal {goal['id']} to the swarm"}
    if action == "correct":
        text = str(params.get("text") or "").strip()
        if not text:
            return {"status": "needs_input", "message": "say what the corrected evidence states",
                    "needs": {"text": "the corrected wording", "note": "why it changed"}}
        item = targets[0]
        item.setdefault("revisions", []).append({"revision": f"r{state['n']}", "label": item["label"],
                                                 "note": str(params.get("note") or ""),
                                                 "at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
        item["label"], item["status"] = text, "corrected"
        affected = [link["from"] for link in state["links"] if link["to"] == item["id"] and link["rel"] == "depends_on"]
        affected += [link["to"] for link in state["links"] if link["from"] == item["id"] and link["rel"] == "supports"]
        for other in state["items"]:
            if other["id"] in affected and "affected-by-correction" not in other.setdefault("flags", []):
                other["flags"].append("affected-by-correction")
        state["n"] += 1
        return {"status": "done", "graph": _graph(state, item["id"], "detail"),
                "message": f"corrected {item['id']}; {len(set(affected))} conclusions flagged for review"}
    return {"status": "refused", "message": f"unknown action {action}"}
