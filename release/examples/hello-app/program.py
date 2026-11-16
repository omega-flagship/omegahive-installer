"""Hello app: the smallest useful program for the program contract 0.1.

One invented question ("Which tea suits a late afternoon?") with a claim, two
pieces of evidence that pull in opposite directions, and one note. The data
lives in a Python dict in this process. Nothing is read from or written to
disk, and the example.org links go nowhere.

The three functions the host calls (see hive/PROGRAMS.md):
- describe(): the kinds, relations and actions this program offers;
- view(ctx, focus, stage): the work graph for one swarm;
- act(ctx, action, items, params): run one action and return a result.
"""

import copy

CONTRACT = "0.1"


def describe():
    return {
        "contract": CONTRACT,
        "kinds": [
            {"id": "question", "label": "Question", "role": "question"},
            {"id": "claim", "label": "Claim", "role": "claim"},
            {"id": "evidence", "label": "Evidence", "role": "evidence"},
            {"id": "note", "label": "Note", "role": "other"},
        ],
        "relations": [
            {"id": "answers", "label": "answers", "polarity": "neutral"},
            {"id": "supports", "label": "supports", "polarity": "support"},
            {"id": "contradicts", "label": "contradicts", "polarity": "oppose"},
            {"id": "about", "label": "about", "polarity": "neutral"},
        ],
        "actions": [
            {"id": "inspect-source", "label": "Open source", "applies_to": ["evidence"]},
            {"id": "add-note", "label": "Add note", "applies_to": ["question", "claim", "evidence"],
             "params": {"text": "what the note says"}},
        ],
    }


def _seed():
    items = [
        {"id": "q1", "kind": "question", "label": "Which tea suits a late afternoon?"},
        {"id": "c1", "kind": "claim", "label": "A caffeine-free herbal tea suits a late afternoon",
         "uncertainty": {"method": "qualitative", "status": "plausible"}},
        {"id": "e1", "kind": "evidence", "label": "Tasting notes say herbal tea does not keep people awake",
         "sources": [{"id": "s-notes", "label": "Invented tasting notes", "kind": "document",
                      "url": "https://example.org/tea/tasting-notes", "status": "retrieved"}]},
        {"id": "e2", "kind": "evidence", "label": "A shop card says green tea is a good afternoon lift",
         "sources": [{"id": "s-card", "label": "Invented shop card", "kind": "document",
                      "url": "https://example.org/tea/shop-card", "status": "cited"}]},
    ]
    links = [
        {"id": "l1", "from": "c1", "to": "q1", "rel": "answers"},
        {"id": "l2", "from": "e1", "to": "c1", "rel": "supports"},
        {"id": "l3", "from": "e2", "to": "c1", "rel": "contradicts"},
    ]
    return {"n": 1, "items": items, "links": links, "notes": 0}


STATE = {}  # swarm id -> this swarm's records. A real program keeps its own store.


def _state(ctx):
    return STATE.setdefault(getattr(ctx, "swarm_id", "local"), _seed())


def _graph(state, focus=None, stage="unfold"):
    return {"revision": f"r{state['n']}", "focus": focus or "q1", "title": "Hello app (invented tea question)",
            "suggested_stage": stage, "items": copy.deepcopy(state["items"]), "links": copy.deepcopy(state["links"]),
            "groups": [{"id": "evidence", "label": "Evidence", "items": ["e1", "e2"]}],
            "notes": ["Invented data. Sources are example.org placeholders."]}


def view(ctx, focus, stage):
    state = _state(ctx)
    ids = {i["id"] for i in state["items"]}
    return _graph(state, focus if focus in ids else None, stage)


def act(ctx, action, items, params):
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
                "message": "references only: opening a link is up to the person"}
    if action == "add-note":
        text = str(params.get("text") or "").strip()
        if not text:
            return {"status": "needs_input", "message": "say what the note says", "needs": {"text": "what the note says"}}
        state["notes"] += 1
        note_id = f"n{state['notes']}"
        state["items"].append({"id": note_id, "kind": "note", "label": text[:200]})
        state["links"].append({"id": f"l-{note_id}", "from": note_id, "to": targets[0]["id"], "rel": "about"})
        state["n"] += 1
        return {"status": "done", "graph": _graph(state, note_id, "detail"), "message": f"added {note_id}"}
    return {"status": "refused", "message": f"unknown action {action}"}
