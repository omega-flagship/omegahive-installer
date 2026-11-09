"""Create plans: who builds and who reviews a piece, resolved over what exists in this hive (never hard-coded).

Jon 2026-11-08: "don't lock the team at 3 - some tasks may need the whole hive, or even multiple hives or random
specialist minds. We always generalise the rules." So the plan engine never names a team in Python. A piece carries an
assignee SELECTOR and this host resolver answers what it resolves to right now, or `assignee-unavailable`:

    ["team", swarm_id]            that swarm, if it exists and is not archived
    ["mind", agent_id]            that mind, if it exists and is not deleted
    ["capability", cap]           the hive's default resolution for cap (DATA: create_assignee_defaults), else open cap
    ["hive", hive_id, cap]        cap on that hive; this hive only until federation exists (shares.py: "federation
                                  comes later"), so another hive's id is assignee-unavailable (federation-not-available)
    ["open", cap]                 any team or mind offering cap: the hive's capability catalogue (collab.py
                                  capability_catalogue: swarm services and role media/mandates), the whole hive included
    a plain string                an artifact kind with no selector: the defaults table maps it (kind:design -> capability
                                  design, kind:code -> capability code); default_selector gives the planner's default.

Defaults are rows, not code. The seeded rows make slice 1 resolve exactly as today: design -> the person's Make (Studio)
mind's team (person_minds purpose studio_maker, studio_makers.py), code -> the foundation Create · Code team (person_minds
purpose foundation_create_code, foundation.py), review -> the foundation Review team (foundation_review). An owner may
change or add rows (e.g. a capability served by a specialist mind) without touching Python.

Review kinds are data too (create_review_for: artifact kind, review kind, the evidence it needs, who reviews), rendered
into the R4.1 Ctx as (ReviewFor artifact-kind review-kind evidence) atoms.
"""
from __future__ import annotations

import json

from .db import now

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS create_assignee_defaults (selector TEXT PRIMARY KEY, resolution TEXT NOT NULL,
  note TEXT, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS create_review_for (artifact_kind TEXT NOT NULL, review_kind TEXT NOT NULL,
  evidence TEXT NOT NULL, reviewer TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (artifact_kind, review_kind))""",
]

# Seed rows (INSERT OR IGNORE: an owner's edits are never overwritten). Each resolution is an ordered list of tries.
SEED_DEFAULTS = {
    # artifact kinds -> the default assignee selector when the planner names none (R4.1 pieces carry a selector)
    "kind:design": ([{"selector": ["capability", "design"]}], "design work goes to whoever offers design"),
    "kind:code": ([{"selector": ["capability", "code"]}], "code work goes to whoever offers code"),
    # capabilities -> host bindings, in order; the first that resolves wins, then the open catalogue
    "capability:design": ([{"binding": "studio_maker", "scope": "person"}], "the person's Make (Studio) mind"),
    "capability:code": ([{"binding": "foundation_create_code", "scope": "hive"}], "the foundation Create · Code team"),
    "capability:review": ([{"binding": "foundation_review", "scope": "hive"}], "the foundation Review team"),
    "capability:design-review": ([{"binding": "foundation_review", "scope": "hive"}], "the foundation Review team"),
    "capability:plan": ([{"binding": "foundation_create_code", "scope": "hive"}], "the planner: Create's controller team"),
    "capability:test-author": ([{"binding": "foundation_create_code", "scope": "hive"}], "Code's test author"),
}
SEED_REVIEW_FOR = [
    # (artifact kind, review kind, evidence kind or none, reviewer selector): the hive's (ReviewFor kind review evidence)
    ("code", "review", "none", ["capability", "review"]),
    ("design", "design-review", "render", ["capability", "design-review"]),
]


class AssigneeResolver:
    def __init__(self, hive):
        self.hive, self.db = hive, hive.db
        for statement in SCHEMA:
            self.db.execute(statement)
        at = now()
        for key, (resolution, note) in SEED_DEFAULTS.items():
            self.db.execute("INSERT OR IGNORE INTO create_assignee_defaults (selector, resolution, note, updated_at) "
                            "VALUES (?, ?, ?, ?)", (key, json.dumps(resolution), note, at))
        for kind, review, evidence, reviewer in SEED_REVIEW_FOR:
            self.db.execute("INSERT OR IGNORE INTO create_review_for (artifact_kind, review_kind, evidence, reviewer, "
                            "updated_at) VALUES (?, ?, ?, ?, ?)", (kind, review, evidence, json.dumps(reviewer), at))

    # ---- data ---------------------------------------------------------------------------------------------------

    def defaults(self):
        return {r["selector"]: json.loads(r["resolution"]) for r in self.db.all("SELECT * FROM create_assignee_defaults")}

    def set_default(self, selector, resolution, note=None):
        self.db.execute("INSERT INTO create_assignee_defaults (selector, resolution, note, updated_at) VALUES (?, ?, ?, ?) "
                        "ON CONFLICT(selector) DO UPDATE SET resolution = excluded.resolution, note = excluded.note, "
                        "updated_at = excluded.updated_at", (selector, json.dumps(resolution), note, now()))

    def review_for(self):
        """The hive's review catalogue: [{artifact_kind, review_kind, evidence, reviewer}] (R4.1 Ctx ReviewFor atoms)."""
        return [{"artifact_kind": r["artifact_kind"], "review_kind": r["review_kind"], "evidence": r["evidence"],
                 "reviewer": json.loads(r["reviewer"])}
                for r in self.db.all("SELECT * FROM create_review_for ORDER BY artifact_kind, review_kind")]

    def set_review_for(self, artifact_kind, review_kind, evidence, reviewer):
        self.db.execute("INSERT INTO create_review_for (artifact_kind, review_kind, evidence, reviewer, updated_at) "
                        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(artifact_kind, review_kind) DO UPDATE SET evidence = "
                        "excluded.evidence, reviewer = excluded.reviewer, updated_at = excluded.updated_at",
                        (artifact_kind, review_kind, evidence, json.dumps(reviewer), now()))

    def review_rule(self, kinds, review_kind):
        """For a piece of these artifact kinds, review_kind's evidence and reviewer selector (the first matching row)."""
        for r in self.review_for():
            if r["artifact_kind"] in kinds and r["review_kind"] == review_kind:
                return r
        return None

    def default_selector(self, kind):
        """The default assignee selector for an artifact kind (a data row), or ["open", kind]."""
        for t in self.defaults().get("kind:" + str(kind)) or []:
            if "selector" in t:
                return list(t["selector"])
        return ["open", str(kind)]

    # ---- resolution ---------------------------------------------------------------------------------------------

    def resolve(self, selector, person, exclude=()):
        self._person = person
        """{resolved: True, kind, ref, swarm_id, agent_id, display, selector, via} or
        {resolved: False, reason: 'assignee-unavailable', detail, selector}. `exclude` names agents that may not be
        chosen (e.g. a piece's builders when resolving its reviewer)."""
        try:
            out = self._resolve(selector, person, set(exclude), depth=0)
        finally:
            self._person = None
        out.setdefault("selector", selector)
        return out

    def _unavailable(self, selector, detail):
        return {"resolved": False, "reason": "assignee-unavailable", "detail": detail, "selector": selector}

    def _resolve(self, selector, person, exclude, depth):
        if depth > 4:
            return self._unavailable(selector, "selector-loop")
        if isinstance(selector, str):                       # an R4.0 piece kind symbol
            tries = self.defaults().get("kind:" + selector)
            if not tries:
                return self._unavailable(selector, f"no default for piece kind {selector}")
            return self._tries(selector, tries, person, exclude, depth)
        if not isinstance(selector, (list, tuple)) or not selector:
            return self._unavailable(selector, "not-a-selector")
        head, args = selector[0], list(selector[1:])
        if head == "team" and len(args) == 1:
            return self._team(args[0], selector, exclude)
        if head == "mind" and len(args) == 1:
            return self._mind(args[0], selector, exclude)
        if head == "capability" and len(args) == 1:
            tries = self.defaults().get("capability:" + str(args[0]))
            if tries:
                got = self._tries(selector, tries, person, exclude, depth)
                if got["resolved"]:
                    return got
            return self._open(args[0], selector, person, exclude)
        if head == "hive" and len(args) == 2:
            if str(args[0]) in self._this_hive_ids():
                got = self._resolve(["capability", args[1]], person, exclude, depth + 1)
                if got["resolved"]:
                    got["hive"] = str(args[0])
                return got
            return self._unavailable(selector, "federation-not-available")
        if head == "open" and len(args) == 1:
            return self._open(args[0], selector, person, exclude)
        return self._unavailable(selector, f"unknown selector {head}")

    def _tries(self, selector, tries, person, exclude, depth):
        last = None
        for t in tries:
            if "selector" in t:
                got = self._resolve(t["selector"], person, exclude, depth + 1)
            elif "binding" in t:
                got = self._binding(t["binding"], t.get("scope", "hive"), person, selector, exclude)
            else:
                got = self._unavailable(selector, "bad-default-row")
            if got["resolved"]:
                got.setdefault("via", []).insert(0, t)
                return got
            last = got
        return last or self._unavailable(selector, "no-default")

    def _this_hive_ids(self):
        ids = {"this", "local"}
        for attr in ("hive_id", "id"):
            value = getattr(self.hive, attr, None)
            if isinstance(value, str) and value:
                ids.add(value)
        with_settings = getattr(getattr(self.hive, "settings", None), "hive_id", None)
        if isinstance(with_settings, str) and with_settings:
            ids.add(with_settings)
        return ids

    def _agent(self, agent_id):
        return self.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))

    def _swarm(self, swarm_id):
        row = self.db.one("SELECT * FROM swarms WHERE id = ?", (swarm_id,))
        if row is None or row.get("archived_at"):
            return None
        return row

    def _may(self, row):
        """Whether the plan's person may direct work to this mind or team: what they see as a member (visibility.py
        Viewer: public, their own, or shared with them; never admin sight), and never someone else's personal mind or
        swarm (personal_of). Review F3: the resolver never picks a mind the person could not ask themselves."""
        from .visibility import Viewer
        if row is None or not self._person:
            return False
        personal = row.get("personal_of")
        if personal and personal != self._person:
            return False
        return Viewer(self._person, False).sees(row)

    def _team(self, swarm_id, selector, exclude, via=None):
        swarm = self._swarm(swarm_id)
        if swarm is None or not self._may(swarm):
            return self._unavailable(selector, "team-not-found")
        lead = swarm.get("coordinator_id")
        if lead in exclude or self._agent(lead) is None:
            lead = None
        return {"resolved": True, "kind": "team", "ref": swarm["id"], "swarm_id": swarm["id"], "agent_id": lead,
                "display": swarm["name"], "via": list(via or [])}

    def _mind(self, agent_id, selector, exclude, via=None):
        if agent_id in exclude:
            return self._unavailable(selector, "mind-excluded")
        agent = self._agent(agent_id)
        swarm = self._swarm(agent["swarm_id"]) if agent else None
        if agent is None or swarm is None or not self._may(agent) or not self._may(swarm):
            return self._unavailable(selector, "mind-not-found")
        return {"resolved": True, "kind": "mind", "ref": agent["id"], "swarm_id": agent["swarm_id"],
                "agent_id": agent["id"], "display": agent["name"] + (f" ({swarm['name']})" if swarm else ""),
                "via": list(via or [])}

    def _binding(self, purpose, scope, person, selector, exclude):
        """A host binding (person_minds purpose): the foundation teams and each person's Make mind are found by their
        binding, never by name (foundation.py, studio_makers.py)."""
        if not self.db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'person_minds'"):
            return self._unavailable(selector, "no-bindings")
        rows = []
        if scope == "person" and person:
            rows = self.db.all("SELECT * FROM person_minds WHERE purpose = ? AND principal = ?", (purpose, person))
        else:
            rows = self.db.all("SELECT * FROM person_minds WHERE purpose = ? ORDER BY created_at", (purpose,))
        for b in rows:
            agent = self._agent(b["agent_id"]) if b.get("agent_id") else None
            swarm_id = b.get("swarm_id") or (agent["swarm_id"] if agent else None)
            if swarm_id and self._swarm(swarm_id):
                got = self._team(swarm_id, selector, exclude, via=[{"binding": purpose}])
                if not got["resolved"]:
                    continue
                bound_ok = agent is not None and (scope == "person" or self._may(agent) or
                                                  agent["id"] == self._swarm(swarm_id).get("coordinator_id"))
                if bound_ok and agent["id"] not in exclude:
                    got["agent_id"] = agent["id"]
                elif agent is not None and agent["id"] in exclude:
                    got["agent_id"] = None
                return got
        return self._unavailable(selector, f"binding {purpose} not available")

    def _open(self, cap, selector, person, exclude):
        """Anyone offering cap in the hive: declared swarm services first, then minds whose role carries it (the same two
        sources collab.capability_catalogue projects)."""
        cap = str(cap)
        for row in self.db.all("SELECT swarm_id, kinds FROM swarm_services ORDER BY swarm_id") \
                if self.db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'swarm_services'") else []:
            try:
                kinds = json.loads(row["kinds"])
            except (TypeError, ValueError):
                continue
            if cap in kinds and self._may(self._swarm(row["swarm_id"])):
                return self._team(row["swarm_id"], selector, exclude, via=[{"catalogue": "service", "kind": cap}])
        for agent in self.db.all("SELECT a.id, r.media, r.mandate FROM agents a JOIN roles r ON r.id = a.role_id "
                                 "WHERE a.deleted = 0 ORDER BY a.id"):
            if agent["id"] in exclude:
                continue
            if not self._may(self._agent(agent["id"])):
                continue
            names = set(json.loads(agent["media"] or "[]"))
            mandate = json.loads(agent["mandate"] or "null")
            if isinstance(mandate, dict) and mandate.get("id"):
                names.add(mandate["id"])
            if cap in names:
                return self._mind(agent["id"], selector, exclude, via=[{"catalogue": "role", "capability": cap}])
        return self._unavailable(selector, f"nobody in this hive offers {cap}")


def resolved_atom(got):
    """The R4.1 `resolved` field for a resolution: (team t) / (mind m) / (hive h agent). A mind or team selector resolves
    to exactly itself; a hive selector to that hive (the reducer's fits? checks both)."""
    from .code_controller_engine import q
    sel = got.get("selector")
    head = sel[0] if isinstance(sel, (list, tuple)) and sel else None
    if head == "hive":
        return ["hive", q(got["hive"]), q(got.get("agent_id") or got["ref"])]
    if head == "mind" or (head != "team" and got["kind"] == "mind"):
        return ["mind", q(got["ref"])]
    return ["team", q(got["ref"])]
