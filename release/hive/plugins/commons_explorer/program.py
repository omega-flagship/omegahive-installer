"""Commons Explorer: a mind program over the swarm's own shared beliefs.

Items:
- the overview question;
- each belief in the commons, as a claim;
- each report that went into it, as evidence (one per assertion, with the mind
  as its source);
- beliefs that say something else about the same subject, as rivals;
- gaps, such as a belief resting on a single independent source.

Uncertainty is the commons' own NAL truth value. Reports that share
evidential stamps get the same origin, so echoes cannot pass as
independent support.
"""

import hashlib
import json

from hive.spaces import sexpr

CONTRACT = "0.1"
OVERVIEW = "overview"
MAX_BELIEFS = 120


def describe():
    return {
        "contract": CONTRACT,
        "kinds": [
            {"id": "question", "label": "Question", "role": "question"},
            {"id": "belief", "label": "Shared belief", "role": "claim"},
            {"id": "report", "label": "Report", "role": "evidence"},
            {"id": "rival", "label": "Rival belief", "role": "hypothesis"},
            {"id": "gap", "label": "Missing research", "role": "gap"},
        ],
        "relations": [
            {"id": "answers", "label": "answers", "polarity": "neutral"},
            {"id": "supports", "label": "supports", "polarity": "support"},
            {"id": "contradicts", "label": "contradicts", "polarity": "oppose"},
            {"id": "rivals", "label": "says otherwise about the same subject", "polarity": "oppose"},
            {"id": "shares-term", "label": "shares a term with", "polarity": "neutral"},
            {"id": "qualifies", "label": "qualifies", "polarity": "qualify"},
        ],
        "actions": [
            {"id": "inspect-source", "label": "Open source", "applies_to": ["report"]},
            {"id": "compare", "label": "Compare", "applies_to": ["belief", "rival"], "stage": "compare"},
            {"id": "challenge", "label": "Look for counterevidence", "applies_to": ["belief", "rival"]},
            {"id": "investigate-gap", "label": "Research this", "applies_to": ["gap"]},
        ],
    }


# ---- helpers -----------------------------------------------------------------------------------

def bid(statement):
    return f"b:{statement}"


def terms(statement):
    try:
        parsed = sexpr.parse(statement)
    except ValueError:
        return []
    out = []

    def walk(node):
        if isinstance(node, list):
            for child in node[1:] if node and isinstance(node[0], str) else node:
                walk(child)
        elif isinstance(node, str):
            out.append(node)
    walk(parsed)
    return out


def subject(statement):
    found = terms(statement)
    return found[0] if found else None


def nal(tv):
    return {"method": "nal", "f": round(float(tv["f"]), 6), "c": round(float(tv["c"]), 6)}


def revision_of(beliefs):
    digest = hashlib.sha1(json.dumps([(b["statement"], b["tv"], b["stamp"]) for b in beliefs],
                                     sort_keys=True).encode()).hexdigest()
    return f"c-{digest[:10]}"


def belief_item(b, kind="belief", names=None):
    names = names or {}
    sources = [{"id": f"dot:{a}", "label": names.get(a, a), "kind": "dot", "status": "cited", "origin": f"dot:{a}"}
               for a in b.get("sources", [])]
    return {"id": bid(b["statement"]), "kind": kind, "label": b["statement"], "uncertainty": nal(b["tv"]),
            "sources": sources, "at": b.get("updated_at"),
            "weight": b["tv"]["c"], "meta": {"stamp": b["stamp"], "independent_sources": len(b.get("sources", []))}}


def gaps_for(b):
    out = []
    if len(b.get("sources", [])) <= 1:
        out.append(("single", f"Only one independent source for {b['statement']}"))
    if b["tv"]["c"] >= 0.5 and abs(b["tv"]["f"] - 0.5) < 0.15:
        out.append(("ambiguous", f"Evidence is split on {b['statement']}"))
    elif b["tv"]["c"] < 0.4:
        out.append(("weak", f"Low confidence in {b['statement']}"))
    return out


def gap_item(b, key, label):
    return {"id": f"gap:{key}:{b['statement']}", "kind": "gap", "label": label,
            "meta": {"statement": b["statement"], "reason": key}}


# ---- views -------------------------------------------------------------------------------------

def view(ctx, focus, stage):
    beliefs = ctx.beliefs()[:MAX_BELIEFS]
    names = {a["id"]: a["name"] for a in ctx.agents()}
    rev = revision_of(beliefs)
    by_id = {bid(b["statement"]): b for b in beliefs}
    owner = _owner(focus, by_id)
    if owner:
        graph = _map(ctx, beliefs, owner, names, rev) if stage == "map" else \
            _belief(ctx, beliefs, owner, names, rev, stage)
        if focus in {i["id"] for i in graph["items"]}:
            graph["focus"] = focus           # keep the item the person asked for in focus
        return graph
    graph = _overview(ctx, beliefs, names, rev)
    if focus and focus != OVERVIEW:
        graph["notes"].append(f"{focus} is no longer in the commons; showing the overview.")
    return graph


def _owner(focus, by_id):
    """The belief a focus belongs to: a belief itself, one of its reports, or one of its gaps."""
    if not focus:
        return None
    if focus in by_id:
        return by_id[focus]
    if focus.startswith("r:"):
        return by_id.get(bid(focus[2:].rsplit(":", 1)[0]))
    if focus.startswith("gap:"):
        return by_id.get(bid(focus.split(":", 2)[2]))
    return None


def _overview(ctx, beliefs, names, rev):
    question = {"id": OVERVIEW, "kind": "question", "label": f"What does {ctx.swarm['name']} believe?",
                "text": f"{len(beliefs)} shared beliefs in this swarm's commons."}
    items, links, gaps = [question], [], []
    for b in beliefs:
        item = belief_item(b, names=names)
        items.append(item)
        links.append({"from": item["id"], "to": OVERVIEW, "rel": "answers", "weight": b["tv"]["c"]})
        for key, label in gaps_for(b):
            g = gap_item(b, key, label)
            items.append(g)
            gaps.append(g["id"])
            links.append({"from": g["id"], "to": item["id"], "rel": "qualifies"})
    well = [bid(b["statement"]) for b in beliefs if len(b.get("sources", [])) >= 2 and b["tv"]["c"] >= 0.6]
    groups = [{"id": "agreement", "label": "Well supported (two or more independent minds)", "items": well},
              {"id": "gap", "label": "Missing research", "items": gaps}]
    notes = [] if beliefs else ["This swarm's commons is empty. Minds add beliefs with hive-publish."]
    return {"revision": rev, "focus": OVERVIEW, "title": question["label"], "suggested_stage": "unfold",
            "items": items, "links": links, "groups": [g for g in groups if g["items"]], "notes": notes}


def _rivals(beliefs, b):
    subj = subject(b["statement"])
    return [o for o in beliefs if o["statement"] != b["statement"] and subj and subject(o["statement"]) == subj]


def _belief(ctx, beliefs, b, names, rev, stage):
    focus = bid(b["statement"])
    detail = ctx.belief(b["statement"]) or {"assertions": []}
    items, links = [belief_item(b, names=names)], []
    for n, a in enumerate(detail.get("assertions", [])):
        origin = "stamp:" + ",".join(sorted(a["stamp"]))
        item = {"id": f"r:{b['statement']}:{n}", "kind": "report",
                "label": f"{names.get(a['agent_id'], a['agent_id'])} reported f={a['tv']['f']:g} c={a['tv']['c']:g}",
                "text": f"Outcome in the commons: {a['outcome']}.", "uncertainty": nal(a["tv"]), "at": a["created_at"],
                "sources": [{"id": f"dot:{a['agent_id']}", "label": names.get(a["agent_id"], a["agent_id"]),
                             "kind": "dot", "status": "cited", "date": a["created_at"][:10], "origin": origin,
                             "locator": "evidence " + ", ".join(a["stamp"])}],
                "status": "superseded" if a["outcome"] in ("kept", "denied") else "current",
                "weight": a["tv"]["c"], "meta": {"outcome": a["outcome"], "stamp": a["stamp"]}}
        items.append(item)
        links.append({"from": item["id"], "to": focus, "rel": "supports" if a["tv"]["f"] >= 0.5 else "contradicts",
                      "weight": a["tv"]["c"]})
    rivals = _rivals(beliefs, b)
    for o in rivals:
        r = belief_item(o, kind="rival", names=names)
        items.append(r)
        links.append({"from": r["id"], "to": focus, "rel": "rivals", "weight": o["tv"]["c"]})
    gaps = []
    for key, label in gaps_for(b):
        g = gap_item(b, key, label)
        items.append(g)
        gaps.append(g["id"])
        links.append({"from": g["id"], "to": focus, "rel": "qualifies"})
    support = [i["id"] for i, link in zip(items[1:], links) if link["rel"] == "supports"]
    oppose = [link["from"] for link in links if link["rel"] in ("contradicts", "rivals")]
    groups = [{"id": "agreement", "label": "Supports it", "items": [focus] + support},
              {"id": "conflict", "label": "Against it or says otherwise", "items": oppose},
              {"id": "gap", "label": "Missing research", "items": gaps}]
    return {"revision": rev, "focus": focus, "title": b["statement"], "suggested_stage": stage,
            "items": items, "links": links, "groups": [g for g in groups if g["items"]],
            "notes": ["Reports from minds that share evidence carry the same origin; they are not independent."]}


def _map(ctx, beliefs, b, names, rev):
    focus = bid(b["statement"])
    seen, frontier, items, links = {focus}, [b], [belief_item(b, names=names)], []
    index = {}
    for o in beliefs:
        for t in set(terms(o["statement"])):
            index.setdefault(t, []).append(o)
    for _depth in range(2):
        nxt = []
        for cur in frontier:
            for t in set(terms(cur["statement"])):
                for o in index.get(t, []):
                    oid = bid(o["statement"])
                    if oid == bid(cur["statement"]) or len(items) >= 80:
                        continue
                    if oid not in seen:
                        seen.add(oid)
                        items.append(belief_item(o, names=names))
                        nxt.append(o)
                    link = {"id": f"{bid(cur['statement'])}|shares-term|{oid}", "from": bid(cur["statement"]),
                            "to": oid, "rel": "shares-term", "weight": 0.5}
                    if not any(x["id"] == link["id"] for x in links) and \
                            not any(x["id"] == f"{oid}|shares-term|{bid(cur['statement'])}" for x in links):
                        links.append(link)
        frontier = nxt
    return {"revision": rev, "focus": focus, "title": f"Around {b['statement']}", "suggested_stage": "map",
            "items": items, "links": links, "groups": [], "notes": ["Linked by shared terms, two steps out."]}


# ---- actions -----------------------------------------------------------------------------------

async def act(ctx, action, items, params):
    beliefs = ctx.beliefs()[:MAX_BELIEFS]
    names = {a["id"]: a["name"] for a in ctx.agents()}
    rev = revision_of(beliefs)
    if params.get("base_revision") and params["base_revision"] != rev:
        return {"status": "stale", "message": "the commons changed; nothing was done",
                "graph": view(ctx, params.get("focus"), params.get("stage") or "unfold")}
    by_id = {bid(b["statement"]): b for b in beliefs}
    if action == "inspect-source":
        statement = items[0][2:].rsplit(":", 1)[0] if items and items[0].startswith("r:") else None
        detail = ctx.belief(statement) if statement else None
        if not detail:
            return {"status": "refused", "message": "choose a report"}
        n = int(items[0].rsplit(":", 1)[1])
        a = detail["assertions"][n]
        return {"status": "done", "detail": {"sources": [{
            "id": f"dot:{a['agent_id']}", "label": names.get(a["agent_id"], a["agent_id"]), "kind": "dot",
            "status": "inspected", "date": a["created_at"], "locator": "evidence " + ", ".join(a["stamp"]),
            "origin": "stamp:" + ",".join(sorted(a["stamp"])),
            "record": {"statement": a["statement"], "tv": a["tv"], "outcome": a["outcome"]}}]}}
    chosen = [by_id[i] for i in items if i in by_id]
    if action == "compare":
        if len(chosen) < 2:
            return {"status": "needs_input", "message": "choose two or more beliefs to compare",
                    "needs": {"items": "two or more beliefs"}}
        cmp_items, links, groups = [], [], []
        for b in chosen:
            graph = _belief(ctx, beliefs, b, names, rev, "compare")
            have = {i["id"] for i in cmp_items}
            cmp_items += [i for i in graph["items"] if i["id"] not in have]
            have_links = {(x["from"], x["rel"], x["to"]) for x in links}
            links += [x for x in graph["links"] if (x["from"], x["rel"], x["to"]) not in have_links]
            for g in graph["groups"]:
                groups.append({"id": f"{g['id']}:{b['statement']}", "label": f"{g['label']}: {b['statement']}",
                               "items": g["items"]})
        return {"status": "done", "graph": {"revision": rev, "focus": bid(chosen[0]["statement"]),
                                            "selected": [bid(b["statement"]) for b in chosen],
                                            "title": "Comparing " + " vs ".join(b["statement"] for b in chosen),
                                            "suggested_stage": "compare", "items": cmp_items, "links": links,
                                            "groups": groups, "notes": ["Disagreement is kept side by side."]}}
    if action in ("challenge", "investigate-gap"):
        if action == "investigate-gap":
            statement = items[0].split(":", 2)[2] if items and items[0].startswith("gap:") else None
            if not statement:
                return {"status": "refused", "message": "choose a gap"}
            title = f"Research: {statement} needs more independent evidence"
        else:
            if not chosen:
                return {"status": "refused", "message": "choose a belief"}
            title = f"Find counterevidence for {chosen[0]['statement']}"
        goal = await ctx.create_goal(title, "Opened from Commons Explorer")
        return {"status": "started", "task": {"id": goal["id"], "kind": "goal", "status": goal["status"]},
                "message": f"posted goal {goal['id']} to the swarm"}
    return {"status": "refused", "message": f"unknown action {action}"}
